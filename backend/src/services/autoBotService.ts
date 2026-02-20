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
  getOrderBookDepth,
  getOrderbook,
  getSpotOrderbook,
  getSpotInstrumentLotSize,
  placeSpotMarginOrder,
  getActiveOrders,
  cancelAllOrders,
  getExecutionList,
  getClosedPnl,
  startExecutionStream,
  getDepthPrice,
  calculateUnrealizedPnLByDepth,
} from './bybitService.js';
import type { OrderbookResult } from './bybitService.js';
import { FundingScanner } from './scannerService.js';
import { insertClosedTrade } from '../models/closedTradesModel.js';
import {
  createHedgeGroup,
  getHedgeGroupByPosition,
  setFundingReceived,
  deleteHedgeGroup,
} from '../models/hedgeGroupModel.js';

const INTERVAL_MS = 5_000;
const ENTRY_FAST_INTERVAL_MS = 500; // when countdown <= 15s (zero latency in final seconds)
const EXIT_INTERVAL_MS = 2_000; // Fallback if WebSocket settlement event doesn't fire

/** Prefetch window: fetch wallet when countdown 20–60s; never call getWalletBalance when countdown <= 15. */
const WALLET_PREFETCH_MIN_SEC = 20;
const WALLET_PREFETCH_MAX_SEC = 60;
const CRITICAL_COUNTDOWN_SEC = 15; // below this: use cache only, no DB/heavy API except orderbook + place order

/** Cached wallet when countdown was 20–60s; used in entry window so we never call getWalletBalance when countdown <= 15. */
const walletCacheByUser = new Map<number, { totalEquity: number; totalAvailableBalance: number }>();

/** Entry prep cache: populated when 20s <= countdown <= 60s; used in critical path (countdown <= 15) so no DB/heavy API. */
interface EntryPrepCandidate {
  symbol: string;
  nextFundingTime: string;
  fundingRate: number;
  side: 'Buy' | 'Sell';
  safeLeverage: number;
  qtyStep: number;
  minOrderQty: number;
  maxOrderQty: number;
  tickSize: string;
}
interface EntryPrep {
  settings: { orderBookDepth?: number; capitalPercent?: number; maxTrades: number; entryTimeSec: number };
  apiKey: string;
  apiSecret: string;
  totalWalletBalance: number;
  tradeMargin: number;
  cachedAvailableMargin: number;
  positionsCount: number;
  maxTrades: number;
  candidates: EntryPrepCandidate[];
}
const entryPrepCacheByUser = new Map<number, EntryPrep>();
/** Cached user IDs with auto entry enabled; used when countdown <= 15 to avoid DB. */
let entryUserIdsCache: number[] = [];

/** When TEST_MODE=true, mock funding time 30s ahead so countdown decrements each tick. */
let mockFundingTimeMs: number | null = null;

/** Manual mock: when true, force 30s countdown for one cycle; reset when cycle end time has passed (mock settlement + exit window). */
let isManualMockActive = false;
let manualMockFundingTimeMs: number | null = null;
let manualMockEndMs: number | null = null;
const MANUAL_MOCK_COUNTDOWN_MS = 30_000;
const MANUAL_MOCK_EXIT_BUFFER_MS = 3600_000; // 1 hour after mock settlement so time-based exit can run, then reset

/** Exact funding rate snapshot 1–2s before settlement, keyed by symbol. */
const lockedFundingRates: Record<string, number> = {};

/** Track which (userId, symbol, nextFundingTime) we already entered this cycle to avoid double entry. */
const enteredThisCycle = new Set<string>();
/** Retry prevention: once we attempt order for this key, do not retry even if order fails. */
const processedTokens = new Set<string>();
/** Track funding time per (userId, symbol, side) for auto exit: close at fundingTime + exitTimeMs. */
const positionFundingTime = new Map<string, number>();

/** Execution WebSocket stream handles per userId (for Settlement-triggered exit). */
const executionStreamsByUser = new Map<number, { close: () => void }>();

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

const IOC_RETRY_DELAY_MS = 200;
const MAX_IOC_RETRIES = 5;
const ORDERBOOK_SWEEP_LIMIT = 100;

/**
 * Get the price level at which cumulative volume >= requiredQty when sweeping the orderbook.
 * Buy: iterate asks (ascending), sum size until sum >= requiredQty, return that ask price.
 * Sell: iterate bids (descending), sum size until sum >= requiredQty, return that bid price.
 * If the book doesn't cover requiredQty, return the deepest available level's price.
 */
function getSweepPrice(orderbook: OrderbookResult, side: 'Buy' | 'Sell', requiredQty: number): number {
  if (side === 'Buy') {
    let sum = 0;
    for (const level of orderbook.asks) {
      const size = parseFloat(level.size) || 0;
      sum += size;
      if (sum >= requiredQty) return parseFloat(level.price) || 0;
    }
    const last = orderbook.asks[orderbook.asks.length - 1];
    return last ? parseFloat(last.price) || 0 : 0;
  } else {
    let sum = 0;
    for (const level of orderbook.bids) {
      const size = parseFloat(level.size) || 0;
      sum += size;
      if (sum >= requiredQty) return parseFloat(level.price) || 0;
    }
    const last = orderbook.bids[orderbook.bids.length - 1];
    return last ? parseFloat(last.price) || 0 : 0;
  }
}

/** Format price to Bybit tick size (e.g. 0.01 → 2 decimals). */
function formatPriceToTick(price: number, tickSize: string): string {
  const tick = parseFloat(tickSize) || 0.01;
  if (tick <= 0 || !Number.isFinite(price)) return String(price);
  const decimals = tick.toString().includes('.') ? tick.toString().split('.')[1]!.length : 0;
  const mult = Math.pow(10, decimals);
  const rounded = Math.round(price / tick) * tick;
  return rounded.toFixed(decimals);
}

/** Format qty to Bybit lot step. */
function formatQtyToStep(qty: number, qtyStep: string): string {
  const step = parseFloat(qtyStep) || 0.1;
  if (step <= 0 || !Number.isFinite(qty)) return String(qty);
  const stepStr = step.toString();
  const stepDecimals = stepStr.includes('.') ? stepStr.split('.')[1]!.length : 0;
  const rounded = parseFloat((Math.floor(qty / step) * step).toFixed(stepDecimals));
  return String(rounded);
}

/**
 * Close a position using IOC limit orderbook sweep. Returns order IDs for saveClosedTradeAfterExit.
 */
async function exitPositionWithIocSweep(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  positionSide: 'Buy' | 'Sell',
  positionSizeQty: number
): Promise<string[]> {
  const orderIds: string[] = [];
  const exitSide = positionSide === 'Buy' ? 'Sell' : 'Buy';
  let remainingQty = positionSizeQty;
  let retries = 0;
  let tickSize = '0.01';
  let qtyStepStr = '0.1';
  try {
    const ls = await getInstrumentLotSize(apiKey, apiSecret, symbol);
    tickSize = ls.tickSize ?? '0.01';
    qtyStepStr = ls.qtyStep;
  } catch {
    // use defaults
  }
  while (remainingQty > 0 && retries < MAX_IOC_RETRIES) {
    const orderbook = await getOrderbook(symbol, ORDERBOOK_SWEEP_LIMIT);
    const sweepPrice = getSweepPrice(orderbook, exitSide, remainingQty);
    if (!Number.isFinite(sweepPrice) || sweepPrice <= 0) break;
    const priceStr = formatPriceToTick(sweepPrice, tickSize);
    const qtyStr = formatQtyToStep(remainingQty, qtyStepStr);
    if (parseFloat(qtyStr) <= 0) break;
    try {
      const { orderId } = await placeLimitOrderReduceOnly(apiKey, apiSecret, symbol, positionSide, qtyStr, priceStr, 'IOC');
      orderIds.push(orderId);
    } catch (e) {
      console.error(`[autoBot] exitPositionWithIocSweep ${symbol} order failed:`, e);
      break;
    }
    await new Promise((r) => setTimeout(r, IOC_RETRY_DELAY_MS));
    const orderId = orderIds[orderIds.length - 1]!;
    const executions = await getExecutionList(apiKey, apiSecret, 'linear', orderId);
    const filledQty = executions.reduce((s, e) => s + (parseFloat(e.execQty) || 0), 0);
    remainingQty -= filledQty;
    if (remainingQty <= 0) break;
    retries++;
    await new Promise((r) => setTimeout(r, IOC_RETRY_DELAY_MS));
  }
  return orderIds;
}

