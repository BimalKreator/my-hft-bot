import { Response } from 'express';
import { getExchangeKeys } from '../models/exchangeModel.js';
import { decrypt } from '../utils/encryption.js';
import {
  setLeverage,
  placeMarketOrder,
  getExecutionList,
} from '../services/bybitService.js';
import { AuthRequest } from '../middleware/authMiddleware.js';

const TRADE_TYPE = ['Manual', 'Auto'] as const;
type TradeType = (typeof TRADE_TYPE)[number];

function isTradeType(s: unknown): s is TradeType {
  return typeof s === 'string' && TRADE_TYPE.includes(s as TradeType);
}

export async function executeTrade(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { symbol, side, qty, leverage, type } = req.body;
    if (
      !symbol ||
      typeof symbol !== 'string' ||
      !side ||
      (side !== 'Buy' && side !== 'Sell') ||
      qty == null ||
      (typeof qty !== 'number' && typeof qty !== 'string') ||
      leverage == null
    ) {
      res.status(400).json({
        error:
          'Missing or invalid body: symbol (string), side (Buy|Sell), qty, leverage required',
      });
      return;
    }
    if (type !== undefined && !isTradeType(type)) {
      res.status(400).json({
        error: 'type must be "Manual" or "Auto"',
      });
      return;
    }

    const keys = await getExchangeKeys(userId, 'Bybit');
    if (!keys) {
      res.status(404).json({
        error: 'No Bybit keys found. Add keys in Exchange Setup.',
      });
      return;
    }

    const apiKey = decrypt(keys.api_key);
    const apiSecret = decrypt(keys.api_secret);

    const leverageNum =
      typeof leverage === 'number' ? leverage : parseInt(String(leverage), 10);
    if (Number.isNaN(leverageNum) || leverageNum < 1) {
      res.status(400).json({ error: 'Invalid leverage' });
      return;
    }

    try {
      await setLeverage(apiKey, apiSecret, symbol, leverageNum);
    } catch {
      // Leverage may already be set; continue without failing
    }

    // Bybit Linear expects quantity in coins (tokens). Pass qty through without modification.
    const qtyStr = typeof qty === 'number' ? String(qty) : String(qty);
    const { orderId } = await placeMarketOrder(
      apiKey,
      apiSecret,
      symbol,
      side,
      qtyStr
    );

    let executedPrice = '';
    try {
      await new Promise((r) => setTimeout(r, 400));
      const executions = await getExecutionList(
        apiKey,
        apiSecret,
        'linear',
        orderId
      );
      if (executions.length > 0) {
        executedPrice = executions[0].execPrice;
      }
    } catch {
      // Best-effort; we still return orderId
    }

    res.status(200).json({ orderId, executedPrice });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Trade execution failed';
    res.status(500).json({ error: msg });
  }
}
