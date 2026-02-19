import { getUsersWithAutoEntryEnabled, getSettings } from '../models/settingsModel.js';
import { getExchangeKeys } from '../models/exchangeModel.js';
import { decrypt } from '../utils/encryption.js';
import {
  getWalletBalance,
  getPositionList,
  getInstrumentLotSize,
  setLeverage,
  placeMarketOrder,
} from './bybitService.js';
import { FundingScanner } from './scannerService.js';

const INTERVAL_MS = 5_000;

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

export function startMonitoring(): void {
  setInterval(runTick, INTERVAL_MS);
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

  // Auto Exit: close positions when now >= fundingTime + exitTimeSec
  if (settings.autoExitEnabled && settings.exitTimeSec > 0) {
    const exitThresholdMs = settings.exitTimeSec * 1000;
    for (const pos of positions) {
      const key = positionKey(userId, pos.symbol, pos.side);
      const fundingTimeMs = positionFundingTime.get(key);
      if (fundingTimeMs != null && now >= fundingTimeMs + exitThresholdMs) {
        try {
          const closeSide = pos.side === 'Buy' ? 'Sell' : 'Buy';
          await placeMarketOrder(apiKey, apiSecret, pos.symbol, closeSide, pos.size);
          positionFundingTime.delete(key);
        } catch (e) {
          console.error(`[autoBot] Auto exit failed ${pos.symbol}:`, e);
        }
      }
    }
  }

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
