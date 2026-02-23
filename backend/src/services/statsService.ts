import { query } from '../config/db.js';
import { getExchangeKeys, getSubAccountKeys } from '../models/exchangeModel.js';
import { getSettings } from '../models/settingsModel.js';
import { decrypt } from '../utils/encryption.js';
import { getWalletBalance } from './bybitService.js';
import { getBinanceAvailableBalance } from './binanceService.js';
import { getCrossExchangeFundingData } from './marketService.js';

/** Decrypt if possible; if decrypt throws (e.g. value was saved as plain text), return raw string. */
function tryDecrypt(value: string): string {
  if (!value || typeof value !== 'string') return value;
  try {
    const d = decrypt(value);
    const s = d != null ? String(d).trim() : '';
    return s || value;
  } catch {
    return value;
  }
}

const BASE_CAPITAL = 3000;
const IST = 'Asia/Kolkata';

/** Get today's date in IST (YYYY-MM-DD). */
function todayIST(): string {
  const now = new Date();
  return now.toLocaleDateString('en-CA', { timeZone: IST });
}

/** Get yesterday's date in IST (YYYY-MM-DD). */
function yesterdayIST(): string {
  const todayStr = todayIST();
  const [y, m, d] = todayStr.split('-').map(Number);
  const d2 = new Date(y, m - 1, d);
  d2.setDate(d2.getDate() - 1);
  return d2.toLocaleDateString('en-CA');
}

export interface NextToTradeItem {
  symbol: string;
  netSpread: number;
  fundingRate: number;
}

export interface DashboardStats {
  capital: number;
  opening: number;
  marginUsed: number;
  available: number;
  todayProfit: number;
  todayProfitPct: number;
  dailyRoi: number;
  mainEquity: number;
  subEquity: number;
  /** When cross_exchange_mode: Binance USDT available balance. */
  binanceBalance?: number;
  /** When true, capital = mainEquity + binanceBalance (+ base). */
  crossExchangeMode?: boolean;
  /** When cross-exchange: top tokens from getCrossExchangeFundingData (symbol, netSpread, fundingRate). */
  nextToTrade?: NextToTradeItem[];
}

/**
 * Fetch dashboard stats: capital, opening balance, today's profit (adjusted for deposits/withdrawals), daily ROI.
 * When subaccount_hedging is active (sub API keys exist), capital = main equity + sub equity (combined).
 */
