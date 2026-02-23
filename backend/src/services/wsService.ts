/**
 * Bybit private WebSocket: position stream for real-time orphan exit.
 * When a position update shows size === "0" (closed via SL/TP or manually), we call verifyAndCloseOrphan(symbol)
 * so the other exchange leg is closed immediately instead of waiting for polling.
 */

import { WebsocketClient } from 'bybit-api';
import { getUsersWithAutoEntryEnabled } from '../models/settingsModel.js';
import { getSettings } from '../models/settingsModel.js';
import { getExchangeKeys } from '../models/exchangeModel.js';
import { decrypt } from '../utils/encryption.js';
import { verifyAndCloseOrphan } from './autoBotService.js';

const testnet = process.env.BYBIT_TESTNET === 'true';

/** userId -> WebsocketClient for position stream (cross-exchange users only). */
const positionClientsByUserId = new Map<number, WebsocketClient>();

/** Debounce: avoid firing verifyAndCloseOrphan multiple times for the same symbol in quick succession. */
const lastOrphanTriggerBySymbol = new Map<string, number>();
const ORPHAN_DEBOUNCE_MS = 3000;

function handlePositionUpdate(userId: number, data: unknown): void {
  const list = Array.isArray(data) ? data : (data as { data?: unknown[] })?.data;
  if (!Array.isArray(list)) return;
  for (const item of list) {
    const row = item as { symbol?: string; size?: string };
    const symbol = row?.symbol;
    const size = row?.size;
    if (!symbol || size !== '0') continue;
    const now = Date.now();
    if (now - (lastOrphanTriggerBySymbol.get(symbol) ?? 0) < ORPHAN_DEBOUNCE_MS) continue;
    lastOrphanTriggerBySymbol.set(symbol, now);
    verifyAndCloseOrphan(userId, symbol).catch((e) =>
      console.error('[wsService] verifyAndCloseOrphan failed', symbol, e)
    );
  }
}

/**
 * Start position WebSocket for each user with cross-exchange mode.
 * On position update with size === "0", calls verifyAndCloseOrphan(userId, symbol).
 */
export async function startPositionStreamForOrphanExit(): Promise<void> {
  const userIds = await getUsersWithAutoEntryEnabled();
  for (const userId of userIds) {
    try {
      const settings = await getSettings(userId);
      const crossExchange =
        (settings as { cross_exchange_mode?: unknown }).cross_exchange_mode === true ||
        settings.crossExchangeMode === true;
      if (!crossExchange) continue;

      const keys = await getExchangeKeys(userId, 'Bybit');
      if (!keys) continue;

      const apiKey = decrypt(keys.api_key);
      const apiSecret = decrypt(keys.api_secret);
      if (!apiKey || !apiSecret) continue;

      if (positionClientsByUserId.has(userId)) continue;

      const client = new WebsocketClient({
        key: apiKey,
        secret: apiSecret,
        testnet,
        market: 'v5',
        recvWindow: 5000,
      });

      client.on('update', (event: { topic?: string; data?: unknown }) => {
        if (event?.topic === 'position' && event.data != null) {
          handlePositionUpdate(userId, event.data);
        }
      });
      client.on('error', (err) => {
        console.warn('[wsService] position stream error for user', userId, err);
      });

      await client.subscribeV5('position', 'linear', true);
      positionClientsByUserId.set(userId, client);
      console.log('[wsService] position stream started for user', userId);
    } catch (e) {
      console.warn('[wsService] failed to start position stream for user', userId, e);
    }
  }
}
