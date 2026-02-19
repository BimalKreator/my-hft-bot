import { getUsersWithAutoEntryEnabled, getSettings } from '../models/settingsModel.js';
import { getExchangeKeys } from '../models/exchangeModel.js';
import { decrypt } from '../utils/encryption.js';
import {
  getWalletBalance,
  getPositionList,
  setLeverage,
  placeMarketOrder,
} from './bybitService.js';
import { FundingScanner } from './scannerService.js';

const INTERVAL_MS = 5_000;
const DEFAULT_LEVERAGE = 5;

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

  // Auto Entry: when countdown (seconds) is in [entry_time_sec - 10, entry_time_sec], place order
  const entryTimeSec = settings.entryTimeSec;
  const capitalPct = settings.capitalPercent / 100;
  const capitalUsdt = availableBalance * capitalPct;

  for (const token of marketData) {
    const countdownSec = Math.floor(token.countdownMs / 1000);
    const price = parseFloat(token.markPrice || token.lastPrice || '0') || 0;
    if (price <= 0) continue;

    const cycleKey = entryCycleKey(userId, token.symbol, token.nextFundingTime);
    if (enteredThisCycle.has(cycleKey)) continue;

    // Fire when countdown is in (entry_time_sec - 10, entry_time_sec]
    if (countdownSec > entryTimeSec || countdownSec <= entryTimeSec - 10) continue;

    const qty = capitalUsdt / price;
    if (qty <= 0) continue;

    const side = token.fundingRate < 0 ? 'Buy' : 'Sell';
    const qtyStr = String(qty);

    try {
      await setLeverage(apiKey, apiSecret, token.symbol, DEFAULT_LEVERAGE);
    } catch {
      // Leverage may already be set
    }

    try {
      enteredThisCycle.add(cycleKey);
      await placeMarketOrder(apiKey, apiSecret, token.symbol, side, qtyStr);
      const nextFundingMs = parseInt(token.nextFundingTime, 10) || 0;
      const key = positionKey(userId, token.symbol, side);
      positionFundingTime.set(key, nextFundingMs);
    } catch (e) {
      console.error(`[autoBot] Entry failed ${token.symbol}:`, e);
      enteredThisCycle.delete(cycleKey);
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
}