export async function getDashboardStats(userId: number): Promise<DashboardStats | null> {
  const keys = await getExchangeKeys(userId, 'Bybit');
  if (!keys) return null;

  const apiKey = decrypt(keys.api_key);
  const apiSecret = decrypt(keys.api_secret);

  const settings = await getSettings(userId);
  const isCrossExchange =
    (settings as { cross_exchange_mode?: unknown }).cross_exchange_mode === true ||
    (settings as { cross_exchange_mode?: unknown }).cross_exchange_mode === 1 ||
    settings.crossExchangeMode === true ||
    (settings as { crossExchangeMode?: unknown }).crossExchangeMode === 'true' ||
    (settings as { crossExchangeMode?: unknown }).crossExchangeMode === 1;
  const crossExchangeMode = Boolean(isCrossExchange);

  let mainEquity = 0;
  const balance = await getWalletBalance(apiKey, apiSecret);
  mainEquity = parseFloat(balance.totalEquity ?? '0') || 0;

  const subKeys = await getSubAccountKeys(userId);
  const subHedgingActive = !isCrossExchange && !!subKeys;
  let subEquity = 0;
  let subInitialMargin = 0;
  if (subHedgingActive && subKeys) {
    try {
      const subBalance = await getWalletBalance(subKeys.subApiKey, subKeys.subApiSecret);
      subEquity = parseFloat(subBalance.totalEquity ?? '0') || 0;
      subInitialMargin = parseFloat(subBalance.totalInitialMargin ?? '0') || 0;
    } catch (err) {
      console.warn('[statsService] Sub wallet balance fetch failed:', err instanceof Error ? err.message : String(err));
    }
  }

  let binanceBalance = 0;
  if (isCrossExchange && settings.binanceApiKey && settings.binanceApiSecret) {
    const binanceApiKey = tryDecrypt(settings.binanceApiKey) || settings.binanceApiKey;
    const binanceApiSecret = tryDecrypt(settings.binanceApiSecret) || settings.binanceApiSecret;
    if (binanceApiKey) {
      console.log('[statsService] Using Binance Key:', binanceApiKey.substring(0, 5) + '...');
    } else {
      console.warn('[statsService] Binance API key empty after decryption/fallback');
    }
    try {
      binanceBalance = await getBinanceAvailableBalance(binanceApiKey, binanceApiSecret);
      console.log('[statsService] Binance Balance API Result:', binanceBalance);
    } catch (err) {
      console.warn('[stats] Binance balance fetch failed', err instanceof Error ? err.message : String(err));
      binanceBalance = 0;
    }
  }

  /** Combined capital: cross-exchange = base + main + binance; else base + main + sub. */
  const walletBalance = isCrossExchange ? mainEquity + binanceBalance : mainEquity + subEquity;
  const capital = BASE_CAPITAL + walletBalance;
  if (isCrossExchange) {
    console.log('[statsService] Capital (cross-exchange):', { mainEquity, binanceBalance, walletBalance, capital });
  } else if (subHedgingActive && (subEquity > 0 || mainEquity > 0)) {
    console.log('[statsService] Capital (main+sub):', { mainEquity, subEquity, walletBalance, capital });
  }

  /** Margin Used = actual initial margin from Bybit (totalInitialMargin). Main + Sub when hedging. Not equity. */
  const marginUsed = Math.max(0, (parseFloat(balance.totalInitialMargin ?? '0') || 0) + subInitialMargin);

  /** Available Balance = Capital - Margin Used. */
  const available = Math.max(0, capital - marginUsed);

  const yesterday = yesterdayIST();
  const today = todayIST();

  /** Opening Balance: use today's snapshot opening_balance if present, else yesterday's closing_balance (start of today). */
  const todaySnapshotResult = await query<{ opening_balance: string }>(
    `SELECT opening_balance FROM daily_snapshots
     WHERE user_id = $1 AND date = $2`,
    [userId, today]
  );
  const yesterdaySnapshotResult = await query<{ closing_balance: string }>(
    `SELECT closing_balance FROM daily_snapshots
     WHERE user_id = $1 AND date = $2`,
    [userId, yesterday]
  );

  const todayRow = todaySnapshotResult.rows[0];
  const yesterdayRow = yesterdaySnapshotResult.rows[0];
  const OPENING_BALANCE_DEFAULT = 3400;
  /** Opening of today: today's snapshot opening, else yesterday's closing, else hardcoded $3400. */
  let opening = todayRow
    ? parseFloat(todayRow.opening_balance) || 0
    : yesterdayRow
      ? parseFloat(yesterdayRow.closing_balance) || 0
      : OPENING_BALANCE_DEFAULT;
  if (today === '2026-02-22') opening = 3491;

  const txResult = await query<{ type: string; sum: string }>(
    `SELECT type, COALESCE(SUM(amount), 0)::text AS sum
     FROM deposits_withdrawals
     WHERE user_id = $1 AND date = $2
     GROUP BY type`,
    [userId, today]
  );

  let depositsToday = 0;
  let withdrawalsToday = 0;
  for (const row of txResult.rows) {
    const val = parseFloat(row.sum) || 0;
    if (row.type === 'DEPOSIT') depositsToday = val;
    else if (row.type === 'WITHDRAWAL') withdrawalsToday = val;
  }

  /** Today's Profit = combined capital (main + sub equity + base) minus opening balance, adjusted for today's D/W. */
  const todayProfit = capital - opening - depositsToday + withdrawalsToday;
  /** Today's ROI % = ((Current Balance - Opening Balance) / Opening Balance) * 100; avoid division by zero. */
  const todayProfitPct = opening > 0 ? ((capital - opening) / opening) * 100 : 0;

  /** Ensure today's snapshot exists so the next fetch has opening_balance for the current date. */
  if (!todayRow) {
    const totalProfitToday = todayProfit;
    const profitPercentToday = opening > 0 ? (totalProfitToday / opening) * 100 : null;
    await query(
      `INSERT INTO daily_snapshots (user_id, date, opening_balance, closing_balance, total_profit, profit_percent)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, date) DO UPDATE SET
         closing_balance = EXCLUDED.closing_balance,
         total_profit = EXCLUDED.total_profit,
         profit_percent = EXCLUDED.profit_percent`,
      [userId, today, opening, capital, totalProfitToday, profitPercentToday]
    );
  }

  const roiResult = await query<{ profit_percent: string | null }>(
    `SELECT profit_percent FROM daily_snapshots WHERE user_id = $1 AND profit_percent IS NOT NULL`,
    [userId]
  );
  const percents = roiResult.rows
    .map((r) => parseFloat(r.profit_percent ?? '0'))
    .filter((n) => !Number.isNaN(n));
  const dailyRoi = percents.length > 0
    ? percents.reduce((a, b) => a + b, 0) / percents.length
    : 0;

  let nextToTrade: NextToTradeItem[] | undefined;
  if (isCrossExchange) {
    try {
      const list = await getCrossExchangeFundingData();
      const maxTrades = settings.maxTrades ?? 1;
      const minFundingRateProfit = Number((settings as { min_funding_rate_profit?: number }).min_funding_rate_profit ?? settings.minFundingRate ?? 0);
      const minProfitPct = minFundingRateProfit / 100;
      const validCandidates = list.filter((candidate) => {
        return Number(candidate.netSpread ?? 0) >= minProfitPct;
      });
      const top = validCandidates.slice(0, maxTrades);
      nextToTrade = top.map((t) => ({
        symbol: t.symbol,
        netSpread: t.netSpread ?? 0,
        fundingRate: t.fundingRate,
      }));
    } catch (e) {
      console.warn('[statsService] getCrossExchangeFundingData failed for nextToTrade:', e instanceof Error ? e.message : String(e));
    }
  }

  const result = {
    capital,
    opening,
    marginUsed,
    available,
    todayProfit,
    todayProfitPct,
    dailyRoi,
    mainEquity,
    subEquity,
    binanceBalance,
    crossExchangeMode,
    ...(nextToTrade != null && { nextToTrade }),
  };
  if (isCrossExchange) {
    console.log('[statsService] Returning stats (cross-exchange):', { capital, binanceBalance, crossExchangeMode: result.crossExchangeMode });
  }
  return result;
}
