/**
 * One-time fix: Set 2026-02-18 closing = $3400, so 2026-02-19 opening = $3400.
 * Recalculate total_profit and profit_percent for 2026-02-19 and all later days.
 * Run from backend: npx tsx scripts/fixSnapshotOpening.ts
 */
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: '.env' });

const pool = new pg.Pool({
  user: process.env.DB_USER ?? 'hft_user',
  password: process.env.DB_PASSWORD ?? 'HftBot123',
  host: process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  database: process.env.DB_NAME ?? 'hft_db',
});

const HARDCODED_OPENING_2026_02_19 = 3400; // closing of 2026-02-18 = opening of 2026-02-19

async function getDepositsWithdrawals(userId: number, date: string): Promise<{ deposits: number; withdrawals: number }> {
  const res = await pool.query<{ type: string; sum: string }>(
    `SELECT type, COALESCE(SUM(amount), 0)::text AS sum
     FROM deposits_withdrawals
     WHERE user_id = $1 AND date = $2
     GROUP BY type`,
    [userId, date]
  );
  let deposits = 0;
  let withdrawals = 0;
  for (const row of res.rows) {
    const val = parseFloat(row.sum) || 0;
    if (row.type === 'DEPOSIT') deposits = val;
    else if (row.type === 'WITHDRAWAL') withdrawals = val;
  }
  return { deposits, withdrawals };
}

async function main() {
  const client = await pool.connect();

  try {
    // 1) Insert or update 2026-02-18: closing_balance = 3400, opening_balance = 3400
    await client.query(
      `INSERT INTO daily_snapshots (user_id, date, opening_balance, closing_balance, total_profit, profit_percent)
       SELECT user_id, '2026-02-18'::date, 3400, 3400, 0, 0
       FROM (SELECT DISTINCT user_id FROM daily_snapshots) u
       ON CONFLICT (user_id, date) DO UPDATE SET
         opening_balance = 3400,
         closing_balance = 3400,
         total_profit = 0,
         profit_percent = 0`
    );
    console.log('Set 2026-02-18 closing_balance = 3400 for all users with snapshots.');

    // 2) Get all (user_id, date) rows with date >= 2026-02-19, ordered by user then date asc
    const rows = await client.query<{ user_id: number; date: string; closing_balance: string }>(
      `SELECT user_id, date, closing_balance
       FROM daily_snapshots
       WHERE date >= '2026-02-19'
       ORDER BY user_id, date ASC`
    );

    for (const row of rows.rows) {
      const userId = row.user_id;
      const date = row.date;
      const closingBalance = parseFloat(row.closing_balance) || 0;

      let opening: number;
      const dateStr = typeof date === 'string' ? date.slice(0, 10) : String(date).slice(0, 10);
      if (dateStr === '2026-02-19') {
        opening = HARDCODED_OPENING_2026_02_19;
      } else {
        const prev = await client.query<{ closing_balance: string }>(
          `SELECT closing_balance FROM daily_snapshots
           WHERE user_id = $1 AND date = $2::date - INTERVAL '1 day'`,
          [userId, date]
        );
        opening = prev.rows[0] ? parseFloat(prev.rows[0].closing_balance) || 0 : HARDCODED_OPENING_2026_02_19;
      }

      const { deposits, withdrawals } = await getDepositsWithdrawals(userId, date);
      const totalProfit = closingBalance - opening - deposits + withdrawals;
      const profitPercent = opening > 0 ? (totalProfit / opening) * 100 : null;

      await client.query(
        `UPDATE daily_snapshots
         SET opening_balance = $1, total_profit = $2, profit_percent = $3
         WHERE user_id = $4 AND date = $5`,
        [opening, totalProfit, profitPercent, userId, date]
      );
      console.log(`Updated ${date} user ${userId}: opening=${opening} total_profit=${totalProfit.toFixed(2)} profit_percent=${profitPercent?.toFixed(4) ?? 'null'}`);
    }

    console.log('Done.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
