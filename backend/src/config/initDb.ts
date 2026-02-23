import pg from 'pg';

const { Client } = pg;

const client = new Client({
  user: 'hft_user',
  password: 'HftBot123',
  host: process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  database: 'hft_db',
});

async function initDb() {
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE,
      password TEXT
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS exchange_keys (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      exchange_name TEXT,
      api_key TEXT,
      api_secret TEXT
    );
  `);
  await client.query(`ALTER TABLE exchange_keys ADD COLUMN IF NOT EXISTS sub_api_key TEXT;`).catch(() => {});
  await client.query(`ALTER TABLE exchange_keys ADD COLUMN IF NOT EXISTS sub_api_secret TEXT;`).catch(() => {});
  // One-time: copy sub keys from bot_settings into latest exchange_keys row per user (so Exchange Setup becomes source of truth)
  await client.query(`
    UPDATE exchange_keys ek
    SET sub_api_key = bs.sub_api_key, sub_api_secret = bs.sub_api_secret
    FROM bot_settings bs
    WHERE bs.user_id = ek.user_id AND bs.sub_api_key IS NOT NULL AND bs.sub_api_secret IS NOT NULL
      AND ek.sub_api_key IS NULL
      AND ek.id = (SELECT id FROM exchange_keys WHERE user_id = ek.user_id AND exchange_name = ek.exchange_name ORDER BY id DESC LIMIT 1)
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS bot_settings (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      auto_entry_enabled BOOLEAN NOT NULL DEFAULT false,
      auto_exit_enabled BOOLEAN NOT NULL DEFAULT false,
      capital_percent NUMERIC NOT NULL DEFAULT 10,
      max_trades NUMERIC NOT NULL DEFAULT 5,
      entry_time_sec NUMERIC NOT NULL DEFAULT 300,
      exit_time_sec NUMERIC NOT NULL DEFAULT 3600,
      min_funding_rate NUMERIC NOT NULL DEFAULT 0,
      leverage NUMERIC NOT NULL DEFAULT 5,
      order_book_depth INTEGER NOT NULL DEFAULT 2
    );
  `);
  await client.query(`
    ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS min_funding_rate NUMERIC NOT NULL DEFAULT 0;
  `).catch(() => {});
  await client.query(`
    ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS leverage NUMERIC NOT NULL DEFAULT 5;
  `).catch(() => {});
  await client.query(`
    ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS sl_pre_funding_enabled BOOLEAN NOT NULL DEFAULT false;
  `).catch(() => {});
  await client.query(`
    ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS sl_pre_multiplier NUMERIC NOT NULL DEFAULT 1;
  `).catch(() => {});
  await client.query(`
    ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS sl_post_funding_enabled BOOLEAN NOT NULL DEFAULT false;
  `).catch(() => {});
  try {
    await client.query('ALTER TABLE bot_settings ADD COLUMN order_book_depth INTEGER DEFAULT 2');
    console.log('Added order_book_depth column to database.');
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code !== '42701') console.error('Error adding column:', err);
  }
  try {
    await client.query('ALTER TABLE bot_settings ADD COLUMN exit_time_ms NUMERIC DEFAULT NULL');
    await client.query(
      `UPDATE bot_settings SET exit_time_ms = exit_time_sec * 1000 WHERE exit_time_ms IS NULL`
    );
    console.log('Added exit_time_ms column to database.');
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code !== '42701') console.error('Error adding exit_time_ms:', err);
  }
  try {
    await client.query('ALTER TABLE bot_settings ADD COLUMN spot_hedging_enabled BOOLEAN NOT NULL DEFAULT false');
    console.log('Added spot_hedging_enabled column to database.');
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code !== '42701') console.error('Error adding spot_hedging_enabled:', err);
  }
  try {
    await client.query('ALTER TABLE bot_settings ADD COLUMN hedge_target_pct NUMERIC NOT NULL DEFAULT 2');
    console.log('Added hedge_target_pct column to database.');
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code !== '42701') console.error('Error adding hedge_target_pct:', err);
  }
  try {
    await client.query('ALTER TABLE bot_settings ADD COLUMN hedge_stoploss_pct NUMERIC NOT NULL DEFAULT 5');
    console.log('Added hedge_stoploss_pct column to database.');
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code !== '42701') console.error('Error adding hedge_stoploss_pct:', err);
  }
  try {
    await client.query('ALTER TABLE bot_settings ADD COLUMN hedge_pnl_depth NUMERIC NOT NULL DEFAULT 1');
    console.log('Added hedge_pnl_depth column to database.');
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code !== '42701') console.error('Error adding hedge_pnl_depth:', err);
  }
  await client.query(`
    ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS universal_stoploss_percent NUMERIC NOT NULL DEFAULT 3;
  `).catch(() => {});
  await client.query(`
    ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS hedge_mode BOOLEAN NOT NULL DEFAULT true;
  `).catch(() => {});
  try {
    await client.query('ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS entry_offset_ms INTEGER');
    await client.query(
      `UPDATE bot_settings SET entry_offset_ms = entry_time_sec * 1000 WHERE entry_offset_ms IS NULL`
    );
    console.log('Added entry_offset_ms column to database.');
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code !== '42701') console.error('Error adding entry_offset_ms:', err);
  }
  await client.query(`
    ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS slippage_buffer_pct NUMERIC NOT NULL DEFAULT 2.0;
  `).catch(() => {});
  await client.query(`
    ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS auto_equalize_funds BOOLEAN NOT NULL DEFAULT false;
  `).catch(() => {});
  await client.query(`
    ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS fallback_sl_multiplier NUMERIC NOT NULL DEFAULT 1.0;
  `).catch(() => {});
  await client.query(`
    ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS cross_exchange_mode BOOLEAN NOT NULL DEFAULT false;
  `).catch(() => {});
  await client.query(`
    ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS binance_api_key TEXT;
  `).catch(() => {});
  await client.query(`
    ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS binance_api_secret TEXT;
  `).catch(() => {});
  await client.query(`
    ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS binance_entry_offset_ms INTEGER NOT NULL DEFAULT 0;
  `).catch(() => {});
  await client.query(`
    ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS target_profit_multiplier NUMERIC NOT NULL DEFAULT 1.0;
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS daily_snapshots (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      opening_balance NUMERIC NOT NULL DEFAULT 0,
      closing_balance NUMERIC NOT NULL DEFAULT 0,
      total_profit NUMERIC,
      profit_percent NUMERIC,
      UNIQUE (user_id, date)
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS deposits_withdrawals (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('DEPOSIT', 'WITHDRAWAL')),
      amount NUMERIC NOT NULL DEFAULT 0,
      note TEXT
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS closed_trades (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('Buy', 'Sell')),
      quantity NUMERIC NOT NULL,
      entry_price NUMERIC NOT NULL,
      exit_price NUMERIC NOT NULL,
      entry_time TIMESTAMPTZ,
      exit_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      fees NUMERIC NOT NULL DEFAULT 0,
      funding_received NUMERIC NOT NULL DEFAULT 0,
      gross_pnl NUMERIC NOT NULL,
      net_pnl NUMERIC NOT NULL,
      status TEXT CHECK (status IN ('manual', 'auto')),
      exit_reason TEXT
    );
  `);
  await client.query(`
    ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS exit_reason TEXT;
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS hedge_groups (
      hedge_group_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      funding_amount_received NUMERIC,
      spot_qty NUMERIC NOT NULL,
      spot_entry_price NUMERIC NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS banned_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, token)
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS trade_history (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      funding_time_ms BIGINT NOT NULL,
      funding_time TIMESTAMPTZ NOT NULL,
      main_triggered_at_ms BIGINT,
      main_order_id TEXT,
      main_exec_price NUMERIC,
      main_exec_qty NUMERIC,
      main_executed_at_ms BIGINT,
      main_ms_before_funding INTEGER,
      sub_triggered_at_ms BIGINT,
      sub_order_id TEXT,
      sub_exec_price NUMERIC,
      sub_exec_qty NUMERIC,
      sub_executed_at_ms BIGINT,
      sub_ms_before_funding INTEGER,
      sub_executed_before_funding BOOLEAN,
      reason_no_sub TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, symbol, funding_time_ms)
    );
  `);

  console.log('Tables created successfully.');
}

initDb()
  .then(() => client.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
