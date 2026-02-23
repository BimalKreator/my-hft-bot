/**
 * Binance Futures (USDT-M) data: REST + WebSocket cache for mark price and funding rate.
 * Used by the cross-exchange scanner and cross-exchange execution (order placement, balance).
 */

import axios from 'axios';
import crypto from 'crypto';
import https from 'https';
import WebSocket from 'ws';

const EXCHANGE_INFO_URL = 'https://fapi.binance.com/fapi/v1/exchangeInfo';

/** Cached exchange info for PRICE_FILTER / LOT_SIZE; refreshed once per process. */
let exchangeInfoCache: { symbols: Array<{ symbol: string; filters: Array<{ filterType: string; tickSize?: string; stepSize?: string }> }> } | null = null;

export async function getBinanceExchangeInfo(): Promise<typeof exchangeInfoCache> {
  if (exchangeInfoCache) return exchangeInfoCache;
  try {
    const res = await axios.get(EXCHANGE_INFO_URL);
    exchangeInfoCache = res.data as typeof exchangeInfoCache;
    return exchangeInfoCache;
  } catch (e) {
    console.error('[binanceService] Failed to fetch Binance exchange info', e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * Format qty and price to Binance tick/step so LIMIT orders pass "Price not increased by tick size" and "Precision is over the maximum".
 */
export async function formatBinanceOrderParams(
  symbol: string,
  qty: string | number,
  price: string | number
): Promise<{ safeQty: string; safePrice: string }> {
  const info = await getBinanceExchangeInfo();
  if (!info) return { safeQty: String(qty), safePrice: String(price) };

  const symbolData = info.symbols.find((s: { symbol: string }) => s.symbol === symbol);
  if (!symbolData) return { safeQty: String(qty), safePrice: String(price) };

  const priceFilter = symbolData.filters.find((f: { filterType: string }) => f.filterType === 'PRICE_FILTER');
  const lotFilter = symbolData.filters.find((f: { filterType: string }) => f.filterType === 'LOT_SIZE');

  let safePrice = Number(price);
  let safeQty = Number(qty);

  if (priceFilter?.tickSize != null) {
    const tickSize = Number(priceFilter.tickSize);
    if (tickSize > 0) safePrice = Math.floor(safePrice / tickSize) * tickSize;
  }
  if (lotFilter?.stepSize != null) {
    const stepSize = Number(lotFilter.stepSize);
    if (stepSize > 0) safeQty = Math.floor(safeQty / stepSize) * stepSize;
  }

  return {
    safeQty: String(parseFloat(safeQty.toFixed(10))),
    safePrice: String(parseFloat(safePrice.toFixed(10))),
  };
}

const BINANCE_BASE = 'fapi.binance.com';
const PREMIUM_INDEX_URL = `https://${BINANCE_BASE}/fapi/v1/premiumIndex`;
const FUNDING_INFO_URL = `https://${BINANCE_BASE}/fapi/v1/fundingInfo`;

/** In-memory cache: symbol -> funding interval in milliseconds (for strict cross-exchange matching). */
export const binanceIntervalCache: Record<string, number> = {};

/** Previous nextFundingTime per symbol for dynamic interval detection when a funding cycle completes. */
const previousBinanceNextFundingTime: Record<string, number> = {};

/** Keep-alive agent for low-latency signed REST (order/balance). */
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  scheduling: 'fifo',
  maxSockets: 8,
});
const WS_BASE = 'wss://fstream.binance.com';
/** Combined stream: all symbols mark price + funding rate, 1s updates */
const WS_STREAM = '!markPrice@arr@1s';

export interface BinanceSymbolData {
  symbol: string;
  markPrice: string;
  fundingRate: number;
  nextFundingTime: number;
  fundingIntervalHours: number;
}

const cache = new Map<string, BinanceSymbolData>();
let ws: WebSocket | null = null;
let restPromise: Promise<void> | null = null;

/** Binance USDT-M: support 1h, 2h, 4h, 8h, 24h. Deduce from nextFundingTime (UTC timestamp). Fallback when cache missing. */
function deduceIntervalHours(nextFundingTimeMs: number, _serverTimeMs: number): number {
  const oneHourMs = 3600000;
  const twoHoursMs = 2 * oneHourMs;
  const fourHoursMs = 4 * oneHourMs;
  const eightHoursMs = 8 * oneHourMs;
  const twentyFourHoursMs = 24 * oneHourMs;
  const mod24 = nextFundingTimeMs % twentyFourHoursMs;
  const mod8 = nextFundingTimeMs % eightHoursMs;
  const mod4 = nextFundingTimeMs % fourHoursMs;
  const mod2 = nextFundingTimeMs % twoHoursMs;
  const mod1 = nextFundingTimeMs % oneHourMs;
  if (mod24 === 0) return 24;
  if (mod8 === 0) return 8;
  if (mod4 === 0) return 4;
  if (mod2 === 0) return 2;
  if (mod1 === 0) return 1;
  return 8;
}

/** Fetch funding interval per symbol from Binance REST and populate binanceIntervalCache (ms). Call once at backend start. */
export async function fetchBinanceFundingInfo(): Promise<void> {
  try {
    const res = await fetch(FUNDING_INFO_URL);
    if (!res.ok) throw new Error(`fundingInfo ${res.status}`);
    const raw = (await res.json()) as FundingInfoRow | FundingInfoRow[];
    const rows = Array.isArray(raw) ? raw : [raw];
    const oneHourMs = 3600000;
    for (const row of rows) {
      const symbol = String(row?.symbol ?? '');
      if (!symbol) continue;
      const hours = Number((row as { fundingIntervalHours?: number }).fundingIntervalHours ?? (row as { fundingInterval?: number }).fundingInterval ?? 8);
      binanceIntervalCache[symbol] = hours * oneHourMs;
    }
    console.log('[binanceService] fetchBinanceFundingInfo: loaded', Object.keys(binanceIntervalCache).length, 'symbols');
  } catch (e) {
    console.warn('[binanceService] fetchBinanceFundingInfo failed:', e instanceof Error ? e.message : String(e));
  }
}

interface FundingInfoRow {
  symbol?: string;
  fundingIntervalHours?: number;
  fundingInterval?: number;
}

async function fetchPremiumIndex(): Promise<void> {
  const res = await fetch(PREMIUM_INDEX_URL);
  if (!res.ok) throw new Error(`Binance premiumIndex failed: ${res.status}`);
  const raw = (await res.json()) as PremiumIndexRow | PremiumIndexRow[];
  const rows = Array.isArray(raw) ? raw : [raw];
  const now = Date.now();
  const oneHourMs = 3600000;
  for (const row of rows) {
    const symbol = String(row.symbol ?? '');
    if (!symbol) continue;
    const nextFundingTime = Number(row.nextFundingTime) || 0;
    const time = Number(row.time) ?? now;
    const intervalMs = binanceIntervalCache[symbol];
    const intervalHours = intervalMs != null ? intervalMs / oneHourMs : deduceIntervalHours(nextFundingTime, time);
    cache.set(symbol, {
      symbol,
      markPrice: String(row.markPrice ?? '0'),
      fundingRate: parseFloat(row.lastFundingRate ?? '0'),
      nextFundingTime,
      fundingIntervalHours: intervalHours,
    });
  }
}

/** Start WebSocket and keep cache updated. Call once at app startup (or when scanner is first used). */
export function startBinanceWebSocket(): void {
  if (ws != null) return;
  const url = `${WS_BASE}/ws/${WS_STREAM}`;
  ws = new WebSocket(url);
  ws.on('open', () => {
    // Initial snapshot comes from REST; WS only updates
  });
  ws.on('message', (raw: Buffer | string) => {
    try {
      const str = typeof raw === 'string' ? raw : raw.toString('utf8');
      const data = JSON.parse(str) as MarkPriceWsMessage | MarkPriceWsMessage[];
      const updates = Array.isArray(data) ? data : [data];
      const oneHourMs = 3600000;
      for (const u of updates) {
        const symbol = u.s ?? '';
        if (!symbol) continue;
        const existing = cache.get(symbol);
        const newNextFundingTime = u.T ?? existing?.nextFundingTime ?? 0;
        const prev = previousBinanceNextFundingTime[symbol];
        if (prev != null && newNextFundingTime > prev) {
          const dynamicIntervalMs = newNextFundingTime - prev;
          binanceIntervalCache[symbol] = dynamicIntervalMs;
        }
        previousBinanceNextFundingTime[symbol] = newNextFundingTime;
        const intervalMs = binanceIntervalCache[symbol];
        const intervalHours = intervalMs != null ? intervalMs / oneHourMs : (existing?.fundingIntervalHours ?? 8);
        cache.set(symbol, {
          symbol,
          markPrice: String(u.p ?? existing?.markPrice ?? '0'),
          fundingRate: parseFloat(String(u.r ?? existing?.fundingRate ?? 0)),
          nextFundingTime: newNextFundingTime,
          fundingIntervalHours: intervalHours,
        });
      }
    } catch {
      // ignore parse errors
    }
  });
  ws.on('error', () => {
    // reconnect handled below
  });
  ws.on('close', () => {
    ws = null;
    // optional: reconnect after delay
    setTimeout(() => {
      if (cache.size > 0) startBinanceWebSocket();
    }, 5000);
  });
}

/** Ensure REST snapshot has been fetched (and optionally start WS). Returns current cache. */
export async function getBinanceDataMap(): Promise<Map<string, BinanceSymbolData>> {
  if (restPromise == null) {
    restPromise = fetchPremiumIndex();
    startBinanceWebSocket();
  }
  await restPromise;
  return new Map(cache);
}

/** Get data for one symbol (from cache; may be stale if WS not yet received). */
export function getBinanceSymbol(symbol: string): BinanceSymbolData | undefined {
  return cache.get(symbol);
}

/** Build query string from params (keys sorted), then append &signature=HMAC_SHA256(query, secret). */
function signParams(apiSecret: string, params: Record<string, string | number>): string {
  const keys = Object.keys(params).sort();
  const query = keys.map((k) => `${k}=${encodeURIComponent(String(params[k]))}`).join('&');
  const sig = crypto.createHmac('sha256', apiSecret).update(query).digest('hex');
  return `${query}&signature=${sig}`;
}

/** Strip newlines, carriage returns, and spaces so headers/signature don't get invalid characters. */
function cleanBinanceKey(val: string): string {
  return String(val).replace(/[\r\n\s]/g, '');
}

/** Signed REST request to Binance Futures (uses keepAlive agent). */
function binanceSignedRequest(
  apiKey: string,
  apiSecret: string,
  method: 'GET' | 'POST',
  path: string,
  bodyParams: Record<string, string | number>
): Promise<unknown> {
  const cleanKey = cleanBinanceKey(apiKey);
  const cleanSecret = cleanBinanceKey(apiSecret);
  if (!cleanKey || !cleanSecret || cleanKey.length < 10) {
    return Promise.reject(new Error('Invalid Binance API key or secret (missing or too short after cleanup)'));
  }
  const params = { ...bodyParams, timestamp: Date.now(), recvWindow: 10000 };
  const query = signParams(cleanSecret, params);
  return new Promise((resolve, reject) => {
    const pathWithQuery = method === 'GET' ? `${path}?${query}` : path;
    const req = https.request(
      {
        hostname: BINANCE_BASE,
        path: pathWithQuery,
        method,
        agent: keepAliveAgent,
        headers: {
          'X-MBX-APIKEY': cleanKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            const data = JSON.parse(raw);
            if (data.code != null && data.code !== 0) {
              reject(new Error(data.msg ?? `Binance error ${data.code}`));
              return;
            }
            resolve(data);
          } catch {
            reject(new Error(raw || 'Binance request failed'));
          }
        });
      }
    );
    req.on('error', reject);
    if (method === 'POST') req.write(query);
    req.end();
  });
}

