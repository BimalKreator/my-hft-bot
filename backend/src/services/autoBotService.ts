import { getUsersWithAutoEntryEnabled, getSettings } from '../models/settingsModel.js';
import { getExchangeKeys } from '../models/exchangeModel.js';
import { decrypt } from '../utils/encryption.js';
import {
  getWalletBalance,
  getPositionList,
  getInstrumentLotSize,
  setLeverage,
  placeMarketOrder,
  placeMarketOrderReduceOnly,
  getExecutionList,
} from './bybitService.js';
import { FundingScanner } from './scannerService.js';
import { calculateVWAP } from './vwapService.js';
import { insertClosedTrade } from '../models/closedTradesModel.js';

const INTERVAL_MS = 5_000;
const EXIT_INTERVAL_MS = 1_000;

/** Track which (userId, symbol, nextFundingTime) we already entered this cycle to avoid double entry. */
const enteredThisCycle = new Set<string>();
/** Track funding time per (userId, symbol, side) for auto exit: close at fundingTime + exitTimeSec. */
const positionFundingTime = new Map<string, number>();

const fundingScanner = new FundingScanner();

function positionKey(userId: number, symbol: string, side: string): string {
  return `${userId}_${symbol}_${side}`;
}

function entryCycleKey(userId: number, symbol: string, nextFundingTime: string): string {
  return `${userId}_${symbol}_${nextFundingTime}`;
}

/** After a reduce-only close, fetch execution list and persist closed trade to DB with exit reason. */
async function saveClosedTradeAfterExit(
  userId: number,
  apiKey: string,
  apiSecret: string,
  symbol: string,
  side: 'Buy' | 'Sell',
  entryPrice: number,
  qty: number,
  orderId: string,
  exitReason: 'Time Exit' | 'Stoploss Hit'
): Promise<void> {
  try {
    await new Promise((r) => setTimeout(r, 400));
    const executions = await getExecutionList(apiKey, apiSecret, 'linear', orderId);
    let exitPrice = 0;
    let fees = 0;
    if (executions.length > 0) {
      let totalQty = 0;
      let sumPxQty = 0;
      for (const e of executions) {
        const eq = parseFloat(e.execQty) || 0;
        const ep = parseFloat(e.execPrice) || 0;
        totalQty += eq;
        sumPxQty += ep * eq;
        fees += parseFloat(e.execFee ?? '0') || 0;
      }
      exitPrice = totalQty > 0 ? sumPxQty / totalQty : parseFloat(executions[0]!.execPrice) || 0;
    }
    const grossPnl = side === 'Buy' ? (exitPrice - entryPrice) * qty : (entryPrice - exitPrice) * qty;
    await insertClosedTrade({
      userId,
      symbol,
      side,
      entryPrice,
      exitPrice,
      qty,
      grossPnl,
      funding: 0,
      fees,
      source: 'auto',
      exitReason,
    });
  } catch (e) {
    console.error(`[autoBot] saveClosedTradeAfterExit failed ${symbol}:`, e);
  }
}

export function startMonitoring(): void {
  setInterval(runTick, INTERVAL_MS);
  setInterval(monitorExits, EXIT_INTERVAL_MS);
}

async function runTick(): Promise<void> {
  try {
    const userIds = await getUsersWithAutoEntryEnabled();
    if (userIds.length === 0) return;

    const marketData = await fundingScanner.getFundingData();
    const now = Date.now();

    for (const userId of userIds) {
      try {
        await processUser(userId, marketData, now);
      } catch (err) {
        console.error(`[autoBot] User ${userId} error:`, err);
      }
    }
  } catch (err) {
    console.error('[autoBot] tick error:', err);
  }
}

