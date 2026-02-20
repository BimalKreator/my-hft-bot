/**
 * One-time script: create the hedge_groups table if it does not exist.
 * Uses the same pool as the app (src/config/db).
 * Run with: npx tsx create-hedge-table.ts (from backend folder)
 */
import { query } from './src/config/db.js';

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS hedge_groups (
    hedge_group_id UUID PRIMARY KEY,
    user_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    funding_amount_received NUMERIC,
    spot_qty NUMERIC NOT NULL,
    spot_entry_price NUMERIC NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

async function run() {
  await query(CREATE_TABLE_SQL);
  console.log('Table created successfully!');
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
