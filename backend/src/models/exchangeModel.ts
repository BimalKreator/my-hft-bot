import { query } from '../config/db.js';
import { encrypt, decrypt } from '../utils/encryption.js';
import { getSettings } from './settingsModel.js';

export interface ExchangeKeysRow {
  api_key: string;
  api_secret: string;
  sub_api_key?: string | null;
  sub_api_secret?: string | null;
}

export async function getExchangeKeys(
  userId: number,
  exchangeName: string
): Promise<ExchangeKeysRow | null> {
  const result = await query<ExchangeKeysRow>(
    `SELECT api_key, api_secret, sub_api_key, sub_api_secret FROM exchange_keys
     WHERE user_id = $1 AND exchange_name = $2
     ORDER BY id DESC LIMIT 1`,
    [userId, exchangeName]
  );
  const row = result.rows[0];
  return row ?? null;
}

/** Resolve decrypted sub-account keys: exchange_keys first, then fallback to bot_settings. */
export async function getSubAccountKeys(
  userId: number,
  exchangeName: string = 'Bybit'
): Promise<{ subApiKey: string; subApiSecret: string } | null> {
  const keys = await getExchangeKeys(userId, exchangeName);
  if (keys?.sub_api_key && keys?.sub_api_secret) {
    try {
      return {
        subApiKey: decrypt(keys.sub_api_key),
        subApiSecret: decrypt(keys.sub_api_secret),
      };
    } catch {
      return null;
    }
  }
  const settings = await getSettings(userId);
  if (settings.subApiKey && settings.subApiSecret) {
    try {
      return {
        subApiKey: decrypt(settings.subApiKey),
        subApiSecret: decrypt(settings.subApiSecret),
      };
    } catch {
      return { subApiKey: settings.subApiKey, subApiSecret: settings.subApiSecret };
    }
  }
  return null;
}

export async function addExchangeKeys(
  userId: number,
  exchange: string,
  apiKey: string,
  apiSecret: string,
  subApiKey?: string,
  subApiSecret?: string
): Promise<void> {
  const encryptedApiKey = encrypt(apiKey);
  const encryptedApiSecret = encrypt(apiSecret);
  const hasSub = typeof subApiKey === 'string' && typeof subApiSecret === 'string' && subApiKey.trim() !== '' && subApiSecret.trim() !== '';
  const encryptedSubKey = hasSub ? encrypt(subApiKey!) : null;
  const encryptedSubSecret = hasSub ? encrypt(subApiSecret!) : null;

  await query(
    `INSERT INTO exchange_keys (user_id, exchange_name, api_key, api_secret, sub_api_key, sub_api_secret)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, exchange, encryptedApiKey, encryptedApiSecret, encryptedSubKey, encryptedSubSecret]
  );
}
