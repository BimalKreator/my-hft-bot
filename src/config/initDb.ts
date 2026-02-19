/**
 * Database initialization script.
 * Uses connection from db.ts (user: hft_user, password: HftBot123, database: hft_db).
 * Run once: npm run db:init
 */
import { query } from './db.js';

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS exchange_keys (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      exchange_name VARCHAR(100) NOT NULL,
      api_key TEXT NOT NULL,
      api_secret TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log('Database initialized: users and exchange_keys tables ready.');
}

initDb()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Init failed:', err);
    process.exit(1);
  });
