/**
 * One-off migration: add subaccount hedging columns to bot_settings.
 * Run from backend: npx tsx scripts/add-subaccount-columns.ts
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
  await pool.query('ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS sub_api_key TEXT');
  await pool.query('ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS sub_api_secret TEXT');
  await pool.query('ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS sub_entry_offset_ms INTEGER DEFAULT 10');
  const upd = await pool.query(
    `UPDATE bot_settings SET sub_entry_offset_ms = 10 WHERE sub_entry_offset_ms IS NULL`
  );
  console.log('Migration done: sub_api_key, sub_api_secret, sub_entry_offset_ms added. Rows updated:', upd.rowCount ?? 0);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
