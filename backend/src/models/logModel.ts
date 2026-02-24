import { query } from '../config/db.js';

export type BotLogType = 'INFO' | 'SELECTION' | 'ENTRY' | 'EXIT' | 'ERROR';

export interface BotLogRow {
  id: number;
  log_type: string | null;
  symbol: string | null;
  message: string | null;
  created_at: Date;
}

/**
 * Initialize bot_logs table. Call at server startup.
 */
export async function initBotLogsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS bot_logs (
      id SERIAL PRIMARY KEY,
      log_type VARCHAR(50),
      symbol VARCHAR(50),
      message TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

/**
 * Insert a log entry. Types: INFO, SELECTION, ENTRY, EXIT, ERROR.
 */
export async function insertLog(
  type: BotLogType,
  symbol: string | null,
  message: string
): Promise<void> {
  await query(
    `INSERT INTO bot_logs (log_type, symbol, message) VALUES ($1, $2, $3)`,
    [type, symbol ?? null, message]
  );
}

/**
 * Fetch recent logs, newest first. Default limit 500.
 */
export async function getLogs(limit: number = 500): Promise<BotLogRow[]> {
  const result = await query<BotLogRow>(
    `SELECT id, log_type, symbol, message, created_at
     FROM bot_logs
     ORDER BY created_at DESC
     LIMIT $1`,
    [Math.max(1, Math.min(2000, limit))]
  );
  return result.rows;
}

/**
 * Delete logs older than 48 hours. Run periodically (e.g. hourly).
 */
export async function deleteOldLogs(): Promise<number> {
  const result = await query<{ count: string }>(
    `WITH deleted AS (
       DELETE FROM bot_logs WHERE created_at < NOW() - INTERVAL '48 hours'
       RETURNING id
     )
     SELECT COUNT(*)::text AS count FROM deleted`
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}
