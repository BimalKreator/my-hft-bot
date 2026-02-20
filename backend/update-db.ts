/**
 * One-time DB update: add spot hedging and hedge exit columns to bot_settings.
 * Uses the same pool as the app (src/config/db).
 * Safe to run multiple times (IF NOT EXISTS / try-catch).
 */
import { query } from './src/config/db.js';

const TABLE = 'bot_settings';

async function run() {
  const alters: { name: string; sql: string }[] = [
    { name: 'spot_hedging_enabled', sql: `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS spot_hedging_enabled BOOLEAN NOT NULL DEFAULT false` },
    { name: 'hedge_target_pct', sql: `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS hedge_target_pct NUMERIC NOT NULL DEFAULT 2` },
    { name: 'hedge_stoploss_pct', sql: `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS hedge_stoploss_pct NUMERIC NOT NULL DEFAULT 5` },
    { name: 'hedge_pnl_depth', sql: `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS hedge_pnl_depth INTEGER NOT NULL DEFAULT 1` },
  ];

  for (const { name, sql } of alters) {
    try {
      await query(sql);
      console.log(`Added column: ${name}`);
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e.code === '42701') {
        console.log(`Column already exists: ${name}`);
      } else {
        throw err;
      }
    }
  }

  console.log('Database updated successfully!');
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