/**
 * Close the spot (margin) leg of a hedge using IOC limit orderbook sweep.
 * exitSide: same as futures position side (Buy to cover spot short, Sell to close spot long).
 */
async function exitSpotWithIocSweep(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  exitSide: 'Buy' | 'Sell',
  positionSizeQty: number
): Promise<void> {
  let remainingQty = positionSizeQty;
  let retries = 0;
  let tickSize = '0.01';
  let qtyStepStr = '0.1';
  try {
    const ls = await getSpotInstrumentLotSize(symbol);
    tickSize = ls.tickSize ?? '0.01';
    qtyStepStr = ls.qtyStep;
  } catch {
    // use defaults
  }
  while (remainingQty > 0 && retries < MAX_IOC_RETRIES) {
    const orderbook = await getSpotOrderbook(symbol, ORDERBOOK_SWEEP_LIMIT);
    const sweepPrice = getSweepPrice(orderbook, exitSide, remainingQty);
    if (!Number.isFinite(sweepPrice) || sweepPrice <= 0) break;
    const priceStr = formatPriceToTick(sweepPrice, tickSize);
    const qtyStr = formatQtyToStep(remainingQty, qtyStepStr);
    if (parseFloat(qtyStr) <= 0) break;
    try {
      const { orderId } = await placeSpotMarginOrder(apiKey, apiSecret, symbol, exitSide, 'Limit', qtyStr, priceStr, 'IOC');
      await new Promise((r) => setTimeout(r, IOC_RETRY_DELAY_MS));
      const executions = await getExecutionList(apiKey, apiSecret, 'spot', orderId);
      const filledQty = executions.reduce((s, e) => s + (parseFloat(e.execQty) || 0), 0);
      remainingQty -= filledQty;
      if (remainingQty <= 0) break;
    } catch (e) {
      console.error(`[autoBot] exitSpotWithIocSweep ${symbol} order failed:`, e);
      break;
    }
    retries++;
    await new Promise((r) => setTimeout(r, IOC_RETRY_DELAY_MS));
  }
}

/** After a reduce-only close, allow Bybit to settle then fetch exact closed PnL & fees, persist to DB. orderIds: one or more (IOC sweep may produce multiple). */
async function saveClosedTradeAfterExit(
  userId: number,
  apiKey: string,
  apiSecret: string,
  symbol: string,
  side: 'Buy' | 'Sell',
  entryPrice: number,
  qty: number,
  orderIds: string | string[],
  exitReason: 'Time Exit' | 'Stoploss Hit' | 'Pre-Funding Stoploss' | 'Post-Funding Stoploss' | 'Post-Funding Stoploss (L2 - 50% Funding)',
  fundingReceived: number = 0,
  estimatedExitPrice?: number,
  estimatedFeesWhenZero?: number
): Promise<void> {
  const ids = Array.isArray(orderIds) ? orderIds : [orderIds];
  try {
    await new Promise((r) => setTimeout(r, 2000));
    const closedList = await getClosedPnl(apiKey, apiSecret, 'linear', symbol, 50);
    const nowMs = Date.now();
    const windowMs = 15_000;
    const recent = closedList.filter((row) => {
      const ut = parseInt(row.updatedTime, 10) || 0;
      return ut >= nowMs - windowMs && ut <= nowMs + 1000;
    });
    let exitPrice = estimatedExitPrice ?? 0;
    let fees = 0;
    let grossPnl: number;
    let exactNetPnl: number | undefined;
    if (recent.length > 0) {
      const sumClosedPnl = recent.reduce((s, r) => s + (parseFloat(r.closedPnl) || 0), 0);
      const exactTotalFee = recent.reduce((s, r) => s + (parseFloat(r.openFee) || 0) + (parseFloat(r.closeFee) || 0), 0);
      exactNetPnl = sumClosedPnl + fundingReceived;
      fees = exactTotalFee;
      grossPnl = exactNetPnl + exactTotalFee - fundingReceived;
      if (!exitPrice && recent[0]) {
        const avgExit = recent[0].avgExitPrice;
        if (avgExit) exitPrice = parseFloat(avgExit) || 0;
      }
    } else {
      let totalQty = 0;
      let sumPxQty = 0;
      for (const orderId of ids) {
        const executions = await getExecutionList(apiKey, apiSecret, 'linear', orderId);
        for (const e of executions) {
          const eq = parseFloat(e.execQty) || 0;
          const ep = parseFloat(e.execPrice) || 0;
          totalQty += eq;
          sumPxQty += ep * eq;
          fees += parseFloat(e.execFee ?? '0') || 0;
        }
      }
      if (totalQty > 0) exitPrice = sumPxQty / totalQty;
      else if (ids.length > 0) {
        const firstExecs = await getExecutionList(apiKey, apiSecret, 'linear', ids[0]!);
        if (firstExecs.length > 0) exitPrice = parseFloat(firstExecs[0]!.execPrice) || 0;
      }
      if (exitPrice === 0 && estimatedExitPrice != null && !Number.isNaN(estimatedExitPrice)) exitPrice = estimatedExitPrice;
      if (fees === 0 && estimatedFeesWhenZero != null && !Number.isNaN(estimatedFeesWhenZero)) fees = estimatedFeesWhenZero;
      grossPnl = side === 'Buy' ? (exitPrice - entryPrice) * qty : (entryPrice - exitPrice) * qty;
    }
    if (exitPrice === 0 && estimatedExitPrice != null && !Number.isNaN(estimatedExitPrice)) exitPrice = estimatedExitPrice;
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
      ...(exactNetPnl != null && { netPnl: exactNetPnl }),
      source: 'auto',
      exitReason,
    });
  } catch (e) {
    console.error(`[autoBot] saveClosedTradeAfterExit failed ${symbol}:`, e);
  }
}

/**
 * Run exit for a position after WebSocket Settlement event; called after exitTimeMs delay.
 */
