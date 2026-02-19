import { getUsersWithAutoEntryEnabled, getSettings } from '../models/settingsModel.js';
import { getExchangeKeys } from '../models/exchangeModel.js';
import { getBannedTokens, addBannedToken } from '../models/bannedTokensModel.js';
import { decrypt } from '../utils/encryption.js';
import {
  getWalletBalance,
  getPositionList,
  getInstrumentLotSize,
  getInstrumentDetails,
  setLeverage,
  placeLimitOrder,
  placeLimitOrderReduceOnly,
  placeMarketOrderReduceOnly,
  getOrderBookL2,
  getActiveOrders,
  cancelAllOrders,
  getExecutionList,
} from './bybitService.js';
import { FundingScanner } from './scannerService.js';
import { insertClosedTrade } from '../models/closedTradesModel.js';

const INTERVAL_MS = 5_000;
const EXIT_INTERVAL_MS = 1_000;

/** Exact funding rate snapshot 1–2s before settlement, keyed by symbol. */
const lockedFundingRates: Record<string, number> = {};

/** Track which (userId, symbol, nextFundingTime) we already entered this cycle to avoid double entry. */
const enteredThisCycle = new Set<string>();
/** Retry prevention: once we attempt order for this key, do not retry even if order fails. */
const processedTokens = new Set<string>();
/** Track funding time per (userId, symbol, side) for auto exit: close at fundingTime + exitTimeSec. */
const positionFundingTime = new Map<string, number>();

