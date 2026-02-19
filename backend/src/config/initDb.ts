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
      exit_time_sec NUMERIC NOT NULL DEFAULT 3600
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
