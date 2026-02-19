import { query } from '../config/db.js';
import { getExchangeKeys } from '../models/exchangeModel.js';
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
 */
export async function getDashboardStats(userId: number): Promise<DashboardStats | null> {
  const keys = await getExchangeKeys(userId, 'Bybit');
  if (!keys) return null;

  const apiKey = decrypt(keys.api_key);
  const apiSecret = decrypt(keys.api_secret);

  const balance = await getWalletBalance(apiKey, apiSecret);
  const walletBalance = parseFloat(balance.totalEquity ?? '0') || 0;
  const capital = BASE_CAPITAL + walletBalance;

  /** Margin Used = sum of (position.size * position.avgPrice) over all active positions. Not exchange margin. */
  let marginUsed = 0;
  try {
    const positions = await getPositionList(apiKey, apiSecret, { category: 'linear', settleCoin: 'USDT' });
    for (const pos of positions) {
      const size = parseFloat(pos.size) || 0;
      const avgPrice = parseFloat(pos.avgPrice) || 0;
      marginUsed += size * avgPrice;
    }
  } catch {
    marginUsed = 0;
  }

  /** Available Balance = Capital Balance - Margin Used. */
  const available = Math.max(0, capital - marginUsed);

  const yesterday = yesterdayIST();
  const today = todayIST();

  const snapshotResult = await query<{ closing_balance: string }>(
    `SELECT closing_balance FROM daily_snapshots
     WHERE user_id = $1 AND date = $2`,
    [userId, yesterday]
  );
  const openingRow = snapshotResult.rows[0];
  /** If no snapshot for yesterday, strictly use hardcoded opening balance. */
  const OPENING_BALANCE_DEFAULT = 3400;
  const opening = openingRow
    ? parseFloat(openingRow.closing_balance) || 0
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
  const todayProfitPct = opening > 0 ? (todayProfit / opening) * 100 : 0;

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