function processedKey(userId: number, symbol: string, fundingTimestamp: string): string {
  return `${userId}_${symbol}_${fundingTimestamp}`;
}

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
  exitReason: 'Time Exit' | 'Stoploss Hit' | 'Pre-Funding Stoploss' | 'Post-Funding Stoploss',
  fundingReceived: number = 0,
  estimatedExitPrice?: number
): Promise<void> {
  try {
    const waitMs = estimatedExitPrice != null ? 2000 : 400;
    await new Promise((r) => setTimeout(r, waitMs));
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
    if (exitPrice === 0 && estimatedExitPrice != null && !Number.isNaN(estimatedExitPrice)) {
      exitPrice = estimatedExitPrice;
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
      funding: fundingReceived,
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
    const countdownBySymbol = new Map(marketData.map((m) => [m.symbol, Math.floor(m.countdownMs / 1000)]));
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
          const fundingTimeMs = positionFundingTime.get(key);
          const fundingRate = fundingBySymbol.get(pos.symbol) ?? 0;
          const countdown = countdownBySymbol.get(pos.symbol) ?? 0;
          const isPreFunding = fundingTimeMs != null && now < fundingTimeMs;
          const isPostFunding = fundingTimeMs == null || now >= fundingTimeMs;

          // Snapshot exact funding rate 1–2s before settlement (handles polling delay)
          if (countdown > 0 && countdown <= 2) {
            lockedFundingRates[pos.symbol] = Math.abs(fundingRate);
          }

          // Pre-Funding Cancel (3-second rule): cancel open orders so partial fill remains as position
          if (countdown > 0 && countdown <= 3) {
            try {
              const openOrders = await getActiveOrders(apiKey, apiSecret, 'linear', pos.symbol);
              if (openOrders.length > 0) {
                await cancelAllOrders(apiKey, apiSecret, 'linear', pos.symbol);
                console.log(`[autoBot] Pre-funding cancel: ${openOrders.length} order(s) for ${pos.symbol}`);
              }
            } catch (e) {
              console.error(`[autoBot] Pre-funding cancel failed ${pos.symbol}:`, e);
            }
          }

          // L2-based PnL: Long = value at bidL2 (sell to close), Short = value at askL2 (buy to close)
          let bidL2 = 0;
          let askL2 = 0;
          try {
            const l2 = await getOrderBookL2(apiKey, apiSecret, pos.symbol);
            bidL2 = l2.bidL2;
            askL2 = l2.askL2;
          } catch (e) {
            console.error(`[autoBot] getOrderBookL2 failed ${pos.symbol}:`, e);
            continue;
          }
          const l2Price = pos.side === 'Buy' ? bidL2 : askL2;
          const pnlPct = entry <= 0 || !Number.isFinite(l2Price) ? 0 : (pos.side === 'Buy' ? (l2Price - entry) / entry : (entry - l2Price) / entry) * 100;
          const pnl = !Number.isFinite(l2Price) ? 0 : pos.side === 'Buy' ? (l2Price - entry) * qty : (entry - l2Price) * qty;

          // Stoploss takes priority over time-based exit. Check pre-funding then post-funding stoploss first.
          if (isPreFunding && settings.slPreFundingEnabled) {
            const slThresholdPct = Math.abs(fundingRate) * 100 * (settings.slPreMultiplier ?? 1);
            if (pnlPct <= -slThresholdPct) {
              try {
                const exitPriceL2 = pos.side === 'Buy' ? bidL2 : askL2;
                const { orderId } = await placeLimitOrderReduceOnly(apiKey, apiSecret, pos.symbol, pos.side, pos.size, String(exitPriceL2));
                positionFundingTime.delete(key);
                await saveClosedTradeAfterExit(userId, apiKey, apiSecret, pos.symbol, pos.side, entry, qty, orderId, 'Pre-Funding Stoploss', 0, exitPriceL2);
                delete lockedFundingRates[pos.symbol];
                console.log(`[autoBot] Exit Triggered: Pre-Funding Stoploss (L2) | PnL: ${pnl.toFixed(4)}`);
              } catch (e) {
                console.error(`[autoBot] Pre-funding stoploss exit failed ${pos.symbol}:`, e);
              }
              continue;
            }
          }

          if (isPostFunding && settings.slPostFundingEnabled) {
            const slThresholdPct = Math.abs(fundingRate) * 100;
            if (pnlPct <= -slThresholdPct) {
              try {
                const exitPriceL2 = pos.side === 'Buy' ? bidL2 : askL2;
                const finalFundingRate = lockedFundingRates[pos.symbol] ?? Math.abs(fundingRate);
                const fundingReceived = (qty * entry) * finalFundingRate;
                const { orderId } = await placeLimitOrderReduceOnly(apiKey, apiSecret, pos.symbol, pos.side, pos.size, String(exitPriceL2));
                positionFundingTime.delete(key);
                await saveClosedTradeAfterExit(userId, apiKey, apiSecret, pos.symbol, pos.side, entry, qty, orderId, 'Post-Funding Stoploss', fundingReceived, exitPriceL2);
                delete lockedFundingRates[pos.symbol];
                console.log(`[autoBot] Exit Triggered: Post-Funding Stoploss (L2) | PnL: ${pnl.toFixed(4)}`);
              } catch (e) {
                console.error(`[autoBot] Post-funding stoploss exit failed ${pos.symbol}:`, e);
              }
              continue;
            }
          }

          // Time-based Auto Exit (after stoploss checks)
          if (settings.autoExitEnabled && exitThresholdMs > 0 && fundingTimeMs != null && now >= fundingTimeMs + exitThresholdMs) {
            try {
              const exitPriceL2 = pos.side === 'Buy' ? bidL2 : askL2;
              const finalFundingRate = lockedFundingRates[pos.symbol] ?? Math.abs(fundingRate);
              const fundingReceived = (qty * entry) * finalFundingRate;
              const { orderId } = await placeLimitOrderReduceOnly(apiKey, apiSecret, pos.symbol, pos.side, pos.size, String(exitPriceL2));
              positionFundingTime.delete(key);
              await saveClosedTradeAfterExit(userId, apiKey, apiSecret, pos.symbol, pos.side, entry, qty, orderId, 'Time Exit', fundingReceived, exitPriceL2);
              delete lockedFundingRates[pos.symbol];
              console.log(`[autoBot] Exit Triggered: Time (funding+exit) (L2) | PnL: ${pnl.toFixed(4)}`);
            } catch (e) {
              console.error(`[autoBot] Auto exit failed ${pos.symbol}:`, e);
            }
            continue;
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

  // Auto Entry: filter by min funding rate, exclude banned tokens, then Smart Sort, then ONLY top token
  const minFundingRate = settings.minFundingRate ?? 0;
  let meetsMinFunding = marketData.filter(
    (token) => Math.abs(token.fundingRate) >= minFundingRate
  );
  const bannedSet = new Set(await getBannedTokens(userId));
  meetsMinFunding = meetsMinFunding.filter((token) => !bannedSet.has(token.symbol));
  if (meetsMinFunding.length === 0) {
    const pct = (minFundingRate * 100).toFixed(4);
    console.log(`[autoBot] No tokens meet Min Funding criteria (>= ${pct}%) or all are banned`);
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

  const procKey = processedKey(userId, topToken.symbol, topToken.nextFundingTime);
  if (processedTokens.has(procKey)) return;

  const countdownSec = Math.floor(topToken.countdownMs / 1000);
  const price = parseFloat(topToken.markPrice || topToken.lastPrice || '0') || 0;
  console.log(`[autoBot] Checking Top Token: ${topToken.symbol} | Countdown: ${countdownSec}s`);

  const cycleKey = entryCycleKey(userId, topToken.symbol, topToken.nextFundingTime);
  if (enteredThisCycle.has(cycleKey)) return;

  const entryTimeSec = settings.entryTimeSec ?? 300;
  const inWindow = countdownSec <= entryTimeSec && countdownSec > entryTimeSec - 10;
  if (!inWindow) return;

  console.log(`[autoBot] Entry Attempt: ${topToken.symbol} (countdown ${countdownSec}s in window)`);

  const userLeverage = settings.leverage ?? 5;
  let maxLeverageStr = '';
  try {
    const details = await getInstrumentDetails(topToken.symbol);
    maxLeverageStr = details.maxLeverage || String(userLeverage);
  } catch {
    maxLeverageStr = String(userLeverage);
  }
  const maxLeverageNum = parseFloat(maxLeverageStr) || userLeverage;
  const safeLeverage = Math.min(userLeverage, maxLeverageNum);
  console.log(`[autoBot] Leverage adjusted to ${safeLeverage} (User: ${userLeverage}, Max: ${maxLeverageStr})`);

  try {
    await setLeverage(apiKey, apiSecret, topToken.symbol, safeLeverage);
  } catch (levErr: unknown) {
    const msg = (levErr as { message?: string })?.message ?? String(levErr);
    if (/leverage\s*not\s*modified/i.test(msg)) {
      // Bybit often returns this when leverage is already set; do not abort the trade.
    } else {
      throw levErr;
    }
  }

  // Margin Used = Balance * Capital%; Position Size = Margin Used * Leverage; Qty = Position Size / Price
  const rawQty = (availableBalance * (settings.capitalPercent / 100) * safeLeverage) / price;
  if (rawQty <= 0) return;

  let finalQty: number;
  try {
    const { qtyStep, minOrderQty, maxOrderQty, maxMktOrderQty } = await getInstrumentLotSize(apiKey, apiSecret, topToken.symbol);
    const step = parseFloat(qtyStep) || 0.1;
    const minQty = parseFloat(minOrderQty) || 0;
    const maxQty = parseFloat(maxMktOrderQty || maxOrderQty) || 999999;
    // Determine number of decimal places in the step size
    const stepStr = step.toString();
    const stepDecimals = stepStr.includes('.') ? stepStr.split('.')[1].length : 0;
    // Calculate and fix floating point precision issues
    finalQty = parseFloat((Math.floor(rawQty / step) * step).toFixed(stepDecimals));
    if (finalQty > maxQty) {
      finalQty = parseFloat((Math.floor(maxQty / step) * step).toFixed(stepDecimals));
      console.log(`[autoBot] Quantity capped to Bybit max limit: ${finalQty}`);
    }
    if (finalQty < minQty) {
      console.warn(`[autoBot] ${topToken.symbol}: finalQty ${finalQty} < minOrderQty ${minQty}, skipping`);
      return;
    }
    console.log('Precision applied for ' + topToken.symbol + ': Raw=' + rawQty + ' Final=' + finalQty);
  } catch (e) {
    console.error(`[autoBot] Instrument info failed for ${topToken.symbol}:`, e);
    return;
  }

  const qtyStr = String(finalQty);
  const side = topToken.fundingRate < 0 ? 'Buy' : 'Sell';

  // Level 2 chase: limit entry at L2 price (Long = askL2, Short = bidL2)
  let entryPrice: number;
  try {
    const l2 = await getOrderBookL2(apiKey, apiSecret, topToken.symbol);
    entryPrice = side === 'Buy' ? l2.askL2 : l2.bidL2;
    if (!Number.isFinite(entryPrice)) {
      console.warn(`[autoBot] L2 price invalid for ${topToken.symbol}, skipping entry`);
      return;
    }
  } catch (e) {
    console.error(`[autoBot] getOrderBookL2 failed ${topToken.symbol}:`, e);
    return;
  }

  processedTokens.add(procKey);
  enteredThisCycle.add(cycleKey);
  try {
    await placeLimitOrder(apiKey, apiSecret, topToken.symbol, side, qtyStr, String(entryPrice));
    const nextFundingMs = parseInt(topToken.nextFundingTime, 10) || 0;
    const key = positionKey(userId, topToken.symbol, side);
    positionFundingTime.set(key, nextFundingMs);
  } catch (e: unknown) {
    const err = e as { response?: { data?: unknown }; message?: string };
    console.error('[autoBot] EXACT BYBIT ERROR for ' + topToken.symbol + ':', err?.response?.data ?? err?.message ?? e);
    try {
      await addBannedToken(userId, topToken.symbol, 'Auto-banned: API Execution Error');
      console.log(`[autoBot] Auto-banned ${topToken.symbol} (API Execution Error)`);
    } catch (banErr) {
      console.error(`[autoBot] Failed to add banned token ${topToken.symbol}:`, banErr);
    }
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
  for (const key of processedTokens) {
    const parts = key.split('_');
    const nextFundingTimeStr = parts.length >= 3 ? parts[parts.length - 1]! : '';
    const nextMs = parseInt(nextFundingTimeStr, 10) || 0;
    if (nextMs > 0 && now > nextMs + 60_000) {
      processedTokens.delete(key);
    }
  }
}
