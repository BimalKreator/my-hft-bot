import { query } from '../config/db.js';

export async function getBannedTokens(userId: number): Promise<string[]> {
  const result = await query<{ token: string }>(
    `SELECT token FROM banned_tokens WHERE user_id = $1`,
    [userId]
  );
  return result.rows.map((r) => r.token);
}

export async function addBannedToken(
  userId: number,
  token: string,
  reason?: string
): Promise<void> {
  await query(
    `INSERT INTO banned_tokens (user_id, token, reason)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, token) DO UPDATE SET reason = EXCLUDED.reason, created_at = NOW()`,
    [userId, token, reason ?? null]
  );
}

export async function removeBannedToken(userId: number, token: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM banned_tokens WHERE user_id = $1 AND token = $2`,
    [userId, token]
  );
  return (result.rowCount ?? 0) > 0;
}
