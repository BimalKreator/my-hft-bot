/**
 * One-off migration: add universal_stoploss_percent to bot_settings.
 * Run from backend: npx tsx scripts/add-universal-stoploss.ts
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
  await pool.query(`
    ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS universal_stoploss_percent NUMERIC NOT NULL DEFAULT 3
  `);
  console.log('Migration done: universal_stoploss_percent added (default 3).');
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