async function monitorExits(): Promise<void> {
  try {
    const userIds = await getUsersWithAutoEntryEnabled();
    if (userIds.length === 0) return;

    const marketData = await fundingScanner.getFundingData();
    const fundingBySymbol = new Map(marketData.map((m) => [m.symbol, m.fundingRate]));
    const now = Date.now();

    for (const userId of userIds) {
      try {
        const settings = await getSettings(userId);
        const keys = await getExchangeKeys(userId, 'Bybit');
        if (!keys) continue;

        const apiKey = decrypt(keys.api_key);
        const apiSecret = decrypt(keys.api_secret);
        const positions = await getPositionList(apiKey, apiSecret, { category: 'linear', settleCoin: 'USDT' });
        if (positions.length === 0) continue;

        const exitThresholdMs = (settings.exitTimeSec ?? 0) * 1000;

        for (const pos of positions) {
          const key = positionKey(userId, pos.symbol, pos.side);
          const entry = parseFloat(pos.avgPrice) || 0;
          const qty = parseFloat(pos.size) || 0;

          // Auto Exit (Time Based): funding just happened + exit_time_sec passed
          if (settings.autoExitEnabled && exitThresholdMs > 0) {
            const fundingTimeMs = positionFundingTime.get(key);
            if (fundingTimeMs != null && now >= fundingTimeMs + exitThresholdMs) {
              try {
                const vwapPrice = await calculateVWAP(pos.symbol, pos.side, qty);
                const pnl = pos.side === 'Buy' ? (vwapPrice - entry) * qty : (entry - vwapPrice) * qty;
                const { orderId } = await placeMarketOrderReduceOnly(apiKey, apiSecret, pos.symbol, pos.side, pos.size);
                positionFundingTime.delete(key);
                await saveClosedTradeAfterExit(userId, apiKey, apiSecret, pos.symbol, pos.side, entry, qty, orderId, 'Time Exit');
                console.log(`[autoBot] Exit Triggered: Time (funding+exit) | PnL: ${pnl.toFixed(4)}`);
              } catch (e) {
                console.error(`[autoBot] Auto exit failed ${pos.symbol}:`, e);
              }
              continue;
            }
          }

          // Stoploss (VWAP Based): close if PnL % <= -(Funding Rate %)
          const fundingRate = fundingBySymbol.get(pos.symbol) ?? 0;
          const fundingRatePct = fundingRate * 100;
          const vwapPrice = await calculateVWAP(pos.symbol, pos.side, qty);
          const pnlPct = entry <= 0 ? 0 : (pos.side === 'Buy' ? (vwapPrice - entry) / entry : (entry - vwapPrice) / entry) * 100;
          const pnl = pos.side === 'Buy' ? (vwapPrice - entry) * qty : (entry - vwapPrice) * qty;

          if (pnlPct <= -Math.abs(fundingRatePct)) {
            try {
              const { orderId } = await placeMarketOrderReduceOnly(apiKey, apiSecret, pos.symbol, pos.side, pos.size);
              positionFundingTime.delete(key);
              await saveClosedTradeAfterExit(userId, apiKey, apiSecret, pos.symbol, pos.side, entry, qty, orderId, 'Stoploss Hit');
              console.log(`[autoBot] Exit Triggered: VWAP Stoploss | PnL: ${pnl.toFixed(4)}`);
            } catch (e) {
              console.error(`[autoBot] VWAP stoploss exit failed ${pos.symbol}:`, e);
            }
          }
        }
      } catch (err) {
        console.error(`[autoBot] Exit monitor user ${userId} error:`, err);
      }
    }
  } catch (err) {
    console.error('[autoBot] Exit monitor tick error:', err);
  }
}

