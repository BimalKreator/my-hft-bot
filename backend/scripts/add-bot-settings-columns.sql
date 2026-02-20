-- Add missing bot_settings columns (spot hedging + hedge exit settings).
-- Run once. Safe to re-run: each ADD COLUMN will error if column exists (ignore or use IF NOT EXISTS in PG 9.5+).

-- PostgreSQL 9.5+: use IF NOT EXISTS (PG 11+ for ADD COLUMN IF NOT EXISTS)
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS spot_hedging_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS hedge_target_pct NUMERIC NOT NULL DEFAULT 2;
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS hedge_stoploss_pct NUMERIC NOT NULL DEFAULT 5;
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS hedge_pnl_depth NUMERIC NOT NULL DEFAULT 1;
