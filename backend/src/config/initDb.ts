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
    CREATE TABLE IF NOT EXISTS banned_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, token)
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