/** Get USDT available balance for Binance Futures (cross margin). Returns 0 on error or no USDT. */
export async function getBinanceAvailableBalance(apiKey: string, apiSecret: string): Promise<number> {
  let raw: unknown;
  try {
    raw = await binanceSignedRequest(apiKey, apiSecret, 'GET', '/fapi/v2/balance', {});
  } catch (err) {
    const errMsg = err && typeof err === 'object' && 'response' in err
      ? String((err as { response?: { data?: unknown } }).response?.data ?? (err as Error).message)
      : (err instanceof Error ? err.message : String(err));
    console.error('[binanceService] API Error:', errMsg);
    throw err;
  }

  const data = Array.isArray(raw)
    ? raw
    : (raw as { balances?: Array<Record<string, unknown>> }).balances;
  if (!Array.isArray(data)) {
    console.error('[binanceService] Balance response is not an array:', typeof raw);
    return 0;
  }
  const usdtAsset = data.find((r: { asset?: string }) => r.asset === 'USDT') as Record<string, unknown> | undefined;
  if (!usdtAsset) return 0;

  const availableBalance = usdtAsset.availableBalance ?? usdtAsset.available_balance;
  const crossWalletBalance = usdtAsset.crossWalletBalance ?? usdtAsset.cross_wallet_balance;
  const balanceStr = String(availableBalance ?? crossWalletBalance ?? '0').trim();
  const value = parseFloat(balanceStr) || 0;
  return value;
}