async function processUser(
  userId: number,
  marketData: Array<{
    symbol: string;
    fundingRate: number;
    nextFundingTime: string;
    countdownMs: number;
    markPrice: string;
    lastPrice: string;
    fundingIntervalHours?: number;
  }>,
  now: number
): Promise<void> {
  const settings = await getSettings(userId);
  if (!settings.autoEntryEnabled) return;

  const keys = await getExchangeKeys(userId, 'Bybit');
  if (!keys) return;
  const apiKey = decrypt(keys.api_key);
  const apiSecret = decrypt(keys.api_secret);

  const positions = await getPositionList(apiKey, apiSecret, { category: 'linear', settleCoin: 'USDT' });
  if (positions.length >= settings.maxTrades) return;

  const balanceRes = await getWalletBalance(apiKey, apiSecret);
  const availableBalance = parseFloat(balanceRes.totalAvailableBalance) || 0;

  // Auto Exit is handled by monitorExits (1s loop) with reduce-only orders and unified logging.

  // Auto Entry: filter by min funding rate, then Smart Sort, then ONLY top token
  const minFundingRate = settings.minFundingRate ?? 0;
  const meetsMinFunding = marketData.filter(
    (token) => Math.abs(token.fundingRate) >= minFundingRate
  );
  if (meetsMinFunding.length === 0) {
    const pct = (minFundingRate * 100).toFixed(4);
    console.log(`[autoBot] No tokens meet Min Funding criteria (>= ${pct}%)`);
    return;
  }

  const sorted = [...meetsMinFunding].sort((a, b) => {
    const intervalA = a.fundingIntervalHours ?? 0;
    const intervalB = b.fundingIntervalHours ?? 0;
    if (intervalA !== intervalB) return intervalA - intervalB;
    return Math.abs(b.fundingRate) - Math.abs(a.fundingRate);
  });
  const topToken = sorted[0];
  if (!topToken) return;

  const countdownSec = Math.floor(topToken.countdownMs / 1000);
  const price = parseFloat(topToken.markPrice || topToken.lastPrice || '0') || 0;
  console.log(`[autoBot] Checking Top Token: ${topToken.symbol} | Countdown: ${countdownSec}s`);

  const cycleKey = entryCycleKey(userId, topToken.symbol, topToken.nextFundingTime);
  if (enteredThisCycle.has(cycleKey)) return;

  const entryTimeSec = settings.entryTimeSec ?? 300;
  const inWindow = countdownSec <= entryTimeSec && countdownSec > entryTimeSec - 10;
  if (!inWindow) return;

  console.log(`[autoBot] Entry Attempt: ${topToken.symbol} (countdown ${countdownSec}s in window)`);

  const leverage = settings.leverage ?? 5;
  try {
    await setLeverage(apiKey, apiSecret, topToken.symbol, leverage);
    console.log(`[autoBot] Leverage set to ${leverage}`);
  } catch {
    // Ignore e.g. "Leverage not modified"
  }

  // Margin Used = Balance * Capital%; Position Size = Margin Used * Leverage; Qty = Position Size / Price
  const rawQty = (availableBalance * (settings.capitalPercent / 100) * leverage) / price;
  if (rawQty <= 0) return;

  let finalQty: number;
  try {
    const { qtyStep, minOrderQty } = await getInstrumentLotSize(apiKey, apiSecret, topToken.symbol);
    const step = parseFloat(qtyStep) || 0.1;
    const minQty = parseFloat(minOrderQty) || 0;
    finalQty = Math.floor(rawQty / step) * step;
    if (finalQty < minQty) {
      console.warn(`[autoBot] ${topToken.symbol}: finalQty ${finalQty} < minOrderQty ${minQty}, skipping`);
      return;
    }
    console.log(`[autoBot] Precision applied for ${topToken.symbol}: Raw=${rawQty} Final=${finalQty}`);
  } catch (e) {
    console.error(`[autoBot] Instrument info failed for ${topToken.symbol}:`, e);
    return;
  }

  const qtyStr = String(finalQty);
  const side = topToken.fundingRate < 0 ? 'Buy' : 'Sell';

  try {
    enteredThisCycle.add(cycleKey);
    await placeMarketOrder(apiKey, apiSecret, topToken.symbol, side, qtyStr);
    const nextFundingMs = parseInt(topToken.nextFundingTime, 10) || 0;
    const key = positionKey(userId, topToken.symbol, side);
    positionFundingTime.set(key, nextFundingMs);
  } catch (e) {
    console.error(`[autoBot] Entry failed ${topToken.symbol}:`, e);
    enteredThisCycle.delete(cycleKey);
  }

  // Prune old cycle keys (nextFundingTime in the past so we can enter next cycle)
  for (const key of enteredThisCycle) {
    const parts = key.split('_');
    const nextFundingTimeStr = parts.length >= 3 ? parts[parts.length - 1]! : '';
    const nextMs = parseInt(nextFundingTimeStr, 10) || 0;
    if (nextMs > 0 && now > nextMs + 60_000) {
      enteredThisCycle.delete(key);
    }
  }
}
