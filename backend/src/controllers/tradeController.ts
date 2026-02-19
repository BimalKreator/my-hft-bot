import { Response } from 'express';
import { getExchangeKeys } from '../models/exchangeModel.js';
import { decrypt } from '../utils/encryption.js';
import {
  setLeverage,
  placeMarketOrder,
  placeMarketOrderReduceOnly,
  getExecutionList,
  getPositionList,
} from '../services/bybitService.js';
import { getEnrichedPositions } from '../services/vwapService.js';
import { AuthRequest } from '../middleware/authMiddleware.js';
import { insertClosedTrade, getClosedTrades } from '../models/closedTradesModel.js';

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

/**
 * Close a position with a market reduce-only order. Body: symbol, side (Buy|Sell), qty (or size), optional exitReason (e.g. 'Manual', 'Stoploss Hit', 'Time Exit').
 * After success, computes PnL and inserts a row into closed_trades with exit_reason.
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

    const { symbol, side, qty, size, exitReason: bodyExitReason, fundingReceived: bodyFundingReceived } = req.body;
    const exitReason = typeof bodyExitReason === 'string' && bodyExitReason.trim()
      ? bodyExitReason.trim()
      : 'Manual';
    const fundingReceived = typeof bodyFundingReceived === 'number' && !Number.isNaN(bodyFundingReceived)
      ? bodyFundingReceived
      : 0;
    const qtyVal = qty ?? size;
    if (
      !symbol ||
      typeof symbol !== 'string' ||
      !side ||
      (side !== 'Buy' && side !== 'Sell') ||
      qtyVal == null ||
      (typeof qtyVal !== 'number' && typeof qtyVal !== 'string')
    ) {
      res.status(400).json({
        error: 'Missing or invalid body: symbol (string), side (Buy|Sell), qty or size required',
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
    const qtyStr = typeof qtyVal === 'number' ? String(qtyVal) : String(qtyVal);
    const qtyNum = typeof qtyVal === 'number' ? qtyVal : parseFloat(String(qtyVal));

    // Get current position for entry price before closing
    let entryPrice = 0;
    try {
      const positions = await getPositionList(apiKey, apiSecret, { category: 'linear', settleCoin: 'USDT' });
      const pos = positions.find((p) => p.symbol === symbol && p.side === side);
      if (pos) entryPrice = parseFloat(pos.avgPrice) || 0;
    } catch {
      // Proceed without entry price; gross_pnl will be wrong but close still succeeds
    }

    const { orderId } = await placeMarketOrderReduceOnly(
      apiKey,
      apiSecret,
      symbol,
      side,
      qtyStr
    );

    // After successful close: execution list for exit price and fees, then save closed trade
    let exitPrice = 0;
    let fees = 0;
    try {
      await new Promise((r) => setTimeout(r, 400));
      const executions = await getExecutionList(apiKey, apiSecret, 'linear', orderId);
      if (executions.length > 0) {
        let totalQty = 0;
        let sumPxQty = 0;
        for (const e of executions) {
          const eq = parseFloat(e.execQty) || 0;
          const ep = parseFloat(e.execPrice) || 0;
          totalQty += eq;
          sumPxQty += ep * eq;
          const fee = parseFloat(e.execFee ?? '0') || 0;
          fees += fee;
        }
        exitPrice = totalQty > 0 ? sumPxQty / totalQty : parseFloat(executions[0]!.execPrice) || 0;
      }
    } catch {
      // Best-effort; still save closed trade with exitPrice 0 / fees 0 if needed
    }

    const grossPnl = side === 'Buy'
      ? (exitPrice - entryPrice) * qtyNum
      : (entryPrice - exitPrice) * qtyNum;
    // Net PnL = Gross PnL - Fees + fundingReceived (persisted via insertClosedTrade)

    await insertClosedTrade({
      userId,
      symbol,
      side,
      entryPrice,
      exitPrice,
      qty: qtyNum,
      grossPnl,
      funding: fundingReceived,
      fees,
      source: 'manual',
      exitReason,
    });

    res.status(200).json({ orderId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Close position failed';
    res.status(500).json({ error: msg });
  }
}

/**
 * Get dashboard positions (enriched with VWAP, PnL, SL/target). Uses vwapService.getEnrichedPositions.
 */
export async function getDashboardPositions(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const positions = await getEnrichedPositions(userId);
    res.status(200).json(positions);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to load dashboard positions';
    res.status(500).json({ error: msg });
  }
}

/**
 * GET /api/trade/history — closed trades with optional filters: from, to (date), token (symbol), profit, loss.
 */
export async function getTradeHistory(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    const token = typeof req.query.token === 'string' ? req.query.token : undefined;
    const profit = req.query.profit === 'true' || req.query.profit === '1';
    const loss = req.query.loss === 'true' || req.query.loss === '1';

    const rows = await getClosedTrades(userId, { from, to, token, profit, loss });
    // Map DB columns (token, direction, quantity, exit_time) to frontend shape (symbol, side, qty, closed_at)
    const mapped = rows.map((r) => ({
      ...r,
      symbol: r.token,
      side: r.direction,
      qty: r.quantity,
      closed_at: r.exit_time,
    }));
    res.status(200).json(mapped);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to load trade history';
    res.status(500).json({ error: msg });
  }
}
