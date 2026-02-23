/**
 * Binance Futures (USDT-M) data: REST + WebSocket cache for mark price and funding rate.
 * Used by the cross-exchange scanner to match with Bybit symbols.
 */

import WebSocket from 'ws';

const PREMIUM_INDEX_URL = 'https://fapi.binance.com/fapi/v1/premiumIndex';
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
