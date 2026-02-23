import cron from 'node-cron';
import { query } from '../config/db.js';
import { getExchangeKeys, getSubAccountKeys } from '../models/exchangeModel.js';
import { getSettings } from '../models/settingsModel.js';
import { decrypt } from '../utils/encryption.js';
import { getWalletBalance } from './bybitService.js';
import { getBinanceAvailableBalance } from './binanceService.js';

/** Same as statsService: used for Closing Balance = BASE_CAPITAL + wallet equity. */
const BASE_CAPITAL = 3000;
/** When no previous day snapshot exists, use this as opening balance (e.g. 2026-02-19). */
const OPENING_BALANCE_DEFAULT = 3400;
const IST = 'Asia/Kolkata';

/** Today's date in IST (YYYY-MM-DD). */
function todayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: IST });
}

/** Yesterday's date in IST (YYYY-MM-DD). */
function yesterdayIST(): string {
  const s = todayIST();
  const [y, m, d] = s.split('-').map(Number);
  const d2 = new Date(y, m - 1, d);
  d2.setDate(d2.getDate() - 1);
  return d2.toLocaleDateString('en-CA');
}

/** Date one day before the given YYYY-MM-DD. */
function dayBefore(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const d2 = new Date(y, m - 1, d);
  d2.setDate(d2.getDate() - 1);
  return d2.toLocaleDateString('en-CA');
}

/**
 * Run daily snapshot for all users with Bybit keys: at 00:00 IST we close the previous day.
 * Closing balance = same as Current Capital (BASE_CAPITAL + totalEquity).
 * Today's profit and profit % use opening = previous day's closing_balance, adjusted for D/W.
 */
async function runDailySnapshot(): Promise<void> {
  const snapshotDate = yesterdayIST();
  const openingDate = dayBefore(snapshotDate);

  const userIdsResult = await query<{ user_id: number }>(
    `SELECT DISTINCT user_id FROM exchange_keys WHERE exchange_name = 'Bybit'`
  );
  const userIds = userIdsResult.rows.map((r) => r.user_id);

  for (const userId of userIds) {
    try {
      const keys = await getExchangeKeys(userId, 'Bybit');
      if (!keys) continue;

      const apiKey = decrypt(keys.api_key);
      const apiSecret = decrypt(keys.api_secret);
      let mainEquity = 0;
      const balance = await getWalletBalance(apiKey, apiSecret);
      mainEquity = parseFloat(balance.totalEquity ?? '0') || 0;

      const settings = await getSettings(userId);
      const crossExchangeMode = !!settings.crossExchangeMode;

      const subKeys = await getSubAccountKeys(userId);
      let subEquity = 0;
      if (!crossExchangeMode && subKeys) {
        try {
          const subBalance = await getWalletBalance(subKeys.subApiKey, subKeys.subApiSecret);
          subEquity = parseFloat(subBalance.totalEquity ?? '0') || 0;
        } catch (err) {
          console.warn('[cron] Sub wallet balance fetch failed for user', userId, err instanceof Error ? err.message : String(err));
        }
      }

      let binanceBalance = 0;
      if (crossExchangeMode && settings.binanceApiKey && settings.binanceApiSecret) {
        try {
          binanceBalance = await getBinanceAvailableBalance(decrypt(settings.binanceApiKey), decrypt(settings.binanceApiSecret));
        } catch (err) {
          console.warn('[cron] Binance balance fetch failed for user', userId, err instanceof Error ? err.message : String(err));
        }
      }

      const walletEquity = crossExchangeMode ? mainEquity + binanceBalance : mainEquity + subEquity;
      const closingBalance = BASE_CAPITAL + walletEquity;
      if (crossExchangeMode && (mainEquity > 0 || binanceBalance > 0)) {
        console.log(`[cron] Daily snapshot user ${userId} capital (cross-exchange): mainEquity=${mainEquity} binanceBalance=${binanceBalance} closing=${closingBalance}`);
      } else if (subKeys && (mainEquity > 0 || subEquity > 0)) {
        console.log(`[cron] Daily snapshot user ${userId} capital (main+sub): mainEquity=${mainEquity} subEquity=${subEquity} closing=${closingBalance}`);
      }

      const openingRow = await query<{ closing_balance: string }>(
        `SELECT closing_balance FROM daily_snapshots
         WHERE user_id = $1 AND date = $2`,
        [userId, openingDate]
      );
      const opening = openingRow.rows[0]
        ? parseFloat(openingRow.rows[0].closing_balance) || 0
        : OPENING_BALANCE_DEFAULT;

      const txResult = await query<{ type: string; sum: string }>(
        `SELECT type, COALESCE(SUM(amount), 0)::text AS sum
         FROM deposits_withdrawals
         WHERE user_id = $1 AND date = $2
         GROUP BY type`,
        [userId, snapshotDate]
      );
      let deposits = 0;
      let withdrawals = 0;
      for (const row of txResult.rows) {
        const val = parseFloat(row.sum) || 0;
        if (row.type === 'DEPOSIT') deposits = val;
        else if (row.type === 'WITHDRAWAL') withdrawals = val;
      }

      const totalProfit = closingBalance - opening - deposits + withdrawals;
      const profitPercent = opening > 0 ? (totalProfit / opening) * 100 : null;

      await query(
        `INSERT INTO daily_snapshots (user_id, date, opening_balance, closing_balance, total_profit, profit_percent)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, date) DO UPDATE SET
           opening_balance = EXCLUDED.opening_balance,
           closing_balance = EXCLUDED.closing_balance,
           total_profit = EXCLUDED.total_profit,
           profit_percent = EXCLUDED.profit_percent`,
        [userId, snapshotDate, opening, closingBalance, totalProfit, profitPercent]
      );
      console.log(`[cron] Daily snapshot user ${userId} date ${snapshotDate} closing=${closingBalance} profitPct=${profitPercent ?? 'n/a'}`);
    } catch (err) {
      console.error(`[cron] Daily snapshot failed for user ${userId}:`, err);
    }
  }
}

/**
 * Schedule the daily snapshot at 00:00 IST.
 * IST = UTC+5:30, so 00:00 IST = 18:30 previous day UTC → cron "30 18 * * *"
 */
export function startDailySnapshotCron(): void {
  cron.schedule('30 18 * * *', () => {
    console.log('[cron] Running daily snapshot (00:00 IST).');
    runDailySnapshot().catch((err) => console.error('[cron] Daily snapshot error:', err));
  });
  console.log('[cron] Daily snapshot scheduled at 00:00 IST (18:30 UTC).');
}
