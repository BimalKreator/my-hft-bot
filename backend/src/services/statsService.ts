import { query } from '../config/db.js';
import { getExchangeKeys } from '../models/exchangeModel.js';
import { getSettings } from '../models/settingsModel.js';
import { decrypt } from '../utils/encryption.js';
import { getWalletBalance, getPositionList } from './bybitService.js';

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

export interface DashboardStats {
  capital: number;
  opening: number;
  marginUsed: number;
  available: number;
  todayProfit: number;
  todayProfitPct: number;
  dailyRoi: number;
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

  let mainEquity = 0;
  const balance = await getWalletBalance(apiKey, apiSecret);
  mainEquity = parseFloat(balance.totalEquity ?? '0') || 0;

  const settings = await getSettings(userId);
  const subHedgingActive = !!(settings.subApiKey && settings.subApiSecret);
  let subEquity = 0;
  if (subHedgingActive && settings.subApiKey && settings.subApiSecret) {
    let subKey = settings.subApiKey;
    let subSecret = settings.subApiSecret;
    try {
      const dKey = decrypt(settings.subApiKey);
      const dSecret = decrypt(settings.subApiSecret);
      if (dKey && dSecret) {
        subKey = dKey;
        subSecret = dSecret;
      }
    } catch {
      /* use plain (subKey/subSecret already set from settings) */
    }
    try {
      const subBalance = await getWalletBalance(subKey, subSecret);
      subEquity = parseFloat(subBalance.totalEquity ?? '0') || 0;
    } catch (err) {
      console.warn('[statsService] Sub wallet balance fetch failed:', err instanceof Error ? err.message : String(err));
      subEquity = 0;
    }
  }

  const walletBalance = mainEquity + subEquity;
  const capital = BASE_CAPITAL + walletBalance;
  if (subHedgingActive && (subEquity > 0 || mainEquity > 0)) {
    console.log('[statsService] Capital (main+sub):', { mainEquity, subEquity, walletBalance, capital });
  }

  /** Margin Used = sum of (position.size * position.avgPrice) over main (and sub when hedging) active positions. */
  let marginUsed = 0;
  try {
    const positions = await getPositionList(apiKey, apiSecret, { category: 'linear', settleCoin: 'USDT' });
    for (const pos of positions) {
      const size = parseFloat(pos.size) || 0;
      const avgPrice = parseFloat(pos.avgPrice) || 0;
      marginUsed += size * avgPrice;
    }
    if (subHedgingActive && settings.subApiKey && settings.subApiSecret) {
      let subKey = settings.subApiKey;
      let subSecret = settings.subApiSecret;
      try {
        const dKey = decrypt(settings.subApiKey);
        const dSecret = decrypt(settings.subApiSecret);
        if (dKey && dSecret) {
          subKey = dKey;
          subSecret = dSecret;
        }
      } catch {
        /* use plain */
      }
      const subPositions = await getPositionList(subKey, subSecret, { category: 'linear', settleCoin: 'USDT' });
      for (const pos of subPositions) {
        const size = parseFloat(pos.size) || 0;
        const avgPrice = parseFloat(pos.avgPrice) || 0;
        marginUsed += size * avgPrice;
      }
    }
  } catch {
    marginUsed = 0;
  }

  /** Available Balance = Capital Balance - Margin Used. */
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
  const opening = todayRow
    ? parseFloat(todayRow.opening_balance) || 0
    : yesterdayRow
      ? parseFloat(yesterdayRow.closing_balance) || 0
      : OPENING_BALANCE_DEFAULT;

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

  return {
    capital,
    opening,
    marginUsed,
    available,
    todayProfit,
    todayProfitPct,
    dailyRoi,
  };
}
