/**
 * One-off script: print last 30 daily_snapshots for all users.
 * Run from backend: npx tsx scripts/showSnapshots.ts
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

async function main() {
  const res = await pool.query(
    `SELECT user_id, date, opening_balance, closing_balance, total_profit, profit_percent
     FROM daily_snapshots
     ORDER BY user_id, date DESC
     LIMIT 60`
  );
  console.log('Daily snapshots (last 60 rows, newest first per user):\n');
  console.table(res.rows);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