/** Position risk row from GET /fapi/v2/positionRisk (one-way mode). */
export interface BinancePositionRisk {
  positionAmt: number;
  unRealizedProfit: number;
  entryPrice: number;
}

/**
 * Fetch open position for a symbol from Binance Futures (USDT-M).
 * Returns null if no open position or symbol not found.
 */
export async function getBinancePositions(
  apiKey: string,
  apiSecret: string,
  symbol: string
): Promise<BinancePositionRisk | null> {
  const all = await getBinanceAllPositions(apiKey, apiSecret);
  return all.find((p) => p.symbol === symbol) ?? null;
}

/** One position from getBinanceAllPositions (includes symbol). */
export interface BinancePositionRiskWithSymbol extends BinancePositionRisk {
  symbol: string;
}

/**
 * Fetch all open positions from Binance Futures (USDT-M) with positionAmt !== 0.
 */
export async function getBinanceAllPositions(
  apiKey: string,
  apiSecret: string
): Promise<BinancePositionRiskWithSymbol[]> {
  const raw = await binanceSignedRequest(apiKey, apiSecret, 'GET', '/fapi/v2/positionRisk', {});
  const list = Array.isArray(raw) ? raw : (raw as { positions?: unknown[] }).positions;
  if (!Array.isArray(list)) return [];
  const out: BinancePositionRiskWithSymbol[] = [];
  for (const row of list as Array<{ symbol?: string; positionAmt?: string; unRealizedProfit?: string; entryPrice?: string }>) {
    const symbol = row.symbol ?? '';
    if (!symbol) continue;
    const amt = parseFloat(row.positionAmt ?? '0') || 0;
    if (amt === 0) continue;
    out.push({
      symbol,
      positionAmt: amt,
      unRealizedProfit: parseFloat(row.unRealizedProfit ?? '0') || 0,
      entryPrice: parseFloat(row.entryPrice ?? '0') || 0,
    });
  }
  return out;
}

