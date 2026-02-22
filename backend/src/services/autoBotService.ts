import { getUsersWithAutoEntryEnabled, getSettings } from '../models/settingsModel.js';
import { getExchangeKeys, getSubAccountKeys } from '../models/exchangeModel.js';
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
  getOrderBookDepth,
  ORDERBOOK_DEPTH_BEST,
  getOrderbook,
  getSpotOrderbook,
  getSpotInstrumentLotSize,
  getSpotMarginSupport,
  placeSpotOrder,
  placeSpotMarginOrder,
  getActiveOrders,
  cancelAllOrders,
  getExecutionList,
  getClosedPnl,
  startExecutionStream,
  getDepthPrice,
  calculateUnrealizedPnLByDepth,
  warmupWsConnection,
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
import { insertTradeHistoryEntry } from '../models/tradeHistoryModel.js';

const INTERVAL_MS = 5_000;
const ENTRY_FAST_INTERVAL_MS = 500; // when countdown <= 15s (zero latency in final seconds)
const EXIT_INTERVAL_MS = 2_000; // Fallback if WebSocket settlement event doesn't fire

/** Prefetch window: fetch wallet when countdown 20–60s; never call getWalletBalance when countdown <= 15. */
const WALLET_PREFETCH_MIN_SEC = 20;
const WALLET_PREFETCH_MAX_SEC = 60;
const CRITICAL_COUNTDOWN_SEC = 15; // below this: use cache only, no DB/heavy API except orderbook + place order
/** Schedule precise entry timeout when we are this many ms before exact entry time (5–10s window). */
const ENTRY_SCHEDULE_MIN_MS = 5_000;
const ENTRY_SCHEDULE_MAX_MS = 10_000;

/** Cached wallet when countdown was 20–60s; used in entry window so we never call getWalletBalance when countdown <= 15. Sub-hedge: optional subEquity/subAvailableBalance for min(main,sub) sizing. */
const walletCacheByUser = new Map<number, { totalEquity: number; totalAvailableBalance: number; subEquity?: number; subAvailableBalance?: number }>();

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
  /** When subaccount hedging: precomputed Q so main and sub use same size. */
  fixedQty?: number;
}
interface EntryPrep {
  settings: { orderBookDepth?: number; capitalPercent?: number; maxTrades: number; entryOffsetMs: number; subEntryOffsetMs?: number; slippageBufferPct?: number };
  apiKey: string;
  apiSecret: string;
  totalWalletBalance: number;
  tradeMargin: number;
  cachedAvailableMargin: number;
  positionsCount: number;
  maxTrades: number;
  candidates: EntryPrepCandidate[];
  /** Subaccount hedging: sub credentials and offset for dual scheduled entry. */
  subApiKey?: string;
  subApiSecret?: string;
  subEntryOffsetMs?: number;
}
const entryPrepCacheByUser = new Map<number, EntryPrep>();
/** Cached user IDs with auto entry enabled; used when countdown <= 15 to avoid DB. */
let entryUserIdsCache: number[] = [];

/** When TEST_MODE=true, mock funding time 30s ahead so countdown decrements each tick. */
let mockFundingTimeMs: number | null = null;

/** When true, runTick returns immediately to give 100% priority to scheduled executeEntry timeouts. Reset after funding time + 2s or when manual mock is cancelled. */
let isExecutionImminent = false;
let executionImminentUntilMs = 0;

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
/** Precise entry timeouts: key = entryCycleKey(userId, symbol, nextFundingTime). Value single timeout (naked) or { main, sub } for subaccount hedging. */
const entryTimeoutByCycle = new Map<string, ReturnType<typeof setTimeout> | { main: ReturnType<typeof setTimeout>; sub: ReturnType<typeof setTimeout> }>();
/** Track funding time per (userId, symbol, side) for auto exit: close at fundingTime + exitTimeMs. */
const positionFundingTime = new Map<string, number>();

/** After main entry fills for sub-hedge, store here so when sub entry fills we can register subHedgeActive. */
const mainFilledForSubHedge = new Map<string, { userId: number; symbol: string; side: 'Buy' | 'Sell'; qty: number; mainApiKey: string; mainApiSecret: string }>();

/** Last entry execution report (main and optionally sub) for dashboard / debugging. */
export interface LastEntryExecutionDetail {
  triggeredAtMs: number;
  orderId: string;
  execPrice: string;
  execQty: string;
  executedAtMs: number;
}
export interface LastEntryReport {
  userId: number;
  symbol: string;
  nextFundingTime: string;
  fundingTimeMs: number;
  main: LastEntryExecutionDetail | null;
  sub: LastEntryExecutionDetail | null;
  subHedged: boolean;
  subExecutedBeforeFunding: boolean | null;
  reasonNoSub: string | null;
}
const lastEntryReportByUser = new Map<number, LastEntryReport>();

function recordLastEntry(
  userId: number,
  account: 'main' | 'sub',
  symbol: string,
  nextFundingTime: string,
  fundingTimeMs: number,
  triggeredAtMs: number,
  orderId: string,
  executions: Array<{ execPrice: string; execQty: string; execTime?: string }>,
  subHedgedExpected: boolean
): void {
  const executedAtMs =
    executions.length > 0 && executions[0]?.execTime
      ? parseInt(executions[0].execTime, 10) || Date.now()
      : Date.now();
  const execPrice = executions.length > 0 ? (executions[0]!.execPrice ?? '0') : '0';
  const execQty = executions.length > 0 ? executions.reduce((s, e) => s + (parseFloat(e.execQty) || 0), 0).toFixed(8) : '0';
  const detail: LastEntryExecutionDetail = { triggeredAtMs, orderId, execPrice, execQty, executedAtMs };

  let report = lastEntryReportByUser.get(userId);
  const cycleMatch = report && report.symbol === symbol && report.nextFundingTime === nextFundingTime;
  if (!report || !cycleMatch) {
    report = {
      userId,
      symbol,
      nextFundingTime,
      fundingTimeMs,
      main: null,
      sub: null,
      subHedged: subHedgedExpected,
      reasonNoSub: null,
    };
    lastEntryReportByUser.set(userId, report);
  }
  if (account === 'main') {
    report.main = detail;
    report.subHedged = subHedgedExpected;
  } else {
    report.sub = detail;
    report.subExecutedBeforeFunding = executedAtMs < fundingTimeMs;
  }
  insertTradeHistoryEntry(report).catch((err) =>
    console.error('[autoBot] trade_history insert failed', err)
  );
}

export function getLastEntryReport(userId: number): LastEntryReport | null {
  return lastEntryReportByUser.get(userId) ?? null;
}
/** Active subaccount hedge pairs: key = positionKey(userId, symbol, side). Exit when MainAccount_UnrealizedPnL > fees. */
const subHedgeActive = new Map<string, { userId: number; symbol: string; side: 'Buy' | 'Sell'; qty: number; mainApiKey: string; mainApiSecret: string; subApiKey: string; subApiSecret: string }>();

/** Pre-calculated order payloads for zero-API executeEntry (key = entryCycleKey). When timer fires, only ws.send(). */
interface PendingOrderPayload {
  apiKey: string;
  apiSecret: string;
  symbol: string;
  side: 'Buy' | 'Sell';
  qtyStr: string;
  priceStr: string;
}
const pendingOrderPayloadByCycle = new Map<string, { main?: PendingOrderPayload; sub?: PendingOrderPayload }>();

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
  const rounded = Math.round(price / tick) * tick;
  return rounded.toFixed(decimals);
}

/** Apply entry slippage buffer to base price and format for limit order. Long (Buy): base * (1 + pct/100); Short (Sell): base * (1 - pct/100). */
function applySlippageAndFormat(
  basePrice: number,
  side: 'Buy' | 'Sell',
  slippageBufferPct: number,
  tickSize: string
): string {
  const pct = Number.isFinite(slippageBufferPct) && slippageBufferPct >= 0 ? slippageBufferPct : 2;
  const limitPrice = side === 'Buy' ? basePrice * (1 + pct / 100) : basePrice * (1 - pct / 100);
  const priceStr = formatPriceToTick(limitPrice, tickSize);
  console.log(`[autoBot] Applying ${pct}% slippage buffer. Base: ${basePrice}, Limit: ${limitPrice}.`);
  return priceStr;
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
  exitReason: 'Time Exit' | 'Stoploss Hit' | 'Pre-Funding Stoploss' | 'Post-Funding Stoploss' | 'Post-Funding Stoploss (L2 - 50% Funding)' | 'PnL Positive Exit' | 'Universal Stoploss' | 'Break-even' | 'Next Trade Cleanup' | 'Post-Funding Profit' | 'Naked Mode Target Hit' | 'Naked Mode SL Hit',
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
  void warmupWsConnections().catch((e) => console.error('[autoBot] warmupWsConnections failed:', e));
}

