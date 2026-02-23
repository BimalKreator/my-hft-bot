/**
 * Binance Futures (USDT-M) data: REST + WebSocket cache for mark price and funding rate.
 * Used by the cross-exchange scanner and cross-exchange execution (order placement, balance).
 */

import crypto from 'crypto';
import https from 'https';
import WebSocket from 'ws';

const BINANCE_BASE = 'fapi.binance.com';
const PREMIUM_INDEX_URL = `https://${BINANCE_BASE}/fapi/v1/premiumIndex`;

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

/** Binance USDT-M standard interval is 8h; some symbols use 4h. Deduce from nextFundingTime vs time. */
function deduceIntervalHours(nextFundingTimeMs: number, serverTimeMs: number): number {
  const msToNext = nextFundingTimeMs - serverTimeMs;
  const eightHoursMs = 8 * 60 * 60 * 1000;
  const fourHoursMs = 4 * 60 * 60 * 1000;
  // If next funding is in ~0–4h, could be 4h cycle; if ~0–8h, 8h cycle. Use remainder to detect cycle length.
  const mod8 = nextFundingTimeMs % eightHoursMs;
  const mod4 = nextFundingTimeMs % fourHoursMs;
  // Binance 8h: 00:00, 08:00, 16:00 UTC -> nextFundingTime % 28800000 is consistent. 4h: 00, 04, 08, 12, 16, 20.
  if (mod4 === 0 && mod8 !== 0) return 4;
  return 8;
}

async function fetchPremiumIndex(): Promise<void> {
  const res = await fetch(PREMIUM_INDEX_URL);
  if (!res.ok) throw new Error(`Binance premiumIndex failed: ${res.status}`);
  const raw = (await res.json()) as PremiumIndexRow | PremiumIndexRow[];
  const rows = Array.isArray(raw) ? raw : [raw];
  const now = Date.now();
  for (const row of rows) {
    const symbol = String(row.symbol ?? '');
    if (!symbol) continue;
    const nextFundingTime = Number(row.nextFundingTime) || 0;
    const time = Number(row.time) ?? now;
    const intervalHours = deduceIntervalHours(nextFundingTime, time);
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
      for (const u of updates) {
        const symbol = u.s ?? '';
        if (!symbol) continue;
        const existing = cache.get(symbol);
        const nextFundingTime = u.T ?? existing?.nextFundingTime ?? 0;
        const intervalHours = existing?.fundingIntervalHours ?? 8;
        cache.set(symbol, {
          symbol,
          markPrice: String(u.p ?? existing?.markPrice ?? '0'),
          fundingRate: parseFloat(String(u.r ?? existing?.fundingRate ?? 0)),
          nextFundingTime,
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

/** Signed REST request to Binance Futures (uses keepAlive agent). */
function binanceSignedRequest(
  apiKey: string,
  apiSecret: string,
  method: 'GET' | 'POST',
  path: string,
  bodyParams: Record<string, string | number>
): Promise<unknown> {
  const params = { ...bodyParams, timestamp: Date.now() };
  const query = signParams(apiSecret, params);
  return new Promise((resolve, reject) => {
    const pathWithQuery = method === 'GET' ? `${path}?${query}` : path;
    const req = https.request(
      {
        hostname: BINANCE_BASE,
        path: pathWithQuery,
        method,
        agent: keepAliveAgent,
        headers: {
          'X-MBX-APIKEY': apiKey,
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
  console.log('[binanceService] Raw USDT Asset Data:', usdtAsset ?? null);
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
    const data = (await binanceSignedRequest(apiKey, apiSecret, 'POST', '/fapi/v1/order', {
      symbol,
      side,
      type: 'LIMIT',
      timeInForce: 'IOC',
      quantity: String(absQty),
      price: String(price),
      reduceOnly: 'true',
    })) as { orderId: number };
    return { orderId: data.orderId };
  }

  const data = (await binanceSignedRequest(apiKey, apiSecret, 'POST', '/fapi/v1/order', {
    symbol,
    side,
    type: 'MARKET',
    quantity: String(absQty),
    reduceOnly: 'true',
  })) as { orderId: number };
  return { orderId: data.orderId };
}

/**
 * Place a LIMIT IOC order on Binance Futures. Optimized for 5–10ms latency (keepAlive + built-in crypto).
 * @returns orderId (number)
 */
export async function placeBinanceOrder(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  side: 'BUY' | 'SELL',
  qty: number,
  price: number
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