const CROSS_EXCHANGE_IOC_SLIPPAGE_PCT = 3; // 2–4% worse price to ensure fill

/**
 * Close an open Binance Futures position.
 * currentPositionAmt: from getBinancePositions (positive = long, negative = short).
 * Long → SELL to close; Short → BUY to close.
 * @param orderType - 'MARKET' (default): market reduce-only. 'IOC': limit IOC with mark price ± slippage (2–4%) to ensure fill.
 */
export async function closeBinancePosition(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  currentPositionAmt: number,
  orderType: 'MARKET' | 'IOC' = 'MARKET'
): Promise<{ orderId: number }> {
  const absQty = Math.abs(currentPositionAmt);
  if (absQty <= 0) throw new Error('closeBinancePosition: positionAmt is zero');
  const side: 'BUY' | 'SELL' = currentPositionAmt > 0 ? 'SELL' : 'BUY';

  if (orderType === 'IOC') {
    let binanceData = getBinanceSymbol(symbol);
    if (!binanceData) await getBinanceDataMap();
    binanceData = getBinanceSymbol(symbol);
    const markPrice = binanceData ? parseFloat(binanceData.markPrice) : 0;
    if (!Number.isFinite(markPrice) || markPrice <= 0) throw new Error('closeBinancePosition IOC: no mark price');
    const slippage = CROSS_EXCHANGE_IOC_SLIPPAGE_PCT / 100;
    const price = side === 'SELL' ? markPrice * (1 - slippage) : markPrice * (1 + slippage);
    const { safeQty, safePrice } = await formatBinanceOrderParams(symbol, absQty, price);
    const data = (await binanceSignedRequest(apiKey, apiSecret, 'POST', '/fapi/v1/order', {
      symbol,
      side,
      type: 'LIMIT',
      timeInForce: 'IOC',
      quantity: safeQty,
      price: safePrice,
      reduceOnly: 'true',
    })) as { orderId: number };
    return { orderId: data.orderId };
  }

  const { safeQty } = await formatBinanceOrderParams(symbol, absQty, 0);
  const data = (await binanceSignedRequest(apiKey, apiSecret, 'POST', '/fapi/v1/order', {
    symbol,
    side,
    type: 'MARKET',
    quantity: safeQty,
    reduceOnly: 'true',
  })) as { orderId: number };
  return { orderId: data.orderId };
}

/**
 * Place a LIMIT IOC order on Binance Futures. qty/price can be number or pre-formatted string from formatBinanceOrderParams.
 * @returns orderId (number)
 */
export async function placeBinanceOrder(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  side: 'BUY' | 'SELL',
  qty: number | string,
  price: number | string
): Promise<{ orderId: number }> {
  const qtyStr = String(qty);
  const priceStr = String(price);
  const data = (await binanceSignedRequest(apiKey, apiSecret, 'POST', '/fapi/v1/order', {
    symbol,
    side,
    type: 'LIMIT',
    timeInForce: 'IOC',
    quantity: qtyStr,
    price: priceStr,
  })) as { orderId: number };
  return { orderId: data.orderId };
}

interface PremiumIndexRow {
  symbol?: string;
  markPrice?: string;
  indexPrice?: string;
  lastFundingRate?: string;
  nextFundingTime?: number;
  time?: number;
}

interface MarkPriceWsMessage {
  e?: string;
  E?: number;
  s?: string;
  p?: string;
  i?: string;
  P?: string;
  r?: string;
  T?: number;
}
