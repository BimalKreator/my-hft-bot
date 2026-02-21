import { Response } from 'express';
import { getExchangeKeys, getSubAccountKeys } from '../models/exchangeModel.js';
import { decrypt } from '../utils/encryption.js';
import { placeMarketOrderReduceOnly, getPositionList } from '../services/bybitService.js';
import { AuthRequest } from '../middleware/authMiddleware.js';

/**
 * POST /api/positions/close — Close hedge (main + sub) for a symbol.
 * Body: { symbol: string }.
 * Requires subaccount hedging (sub-account keys in Exchange Setup).
 * Calls placeMarketOrderReduceOnly twice (main, sub); one failure does not block the other.
 */
export async function closePosition(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const symbol = req.body?.symbol;
    if (!symbol || typeof symbol !== 'string') {
      console.log('[API] Manual Close rejected: missing or invalid symbol', req.body);
      res.status(400).json({ error: 'Body must include symbol (string).' });
      return;
    }

    console.log('[API] Manual Close requested for', symbol);

    const subKeys = await getSubAccountKeys(userId);
    if (!subKeys) {
      console.log('[API] Manual Close rejected: subaccount hedging not configured');
      res.status(400).json({ error: 'Subaccount hedging not configured. Add sub-account keys in Exchange Setup.' });
      return;
    }

    const keys = await getExchangeKeys(userId, 'Bybit');
    if (!keys) {
      console.log('[API] Manual Close rejected: no Bybit keys');
      res.status(404).json({ error: 'No Bybit keys found.' });
      return;
    }

    const mainKey = decrypt(keys.api_key);
    const mainSecret = decrypt(keys.api_secret);

    console.log('[API] Fetching main and sub positions for', symbol);
    const [mainPositions, subPositions] = await Promise.all([
      getPositionList(mainKey, mainSecret, { category: 'linear', settleCoin: 'USDT' }),
      getPositionList(subKeys.subApiKey, subKeys.subApiSecret, { category: 'linear', settleCoin: 'USDT' }),
    ]);

    const mainPos = mainPositions.find((p) => p.symbol === symbol && parseFloat(p.size) > 0);
    const subPos = subPositions.find((p) => p.symbol === symbol && parseFloat(p.size) > 0);

    if (!mainPos && !subPos) {
      console.log('[API] Manual Close: no open position for', symbol, 'on main or sub');
      res.status(400).json({ error: `No open position for ${symbol} on main or sub.` });
      return;
    }

    const mainClose =
      mainPos
        ? placeMarketOrderReduceOnly(mainKey, mainSecret, symbol, mainPos.side, mainPos.size)
            .then((r) => {
              console.log('[API] Main close ok for', symbol);
              return { account: 'main' as const, ok: true, result: r };
            })
            .catch((e) => {
              console.error('[API] Main close failed for', symbol, e);
              return { account: 'main' as const, ok: false, error: e };
            })
        : Promise.resolve({ account: 'main' as const, ok: true, skipped: true });

    const subClose =
      subPos
        ? placeMarketOrderReduceOnly(subKeys.subApiKey, subKeys.subApiSecret, symbol, subPos.side, subPos.size)
            .then((r) => {
              console.log('[API] Sub close ok for', symbol);
              return { account: 'sub' as const, ok: true, result: r };
            })
            .catch((e) => {
              console.error('[API] Sub close failed for', symbol, e);
              return { account: 'sub' as const, ok: false, error: e };
            })
        : Promise.resolve({ account: 'sub' as const, ok: true, skipped: true });

    const [mainResult, subResult] = await Promise.all([mainClose, subClose]);

    const mainOk = mainResult.ok;
    const subOk = subResult.ok;
    if (!mainOk && !subOk && !('skipped' in mainResult) && !('skipped' in subResult)) {
      console.log('[API] Manual Close: both main and sub close failed for', symbol);
      res.status(500).json({
        error: 'Both main and sub close failed.',
        mainError: mainResult.error instanceof Error ? mainResult.error.message : String(mainResult.error),
        subError: subResult.error instanceof Error ? subResult.error.message : String(subResult.error),
      });
      return;
    }

    const message =
      mainOk && subOk
        ? 'Hedge closed (main + sub).'
        : mainOk && !subOk
          ? 'Main closed; sub close failed (check logs).'
          : !mainOk && subOk
            ? 'Sub closed; main close failed (check logs).'
            : 'Hedge close completed with partial success.';
    console.log('[API] Manual Close completed for', symbol, message);
    res.status(200).json({ ok: true, message });
  } catch (err) {
    console.error('[API] Manual Close error:', err);
    const msg = err instanceof Error ? err.message : 'Close failed';
    res.status(500).json({ error: msg });
  }
}