async function doExitAfterSettlement(userId: number, symbol: string): Promise<void> {
  try {
    const settings = await getSettings(userId);
    if (!settings.autoExitEnabled) return;
    const keys = await getExchangeKeys(userId, 'Bybit');
    if (!keys) return;
    const apiKey = decrypt(keys.api_key);
    const apiSecret = decrypt(keys.api_secret);
    const positions = await getPositionList(apiKey, apiSecret, { category: 'linear', settleCoin: 'USDT' });
    const pos = positions.find((p) => p.symbol === symbol);
    if (!pos) return;
    const key = positionKey(userId, pos.symbol, pos.side);
    const entry = parseFloat(pos.avgPrice) || 0;
    const qty = parseFloat(pos.size) || 0;
    const marketData = await fundingScanner.getFundingData();
    const fundingRate = marketData.find((m) => m.symbol === symbol)?.fundingRate ?? 0;
    const fundingReceived = (qty * entry) * (lockedFundingRates[symbol] ?? Math.abs(fundingRate));
    const estimatedMakerFee = 0.0002 * qty * entry;
    const hedgeGroup = await getHedgeGroupByPosition(userId, pos.symbol, pos.side);
    const doDualExit = settings.spotHedgingEnabled || hedgeGroup != null;
    let orderIds: string[];
    if (doDualExit) {
      if (hedgeGroup != null && hedgeGroup.fundingAmountReceived == null) {
        await setFundingReceived(hedgeGroup.hedgeGroupId, fundingReceived);
      }
      [orderIds] = await Promise.all([
        exitPositionWithIocSweep(apiKey, apiSecret, pos.symbol, pos.side, qty),
        exitSpotWithIocSweep(apiKey, apiSecret, pos.symbol, pos.side, qty),
      ]);
      if (hedgeGroup != null) await deleteHedgeGroup(hedgeGroup.hedgeGroupId);
    } else {
      orderIds = await exitPositionWithIocSweep(apiKey, apiSecret, pos.symbol, pos.side, qty);
    }
    positionFundingTime.delete(key);
    if (orderIds.length > 0) {
      const ob = await getOrderBookDepth(apiKey, apiSecret, pos.symbol, settings.orderBookDepth ?? 2);
      const exitPrice = pos.side === 'Buy' ? ob.bidPrice : ob.askPrice;
      await saveClosedTradeAfterExit(userId, apiKey, apiSecret, pos.symbol, pos.side, entry, qty, orderIds, 'Time Exit', fundingReceived, exitPrice, estimatedMakerFee);
    }
    delete lockedFundingRates[symbol];
    console.log(`[autoBot] Exit Triggered: WebSocket Settlement + exitTimeMs | ${symbol}`);
  } catch (e) {
    console.error(`[autoBot] doExitAfterSettlement failed ${symbol}:`, e);
  }
}

/**
 * Sync execution WebSocket streams: one per user with auto entry enabled.
 * On Settlement (execType === 'Settle'), schedule exit after exitTimeMs using setTimeout.
 */
async function syncExecutionStreams(): Promise<void> {
  const userIds = await getUsersWithAutoEntryEnabled();
  const currentSet = new Set(userIds);
  for (const userId of executionStreamsByUser.keys()) {
    if (!currentSet.has(userId)) {
      executionStreamsByUser.get(userId)?.close();
      executionStreamsByUser.delete(userId);
    }
  }
  for (const userId of userIds) {
    if (executionStreamsByUser.has(userId)) continue;
    const keys = await getExchangeKeys(userId, 'Bybit');
    if (!keys) continue;
    const apiKey = decrypt(keys.api_key);
    const apiSecret = decrypt(keys.api_secret);
    const handle = startExecutionStream(apiKey, apiSecret, userId, (uid, symbol) => {
      getSettings(uid).then((settings) => {
        const exitTimeMs = Math.max(0, settings.exitTimeMs ?? 3600000);
        setTimeout(() => doExitAfterSettlement(uid, symbol), exitTimeMs);
      }).catch((e) => console.error('[autoBot] getSettings for settlement exit:', e));
    });
    executionStreamsByUser.set(userId, handle);
  }
}

export function startMonitoring(): void {
  setInterval(monitorExits, EXIT_INTERVAL_MS);
  scheduleNextTick();
  syncExecutionStreams().then(() => {
    setInterval(syncExecutionStreams, 60_000);
  }).catch((e) => console.error('[autoBot] syncExecutionStreams failed:', e));
}

/** Run entry tick; when countdown <= 15s schedule next in 500ms, else 5s. */
function scheduleNextTick(): void {
  runTick()
    .then((minCountdownSec) => {
      const delay =
        minCountdownSec >= 0 && minCountdownSec <= CRITICAL_COUNTDOWN_SEC ? ENTRY_FAST_INTERVAL_MS : INTERVAL_MS;
      setTimeout(scheduleNextTick, delay);
    })
    .catch((err) => {
      console.error('[autoBot] tick error:', err);
      setTimeout(scheduleNextTick, INTERVAL_MS);
    });
}

/**
 * Trigger a one-off manual mock cycle: force countdown to 30s for all symbols so entry/exit logic runs.
 * Resets isManualMockActive when mock cycle end time has passed (settlement time + exit buffer).
 */
export function triggerManualMock(): void {
  const now = Date.now();
  isManualMockActive = true;
  manualMockFundingTimeMs = now + MANUAL_MOCK_COUNTDOWN_MS;
  manualMockEndMs = manualMockFundingTimeMs + MANUAL_MOCK_EXIT_BUFFER_MS;
  console.log('[autoBot] Manual mock triggered: 30s countdown, will reset after cycle end.');
}

/**
 * Cancel manual mock: reset to normal sync. No settlement event will fire; any open mock position stays until next real settlement or manual exit.
 */
export function cancelManualMock(): void {
  isManualMockActive = false;
  manualMockFundingTimeMs = null;
  manualMockEndMs = null;
  console.log('[autoBot] Manual mock cancelled; returning to live sync.');
}

