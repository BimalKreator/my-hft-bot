import { query } from '../config/db.js';
import { encrypt } from '../utils/encryption.js';

export async function getExchangeKeys(
  userId: number,
  exchangeName: string
): Promise<{ api_key: string; api_secret: string } | null> {
  const result = await query<{ api_key: string; api_secret: string }>(
    `SELECT api_key, api_secret FROM exchange_keys
     WHERE user_id = $1 AND exchange_name = $2
     ORDER BY id DESC LIMIT 1`,
    [userId, exchangeName]
  );
  const row = result.rows[0];
  return row ?? null;
}

export async function addExchangeKeys(
  userId: number,
  exchange: string,
  apiKey: string,
  apiSecret: string
): Promise<void> {
  const encryptedApiKey = encrypt(apiKey);
  const encryptedApiSecret = encrypt(apiSecret);

  await query(
    `INSERT INTO exchange_keys (user_id, exchange_name, api_key, api_secret)
     VALUES ($1, $2, $3, $4)`,
    [userId, exchange, encryptedApiKey, encryptedApiSecret]
  );
}
