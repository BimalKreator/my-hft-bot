/**
 * One-off migration: add entry_offset_ms to bot_settings if missing.
 * Run from backend: npx tsx scripts/add-entry-offset-ms.ts
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
  await pool.query('ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS entry_offset_ms INTEGER');
  const upd = await pool.query(
    `UPDATE bot_settings SET entry_offset_ms = entry_time_sec * 1000 WHERE entry_offset_ms IS NULL`
  );
  console.log('Migration done: entry_offset_ms column added/backfilled. Rows updated:', upd.rowCount ?? 0);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