/** Returns minimum countdown in seconds across market data, or -1 if none. */
async function runTick(): Promise<number> {
  try {
    let marketData = await fundingScanner.getFundingData();
    const now = Date.now();

    if (process.env.TEST_MODE === 'true') {
      if (mockFundingTimeMs === null || now >= mockFundingTimeMs) {
        mockFundingTimeMs = now + 30_000;
        console.log('[TEST MODE] Mocking funding time to 30s for testing.');
      }
      const countdownMs = Math.max(0, mockFundingTimeMs - now);
      const nextFundingTime = String(mockFundingTimeMs);
      marketData = marketData.map((m) => ({ ...m, nextFundingTime, countdownMs }));
    } else if (isManualMockActive) {
      if (manualMockFundingTimeMs == null || manualMockEndMs == null) {
        isManualMockActive = false;
        manualMockFundingTimeMs = null;
        manualMockEndMs = null;
        console.log('[autoBot] Manual mock state cleared (missing times); resuming live sync.');
      } else if (now >= manualMockEndMs) {
        isManualMockActive = false;
        manualMockFundingTimeMs = null;
        manualMockEndMs = null;
        console.log('[autoBot] Manual mock cycle finished; resuming real-time sync.');
      } else {
        const countdownMs = Math.max(0, manualMockFundingTimeMs - now);
        const nextFundingTime = String(manualMockFundingTimeMs);
        marketData = marketData.map((m) => ({ ...m, nextFundingTime, countdownMs }));
      }
    }

    const minCountdownSec =
      marketData.length > 0
        ? Math.min(...marketData.map((m) => Math.floor(m.countdownMs / 1000)))
        : -1;

    const isCritical = minCountdownSec >= 0 && minCountdownSec <= CRITICAL_COUNTDOWN_SEC;
    let userIds: number[];
    try {
      userIds = isCritical && entryUserIdsCache.length > 0
        ? entryUserIdsCache
        : await getUsersWithAutoEntryEnabled();
    } catch (e) {
      console.error('[autoBot] getUsersWithAutoEntryEnabled failed:', e);
      return minCountdownSec >= 0 ? minCountdownSec : -1;
    }
    if (!isCritical) entryUserIdsCache = userIds;
    if (userIds.length === 0) return minCountdownSec;

    for (const userId of userIds) {
      try {
        if (isCritical) {
          await processUserCritical(userId, marketData, now);
        } else {
          await processUser(userId, marketData, now);
        }
      } catch (err) {
        console.error(`[autoBot] User ${userId} error:`, err);
      }
    }
    return minCountdownSec;
  } catch (error) {
    console.error('[autoBot] CRITICAL LOOP ERROR:', error);
    return -1;
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

        const exitThresholdMs = settings.exitTimeMs ?? 0;

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

          // Depth-based PnL: Long = value at bidPrice (sell to close), Short = value at askPrice (buy to close)
          let bidPrice = 0;
          let askPrice = 0;
          try {
            const ob = await getOrderBookDepth(apiKey, apiSecret, pos.symbol, settings.orderBookDepth ?? 2);
            bidPrice = ob.bidPrice;
            askPrice = ob.askPrice;
          } catch (e) {
            console.error(`[autoBot] getOrderBookDepth failed ${pos.symbol}:`, e);
            continue;
          }
          // Fallback so exit price is never 0: markPrice then avgPrice
          const fallbackPrice = parseFloat(pos.markPrice ?? '') || entry;
          const bidPriceSafe = (Number.isFinite(bidPrice) && bidPrice > 0) ? bidPrice : fallbackPrice;
          const askPriceSafe = (Number.isFinite(askPrice) && askPrice > 0) ? askPrice : fallbackPrice;
          const currentPrice = pos.side === 'Buy' ? bidPriceSafe : askPriceSafe;
          const pnlPct = entry <= 0 || !Number.isFinite(currentPrice) ? 0 : (pos.side === 'Buy' ? (currentPrice - entry) / entry : (entry - currentPrice) / entry) * 100;
          const pnl = !Number.isFinite(currentPrice) ? 0 : pos.side === 'Buy' ? (currentPrice - entry) * qty : (entry - currentPrice) * qty;
          // Maker fee estimate (0.02%) when Bybit returns 0
          const estimatedMakerFee = 0.0002 * qty * currentPrice;

          // Exit price never 0: use depth price or fallback (markPrice / avgPrice)
          const exitPrice = pos.side === 'Buy' ? bidPriceSafe : askPriceSafe;

          const hedgeGroup = await getHedgeGroupByPosition(userId, pos.symbol, pos.side);

          // Hedged position: live orderbook depth PnL, target/stoploss (dollar), timeout
          if (hedgeGroup != null) {
            const settlementTimeMs = fundingTimeMs ?? 0;
            if (settlementTimeMs === 0 || now < settlementTimeMs) continue;

            let fundingAmountReceived = hedgeGroup.fundingAmountReceived;
            if (fundingAmountReceived == null) {
              const rate = lockedFundingRates[pos.symbol] ?? Math.abs(fundingRate);
              fundingAmountReceived = (qty * entry) * rate;
              await setFundingReceived(hedgeGroup.hedgeGroupId, fundingAmountReceived);
            }

            const depthRow = Math.max(1, Math.min(50, settings.hedgePnlDepth ?? 1));
            const [orderbookLinear, orderbookSpot] = await Promise.all([
              getOrderbook(pos.symbol, 50, 'linear'),
              getSpotOrderbook(pos.symbol, 50),
            ]);
            const currentDepthPriceFutures = getDepthPrice(orderbookLinear, pos.side, depthRow);
            const spotSide: 'Buy' | 'Sell' = pos.side === 'Buy' ? 'Sell' : 'Buy';
            const currentDepthPriceSpot = getDepthPrice(orderbookSpot, spotSide, depthRow);

            const futuresPnl = calculateUnrealizedPnLByDepth(pos, currentDepthPriceFutures);
            const spotPositionLike = {
              side: spotSide,
              avgPrice: String(hedgeGroup.spotEntryPrice),
              size: String(hedgeGroup.spotQty),
            };
            const spotPnl = calculateUnrealizedPnLByDepth(spotPositionLike, currentDepthPriceSpot);
            const avgDepthPrice = (currentDepthPriceFutures + currentDepthPriceSpot) / 2 || currentDepthPriceFutures;
            const estimatedExitFees = 2 * 0.0002 * qty * avgDepthPrice;
            const combinedPnl = futuresPnl + spotPnl + fundingAmountReceived - estimatedExitFees;

            const totalMargin = qty * entry;
            const hedgeTargetPct = settings.hedgeTargetPct ?? 2;
            const hedgeStoplossPct = settings.hedgeStoplossPct ?? 5;
            const targetDollar = hedgeTargetPct === 0
              ? fundingAmountReceived
              : (totalMargin * hedgeTargetPct) / 100;
            const stoplossDollar = -(totalMargin * hedgeStoplossPct) / 100;

            let shouldExit = false;
            let exitReason: 'Time Exit' | 'Stoploss Hit' = 'Time Exit';
            if (combinedPnl >= targetDollar) {
              shouldExit = true;
              console.log(`[autoBot] Hedged exit: Target | ${pos.symbol} Combined PnL=${combinedPnl.toFixed(4)} >= targetDollar=${targetDollar.toFixed(4)}`);
            } else if (combinedPnl <= stoplossDollar) {
              shouldExit = true;
              exitReason = 'Stoploss Hit';
              console.log(`[autoBot] Hedged exit: Stoploss | ${pos.symbol} Combined PnL=${combinedPnl.toFixed(4)} <= stoplossDollar=${stoplossDollar.toFixed(4)}`);
            }
            if (!shouldExit) {
              const bannedList = await getBannedTokens(userId);
              const minFunding = settings.minFundingRate ?? 0;
              const maxTrades = settings.maxTrades ?? 1;
              const queue = marketData
                .filter((m) => Math.abs(m.fundingRate) >= minFunding && !bannedList.includes(m.symbol))
                .sort((a, b) => (a.fundingIntervalHours ?? 0) - (b.fundingIntervalHours ?? 0) || Math.abs(b.fundingRate) - Math.abs(a.fundingRate));
              const topTokens = queue.slice(0, maxTrades);
              const nextFundingTimeMs = topTokens.length > 0
                ? Math.min(...topTokens.map((t) => parseInt(t.nextFundingTime, 10) || 0))
                : 0;
              const timeoutThresholdMs = nextFundingTimeMs - 10 * 60 * 1000;
              if (nextFundingTimeMs > 0 && now >= timeoutThresholdMs) {
                shouldExit = true;
                console.log(`[autoBot] Hedged exit: Timeout (next funding in <10m) | ${pos.symbol}`);
              }
            }
            if (shouldExit) {
              try {
                const finalFundingRate = lockedFundingRates[pos.symbol] ?? Math.abs(fundingRate);
                const fundingReceived = (qty * entry) * finalFundingRate;
                const [orderIds] = await Promise.all([
                  exitPositionWithIocSweep(apiKey, apiSecret, pos.symbol, pos.side, qty),
                  exitSpotWithIocSweep(apiKey, apiSecret, pos.symbol, pos.side, qty),
                ]);
                positionFundingTime.delete(key);
                if (orderIds.length > 0) {
                  await saveClosedTradeAfterExit(userId, apiKey, apiSecret, pos.symbol, pos.side, entry, qty, orderIds, exitReason, fundingReceived, currentDepthPriceFutures, estimatedMakerFee);
                }
                await deleteHedgeGroup(hedgeGroup.hedgeGroupId);
                delete lockedFundingRates[pos.symbol];
              } catch (e) {
                console.error(`[autoBot] Hedged exit failed ${pos.symbol}:`, e);
              }
            }
            continue;
          }

          // Stoploss takes priority over time-based exit. Check pre-funding then post-funding stoploss first.
          if (isPreFunding && settings.slPreFundingEnabled) {
            const slThresholdPct = Math.abs(fundingRate) * 100 * (settings.slPreMultiplier ?? 1);
            if (pnlPct <= -slThresholdPct) {
              try {
                let orderIds: string[];
                if (settings.spotHedgingEnabled) {
                  [orderIds] = await Promise.all([
                    exitPositionWithIocSweep(apiKey, apiSecret, pos.symbol, pos.side, qty),
                    exitSpotWithIocSweep(apiKey, apiSecret, pos.symbol, pos.side, qty),
                  ]);
                } else {
                  orderIds = await exitPositionWithIocSweep(apiKey, apiSecret, pos.symbol, pos.side, qty);
                }
                positionFundingTime.delete(key);
                if (orderIds.length > 0) {
                  await saveClosedTradeAfterExit(userId, apiKey, apiSecret, pos.symbol, pos.side, entry, qty, orderIds, 'Pre-Funding Stoploss', 0, exitPrice, estimatedMakerFee);
                }
                delete lockedFundingRates[pos.symbol];
                console.log(`[autoBot] Exit Triggered: Pre-Funding Stoploss | PnL: ${pnl.toFixed(4)}`);
              } catch (e) {
                console.error(`[autoBot] Pre-funding stoploss exit failed ${pos.symbol}:`, e);
              }
              continue;
            }
          }

          // Post-Funding Stoploss removed for naked trades: only Time-Based Exit after funding (WebSocket + exitTimeMs or timer fallback).

          // Time-based Auto Exit (after funding time)
          if (settings.autoExitEnabled && exitThresholdMs > 0 && fundingTimeMs != null && now >= fundingTimeMs + exitThresholdMs) {
            try {
              const finalFundingRate = lockedFundingRates[pos.symbol] ?? Math.abs(fundingRate);
              const fundingReceived = (qty * entry) * finalFundingRate;
              let orderIds: string[];
              if (settings.spotHedgingEnabled) {
                [orderIds] = await Promise.all([
                  exitPositionWithIocSweep(apiKey, apiSecret, pos.symbol, pos.side, qty),
                  exitSpotWithIocSweep(apiKey, apiSecret, pos.symbol, pos.side, qty),
                ]);
              } else {
                orderIds = await exitPositionWithIocSweep(apiKey, apiSecret, pos.symbol, pos.side, qty);
              }
              positionFundingTime.delete(key);
              if (orderIds.length > 0) {
                await saveClosedTradeAfterExit(userId, apiKey, apiSecret, pos.symbol, pos.side, entry, qty, orderIds, 'Time Exit', fundingReceived, exitPrice, estimatedMakerFee);
              }
              delete lockedFundingRates[pos.symbol];
              console.log(`[autoBot] Exit Triggered: Time (funding+exit) | PnL: ${pnl.toFixed(4)}`);
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

/**
 * Critical path when countdown <= 15s: no DB, no getWalletBalance, no getInstrumentDetails, no getPositionList.
 * IOC limit orderbook sweep for entry. Uses entryPrepCacheByUser and walletCacheByUser.
 */
async function processUserCritical(
  userId: number,
  marketData: Array<{ symbol: string; fundingRate: number; nextFundingTime: string; countdownMs: number }>,
  now: number
): Promise<void> {
  const prep = entryPrepCacheByUser.get(userId);
  if (!prep || prep.candidates.length === 0) return;
  if (prep.positionsCount >= prep.maxTrades) return;

  const entryTimeSec = prep.settings.entryTimeSec ?? 300;
  const marketBySymbol = new Map(marketData.map((m) => [m.symbol, m]));

  for (const c of prep.candidates) {
    const token = marketBySymbol.get(c.symbol);
    if (!token) continue;

    const countdownSec = Math.floor(token.countdownMs / 1000);
    const inWindow = countdownSec <= entryTimeSec && countdownSec > entryTimeSec - 10;
    if (!inWindow) continue;

    const procKey = processedKey(userId, c.symbol, c.nextFundingTime);
    if (processedTokens.has(procKey)) continue;
    const cycleKey = entryCycleKey(userId, c.symbol, c.nextFundingTime);
    if (enteredThisCycle.has(cycleKey)) continue;

    let entryPrice: number;
    try {
      const obDepth = await getOrderBookDepth(prep.apiKey, prep.apiSecret, c.symbol, prep.settings.orderBookDepth ?? 2);
      entryPrice = c.side === 'Buy' ? obDepth.askPrice : obDepth.bidPrice;
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;
    } catch {
      continue;
    }

    const finalMargin = Math.min(prep.tradeMargin, prep.cachedAvailableMargin);
    const rawQty = (finalMargin * c.safeLeverage) / entryPrice;
    if (rawQty <= 0) continue;

    const step = c.qtyStep;
    const minQty = c.minOrderQty;
    const maxQty = c.maxOrderQty;
    const stepStr = step.toString();
    const stepDecimals = stepStr.includes('.') ? stepStr.split('.')[1]!.length : 0;
    let finalQty = parseFloat((Math.floor(rawQty / step) * step).toFixed(stepDecimals));
    if (finalQty > maxQty) finalQty = parseFloat((Math.floor(maxQty / step) * step).toFixed(stepDecimals));
    if (finalQty < minQty) continue;

    processedTokens.add(procKey);
    enteredThisCycle.add(cycleKey);

    try {
      let remainingQty = finalQty;
      let retries = 0;
      const tickSize = c.tickSize ?? '0.01';

      while (remainingQty > 0 && retries < MAX_IOC_RETRIES) {
        try {
          const orderbook = await getOrderbook(c.symbol, ORDERBOOK_SWEEP_LIMIT);
          const sweepPrice = getSweepPrice(orderbook, c.side, remainingQty);
          if (!Number.isFinite(sweepPrice) || sweepPrice <= 0) break;
          const priceStr = formatPriceToTick(sweepPrice, tickSize);
          const qtyStr = formatQtyToStep(remainingQty, String(c.qtyStep));
          if (parseFloat(qtyStr) <= 0) break;

          const { orderId } = await placeLimitOrder(prep.apiKey, prep.apiSecret, c.symbol, c.side, qtyStr, priceStr, 'IOC');
          await new Promise((r) => setTimeout(r, IOC_RETRY_DELAY_MS));
          const executions = await getExecutionList(prep.apiKey, prep.apiSecret, 'linear', orderId);
          const filledQty = executions.reduce((s, e) => s + (parseFloat(e.execQty) || 0), 0);
          remainingQty -= filledQty;
          if (remainingQty <= 0) break;
        } catch (e) {
          console.error(`[autoBot] processUserCritical ${c.symbol} orderbook/order/execution failed:`, e);
        }
        retries++;
        await new Promise((r) => setTimeout(r, IOC_RETRY_DELAY_MS));
      }

      const nextFundingMs = parseInt(c.nextFundingTime, 10) || 0;
      positionFundingTime.set(positionKey(userId, c.symbol, c.side), nextFundingMs);
    } catch {
      /* ignore */
    }
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
  const globalMinCountdownSec =
    marketData.length > 0 ? Math.min(...marketData.map((m) => Math.floor(m.countdownMs / 1000))) : 9999;
  const debugSkip = globalMinCountdownSec <= 15;

  let settings: Awaited<ReturnType<typeof getSettings>>;
  try {
    settings = await getSettings(userId);
  } catch (e) {
    console.error('[autoBot] getSettings failed for user', userId, e);
    return;
  }
  if (!settings.autoEntryEnabled) {
    if (debugSkip) console.log('[DEBUG] Trade Skipped Reason: autoEntryEnabled is false');
    return;
  }

  let keys: Awaited<ReturnType<typeof getExchangeKeys>>;
  try {
    keys = await getExchangeKeys(userId, 'Bybit');
  } catch (e) {
    console.error('[autoBot] getExchangeKeys failed for user', userId, e);
    return;
  }
  if (!keys) {
    if (debugSkip) console.log('[DEBUG] Trade Skipped Reason: No Bybit exchange keys');
    return;
  }
  const apiKey = decrypt(keys.api_key);
  const apiSecret = decrypt(keys.api_secret);

  let positions: Awaited<ReturnType<typeof getPositionList>>;
  try {
    positions = await getPositionList(apiKey, apiSecret, { category: 'linear', settleCoin: 'USDT' });
  } catch (e) {
    console.error('[autoBot] getPositionList failed for user', userId, e);
    return;
  }
  const maxTrades = settings.maxTrades ?? 1;
  if (positions.length >= maxTrades) {
    if (debugSkip) console.log('[DEBUG] Trade Skipped Reason: Max concurrent positions reached', 'positions:', positions.length, 'maxTrades:', maxTrades);
    return;
  }

  // Auto Exit is handled by monitorExits (1s loop) with reduce-only orders and unified logging.

  // Auto Entry: filter by min funding rate, exclude banned tokens, Smart Sort, then top N
  const minFundingRate = settings.minFundingRate ?? 0;
  let meetsMinFunding = marketData.filter(
    (token) => Math.abs(token.fundingRate) >= minFundingRate
  );
  let bannedSet: Set<string>;
  try {
    bannedSet = new Set(await getBannedTokens(userId));
  } catch (e) {
    console.error('[autoBot] getBannedTokens failed for user', userId, e);
    bannedSet = new Set();
  }
  meetsMinFunding = meetsMinFunding.filter((token) => !bannedSet.has(token.symbol));
  if (meetsMinFunding.length === 0) {
    const pct = (minFundingRate * 100).toFixed(4);
    if (debugSkip) console.log('[DEBUG] Trade Skipped Reason: No tokens meet Min Funding or all banned', 'minFundingRate%:', pct);
    console.log(`[autoBot] No tokens meet Min Funding criteria (>= ${pct}%) or all are banned`);
    return;
  }

  const sorted = [...meetsMinFunding].sort((a, b) => {
    const intervalA = a.fundingIntervalHours ?? 0;
    const intervalB = b.fundingIntervalHours ?? 0;
    if (intervalA !== intervalB) return intervalA - intervalB;
    return Math.abs(b.fundingRate) - Math.abs(a.fundingRate);
  });
  const candidates = sorted.slice(0, maxTrades);
  if (candidates.length === 0) {
    if (debugSkip) console.log('[DEBUG] Trade Skipped Reason: No candidates after sort/slice');
    return;
  }

  const entryTimeSec = settings.entryTimeSec ?? 300;
  const minCountdownSec =
    Math.min(...candidates.map((c) => Math.floor(c.countdownMs / 1000))) ?? 9999;
  const inEntryWindow = minCountdownSec <= entryTimeSec && minCountdownSec > entryTimeSec - 10;
  const inPrefetchWindow = minCountdownSec >= WALLET_PREFETCH_MIN_SEC && minCountdownSec <= WALLET_PREFETCH_MAX_SEC;

  // Pre-fetch wallet when countdown 20–60s; never call getWalletBalance when countdown <= 15 (critical path uses cache only)
  if (inPrefetchWindow) {
    try {
      const wallet = await getWalletBalance(apiKey, apiSecret);
      walletCacheByUser.set(userId, {
        totalEquity: parseFloat(wallet.totalEquity) || 0,
        totalAvailableBalance: parseFloat(wallet.totalAvailableBalance) || 0,
      });
    } catch (e) {
      console.error('[autoBot] getWalletBalance (prefetch) failed:', e);
    }
  }

  let totalWalletBalance = 0;
  let tradeMargin = 0;
  let cachedAvailableMargin = 0;
  if (inEntryWindow) {
    const cache = walletCacheByUser.get(userId);
    if (cache) {
      totalWalletBalance = cache.totalEquity;
      cachedAvailableMargin = cache.totalAvailableBalance;
      tradeMargin = totalWalletBalance * ((settings.capitalPercent ?? 0) / 100);
    } else {
      if (debugSkip) console.log('[DEBUG] Trade Skipped Reason: Entry window but no wallet cache (critical path)');
      console.warn('[autoBot] Entry window but no wallet cache; skip to avoid getWalletBalance in critical path');
      return;
    }
  } else {
    try {
      const wallet = await getWalletBalance(apiKey, apiSecret);
      totalWalletBalance = parseFloat(wallet.totalEquity) || 0;
      cachedAvailableMargin = parseFloat(wallet.totalAvailableBalance) || 0;
      tradeMargin = totalWalletBalance * ((settings.capitalPercent ?? 0) / 100);
      walletCacheByUser.set(userId, { totalEquity: totalWalletBalance, totalAvailableBalance: cachedAvailableMargin });
    } catch (e) {
      if (debugSkip) console.log('[DEBUG] Trade Skipped Reason: getWalletBalance failed');
      console.error('[autoBot] getWalletBalance failed:', e);
      return;
    }
  }

  const prepCandidates: EntryPrepCandidate[] = [];
  await Promise.all(
    candidates.map(async (topToken) => {
      if (inPrefetchWindow) {
        try {
          const userLeverage = settings.leverage ?? 5;
          const spotHedgingEnabled = Boolean(settings.spotHedgingEnabled);
          // CRITICAL: Do NOT call getInstrumentsInfo({ category: 'spot' }) — the spot API hangs.
          const spotLeverage = 5;
          let futuresMaxLeverage = userLeverage;
          try {
            const details = await getInstrumentDetails(topToken.symbol);
            futuresMaxLeverage = parseFloat(details.maxLeverage) || userLeverage;
          } catch {
            /* use user leverage as fallback */
          }
          const futuresLeverage = Math.min(settings.leverage || 10, futuresMaxLeverage);
          try {
            await setLeverage(apiKey, apiSecret, topToken.symbol, futuresLeverage);
          } catch {
            /* ignore */
          }
          const side: 'Buy' | 'Sell' = topToken.fundingRate < 0 ? 'Buy' : 'Sell';
          let qtyStep = 0.1;
          let minOrderQty = 0;
          let maxOrderQty = 999999;
          let tickSize = '0.01';
          try {
            const ls = await getInstrumentLotSize(apiKey, apiSecret, topToken.symbol);
            qtyStep = parseFloat(ls.qtyStep) || 0.1;
            minOrderQty = parseFloat(ls.minOrderQty) || 0;
            maxOrderQty = parseFloat(ls.maxMktOrderQty || ls.maxOrderQty) || 999999;
            tickSize = ls.tickSize ?? '0.01';
          } catch {
            /* ignore */
          }
          prepCandidates.push({
            symbol: topToken.symbol,
            nextFundingTime: topToken.nextFundingTime,
            fundingRate: topToken.fundingRate,
            side,
            safeLeverage: futuresLeverage,
            qtyStep,
            minOrderQty,
            maxOrderQty,
            tickSize,
          });
        } catch (err) {
          console.error('Prep Error:', err);
        }
        return;
      }

      const countdownSec = Math.floor(topToken.countdownMs / 1000);
      const debugSkipToken = countdownSec <= 15;

      const activePositions = await getPositionList(apiKey, apiSecret, { category: 'linear', settleCoin: 'USDT' });
      if (activePositions.length >= maxTrades) {
        if (debugSkipToken) console.log('[DEBUG] Trade Skipped Reason: Active positions at max', 'symbol:', topToken.symbol, 'positions:', activePositions.length, 'maxTrades:', maxTrades);
        return;
      }

      const procKey = processedKey(userId, topToken.symbol, topToken.nextFundingTime);
      if (processedTokens.has(procKey)) {
        if (debugSkipToken) console.log('[DEBUG] Trade Skipped Reason: Already processed this cycle', 'symbol:', topToken.symbol);
        return;
      }

      console.log(`[autoBot] ${topToken.symbol} - Countdown: ${countdownSec}s | Base Capital: $${totalWalletBalance.toFixed(2)} | Target Margin: $${tradeMargin.toFixed(2)}`);

      const cycleKey = entryCycleKey(userId, topToken.symbol, topToken.nextFundingTime);
      if (enteredThisCycle.has(cycleKey)) {
        if (debugSkipToken) console.log('[DEBUG] Trade Skipped Reason: Already entered this cycle', 'symbol:', topToken.symbol);
        return;
      }

      const inWindow = countdownSec <= entryTimeSec && countdownSec > entryTimeSec - 10;
      if (!inWindow) {
        if (debugSkipToken) console.log('[DEBUG] Trade Skipped Reason: Countdown not in entry window', 'symbol:', topToken.symbol, 'countdown:', countdownSec, 'window:', entryTimeSec - 10, '-', entryTimeSec);
        return;
      }

      console.log(`[autoBot] ${topToken.symbol} - Entry Attempt (countdown ${countdownSec}s in window)`);

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
      console.log(`[autoBot] ${topToken.symbol} - Leverage adjusted to ${safeLeverage} (User: ${userLeverage}, Max: ${maxLeverageStr})`);

      try {
        await setLeverage(apiKey, apiSecret, topToken.symbol, safeLeverage);
      } catch (levErr: unknown) {
        const msg = (levErr as { message?: string })?.message ?? String(levErr);
        if (!/leverage\s*not\s*modified/i.test(msg)) throw levErr;
      }

      const side = topToken.fundingRate < 0 ? 'Buy' : 'Sell';

      let entryPrice: number;
      try {
        const ob = await getOrderBookDepth(apiKey, apiSecret, topToken.symbol, settings.orderBookDepth ?? 2);
        entryPrice = side === 'Buy' ? ob.askPrice : ob.bidPrice;
        if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
          if (debugSkipToken) console.log('[DEBUG] Trade Skipped Reason: Order book price invalid', 'symbol:', topToken.symbol, 'entryPrice:', entryPrice);
          console.warn(`[autoBot] ${topToken.symbol} - Order book price invalid, skipping entry`);
          return;
        }
      } catch (e) {
        if (debugSkipToken) console.log('[DEBUG] Trade Skipped Reason: getOrderBookDepth failed', 'symbol:', topToken.symbol);
        console.error(`[autoBot] ${topToken.symbol} - getOrderBookDepth failed:`, e);
        return;
      }

      // Use cached available margin in entry window to avoid API latency; otherwise already set at processUser start
      const finalMargin = Math.min(tradeMargin, cachedAvailableMargin);
      const rawQty = (finalMargin * safeLeverage) / entryPrice;
      if (rawQty <= 0) {
        if (debugSkipToken) console.log('[DEBUG] Trade Skipped Reason: rawQty <= 0 (insufficient margin or invalid price)', 'symbol:', topToken.symbol, 'rawQty:', rawQty);
        return;
      }

      const positionsBeforeOrder = await getPositionList(apiKey, apiSecret, { category: 'linear', settleCoin: 'USDT' });
      if (positionsBeforeOrder.length >= maxTrades) {
        if (debugSkipToken) console.log('[DEBUG] Trade Skipped Reason: Positions at max before order', 'symbol:', topToken.symbol, 'positions:', positionsBeforeOrder.length, 'maxTrades:', maxTrades);
        return;
      }

      const actualLeverage = safeLeverage;

      let finalQty: number;
      let tickSize = '0.01';
      let qtyStepStr = '0.1';
      const spotHedgingEnabled = Boolean(settings.spotHedgingEnabled);

      if (spotHedgingEnabled) {
        // Spot hedging: margin split. CRITICAL: no getInstrumentsInfo({ category: 'spot' }) — it hangs.
        const spotLeverage = 5;
        const futuresLeverage = actualLeverage;
        const targetMargin = finalMargin;
        const totalPositionValue = targetMargin * (futuresLeverage * spotLeverage) / (futuresLeverage + spotLeverage);
        const spotMarginUsed = totalPositionValue / spotLeverage;
        const futuresMarginUsed = totalPositionValue / futuresLeverage;
        const currentPrice = entryPrice;
        const baseQty = totalPositionValue / currentPrice;
        if (baseQty <= 0) {
          if (debugSkipToken) console.log('[DEBUG] Trade Skipped Reason: spot baseQty <= 0', 'symbol:', topToken.symbol);
          return;
        }
        try {
          const ls = await getInstrumentLotSize(apiKey, apiSecret, topToken.symbol);
          tickSize = ls.tickSize ?? '0.01';
          qtyStepStr = ls.qtyStep;
          const stepLinear = parseFloat(ls.qtyStep) || 0.1;
          const stepSpot = 0.1;
          const minQtyLinear = parseFloat(ls.minOrderQty) || 0;
          const minQtySpot = 0;
          const maxQtyLinear = parseFloat(ls.maxMktOrderQty || ls.maxOrderQty) || 999999;
          const maxQtySpot = maxQtyLinear;
          const minQty = Math.max(minQtyLinear, minQtySpot);
          const maxQty = Math.min(maxQtyLinear, maxQtySpot);
          const stepDecimalsL = stepLinear.toString().includes('.') ? stepLinear.toString().split('.')[1]!.length : 0;
          const stepDecimalsS = 1;
          const roundedLinear = parseFloat((Math.floor(baseQty / stepLinear) * stepLinear).toFixed(stepDecimalsL));
          const roundedSpot = parseFloat((Math.floor(baseQty / stepSpot) * stepSpot).toFixed(stepDecimalsS));
          finalQty = Math.min(roundedLinear, roundedSpot);
          if (finalQty > maxQty) {
            const capLinear = parseFloat((Math.floor(maxQty / stepLinear) * stepLinear).toFixed(stepDecimalsL));
            const capSpot = parseFloat((Math.floor(maxQty / stepSpot) * stepSpot).toFixed(stepDecimalsS));
            const cap = Math.min(capLinear, capSpot);
            const cappedLinear = parseFloat((Math.floor(cap / stepLinear) * stepLinear).toFixed(stepDecimalsL));
            const cappedSpot = parseFloat((Math.floor(cap / stepSpot) * stepSpot).toFixed(stepDecimalsS));
            finalQty = Math.min(cappedLinear, cappedSpot);
            console.log(`[autoBot] ${topToken.symbol} - Spot hedge quantity capped to max: ${finalQty}`);
          }
          if (finalQty < minQty) {
            if (debugSkipToken) console.log('[DEBUG] Trade Skipped Reason: spot-hedge finalQty below min', 'symbol:', topToken.symbol, 'finalQty:', finalQty, 'minQty:', minQty);
            console.warn(`[autoBot] ${topToken.symbol} - Spot hedge finalQty ${finalQty} < min ${minQty}, skipping`);
            return;
          }
          console.log(`[autoBot] ${topToken.symbol} - Spot hedge: totalPositionValue=$${totalPositionValue.toFixed(2)} spotMargin=$${spotMarginUsed.toFixed(2)} futuresMargin=$${futuresMarginUsed.toFixed(2)} baseQty=${baseQty} finalQty=${finalQty}`);
        } catch (e) {
          if (debugSkipToken) console.log('[DEBUG] Trade Skipped Reason: Instrument lot size failed', 'symbol:', topToken.symbol);
          console.error(`[autoBot] ${topToken.symbol} - Instrument info failed:`, e);
          return;
        }
      } else {
        try {
          const ls = await getInstrumentLotSize(apiKey, apiSecret, topToken.symbol);
          const { qtyStep, minOrderQty, maxOrderQty, maxMktOrderQty } = ls;
          tickSize = ls.tickSize ?? '0.01';
          qtyStepStr = qtyStep;
          const step = parseFloat(qtyStep) || 0.1;
          const minQty = parseFloat(minOrderQty) || 0;
          const maxQty = parseFloat(maxMktOrderQty || maxOrderQty) || 999999;
          const stepStr = step.toString();
          const stepDecimals = stepStr.includes('.') ? stepStr.split('.')[1].length : 0;
          finalQty = parseFloat((Math.floor(rawQty / step) * step).toFixed(stepDecimals));
          if (finalQty > maxQty) {
            finalQty = parseFloat((Math.floor(maxQty / step) * step).toFixed(stepDecimals));
            console.log(`[autoBot] ${topToken.symbol} - Quantity capped to Bybit max limit: ${finalQty}`);
          }
          if (finalQty < minQty) {
            if (debugSkipToken) console.log('[DEBUG] Trade Skipped Reason: finalQty below minOrderQty', 'symbol:', topToken.symbol, 'finalQty:', finalQty, 'minOrderQty:', minQty);
            console.warn(`[autoBot] ${topToken.symbol} - finalQty ${finalQty} < minOrderQty ${minQty}, skipping`);
            return;
          }
          console.log(`[autoBot] ${topToken.symbol} - Precision: Raw=${rawQty} Final=${finalQty}`);
        } catch (e) {
          if (debugSkipToken) console.log('[DEBUG] Trade Skipped Reason: Instrument lot size failed', 'symbol:', topToken.symbol);
          console.error(`[autoBot] ${topToken.symbol} - Instrument info failed:`, e);
          return;
        }
      }

      processedTokens.add(procKey);
      enteredThisCycle.add(cycleKey);

      try {
        if (spotHedgingEnabled) {
          // Funding < 0: Futures LONG (Buy), Spot SHORT (Sell). Funding > 0: Futures SHORT (Sell), Spot LONG (Buy).
          const futuresSide: 'Buy' | 'Sell' = topToken.fundingRate < 0 ? 'Buy' : 'Sell';
          const spotSide: 'Buy' | 'Sell' = topToken.fundingRate < 0 ? 'Sell' : 'Buy';
          let remainingQty = finalQty;
          let retries = 0;
          while (remainingQty > 0 && retries < MAX_IOC_RETRIES) {
            try {
              const [orderbookLinear, orderbookSpot] = await Promise.all([
                getOrderbook(topToken.symbol, ORDERBOOK_SWEEP_LIMIT, 'linear'),
                getSpotOrderbook(topToken.symbol, ORDERBOOK_SWEEP_LIMIT),
              ]);
              const sweepPriceLinear = getSweepPrice(orderbookLinear, futuresSide, remainingQty);
              const sweepPriceSpot = getSweepPrice(orderbookSpot, spotSide, remainingQty);
              if (!Number.isFinite(sweepPriceLinear) || sweepPriceLinear <= 0 || !Number.isFinite(sweepPriceSpot) || sweepPriceSpot <= 0) break;
              const priceStrLinear = formatPriceToTick(sweepPriceLinear, tickSize);
              const priceStrSpot = formatPriceToTick(sweepPriceSpot, tickSize);
              const qtyStr = formatQtyToStep(remainingQty, qtyStepStr);
              if (parseFloat(qtyStr) <= 0) break;
              const [futuresRes, spotRes] = await Promise.all([
                placeLimitOrder(apiKey, apiSecret, topToken.symbol, futuresSide, qtyStr, priceStrLinear, 'IOC'),
                placeSpotMarginOrder(apiKey, apiSecret, topToken.symbol, spotSide, 'Limit', qtyStr, priceStrSpot, 'IOC'),
              ]);
              await new Promise((r) => setTimeout(r, IOC_RETRY_DELAY_MS));
              const [execLinear, execSpot] = await Promise.all([
                getExecutionList(apiKey, apiSecret, 'linear', futuresRes.orderId),
                getExecutionList(apiKey, apiSecret, 'spot', spotRes.orderId),
              ]);
              const filledLinear = execLinear.reduce((s, e) => s + (parseFloat(e.execQty) || 0), 0);
              const filledSpot = execSpot.reduce((s, e) => s + (parseFloat(e.execQty) || 0), 0);
              const filledBoth = Math.min(filledLinear, filledSpot);
              remainingQty -= filledBoth;
              if (remainingQty <= 0) break;
            } catch (e) {
              console.error(`[autoBot] ${topToken.symbol} spot-hedge orderbook/order/execution failed:`, e);
            }
            retries++;
            await new Promise((r) => setTimeout(r, IOC_RETRY_DELAY_MS));
          }
          const nextFundingMs = parseInt(topToken.nextFundingTime, 10) || 0;
          positionFundingTime.set(positionKey(userId, topToken.symbol, side), nextFundingMs);
          try {
            await createHedgeGroup(userId, topToken.symbol, futuresSide, finalQty, entryPrice);
          } catch (e) {
            console.error(`[autoBot] ${topToken.symbol} - createHedgeGroup failed:`, e);
          }
        } else {
          let remainingQty = finalQty;
          let retries = 0;
          while (remainingQty > 0 && retries < MAX_IOC_RETRIES) {
            try {
              const orderbook = await getOrderbook(topToken.symbol, ORDERBOOK_SWEEP_LIMIT);
              const sweepPrice = getSweepPrice(orderbook, side, remainingQty);
              if (!Number.isFinite(sweepPrice) || sweepPrice <= 0) break;
              const priceStr = formatPriceToTick(sweepPrice, tickSize);
              const qtyStr = formatQtyToStep(remainingQty, qtyStepStr);
              if (parseFloat(qtyStr) <= 0) break;
              console.log('[DEBUG PAYLOAD]', { symbol: topToken.symbol, side, orderType: 'Limit', timeInForce: 'IOC', qty: qtyStr, price: priceStr });
              const response = await placeLimitOrder(apiKey, apiSecret, topToken.symbol, side, qtyStr, priceStr, 'IOC');
              console.log('[DEBUG SUCCESS] Order Placed:', response);
              await new Promise((r) => setTimeout(r, IOC_RETRY_DELAY_MS));
              const executions = await getExecutionList(apiKey, apiSecret, 'linear', response.orderId);
              const filledQty = executions.reduce((s, e) => s + (parseFloat(e.execQty) || 0), 0);
              remainingQty -= filledQty;
              if (remainingQty <= 0) break;
            } catch (e) {
              console.error(`[autoBot] ${topToken.symbol} naked orderbook/order/execution failed:`, e);
            }
            retries++;
            await new Promise((r) => setTimeout(r, IOC_RETRY_DELAY_MS));
          }
          const nextFundingMs = parseInt(topToken.nextFundingTime, 10) || 0;
          positionFundingTime.set(positionKey(userId, topToken.symbol, side), nextFundingMs);
        }
        if (isManualMockActive) {
          setTimeout(() => {
            doExitAfterSettlement(userId, topToken.symbol).finally(() => {
              isManualMockActive = false;
              manualMockFundingTimeMs = null;
              manualMockEndMs = null;
              console.log('[autoBot] Mock exit completed; mock mode off.');
            });
          }, 2000);
        }
      } catch (e: unknown) {
        const err = e as { response?: { data?: unknown }; message?: string };
        console.error('[DEBUG ERROR] Order Failed:', err?.message ?? e, err?.response ?? '');
        console.error(`[autoBot] ${topToken.symbol} - EXACT BYBIT ERROR:`, err?.response?.data ?? err?.message ?? e);
        try {
          await addBannedToken(userId, topToken.symbol, 'Auto-banned: API Execution Error');
          console.log(`[autoBot] ${topToken.symbol} - Auto-banned (API Execution Error)`);
        } catch (banErr) {
          console.error(`[autoBot] ${topToken.symbol} - Failed to add banned token:`, banErr);
        }
      }
    }));

  if (inPrefetchWindow && prepCandidates.length > 0 && !settings.spotHedgingEnabled) {
    entryPrepCacheByUser.set(userId, {
      settings: { orderBookDepth: settings.orderBookDepth, capitalPercent: settings.capitalPercent, maxTrades, entryTimeSec },
      apiKey,
      apiSecret,
      totalWalletBalance,
      tradeMargin,
      cachedAvailableMargin,
      positionsCount: positions.length,
      maxTrades,
      candidates: prepCandidates,
    });
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