/** Warm up WebSocket Private Trade connections for all users with auto entry (main + sub when subaccount hedging) so first order has minimal latency. */
async function warmupWsConnections(): Promise<void> {
  const userIds = await getUsersWithAutoEntryEnabled();
  for (const userId of userIds) {
    try {
      const keys = await getExchangeKeys(userId, 'Bybit');
      if (!keys) continue;
      await warmupWsConnection(decrypt(keys.api_key), decrypt(keys.api_secret));
      const subKeys = await getSubAccountKeys(userId);
      if (subKeys) {
        await warmupWsConnection(subKeys.subApiKey, subKeys.subApiSecret);
        console.log(`[autoBot] WS warmup done for user ${userId} (main + sub)`);
      } else {
        console.log(`[autoBot] WS warmup done for user ${userId}`);
      }
    } catch (e) {
      console.warn(`[autoBot] WS warmup failed for user ${userId}:`, e);
    }
  }
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
 * Cancel manual mock: reset to normal sync. Clear any scheduled entry timeouts to avoid double entries.
 */
export function cancelManualMock(): void {
  isManualMockActive = false;
  manualMockFundingTimeMs = null;
  manualMockEndMs = null;
  for (const [, t] of entryTimeoutByCycle) {
    if (typeof t === 'object' && t != null && 'main' in t) {
      clearTimeout(t.main);
      clearTimeout(t.sub);
    } else {
      clearTimeout(t as ReturnType<typeof setTimeout>);
    }
  }
  entryTimeoutByCycle.clear();
  pendingOrderPayloadByCycle.clear();
  console.log('[autoBot] Manual mock cancelled; returning to live sync.');
}

/** Returns minimum countdown in seconds across market data, or -1 if none. */
async function runTick(): Promise<number> {
  if (isExecutionImminent && Date.now() < executionImminentUntilMs) {
    return -1;
  }
  if (entryTimeoutByCycle.size === 0) {
    console.log('[autoBot] Tick Check - ' + new Date().toISOString());
  }
  try {
    const now = Date.now();
    let marketData: Array<{ symbol: string; fundingRate: number; nextFundingTime: string; countdownMs: number; markPrice?: string; lastPrice?: string; fundingIntervalHours?: number }>;

    if (isManualMockActive && manualMockFundingTimeMs != null && manualMockEndMs != null && now < manualMockEndMs) {
      try {
        marketData = await Promise.race([
          fundingScanner.getFundingData(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('getFundingData timeout')), 5000)),
        ]);
      } catch {
        const countdownMs = Math.max(0, manualMockFundingTimeMs - now);
        const nextFundingTime = String(manualMockFundingTimeMs);
        marketData = [{
          symbol: 'BTCUSDT',
          fundingRate: 0.01,
          nextFundingTime,
          countdownMs,
          markPrice: '0',
          lastPrice: '0',
          fundingIntervalHours: 8,
        }];
      }
    } else {
      if (isManualMockActive && (manualMockFundingTimeMs == null || manualMockEndMs == null || now >= manualMockEndMs)) {
        const wasEndOfCycle = manualMockEndMs != null && now >= manualMockEndMs;
        const wasMissingTimes = manualMockFundingTimeMs == null || manualMockEndMs == null;
        isManualMockActive = false;
        manualMockFundingTimeMs = null;
        manualMockEndMs = null;
        isExecutionImminent = false;
        executionImminentUntilMs = 0;
        if (wasEndOfCycle) {
          console.log('[autoBot] Manual mock cycle finished; resuming real-time sync.');
        } else if (wasMissingTimes) {
          console.log('[autoBot] Manual mock state cleared (missing times); resuming live sync.');
        }
      }
      marketData = await fundingScanner.getFundingData();
    }

    if (process.env.TEST_MODE === 'true') {
      if (mockFundingTimeMs === null || now >= mockFundingTimeMs) {
        mockFundingTimeMs = now + 30_000;
        console.log('[TEST MODE] Mocking funding time to 30s for testing.');
      }
      const countdownMs = Math.max(0, mockFundingTimeMs - now);
      const nextFundingTime = String(mockFundingTimeMs);
      marketData = marketData.map((m) => ({ ...m, nextFundingTime, countdownMs }));
    } else if (isManualMockActive && manualMockFundingTimeMs != null && manualMockEndMs != null && now < manualMockEndMs) {
      const countdownMs = Math.max(0, manualMockFundingTimeMs - now);
      const nextFundingTime = String(manualMockFundingTimeMs);
      marketData = marketData.map((m) => ({ ...m, nextFundingTime, countdownMs }));
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
        await processUser(userId, marketData, now);
      } catch (err) {
        console.error(`[autoBot] User ${userId} error:`, err);
      }
    }
    if (isExecutionImminent && now >= executionImminentUntilMs) {
      isExecutionImminent = false;
      executionImminentUntilMs = 0;
    }
    for (const [key, t] of entryTimeoutByCycle.entries()) {
      const parts = key.split('_');
      const nextFundingTimeStr = parts.length >= 3 ? parts[parts.length - 1]! : '';
      const nextMs = parseInt(nextFundingTimeStr, 10) || 0;
      if (nextMs > 0 && now > nextMs + 60_000) {
        if (typeof t === 'object' && t != null && 'main' in t) {
          clearTimeout(t.main);
          clearTimeout(t.sub);
        } else {
          clearTimeout(t as ReturnType<typeof setTimeout>);
        }
        entryTimeoutByCycle.delete(key);
      }
    }
    for (const cycleKey of mainFilledForSubHedge.keys()) {
      const parts = cycleKey.split('_');
      const nextFundingTimeStr = parts.length >= 3 ? parts[parts.length - 1]! : '';
      const nextMs = parseInt(nextFundingTimeStr, 10) || 0;
      if (nextMs > 0 && now > nextMs + 60_000) {
        mainFilledForSubHedge.delete(cycleKey);
      }
    }
    for (const cycleKey of pendingOrderPayloadByCycle.keys()) {
      const parts = cycleKey.split('_');
      const nextFundingTimeStr = parts.length >= 3 ? parts[parts.length - 1]! : '';
      const nextMs = parseInt(nextFundingTimeStr, 10) || 0;
      if (nextMs > 0 && now > nextMs + 60_000) {
        pendingOrderPayloadByCycle.delete(cycleKey);
      }
    }
    // Clear prep cache only after funding time + 1s so sub-account entry still has prep data
    for (const prep of entryPrepCacheByUser.values()) {
      prep.candidates = prep.candidates.filter((c) => now <= parseInt(c.nextFundingTime, 10) + 1000);
    }
    return minCountdownSec;
  } catch (error) {
    console.error('[autoBot] CRITICAL LOOP ERROR:', error);
    if (isManualMockActive) {
      isManualMockActive = false;
      manualMockFundingTimeMs = null;
      manualMockEndMs = null;
      console.log('[autoBot] Mock state reset after tick error so button is clickable again.');
    }
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

        let subPositions: Awaited<ReturnType<typeof getPositionList>> = [];
        const subKeys = await getSubAccountKeys(userId);
        if (subKeys) {
          try {
            subPositions = await getPositionList(subKeys.subApiKey, subKeys.subApiSecret, { category: 'linear', settleCoin: 'USDT' });
          } catch (e) {
            console.error('[autoBot] getPositionList (sub) failed for user', userId, e);
          }
        }

        const exitThresholdMs = settings.exitTimeMs ?? 0;
        const universalStoplossPct = Math.max(0, settings.universalStoplossPercent ?? 3);
        const nextFundingTimesMs = marketData.map((m) => parseInt(m.nextFundingTime, 10)).filter((t) => t > 0);
        const nearestNextFundingMs = nextFundingTimesMs.length > 0 ? Math.min(...nextFundingTimesMs) : 0;
        const PRE_NEXT_FUNDING_MS = 15 * 60 * 1000;

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

          // Real-time PnL: fetch bid1 (best bid) and ask1 (best ask). LONG = exit at bid → PnL = (bid1 - entry)*qty; SHORT = exit at ask → PnL = (entry - ask1)*qty
          let bid1Price = 0;
          let ask1Price = 0;
          try {
            const ob = await getOrderBookDepth(apiKey, apiSecret, pos.symbol, ORDERBOOK_DEPTH_BEST);
            bid1Price = ob.bidPrice;
            ask1Price = ob.askPrice;
          } catch (e) {
            console.error(`[autoBot] getOrderBookDepth failed ${pos.symbol}:`, e);
            continue;
          }
          const fallbackPrice = parseFloat(pos.markPrice ?? '') || entry;
          const bid1Safe = (Number.isFinite(bid1Price) && bid1Price > 0) ? bid1Price : fallbackPrice;
          const ask1Safe = (Number.isFinite(ask1Price) && ask1Price > 0) ? ask1Price : fallbackPrice;
          const realTimeExitPrice = pos.side === 'Buy' ? bid1Safe : ask1Safe;
          const pnlPct = entry <= 0 || !Number.isFinite(realTimeExitPrice) ? 0 : (pos.side === 'Buy' ? (realTimeExitPrice - entry) / entry : (entry - realTimeExitPrice) / entry) * 100;
          const pnl = !Number.isFinite(realTimeExitPrice) ? 0 : pos.side === 'Buy' ? (bid1Safe - entry) * qty : (entry - ask1Safe) * qty;
          // Maker fee estimate (0.02%) when Bybit returns 0
          const estimatedMakerFee = 0.0002 * qty * realTimeExitPrice;

          // Real-time exit price for triggers and saveClosedTradeAfterExit: LONG = bid1, SHORT = ask1
          const exitPrice = pos.side === 'Buy' ? bid1Safe : ask1Safe;

          // Subaccount future-to-future hedge: Universal Stoploss (before funding), then after funding: Break-even, 15m Pre-next Funding, PnL Positive.
          const subHedge = subHedgeActive.get(key);
          if (subHedge != null) {
            const subPos = subPositions.find((p) => p.symbol === pos.symbol);
            const subEntry = subPos ? parseFloat(subPos.avgPrice) || 0 : 0;
            const subQty = subPos ? parseFloat(subPos.size) || 0 : subHedge.qty;
            const subPnl =
              subPos && (Number.isFinite(bid1Safe) && Number.isFinite(ask1Safe))
                ? (subHedge.side === 'Buy' ? (bid1Safe - subEntry) * subQty : (subEntry - ask1Safe) * subQty)
                : 0;
            const combinedPnl = pnl + subPnl;
            const cache = walletCacheByUser.get(userId);
            const totalCapital = cache
              ? (cache.subEquity != null ? cache.totalEquity + cache.subEquity : cache.totalEquity)
              : 0;
            const combinedPnlPct = totalCapital > 0 ? (combinedPnl / totalCapital) * 100 : 0;

            const runSubHedgeExit = async (
              exitReason: 'Universal Stoploss' | 'Break-even' | 'Next Trade Cleanup' | 'PnL Positive Exit' | 'Post-Funding Profit'
            ): Promise<boolean> => {
              try {
                // Orphaned sub safety: close main always; close sub only if sub has an open position (subQty > 0)
                const mainOrderIds = await exitPositionWithIocSweep(apiKey, apiSecret, pos.symbol, pos.side, qty);
                const subOrderIds =
                  subQty > 0
                    ? await exitPositionWithIocSweep(subHedge.subApiKey, subHedge.subApiSecret, pos.symbol, subHedge.side, subQty)
                    : [];
                positionFundingTime.delete(key);
                subHedgeActive.delete(key);
                for (const [ck, v] of mainFilledForSubHedge.entries()) {
                  if (v.userId === userId && v.symbol === pos.symbol && v.side === pos.side) {
                    mainFilledForSubHedge.delete(ck);
                    break;
                  }
                }
                delete lockedFundingRates[pos.symbol];
                if (mainOrderIds.length > 0) {
                  saveClosedTradeAfterExit(userId, apiKey, apiSecret, pos.symbol, pos.side, entry, qty, mainOrderIds, exitReason, 0, exitPrice).catch((e) =>
                    console.error(`[autoBot] saveClosedTradeAfterExit (main) failed ${pos.symbol}:`, e)
                  );
                }
                if (subOrderIds.length > 0) {
                  saveClosedTradeAfterExit(userId, subHedge.subApiKey, subHedge.subApiSecret, pos.symbol, subHedge.side, subPos ? parseFloat(subPos.avgPrice) || entry : entry, subQty, subOrderIds, exitReason, 0, exitPrice).catch((e) =>
                    console.error(`[autoBot] saveClosedTradeAfterExit (sub) failed ${pos.symbol}:`, e)
                  );
                }
                if (exitReason === 'Universal Stoploss') console.log('[EXIT] Universal Stoploss |', pos.symbol, 'combinedPnlPct=', combinedPnlPct.toFixed(2) + '%');
                else if (exitReason === 'Break-even') console.log('[EXIT] Break-even |', pos.symbol);
                else if (exitReason === 'Next Trade Cleanup') console.log('[EXIT] Next Trade Cleanup |', pos.symbol);
                else if (exitReason === 'Post-Funding Profit') console.log('[EXIT] Post-Funding Profit |', pos.symbol);
                else console.log('[EXIT] PnL Positive Exit |', pos.symbol);
                return true;
              } catch (e) {
                console.error(`[autoBot] Sub-hedge exit failed ${pos.symbol}:`, e);
                return false;
              }
            };

            // 1) Universal Stoploss (3%): immediate exit even before funding if combined loss % exceeds settings.universal_stoploss_percent. Uses Limit (IOC sweep).
            if (combinedPnlPct <= -universalStoplossPct && totalCapital > 0) {
              await runSubHedgeExit('Universal Stoploss');
              continue;
            }

            // Funding guard: no automated exit (except Universal Stoploss) before tradeFundingTime
            if (fundingTimeMs == null || now < fundingTimeMs) {
              continue;
            }

            // 2) Break-even: after funding only. Long: trigger if bid1 >= entry (recovered to entry or above); Short: trigger if ask1 <= entry (recovered to entry or below)
            const breakEvenHit =
              entry > 0 &&
              Number.isFinite(bid1Safe) &&
              Number.isFinite(ask1Safe) &&
              (pos.side === 'Buy' ? bid1Safe >= entry : ask1Safe <= entry);
            if (breakEvenHit) {
              console.log('[EXIT CHECK] Break-even hit! Side:', pos.side, 'Entry:', entry, 'Current:', pos.side === 'Buy' ? bid1Safe : ask1Safe);
              await runSubHedgeExit('Break-even');
              continue;
            }

            // 2b) Post-Funding Profit: 5 minutes after funding and combined PnL strictly positive → Limit Exit
            const fiveMinAfterFundingMs = 5 * 60 * 1000;
            if (fundingTimeMs != null && now > fundingTimeMs + fiveMinAfterFundingMs && combinedPnl > 0) {
              console.log('[EXIT CHECK] Positive Combined PnL 5 mins after funding. Combined PnL:', combinedPnl);
              await runSubHedgeExit('Post-Funding Profit');
              continue;
            }

            // 3) 15-min window: currentTime within 15 mins of next potential trade funding → Limit Exit (Next Trade Cleanup)
            if (nearestNextFundingMs > 0 && now >= nearestNextFundingMs - PRE_NEXT_FUNDING_MS) {
              await runSubHedgeExit('Next Trade Cleanup');
              continue;
            }

            // 4) PnL Positive: main net PnL > 0 (after funding) → Limit Exit
            const notional = qty * entry;
            const estimatedTakerFees = 2 * 0.0006 * notional;
            const mainNetPnl = pnl - estimatedTakerFees;
            if (mainNetPnl > 0) {
              await runSubHedgeExit('PnL Positive Exit');
            }
            continue;
          }

          const hedgeGroup = await getHedgeGroupByPosition(userId, pos.symbol, pos.side);

          // Hedged position: live orderbook depth PnL, target/stoploss (dollar), timeout
          if (hedgeGroup != null) {
            const settlementTimeMs = fundingTimeMs ?? 0;
            if (settlementTimeMs === 0 || now < settlementTimeMs) continue;

            // Emergency timeout: if WebSocket Settlement was missed, close after fundingTime + exitTimeMs so trade doesn't stay open forever
            if (exitThresholdMs > 0 && now >= settlementTimeMs + exitThresholdMs) {
              try {
                let fundingAmountReceived = hedgeGroup.fundingAmountReceived;
                if (fundingAmountReceived == null) {
                  const rate = lockedFundingRates[pos.symbol] ?? Math.abs(fundingRate);
                  fundingAmountReceived = (qty * entry) * rate;
                  await setFundingReceived(hedgeGroup.hedgeGroupId, fundingAmountReceived);
                }
                const [orderIds] = await Promise.all([
                  exitPositionWithIocSweep(apiKey, apiSecret, pos.symbol, pos.side, qty),
                  exitSpotWithIocSweep(apiKey, apiSecret, pos.symbol, pos.side, qty),
                ]);
                positionFundingTime.delete(key);
                if (orderIds.length > 0) {
                  const finalFundingRate = lockedFundingRates[pos.symbol] ?? Math.abs(fundingRate);
                  const fundingReceived = (qty * entry) * finalFundingRate;
                  await saveClosedTradeAfterExit(userId, apiKey, apiSecret, pos.symbol, pos.side, entry, qty, orderIds, 'Time Exit', fundingReceived, exitPrice, estimatedMakerFee);
                }
                await deleteHedgeGroup(hedgeGroup.hedgeGroupId);
                delete lockedFundingRates[pos.symbol];
                console.log(`[autoBot] Exit Triggered: Emergency timeout (WebSocket Settlement fallback) | ${pos.symbol}`);
              } catch (e) {
                console.error(`[autoBot] Hedged emergency exit failed ${pos.symbol}:`, e);
              }
              continue;
            }

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
              const minPctExit = minFunding > 0 && minFunding < 0.1 ? minFunding * 100 : minFunding;
              const maxTrades = settings.maxTrades ?? 1;
              const queue = marketData
                .filter((m) => Math.abs(m.fundingRate * 100) >= minPctExit && !bannedList.includes(m.symbol))
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

          if (subHedgeActive.has(key)) continue;

          const userSubHedgingEnabled = !!subKeys;
          if (settings.hedgeMode && userSubHedgingEnabled) continue;

          // Naked Mode: after funding, exit on target (Main ROE % >= funding rate %) or SL (Main ROE % <= -funding rate %)
          if (!settings.hedgeMode && fundingTimeMs != null && now >= fundingTimeMs) {
            const fundingRatePct = Math.abs(fundingRate) * 100;
            if (pnlPct >= fundingRatePct) {
              try {
                const orderIds = await exitPositionWithIocSweep(apiKey, apiSecret, pos.symbol, pos.side, qty);
                positionFundingTime.delete(key);
                if (orderIds.length > 0) {
                  const fundingReceived = (qty * entry) * Math.abs(fundingRate);
                  await saveClosedTradeAfterExit(userId, apiKey, apiSecret, pos.symbol, pos.side, entry, qty, orderIds, 'Naked Mode Target Hit', fundingReceived, exitPrice, estimatedMakerFee);
                }
                delete lockedFundingRates[pos.symbol];
                console.log('[EXIT] Naked Mode Target Hit |', pos.symbol, 'ROE%=', pnlPct.toFixed(2) + '%');
              } catch (e) {
                console.error(`[autoBot] Naked target exit failed ${pos.symbol}:`, e);
              }
              continue;
            }
            if (pnlPct <= -fundingRatePct) {
              try {
                const orderIds = await exitPositionWithIocSweep(apiKey, apiSecret, pos.symbol, pos.side, qty);
                positionFundingTime.delete(key);
                if (orderIds.length > 0) {
                  const fundingReceived = (qty * entry) * Math.abs(fundingRate);
                  await saveClosedTradeAfterExit(userId, apiKey, apiSecret, pos.symbol, pos.side, entry, qty, orderIds, 'Naked Mode SL Hit', fundingReceived, exitPrice, estimatedMakerFee);
                }
                delete lockedFundingRates[pos.symbol];
                console.log('[EXIT] Naked Mode SL Hit |', pos.symbol, 'ROE%=', pnlPct.toFixed(2) + '%');
              } catch (e) {
                console.error(`[autoBot] Naked SL exit failed ${pos.symbol}:`, e);
              }
              continue;
            }
          }

          // Time-based Auto Exit (after funding time) — disabled when subaccount hedging; only PnL-based exit applies for hedges
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

/** Prep data passed into executeEntry so it never gets lost (no cache lookup). */
type ExecuteEntryPrepData = { prep: EntryPrep; candidate: EntryPrepCandidate };

/**
 * Run entry at exact timestamp (called from precise setTimeout). Uses prepData when provided; otherwise falls back to cache.
 * For subaccount hedging: account 'main' fires at funding - entry_offset_ms, 'sub' at funding - sub_entry_offset_ms; both use same Q from min(balances).
 */
async function executeEntry(
  userId: number,
  symbol: string,
  nextFundingTime: string,
  account?: 'main' | 'sub',
  prepData?: ExecuteEntryPrepData
): Promise<void> {
  const triggeredAtMs = Date.now();
  const fundingTimeMs = parseInt(nextFundingTime, 10) || 0;
  console.log(`[DEBUG] executeEntry TRIGGERED for ${symbol} - Account: ${account ?? 'main'} at ${triggeredAtMs}`);
  console.log('[DEBUG] PrepData Check:', !!prepData);
  try {
    const cycleKey = entryCycleKey(userId, symbol, nextFundingTime);
    const procKey = processedKey(userId, symbol, nextFundingTime);
    const existing = entryTimeoutByCycle.get(cycleKey);
    if (existing) {
      if (typeof existing === 'object' && existing != null && 'main' in existing) {
        if (account === 'main') {
          clearTimeout(existing.main);
        } else if (account === 'sub') {
          clearTimeout(existing.sub);
          entryTimeoutByCycle.delete(cycleKey);
        }
      } else {
        clearTimeout(existing as ReturnType<typeof setTimeout>);
        entryTimeoutByCycle.delete(cycleKey);
      }
    }
    // When prepData (passedData) is injected, use it only: sub uses prep.subApiKey/subApiSecret and candidate.fixedQty; main uses prep.apiKey/apiSecret and candidate.fixedQty.
    const prep = prepData ? prepData.prep : entryPrepCacheByUser.get(userId);
    const c = prepData ? prepData.candidate : prep?.candidates.find((x) => x.symbol === symbol && x.nextFundingTime === nextFundingTime);
    if (prepData && (!prep || !c)) {
      console.log('[ABORT] executeEntry stopped at prepData provided but prep or candidate missing');
      return;
    }
    const isSubHedge = account === 'sub' && prep?.subApiKey && prep?.subApiSecret && c?.fixedQty != null;
    const isMainHedge = account !== 'sub' && prep?.subApiKey && prep?.subApiSecret;

    const pendingPayload = pendingOrderPayloadByCycle.get(cycleKey);

  if (account === 'sub' && pendingPayload?.sub) {
    const pl = pendingPayload.sub;
    const orderSide: 'Buy' | 'Sell' = pl.side === 'Buy' ? 'Sell' : 'Buy';
    try {
      console.log('[DEBUG] Sending WS Order to Bybit for', account ?? 'sub');
      const response = await placeLimitOrder(pl.apiKey, pl.apiSecret, pl.symbol, orderSide, pl.qtyStr, pl.priceStr, 'IOC');
      console.log(`[DEBUG] Bybit Response for sub:`, response);
      const executions = await getExecutionList(pl.apiKey, pl.apiSecret, 'linear', response.orderId).catch(() => []);
      recordLastEntry(userId, 'sub', pl.symbol, nextFundingTime, fundingTimeMs, triggeredAtMs, response.orderId, executions, true);
      const mainFilled = mainFilledForSubHedge.get(cycleKey);
      if (mainFilled) {
        const posKey = positionKey(userId, pl.symbol, pl.side);
        const qtyNum = parseFloat(pl.qtyStr) || 0;
        subHedgeActive.set(posKey, {
          userId,
          symbol: pl.symbol,
          side: orderSide,
          qty: mainFilled.qty,
          mainApiKey: mainFilled.mainApiKey,
          mainApiSecret: mainFilled.mainApiSecret,
          subApiKey: pl.apiKey,
          subApiSecret: pl.apiSecret,
        });
        mainFilledForSubHedge.delete(cycleKey);
        console.log(`[autoBot] Sub-hedge both filled | ${pl.symbol} qty=${mainFilled.qty}`);
      }
      processedTokens.add(procKey);
      enteredThisCycle.add(cycleKey);
    } catch (e) {
      console.error(`[autoBot] executeEntry sub (payload) ${pendingPayload.sub.symbol} failed:`, e);
    }
    pendingOrderPayloadByCycle.delete(cycleKey);
    console.log('[ABORT] executeEntry stopped at sub payload path completed');
    return;
  }

  if (account !== 'sub' && pendingPayload?.main) {
    const pl = pendingPayload.main;
    try {
      console.log('[DEBUG] Sending WS Order to Bybit for', account ?? 'main');
      const response = await placeLimitOrder(pl.apiKey, pl.apiSecret, pl.symbol, pl.side, pl.qtyStr, pl.priceStr, 'IOC');
      console.log(`[DEBUG] Bybit Response for main:`, response);
      const executions = await getExecutionList(pl.apiKey, pl.apiSecret, 'linear', response.orderId).catch(() => []);
      recordLastEntry(userId, 'main', pl.symbol, nextFundingTime, fundingTimeMs, triggeredAtMs, response.orderId, executions, !!(prep?.subApiKey && prep?.subApiSecret));
      const nextFundingMs = parseInt(nextFundingTime, 10) || 0;
      positionFundingTime.set(positionKey(userId, pl.symbol, pl.side), nextFundingMs);
      if (prep?.subApiKey && prep?.subApiSecret) {
        const qtyNum = parseFloat(pl.qtyStr) || 0;
        if (qtyNum > 0) {
          mainFilledForSubHedge.set(cycleKey, {
            userId,
            symbol: pl.symbol,
            side: pl.side,
            qty: qtyNum,
            mainApiKey: pl.apiKey,
            mainApiSecret: pl.apiSecret,
          });
        }
      }
    } catch (e) {
      console.error(`[autoBot] executeEntry main (payload) ${pl.symbol} failed:`, e);
    }
    if (pendingPayload.sub) {
      pendingOrderPayloadByCycle.set(cycleKey, { sub: pendingPayload.sub });
    } else {
      pendingOrderPayloadByCycle.delete(cycleKey);
    }
    console.log('[ABORT] executeEntry stopped at main payload path completed');
    return;
  }

  if (isSubHedge && prep && c) {
    if (processedTokens.has(procKey)) {
      console.log('[ABORT] executeEntry stopped at sub hedge path already processed (procKey)');
      return;
    }
    const tickSize = c.tickSize ?? '0.01';
    const finalQty = c.fixedQty!;
    const qtyStr = formatQtyToStep(finalQty, String(c.qtyStep));
    if (parseFloat(qtyStr) <= 0) {
      console.log('[ABORT] executeEntry stopped at sub hedge qty zero or negative');
      return;
    }
    const orderSide: 'Buy' | 'Sell' = c.side === 'Buy' ? 'Sell' : 'Buy';
    try {
      const orderbook = await getOrderbook(c.symbol, ORDERBOOK_SWEEP_LIMIT);
      const sweepPrice = getSweepPrice(orderbook, orderSide, finalQty);
      if (!Number.isFinite(sweepPrice) || sweepPrice <= 0) {
        console.log('[ABORT] executeEntry stopped at sub hedge invalid sweep price');
        return;
      }
      const slippagePct = prep.settings.slippageBufferPct ?? 2;
      const priceStr = applySlippageAndFormat(sweepPrice, orderSide, slippagePct, tickSize);
      const subApiKey = prep.subApiKey!;
      const subApiSecret = prep.subApiSecret!;
      console.log('[DEBUG] Sending WS Order to Bybit for', account ?? 'sub');
      const response = await placeLimitOrder(subApiKey, subApiSecret, c.symbol, orderSide, qtyStr, priceStr, 'IOC');
      console.log(`[DEBUG] Bybit Response for sub:`, response);
      await new Promise((r) => setTimeout(r, IOC_RETRY_DELAY_MS));
      const executions = await getExecutionList(subApiKey, subApiSecret, 'linear', response.orderId);
      const filledQty = executions.reduce((s, e) => s + (parseFloat(e.execQty) || 0), 0);
      if (filledQty <= 0) {
        let r = lastEntryReportByUser.get(userId);
        if (r && r.symbol === c.symbol && r.nextFundingTime === nextFundingTime) {
          r.reasonNoSub = 'Sub order had no fill';
        } else if (!r) {
          r = { userId, symbol: c.symbol, nextFundingTime, fundingTimeMs, main: null, sub: null, subHedged: true, reasonNoSub: 'Sub order had no fill', subExecutedBeforeFunding: null };
          lastEntryReportByUser.set(userId, r);
        }
        insertTradeHistoryEntry(r).catch((err) => console.error('[autoBot] trade_history insert failed', err));
        console.log('[ABORT] executeEntry stopped at sub hedge no fill');
        return;
      }
      recordLastEntry(userId, 'sub', c.symbol, nextFundingTime, fundingTimeMs, triggeredAtMs, response.orderId, executions, true);
      const mainFilled = mainFilledForSubHedge.get(cycleKey);
      if (mainFilled) {
        const posKey = positionKey(userId, c.symbol, c.side);
        subHedgeActive.set(posKey, {
          userId,
          symbol: c.symbol,
          side: orderSide,
          qty: mainFilled.qty,
          mainApiKey: mainFilled.mainApiKey,
          mainApiSecret: mainFilled.mainApiSecret,
          subApiKey: prep.subApiKey!,
          subApiSecret: prep.subApiSecret!,
        });
        mainFilledForSubHedge.delete(cycleKey);
        console.log(`[autoBot] Sub-hedge both filled | ${c.symbol} qty=${mainFilled.qty}`);
      }
      processedTokens.add(procKey);
      enteredThisCycle.add(cycleKey);
    } catch (e) {
      console.error(`[autoBot] executeEntry sub ${c.symbol} failed:`, e);
    }
    console.log('[ABORT] executeEntry stopped at sub hedge path completed');
    return;
  }

  if (processedTokens.has(procKey) || enteredThisCycle.has(cycleKey)) {
    console.log('[ABORT] executeEntry stopped at already processed or entered this cycle');
    return;
  }

  if (prep && c && account !== 'sub') {
    let entryPrice: number;
    try {
      const obDepth = await getOrderBookDepth(prep.apiKey, prep.apiSecret, c.symbol, prep.settings.orderBookDepth ?? 2);
      entryPrice = c.side === 'Buy' ? obDepth.askPrice : obDepth.bidPrice;
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
        console.log('[ABORT] executeEntry stopped at main prep invalid entry price');
        return;
      }
    } catch {
      console.log('[ABORT] executeEntry stopped at main prep orderbook depth failed');
      return;
    }
    const finalMargin = Math.min(prep.tradeMargin, prep.cachedAvailableMargin);
    const rawQty = (finalMargin * c.safeLeverage) / entryPrice;
    if (rawQty <= 0) {
      console.log('[ABORT] executeEntry stopped at main prep raw qty <= 0');
      return;
    }
    const step = c.qtyStep;
    const minQty = c.minOrderQty;
    const maxQty = c.maxOrderQty;
    const stepStr = step.toString();
    const stepDecimals = stepStr.includes('.') ? stepStr.split('.')[1]!.length : 0;
    let finalQty = c.fixedQty ?? parseFloat((Math.floor(rawQty / step) * step).toFixed(stepDecimals));
    if (finalQty > maxQty) finalQty = parseFloat((Math.floor(maxQty / step) * step).toFixed(stepDecimals));
    if (finalQty < minQty) {
      console.log('[ABORT] executeEntry stopped at main prep final qty below min order qty');
      return;
    }
    if (!isMainHedge) {
      processedTokens.add(procKey);
      enteredThisCycle.add(cycleKey);
    }
    try {
      let remainingQty = finalQty;
      let retries = 0;
      const tickSize = c.tickSize ?? '0.01';
      while (remainingQty > 0 && retries < MAX_IOC_RETRIES) {
        try {
          const orderbook = await getOrderbook(c.symbol, ORDERBOOK_SWEEP_LIMIT);
          const sweepPrice = getSweepPrice(orderbook, c.side, remainingQty);
          if (!Number.isFinite(sweepPrice) || sweepPrice <= 0) break;
          const slippagePct = prep.settings.slippageBufferPct ?? 2;
          const priceStr = applySlippageAndFormat(sweepPrice, c.side, slippagePct, tickSize);
          const qtyStr = formatQtyToStep(remainingQty, String(c.qtyStep));
          if (parseFloat(qtyStr) <= 0) break;
          console.log('[DEBUG] Sending WS Order to Bybit for', account ?? 'main');
          const response = await placeLimitOrder(prep.apiKey, prep.apiSecret, c.symbol, c.side, qtyStr, priceStr, 'IOC');
          console.log(`[DEBUG] Bybit Response for main:`, response);
          await new Promise((r) => setTimeout(r, IOC_RETRY_DELAY_MS));
          const executions = await getExecutionList(prep.apiKey, prep.apiSecret, 'linear', response.orderId);
          const filledQty = executions.reduce((s, e) => s + (parseFloat(e.execQty) || 0), 0);
          if (filledQty > 0) {
            recordLastEntry(userId, 'main', c.symbol, nextFundingTime, fundingTimeMs, triggeredAtMs, response.orderId, executions, !!(prep.subApiKey && prep.subApiSecret));
          }
          remainingQty -= filledQty;
          if (remainingQty <= 0) break;
        } catch (e) {
          console.error(`[autoBot] executeEntry ${c.symbol} orderbook/order failed:`, e);
        }
        retries++;
        await new Promise((r) => setTimeout(r, IOC_RETRY_DELAY_MS));
      }
      const nextFundingMs = parseInt(c.nextFundingTime, 10) || 0;
      positionFundingTime.set(positionKey(userId, c.symbol, c.side), nextFundingMs);
      if (isMainHedge && prep.subApiKey && prep.subApiSecret) {
        const filledTotal = finalQty - remainingQty;
        if (filledTotal > 0) {
          mainFilledForSubHedge.set(cycleKey, {
            userId,
            symbol: c.symbol,
            side: c.side,
            qty: filledTotal,
            mainApiKey: prep.apiKey,
            mainApiSecret: prep.apiSecret,
          });
        }
      }
    } catch {
      /* ignore */
    }
    console.log('[ABORT] executeEntry stopped at main prep path completed');
    return;
  }

  if (account === 'sub') {
    console.log('[ABORT] executeEntry stopped at sub account fallback disabled (use passedData only)');
    return;
  }

  try {
    const settings = await getSettings(userId);
    const keys = await getExchangeKeys(userId, 'Bybit');
    if (!keys || !settings.autoEntryEnabled) {
      console.log('[ABORT] executeEntry stopped at fallback no keys or auto entry disabled');
      return;
    }
    const apiKey = decrypt(keys.api_key);
    const apiSecret = decrypt(keys.api_secret);
    const positions = await getPositionList(apiKey, apiSecret, { category: 'linear', settleCoin: 'USDT' });
    const maxTrades = settings.maxTrades ?? 1;
    if (positions.length >= maxTrades) {
      console.log('[ABORT] executeEntry stopped at fallback max trades reached');
      return;
    }
    const marketData = await fundingScanner.getFundingData();
    const token = marketData.find((m) => m.symbol === symbol);
    if (!token || token.nextFundingTime !== nextFundingTime) {
      console.log('[ABORT] executeEntry stopped at fallback token not found or wrong funding time');
      return;
    }
    const bannedSet = new Set(await getBannedTokens(userId));
    if (bannedSet.has(symbol)) {
      console.log('[ABORT] executeEntry stopped at fallback symbol banned');
      return;
    }
    const cache = walletCacheByUser.get(userId);
    if (!cache) {
      console.log('[ABORT] executeEntry stopped at fallback no wallet cache');
      return;
    }
    const tradeMargin = cache.totalEquity * ((settings.capitalPercent ?? 0) / 100);
    const cachedAvailableMargin = cache.totalAvailableBalance;
    const obDepth = await getOrderBookDepth(apiKey, apiSecret, symbol, settings.orderBookDepth ?? 2);
    const side: 'Buy' | 'Sell' = token.fundingRate < 0 ? 'Buy' : 'Sell';
    const entryPrice = side === 'Buy' ? obDepth.askPrice : obDepth.bidPrice;
    const finalMargin = Math.min(tradeMargin, cachedAvailableMargin);
    let safeLeverage = settings.leverage ?? 5;
    try {
      const details = await getInstrumentDetails(symbol);
      safeLeverage = Math.min(safeLeverage, parseFloat(details.maxLeverage) || safeLeverage);
    } catch {
      /* ignore */
    }
    const rawQty = (finalMargin * safeLeverage) / entryPrice;
    let ls: { qtyStep: string; minOrderQty: string; maxOrderQty: string; maxMktOrderQty?: string; tickSize: string };
    try {
      ls = await getInstrumentLotSize(apiKey, apiSecret, symbol);
    } catch {
      console.log('[ABORT] executeEntry stopped at fallback getInstrumentLotSize failed');
      return;
    }
    const step = parseFloat(ls.qtyStep) || 0.1;
    const minQty = parseFloat(ls.minOrderQty) || 0;
    const maxQty = parseFloat(ls.maxMktOrderQty || ls.maxOrderQty) || 999999;
    const stepDecimals = step.toString().includes('.') ? step.toString().split('.')[1]!.length : 0;
    let finalQty = parseFloat((Math.floor(rawQty / step) * step).toFixed(stepDecimals));
    if (finalQty > maxQty) finalQty = parseFloat((Math.floor(maxQty / step) * step).toFixed(stepDecimals));
    if (finalQty < minQty) {
      console.log('[ABORT] executeEntry stopped at fallback final qty below min');
      return;
    }
    processedTokens.add(procKey);
    enteredThisCycle.add(cycleKey);
    let remainingQty = finalQty;
    let retries = 0;
    while (remainingQty > 0 && retries < MAX_IOC_RETRIES) {
      try {
        const orderbook = await getOrderbook(symbol, ORDERBOOK_SWEEP_LIMIT);
        const sweepPrice = getSweepPrice(orderbook, side, remainingQty);
        if (!Number.isFinite(sweepPrice) || sweepPrice <= 0) break;
        const slippagePct = settings.slippageBufferPct ?? 2;
        const priceStr = applySlippageAndFormat(sweepPrice, side, slippagePct, ls.tickSize ?? '0.01');
        const qtyStr = formatQtyToStep(remainingQty, ls.qtyStep);
        if (parseFloat(qtyStr) <= 0) break;
        console.log('[DEBUG] Sending WS Order to Bybit for', account ?? 'main');
        const response = await placeLimitOrder(apiKey, apiSecret, symbol, side, qtyStr, priceStr, 'IOC');
        console.log(`[DEBUG] Bybit Response for main:`, response);
        await new Promise((r) => setTimeout(r, IOC_RETRY_DELAY_MS));
        const executions = await getExecutionList(apiKey, apiSecret, 'linear', response.orderId);
        const filledQty = executions.reduce((s, e) => s + (parseFloat(e.execQty) || 0), 0);
        if (filledQty > 0) {
          recordLastEntry(userId, 'main', symbol, nextFundingTime, fundingTimeMs, triggeredAtMs, response.orderId, executions, false);
        }
        remainingQty -= filledQty;
        if (remainingQty <= 0) break;
      } catch (e) {
        console.error(`[autoBot] executeEntry full ${symbol} failed:`, e);
      }
      retries++;
      await new Promise((r) => setTimeout(r, IOC_RETRY_DELAY_MS));
    }
    const nextFundingMs = parseInt(nextFundingTime, 10) || 0;
    positionFundingTime.set(positionKey(userId, symbol, side), nextFundingMs);
  } catch (e) {
    console.error(`[autoBot] executeEntry ${symbol} failed:`, e);
  }
  } catch (e) {
    console.error('[CRITICAL EXECUTION ERROR]', e);
  }
}

/**
 * Critical path when countdown <= 15s: schedule precise entry timeout when 5–10s before exact entry time; no immediate order in loop.
 */
async function processUserCritical(
  userId: number,
  marketData: Array<{ symbol: string; fundingRate: number; nextFundingTime: string; countdownMs: number }>,
  now: number
): Promise<void> {
  const prep = entryPrepCacheByUser.get(userId);
  if (!prep || prep.candidates.length === 0) return;
  if (prep.positionsCount >= prep.maxTrades) return;

  const entryOffsetMs = prep.settings.entryOffsetMs ?? 300000;
  const marketBySymbol = new Map(marketData.map((m) => [m.symbol, m]));

  const scheduleNow = Date.now();
  for (const c of prep.candidates) {
    const token = marketBySymbol.get(c.symbol);
    if (!token) continue;

    const fundingTimeMs = parseInt(c.nextFundingTime, 10) || scheduleNow + token.countdownMs;
    const exactEntryTimeMs = fundingTimeMs - entryOffsetMs;
    const delayMs = fundingTimeMs - scheduleNow - entryOffsetMs;
    if (delayMs < ENTRY_SCHEDULE_MIN_MS || delayMs > ENTRY_SCHEDULE_MAX_MS) continue;

    const cycleKey = entryCycleKey(userId, c.symbol, c.nextFundingTime);
    if (entryTimeoutByCycle.has(cycleKey)) continue;
    if (processedTokens.has(processedKey(userId, c.symbol, c.nextFundingTime))) continue;
    if (enteredThisCycle.has(cycleKey)) continue;

    isExecutionImminent = true;
    executionImminentUntilMs = Math.max(executionImminentUntilMs, fundingTimeMs + 2000);
    const prepData: ExecuteEntryPrepData = { prep, candidate: c };
    const t = setTimeout(() => {
      executeEntry(userId, c.symbol, c.nextFundingTime, undefined, prepData).catch((e) =>
        console.error('[autoBot] executeEntry failed', e)
      );
    }, Math.max(0, delayMs));
    entryTimeoutByCycle.set(cycleKey, t);
    console.log(`[autoBot] Entry scheduled exactly at ${exactEntryTimeMs} (in ${delayMs}ms).`);
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

  // Auto Entry: filter by min funding rate (compare % to % so negative/short-squeeze rates are not missed)
  const minFundingRate = settings.minFundingRate ?? 0;
  const minPct = minFundingRate > 0 && minFundingRate < 0.1 ? minFundingRate * 100 : minFundingRate;

  let meetsMinFunding: typeof marketData;
  if (isManualMockActive) {
    // Mock bypass: take #1 ranked token regardless of rate for testing
    meetsMinFunding = [...marketData];
  } else {
    meetsMinFunding = marketData.filter((token) => {
      const absRatePct = Math.abs(token.fundingRate * 100);
      const passes = absRatePct >= minPct;
      if (debugSkip && !passes && marketData.indexOf(token) < 5 && entryTimeoutByCycle.size === 0) {
        console.log(`[DEBUG] Checking ${token.symbol}: Abs Rate ${absRatePct.toFixed(4)}% vs Min ${minPct}%`);
      }
      return passes;
    });
  }
  let bannedSet: Set<string>;
  try {
    bannedSet = new Set(await getBannedTokens(userId));
  } catch (e) {
    console.error('[autoBot] getBannedTokens failed for user', userId, e);
    bannedSet = new Set();
  }
  meetsMinFunding = meetsMinFunding.filter((token) => !bannedSet.has(token.symbol));
  if (meetsMinFunding.length === 0) {
    const pctStr = minPct.toFixed(4);
    if (debugSkip) console.log('[DEBUG] Trade Skipped Reason: No tokens meet Min Funding or all banned', 'minFundingRate%:', pctStr);
    console.log(`[autoBot] No tokens meet Min Funding criteria (>= ${pctStr}%) or all are banned`);
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

  const entryOffsetMs = settings.entryOffsetMs ?? 300000;
  const minCountdownSec =
    Math.min(...candidates.map((c) => Math.floor(c.countdownMs / 1000))) ?? 9999;
  const minDelayToEntry = Math.min(
    ...candidates.map((c) => {
      const fundingTimeMs = parseInt(c.nextFundingTime, 10) || 0;
      return fundingTimeMs - entryOffsetMs - now;
    })
  );
  const inEntryWindow = minDelayToEntry > 0 && minDelayToEntry <= ENTRY_SCHEDULE_MAX_MS + 5000;
  const inPrefetchWindow = minCountdownSec >= WALLET_PREFETCH_MIN_SEC && minCountdownSec <= WALLET_PREFETCH_MAX_SEC;

  const subKeys = await getSubAccountKeys(userId);
  const subHedgingEnabled = !!settings.hedgeMode && !!subKeys;

  // Pre-fetch wallet when countdown 20–60s; never call getWalletBalance when countdown <= 15 (critical path uses cache only). Sub-hedge: also fetch sub balance.
  if (inPrefetchWindow) {
    try {
      const [wallet, subWallet] = subHedgingEnabled && subKeys
        ? await Promise.all([
            getWalletBalance(apiKey, apiSecret),
            getWalletBalance(subKeys.subApiKey, subKeys.subApiSecret),
          ])
        : [await getWalletBalance(apiKey, apiSecret), null];
      const totalEquity = parseFloat(wallet.totalEquity) || 0;
      const totalAvailableBalance = parseFloat(wallet.totalAvailableBalance) || 0;
      const subEquity = subWallet ? parseFloat(subWallet.totalEquity) || 0 : undefined;
      const subAvailableBalance = subWallet ? parseFloat(subWallet.totalAvailableBalance) || 0 : undefined;
      walletCacheByUser.set(userId, {
        totalEquity,
        totalAvailableBalance,
        ...(subEquity !== undefined && { subEquity }),
        ...(subAvailableBalance !== undefined && { subAvailableBalance }),
      });
      if (subHedgingEnabled && subEquity !== undefined) {
        const minBal = Math.min(totalEquity, subEquity);
        console.log(`[autoBot] Balances synced - Main: $${totalEquity.toFixed(2)}, Sub: $${subEquity.toFixed(2)}. Using Min: $${minBal.toFixed(2)} for quantity calculation.`);
      }
    } catch (e) {
      console.error('[autoBot] getWalletBalance (prefetch) failed:', e);
    }
  }

  const subHasScheduledTimers = subHedgingEnabled && candidates.some(
    (c) => entryTimeoutByCycle.has(entryCycleKey(userId, c.symbol, c.nextFundingTime))
  );

  let totalWalletBalance = 0;
  let tradeMargin = 0;
  let cachedAvailableMargin = 0;
  if (inEntryWindow) {
    const cache = walletCacheByUser.get(userId);
    if (cache) {
      totalWalletBalance = cache.totalEquity;
      cachedAvailableMargin = cache.totalAvailableBalance;
      const capPct = (settings.capitalPercent ?? 0) / 100;
      if (subHedgingEnabled && cache.subEquity != null) {
        const minEquity = Math.min(cache.totalEquity, cache.subEquity);
        tradeMargin = minEquity * capPct;
        cachedAvailableMargin = Math.min(cache.totalAvailableBalance, cache.subAvailableBalance ?? cache.totalAvailableBalance);
      } else {
        tradeMargin = totalWalletBalance * capPct;
      }
    } else if (subHasScheduledTimers) {
      // Sub-hedging with precision timers already scheduled: fetch balances instead of skipping so timers have data when they fire
      try {
        let mainEquity = 0;
        let mainAvailable = 0;
        const wallet = await getWalletBalance(apiKey, apiSecret);
        mainEquity = parseFloat(wallet.totalEquity) || 0;
        mainAvailable = parseFloat(wallet.totalAvailableBalance) || 0;
        let subEquity: number | null = null;
        let subAvailable: number | null = null;
        if (subKeys) {
          const subWallet = await getWalletBalance(subKeys.subApiKey, subKeys.subApiSecret);
          subEquity = parseFloat(subWallet.totalEquity) || 0;
          subAvailable = parseFloat(subWallet.totalAvailableBalance) || 0;
        }
        totalWalletBalance = mainEquity;
        cachedAvailableMargin = subEquity != null ? Math.min(mainAvailable, subAvailable ?? mainAvailable) : mainAvailable;
        const minBalance = subEquity != null ? Math.min(mainEquity, subEquity) : mainEquity;
        tradeMargin = minBalance * ((settings.capitalPercent ?? 0) / 100);
        walletCacheByUser.set(userId, {
          totalEquity: mainEquity,
          totalAvailableBalance: mainAvailable,
          ...(subEquity != null && { subEquity, subAvailableBalance: subAvailable ?? 0 }),
        });
      } catch (e) {
        if (debugSkip) console.log('[DEBUG] Trade Skipped Reason: Entry window but no wallet cache (critical path)');
        console.warn('[autoBot] Entry window but no wallet cache; fetch failed:', e);
        return;
      }
    } else {
      if (debugSkip) console.log('[DEBUG] Trade Skipped Reason: Entry window but no wallet cache (critical path)');
      console.warn('[autoBot] Entry window but no wallet cache; skip to avoid getWalletBalance in critical path');
      return;
    }
  } else {
    try {
      let mainEquity = 0;
      let mainAvailable = 0;
      const wallet = await getWalletBalance(apiKey, apiSecret);
      mainEquity = parseFloat(wallet.totalEquity) || 0;
      mainAvailable = parseFloat(wallet.totalAvailableBalance) || 0;
      let subEquity: number | null = null;
      let subAvailable: number | null = null;
      if (subHedgingEnabled && subKeys) {
        const subWallet = await getWalletBalance(subKeys.subApiKey, subKeys.subApiSecret);
        subEquity = parseFloat(subWallet.totalEquity) || 0;
        subAvailable = parseFloat(subWallet.totalAvailableBalance) || 0;
      }
      totalWalletBalance = mainEquity;
      cachedAvailableMargin = subEquity != null ? Math.min(mainAvailable, subAvailable ?? mainAvailable) : mainAvailable;
      const minBalance = subEquity != null ? Math.min(mainEquity, subEquity) : mainEquity;
      tradeMargin = minBalance * ((settings.capitalPercent ?? 0) / 100);
      walletCacheByUser.set(userId, {
        totalEquity: mainEquity,
        totalAvailableBalance: mainAvailable,
        ...(subEquity != null && { subEquity, subAvailableBalance: subAvailable ?? 0 }),
      });
    } catch (e) {
      if (debugSkip) console.log('[DEBUG] Trade Skipped Reason: getWalletBalance failed');
      console.error('[autoBot] getWalletBalance failed:', e);
      return;
    }
  }

  const prepCandidates: EntryPrepCandidate[] = [];
  await Promise.all(
    candidates.map(async (topToken) => {
      const fundingTimeMs = parseInt(topToken.nextFundingTime, 10) || 0;
      const exactEntryTimeMs = fundingTimeMs - entryOffsetMs;
      const delayMs = exactEntryTimeMs - now;
      const subEntryOffsetMs = settings.subEntryOffsetMs ?? 10;
      const cycleKey = entryCycleKey(userId, topToken.symbol, topToken.nextFundingTime);

      const globalManualMockTarget = isManualMockActive && manualMockFundingTimeMs != null ? manualMockFundingTimeMs : 0;
      const isMock = globalManualMockTarget > 0;
      const targetTime = isMock ? globalManualMockTarget : fundingTimeMs;
      const mainOffset = entryOffsetMs;
      const maxDelayMs = isMock ? MANUAL_MOCK_COUNTDOWN_MS : ENTRY_SCHEDULE_MAX_MS;
      const nowForRange = Date.now();
      const delayMainForRange = targetTime - nowForRange - mainOffset;
      const inRangeMain = delayMainForRange <= maxDelayMs && delayMainForRange > 0;

      const hedgeMode = settings.hedgeMode !== false;
      if (subHedgingEnabled && entryTimeoutByCycle.has(cycleKey)) {
        return;
      }

      if (inRangeMain && !entryTimeoutByCycle.has(cycleKey)) {
        if (processedTokens.has(processedKey(userId, topToken.symbol, topToken.nextFundingTime))) return;
        if (enteredThisCycle.has(cycleKey)) return;
        if (Number.isNaN(delayMs) || delayMs < 0) return;
        const prepForPayload = entryPrepCacheByUser.get(userId);
        const cForPayload = prepForPayload?.candidates.find((x) => x.symbol === topToken.symbol && x.nextFundingTime === topToken.nextFundingTime);
        const side: 'Buy' | 'Sell' = topToken.fundingRate < 0 ? 'Buy' : 'Sell';
        if (hedgeMode && subKeys && prepForPayload && cForPayload && cForPayload.fixedQty != null && prepForPayload.subApiKey && prepForPayload.subApiSecret) {
          try {
            const orderbook = await getOrderbook(topToken.symbol, ORDERBOOK_SWEEP_LIMIT);
            const sweepPrice = getSweepPrice(orderbook, side, cForPayload.fixedQty);
            if (Number.isFinite(sweepPrice) && sweepPrice > 0) {
              const tickSize = cForPayload.tickSize ?? '0.01';
              const slippagePct = settings.slippageBufferPct ?? 2;
              const priceStr = applySlippageAndFormat(sweepPrice, side, slippagePct, tickSize);
              const qtyStr = formatQtyToStep(cForPayload.fixedQty, String(cForPayload.qtyStep));
              if (parseFloat(qtyStr) > 0) {
                pendingOrderPayloadByCycle.set(cycleKey, {
                  main: { apiKey: prepForPayload.apiKey, apiSecret: prepForPayload.apiSecret, symbol: topToken.symbol, side, qtyStr, priceStr },
                  sub: { apiKey: prepForPayload.subApiKey, apiSecret: prepForPayload.subApiSecret, symbol: topToken.symbol, side, qtyStr, priceStr },
                });
              }
            }
          } catch (e) {
            console.warn('[autoBot] Pre-compute payload failed, executeEntry will compute:', e);
          }
        }
        isExecutionImminent = true;
        executionImminentUntilMs = Math.max(executionImminentUntilMs, fundingTimeMs + 2000);
        let passedData: ExecuteEntryPrepData;
        if (prepForPayload && cForPayload && cForPayload.fixedQty != null) {
          passedData = { prep: prepForPayload, candidate: cForPayload };
        } else {
          const cache = walletCacheByUser.get(userId);
          const totalW = cache?.totalEquity ?? totalWalletBalance;
          const tradeM = cache && cache.subEquity != null && hedgeMode
            ? Math.min(cache.totalEquity, cache.subEquity) * ((settings.capitalPercent ?? 0) / 100)
            : totalWalletBalance * ((settings.capitalPercent ?? 0) / 100);
          const cachedAvail = cache
            ? (hedgeMode && cache.subAvailableBalance != null ? Math.min(cache.totalAvailableBalance, cache.subAvailableBalance) : cache.totalAvailableBalance)
            : cachedAvailableMargin;
          const prepBuilt: EntryPrep = {
            settings: { orderBookDepth: settings.orderBookDepth, capitalPercent: settings.capitalPercent, maxTrades, entryOffsetMs, subEntryOffsetMs: settings.subEntryOffsetMs ?? 10, slippageBufferPct: settings.slippageBufferPct ?? 2 },
            apiKey,
            apiSecret,
            totalWalletBalance: totalW,
            tradeMargin: tradeM,
            cachedAvailableMargin: cachedAvail,
            positionsCount: positions.length,
            maxTrades,
            candidates: [],
            ...(hedgeMode && subKeys && { subApiKey: subKeys.subApiKey, subApiSecret: subKeys.subApiSecret }),
            subEntryOffsetMs: settings.subEntryOffsetMs ?? 10,
          };
          let qtyStep = 0.1;
          let minOrderQty = 0;
          let maxOrderQty = 999999;
          let tickSize = '0.01';
          let futuresLeverage = settings.leverage ?? 10;
          try {
            const ls = await getInstrumentLotSize(apiKey, apiSecret, topToken.symbol);
            qtyStep = parseFloat(ls.qtyStep) || 0.1;
            minOrderQty = parseFloat(ls.minOrderQty) || 0;
            maxOrderQty = parseFloat(ls.maxMktOrderQty || ls.maxOrderQty) || 999999;
            tickSize = ls.tickSize ?? '0.01';
          } catch { /* ignore */ }
          try {
            const details = await getInstrumentDetails(topToken.symbol);
            futuresLeverage = Math.min(settings.leverage ?? 10, parseFloat(details.maxLeverage) || futuresLeverage);
          } catch { /* ignore */ }
          let fixedQty: number | undefined;
          try {
            const ob = await getOrderBookDepth(apiKey, apiSecret, topToken.symbol, settings.orderBookDepth ?? 2);
            const entryPrice = side === 'Buy' ? ob.askPrice : ob.bidPrice;
            if (Number.isFinite(entryPrice) && entryPrice > 0) {
              const rawQty = (tradeM * futuresLeverage) / entryPrice;
              const step = qtyStep;
              const stepDecimals = step.toString().includes('.') ? step.toString().split('.')[1]!.length : 0;
              let q = parseFloat((Math.floor(rawQty / step) * step).toFixed(stepDecimals));
              if (q > maxOrderQty) q = parseFloat((Math.floor(maxOrderQty / step) * step).toFixed(stepDecimals));
              if (q >= minOrderQty) fixedQty = q;
            }
          } catch { /* ignore */ }
          const candidateBuilt: EntryPrepCandidate = {
            symbol: topToken.symbol,
            nextFundingTime: topToken.nextFundingTime,
            fundingRate: topToken.fundingRate,
            side,
            safeLeverage: futuresLeverage,
            qtyStep,
            minOrderQty,
            maxOrderQty,
            tickSize,
            ...(fixedQty != null && { fixedQty }),
          };
          passedData = { prep: prepBuilt, candidate: candidateBuilt };
        }
        const leverageForEntry = passedData.candidate.safeLeverage ?? settings.leverage ?? 10;
        setLeverage(apiKey, apiSecret, topToken.symbol, leverageForEntry).catch(() => {});
        if (hedgeMode && subKeys) {
          setLeverage(subKeys.subApiKey, subKeys.subApiSecret, topToken.symbol, leverageForEntry).catch(() => {});
        }
        const scheduleNow = Date.now();
        const delayMain = targetTime - scheduleNow - mainOffset;
        const tMain = setTimeout(() => {
          executeEntry(userId, topToken.symbol, topToken.nextFundingTime, 'main', passedData).catch((e) =>
            console.error('[autoBot] executeEntry main failed', e)
          );
        }, Math.max(0, delayMain));
        if (hedgeMode && subKeys) {
          const delaySub = targetTime - scheduleNow - subEntryOffsetMs;
          const tSub = setTimeout(() => {
            executeEntry(userId, topToken.symbol, topToken.nextFundingTime, 'sub', passedData).catch((e) =>
              console.error('[autoBot] executeEntry sub failed', e)
            );
          }, Math.max(0, delaySub));
          console.log(`[autoBot] Sub-hedge entry scheduled: main in ${delayMain}ms, sub in ${delaySub}ms.`);
          entryTimeoutByCycle.set(cycleKey, { main: tMain, sub: tSub });
        } else {
          console.log(`[autoBot] Entry scheduled for Main (hedge_mode: false) in ${delayMain}ms.`);
          entryTimeoutByCycle.set(cycleKey, tMain);
        }
        return;
      }

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
          if (subHedgingEnabled && subKeys) {
            try {
              await setLeverage(subKeys.subApiKey, subKeys.subApiSecret, topToken.symbol, futuresLeverage);
            } catch {
              /* ignore */
            }
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
          let fixedQty: number | undefined;
          const cache = walletCacheByUser.get(userId);
          const minEquity = cache && cache.subEquity != null && settings.hedgeMode !== false
            ? Math.min(cache.totalEquity, cache.subEquity)
            : totalWalletBalance;
          const tradeMarginPrefetch = minEquity * ((settings.capitalPercent ?? 0) / 100);
          try {
            const ob = await getOrderBookDepth(apiKey, apiSecret, topToken.symbol, settings.orderBookDepth ?? 2);
            const entryPrice = side === 'Buy' ? ob.askPrice : ob.bidPrice;
            if (Number.isFinite(entryPrice) && entryPrice > 0) {
              const rawQty = (tradeMarginPrefetch * futuresLeverage) / entryPrice;
              const step = parseFloat(String(qtyStep)) || 0.1;
              const stepDecimals = step.toString().includes('.') ? step.toString().split('.')[1]!.length : 0;
              let q = parseFloat((Math.floor(rawQty / step) * step).toFixed(stepDecimals));
              if (q > maxOrderQty) q = parseFloat((Math.floor(maxOrderQty / step) * step).toFixed(stepDecimals));
              if (q >= minOrderQty) fixedQty = q;
            }
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
            ...(fixedQty != null && { fixedQty }),
          });
        } catch (err) {
          console.error('Prep Error:', err);
        }
        if (settings.spotHedgingEnabled) {
          const entryOffsetSec = Math.floor(entryOffsetMs / 1000);
          const countdownSecPrefetch = Math.floor(topToken.countdownMs / 1000);
          const inWindowPrefetch = countdownSecPrefetch <= entryOffsetSec && countdownSecPrefetch > Math.max(0, entryOffsetSec - 10);
          if (!inWindowPrefetch) return;
        }
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

      const spotTag = settings.spotHedgingEnabled ? ' [SPOT]' : '';
      if (subHedgingEnabled) {
        const cacheForLog = walletCacheByUser.get(userId);
        const mainCap = totalWalletBalance;
        const subCap = cacheForLog?.subEquity ?? 0;
        console.log(`[autoBot] ${topToken.symbol} - Countdown: ${countdownSec}s | Main: $${mainCap.toFixed(2)} | Sub: $${subCap.toFixed(2)} | Target: $${tradeMargin.toFixed(2)}`);
      } else {
        console.log(`[autoBot] ${topToken.symbol}${spotTag} - Countdown: ${countdownSec}s | Base Capital: $${totalWalletBalance.toFixed(2)} | Target Margin: $${tradeMargin.toFixed(2)}`);
      }

      if (enteredThisCycle.has(cycleKey)) {
        if (debugSkipToken) console.log('[DEBUG] Trade Skipped Reason: Already entered this cycle', 'symbol:', topToken.symbol);
        return;
      }

      const entryOffsetSec = Math.floor(entryOffsetMs / 1000);
      const inWindow = (isManualMockActive && subHedgingEnabled)
        ? (countdownSec <= 30 && countdownSec >= -5)
        : (countdownSec <= entryOffsetSec && countdownSec > Math.max(0, entryOffsetSec - 10));
      if (!inWindow) {
        if (debugSkipToken) console.log('[DEBUG] Trade Skipped Reason: Countdown not in entry window', 'symbol:', topToken.symbol, 'countdown:', countdownSec, 'window:', (isManualMockActive && subHedgingEnabled) ? '30 to -5s' : `${Math.max(0, entryOffsetSec - 10)}-${entryOffsetSec}s`);
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

      let spotLeverageUsed = 1;
      if (spotHedgingEnabled) {
        try {
          const marginSupported = await getSpotMarginSupport(topToken.symbol);
          spotLeverageUsed = marginSupported ? 5 : 1;
        } catch {
          spotLeverageUsed = 1;
        }
        console.log(`[autoBot] ${topToken.symbol} Hedging Mode: ${spotLeverageUsed > 1 ? 'Spot Margin' : 'Pure Spot (1x)'}`);
        const spotLeverage = spotLeverageUsed;
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
          if (finalQty <= 0) {
            console.warn(`[autoBot] Insufficient margin for minimum lot size | ${topToken.symbol}`);
            return;
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
          const stepDecimals = stepStr.includes('.') ? stepStr.split('.')[1]!.length : 0;
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
          const fundingPct = (topToken.fundingRate * 100).toFixed(4);
          console.log(`[autoBot] Executing ${topToken.symbol} | Funding: ${fundingPct}% | Direction: ${futuresSide}/${spotSide} | Hedging: true`);
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
              const slippagePct = settings.slippageBufferPct ?? 2;
              const priceStrLinear = applySlippageAndFormat(sweepPriceLinear, futuresSide, slippagePct, tickSize);
              const priceStrSpot = applySlippageAndFormat(sweepPriceSpot, spotSide, slippagePct, tickSize);
              const qtyStr = formatQtyToStep(remainingQty, qtyStepStr);
              if (parseFloat(qtyStr) <= 0) break;
              const spotOrderPromise = spotLeverageUsed > 1
                ? placeSpotMarginOrder(apiKey, apiSecret, topToken.symbol, spotSide, 'Limit', qtyStr, priceStrSpot, 'IOC')
                : placeSpotOrder(apiKey, apiSecret, topToken.symbol, spotSide, 'Limit', qtyStr, priceStrSpot, 'IOC');
              const [futuresRes, spotRes] = await Promise.all([
                placeLimitOrder(apiKey, apiSecret, topToken.symbol, futuresSide, qtyStr, priceStrLinear, 'IOC'),
                spotOrderPromise,
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
          const fundingPctNaked = (topToken.fundingRate * 100).toFixed(4);
          console.log(`[autoBot] Executing ${topToken.symbol} | Funding: ${fundingPctNaked}% | Direction: ${side}/- | Hedging: false`);
          let remainingQty = finalQty;
          let retries = 0;
          while (remainingQty > 0 && retries < MAX_IOC_RETRIES) {
            try {
              const orderbook = await getOrderbook(topToken.symbol, ORDERBOOK_SWEEP_LIMIT);
              const sweepPrice = getSweepPrice(orderbook, side, remainingQty);
              if (!Number.isFinite(sweepPrice) || sweepPrice <= 0) break;
              const slippagePct = settings.slippageBufferPct ?? 2;
              const priceStr = applySlippageAndFormat(sweepPrice, side, slippagePct, tickSize);
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
              console.log('[autoBot] Mock exit completed; mock mode off.');
            });
          }, 2000);
          isManualMockActive = false;
          manualMockFundingTimeMs = null;
          manualMockEndMs = null;
          console.log('[autoBot] Mock entry attempt done; returning to live sync.');
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

  if (inPrefetchWindow && prepCandidates.length > 0 && (!settings.spotHedgingEnabled || subHedgingEnabled)) {
    const existingPrep = entryPrepCacheByUser.get(userId);
    const inFlightCandidates = (existingPrep?.candidates ?? []).filter((c) =>
      entryTimeoutByCycle.has(entryCycleKey(userId, c.symbol, c.nextFundingTime))
    );
    const seen = new Set<string>();
    for (const p of prepCandidates) {
      seen.add(`${p.symbol}_${p.nextFundingTime}`);
    }
    for (const c of inFlightCandidates) {
      if (!seen.has(`${c.symbol}_${c.nextFundingTime}`)) {
        prepCandidates.push(c);
        seen.add(`${c.symbol}_${c.nextFundingTime}`);
      }
    }
    entryPrepCacheByUser.set(userId, {
      settings: {
        orderBookDepth: settings.orderBookDepth,
        capitalPercent: settings.capitalPercent,
        maxTrades,
        entryOffsetMs,
        slippageBufferPct: settings.slippageBufferPct ?? 2,
        ...(subHedgingEnabled && { subEntryOffsetMs: settings.subEntryOffsetMs ?? 10 }),
      },
      apiKey,
      apiSecret,
      totalWalletBalance,
      tradeMargin,
      cachedAvailableMargin,
      positionsCount: positions.length,
      maxTrades,
      candidates: prepCandidates,
      ...(subHedgingEnabled && subKeys && {
        subApiKey: subKeys.subApiKey,
        subApiSecret: subKeys.subApiSecret,
        subEntryOffsetMs: settings.subEntryOffsetMs ?? 10,
      }),
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
