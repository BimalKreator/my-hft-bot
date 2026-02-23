import { Response } from 'express';
import { getExchangeKeys, getSubAccountKeys } from '../models/exchangeModel.js';
import { decrypt } from '../utils/encryption.js';
import {
  setLeverage,
  placeMarketOrder,
  placeMarketOrderReduceOnly,
  getExecutionList,
  getPositionList,
  getClosedPnl,
  getWalletBalance,
} from '../services/bybitService.js';
import { getBinanceSymbol, getBinanceAvailableBalance, placeBinanceOrder } from '../services/binanceService.js';
import { FundingScanner } from '../services/scannerService.js';
import { getCrossExchangeFundingData } from '../services/marketService.js';
import { getEnrichedPositions } from '../services/vwapService.js';
import { getLastEntryReport } from '../services/autoBotService.js';
import { AuthRequest } from '../middleware/authMiddleware.js';
import { insertClosedTrade, getClosedTrades } from '../models/closedTradesModel.js';
import { getTradeHistoryByUserId } from '../models/tradeHistoryModel.js';
import { getSettings } from '../models/settingsModel.js';

const fundingScanner = new FundingScanner();

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

    const { symbol, side, qty, leverage, type, isCrossExchange: bodyCrossExchange } = req.body;
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

    const settings = await getSettings(userId);
    const isCrossExchange = bodyCrossExchange === true && !!settings.crossExchangeMode && !!settings.binanceApiKey && !!settings.binanceApiSecret;

    if (isCrossExchange) {
      // Cross-exchange manual: targetQty = min(Bybit capacity, Binance capacity); sides from funding spread; fire both with offset timeouts.
      const bybitBalance = await getWalletBalance(apiKey, apiSecret);
      const bybitAvailable = parseFloat(bybitBalance.totalAvailableBalance ?? '0') || 0;
      const binanceKey = decrypt(settings.binanceApiKey!);
      const binanceSecret = decrypt(settings.binanceApiSecret!);
      const binanceAvailable = await getBinanceAvailableBalance(binanceKey, binanceSecret);
      const binanceData = getBinanceSymbol(symbol);
      const marketData = await getCrossExchangeFundingData();
      const bybitToken = marketData.find((m) => m.symbol === symbol);
      const bybitFundingRate = bybitToken?.fundingRate ?? 0;
      const binanceFundingRate = binanceData?.fundingRate ?? bybitToken?.binanceFundingRate ?? 0;
      const markBinance = binanceData ? parseFloat(binanceData.markPrice) || 0 : 0;
      const markBybit = bybitToken ? parseFloat(bybitToken.markPrice ?? '0') || 0 : markBinance;
      const priceForQty = Math.max(markBybit, markBinance) || 1;
      const bybitMaxQty = priceForQty > 0 && markBybit > 0 ? (bybitAvailable * leverageNum) / markBybit : 0;
      const binanceMaxQty = priceForQty > 0 && markBinance > 0 ? (binanceAvailable * leverageNum) / markBinance : 0;
      const targetQtyNum = Math.min(
        typeof qty === 'number' ? qty : parseFloat(String(qty)) || 0,
        bybitMaxQty,
        binanceMaxQty
      );
      if (targetQtyNum <= 0) {
        res.status(400).json({ error: 'Insufficient balance on Bybit or Binance for cross-exchange quantity.' });
        return;
      }
      const bybitSide = binanceFundingRate > bybitFundingRate ? 'Buy' : 'Sell';
      const binanceSide = bybitSide === 'Buy' ? 'SELL' : 'BUY';
      const qtyStr = String(targetQtyNum);
      const entryOffsetMs = settings.entryOffsetMs ?? 0;
      const binanceEntryOffsetMs = settings.binanceEntryOffsetMs ?? 0;

      try {
        await setLeverage(apiKey, apiSecret, symbol, leverageNum);
      } catch {
        // continue
      }

      const runBybit = () => placeMarketOrder(apiKey, apiSecret, symbol, bybitSide, qtyStr);
      const runBinance = () => {
        const slippagePct = settings.slippageBufferPct ?? 2;
        const mult = binanceSide === 'BUY' ? 1 + slippagePct / 100 : 1 - slippagePct / 100;
        const price = (binanceData ? parseFloat(binanceData.markPrice) : 0) * mult || priceForQty * mult;
        return placeBinanceOrder(binanceKey, binanceSecret, symbol, binanceSide, targetQtyNum, price);
      };

      const delayBybit = Math.max(0, entryOffsetMs);
      const delayBinance = Math.max(0, binanceEntryOffsetMs);

      const [bybitResult, binanceResult] = await Promise.all([
        delayBybit === 0 ? runBybit() : new Promise<{ orderId: string }>((res, rej) => setTimeout(() => runBybit().then(res).catch(rej), delayBybit)),
        delayBinance === 0 ? runBinance() : new Promise<{ orderId: number }>((res, rej) => setTimeout(() => runBinance().then(res).catch(rej), delayBinance)),
      ]);

      console.log(`[trade] Manual cross-exchange executed: ${symbol} Bybit ${bybitSide} orderId=${bybitResult.orderId} Binance ${binanceSide} orderId=${binanceResult.orderId} qty=${qtyStr}`);
      let executedPrice = '';
      try {
        await new Promise((r) => setTimeout(r, 400));
        const executions = await getExecutionList(apiKey, apiSecret, 'linear', bybitResult.orderId);
        if (executions.length > 0) executedPrice = executions[0].execPrice;
      } catch {
        // best-effort
      }
      res.status(200).json({ orderId: bybitResult.orderId, executedPrice, binanceOrderId: binanceResult.orderId });
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

    const { symbol, side, qty, size, exitReason: bodyExitReason, fundingReceived: bodyFundingReceived, accountType: bodyAccountType, hedgeClose: bodyHedgeClose } = req.body;
    const exitReason = typeof bodyExitReason === 'string' && bodyExitReason.trim()
      ? bodyExitReason.trim()
      : 'Manual';
    const fundingReceived = typeof bodyFundingReceived === 'number' && !Number.isNaN(bodyFundingReceived)
      ? bodyFundingReceived
      : 0;
    const useSubAccount = bodyAccountType === 'sub';
    const hedgeClose = bodyHedgeClose === true;
    const qtyVal = qty ?? size;

    if (hedgeClose) {
      if (!symbol || typeof symbol !== 'string') {
        res.status(400).json({ error: 'hedgeClose requires symbol (string).' });
        return;
      }
      const subKeys = await getSubAccountKeys(userId);
      if (!subKeys) {
        res.status(400).json({ error: 'Subaccount hedging not configured. Add sub-account keys in Exchange Setup.' });
        return;
      }
      const keys = await getExchangeKeys(userId, 'Bybit');
      if (!keys) {
        res.status(404).json({ error: 'No Bybit keys found.' });
        return;
      }
      const mainKey = decrypt(keys.api_key);
      const mainSecret = decrypt(keys.api_secret);
      const [mainPositions, subPositions] = await Promise.all([
        getPositionList(mainKey, mainSecret, { category: 'linear', settleCoin: 'USDT' }),
        getPositionList(subKeys.subApiKey, subKeys.subApiSecret, { category: 'linear', settleCoin: 'USDT' }),
      ]);
      const mainPos = mainPositions.find((p) => p.symbol === symbol);
      const subPos = subPositions.find((p) => p.symbol === symbol);
      const closes: Promise<{ orderId: string; orderLinkId: string }>[] = [];
      if (mainPos && parseFloat(mainPos.size) > 0) {
        closes.push(placeMarketOrderReduceOnly(mainKey, mainSecret, symbol, mainPos.side, mainPos.size));
      }
      if (subPos && parseFloat(subPos.size) > 0) {
        closes.push(placeMarketOrderReduceOnly(subKeys.subApiKey, subKeys.subApiSecret, symbol, subPos.side, subPos.size));
      }
      if (closes.length === 0) {
        res.status(400).json({ error: `No open position for ${symbol} on main or sub.` });
        return;
      }
      await Promise.all(closes);
      res.status(200).json({ ok: true, message: 'Hedge closed (main + sub).' });
      return;
    }

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

    let apiKey: string;
    let apiSecret: string;
    if (useSubAccount) {
      const subKeys = await getSubAccountKeys(userId);
      if (!subKeys) {
        res.status(400).json({ error: 'Sub-account close requested but no sub-account keys. Add them in Exchange Setup.' });
        return;
      }
      apiKey = subKeys.subApiKey;
      apiSecret = subKeys.subApiSecret;
    } else {
      const keys = await getExchangeKeys(userId, 'Bybit');
      if (!keys) {
        res.status(404).json({
          error: 'No Bybit keys found. Add keys in Exchange Setup.',
        });
        return;
      }
      apiKey = decrypt(keys.api_key);
      apiSecret = decrypt(keys.api_secret);
    }

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

    await new Promise((r) => setTimeout(r, 2000));
    let exitPrice = 0;
    let fees = 0;
    let grossPnl: number;
    let exactNetPnl: number | undefined;
    try {
      const closedList = await getClosedPnl(apiKey, apiSecret, 'linear', symbol, 50);
      const nowMs = Date.now();
      const recent = closedList.filter((row) => {
        const ut = parseInt(row.updatedTime, 10) || 0;
        return ut >= nowMs - 15_000 && ut <= nowMs + 1000;
      });
      if (recent.length > 0) {
        const sumClosedPnl = recent.reduce((s, r) => s + (parseFloat(r.closedPnl) || 0), 0);
        const exactTotalFee = recent.reduce((s, r) => s + (parseFloat(r.openFee) || 0) + (parseFloat(r.closeFee) || 0), 0);
        exactNetPnl = sumClosedPnl + fundingReceived;
        fees = exactTotalFee;
        grossPnl = exactNetPnl + exactTotalFee - fundingReceived;
        const avgExit = recent[0].avgExitPrice;
        if (avgExit) exitPrice = parseFloat(avgExit) || 0;
      } else {
        const executions = await getExecutionList(apiKey, apiSecret, 'linear', orderId);
        if (executions.length > 0) {
          let totalQty = 0;
          let sumPxQty = 0;
          for (const e of executions) {
            const eq = parseFloat(e.execQty) || 0;
            const ep = parseFloat(e.execPrice) || 0;
            totalQty += eq;
            sumPxQty += ep * eq;
            fees += parseFloat(e.execFee ?? '0') || 0;
          }
          exitPrice = totalQty > 0 ? sumPxQty / totalQty : parseFloat(executions[0]!.execPrice) || 0;
        }
        grossPnl = side === 'Buy'
          ? (exitPrice - entryPrice) * qtyNum
          : (entryPrice - exitPrice) * qtyNum;
      }
    } catch {
      const executions = await getExecutionList(apiKey, apiSecret, 'linear', orderId);
      if (executions.length > 0) {
        let totalQty = 0;
        let sumPxQty = 0;
        for (const e of executions) {
          const eq = parseFloat(e.execQty) || 0;
          const ep = parseFloat(e.execPrice) || 0;
          totalQty += eq;
          sumPxQty += ep * eq;
          fees += parseFloat(e.execFee ?? '0') || 0;
        }
        exitPrice = totalQty > 0 ? sumPxQty / totalQty : parseFloat(executions[0]!.execPrice) || 0;
      }
      grossPnl = side === 'Buy'
        ? (exitPrice - entryPrice) * qtyNum
        : (entryPrice - exitPrice) * qtyNum;
    }

    const entryPriceStored = Number(entryPrice.toFixed(6));
    const exitPriceStored = Number(exitPrice.toFixed(6));

    await insertClosedTrade({
      userId,
      symbol,
      side,
      entryPrice: entryPriceStored,
      exitPrice: exitPriceStored,
      qty: qtyNum,
      grossPnl,
      funding: fundingReceived,
      fees,
      ...(exactNetPnl != null && { netPnl: exactNetPnl }),
      source: 'manual',
      exitReason,
      exchange: 'Bybit Main',
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

/** Map Bybit closed PnL row to frontend history shape; accountType is injected by caller. */
function mapBybitClosedPnlToHistoryRow(
  r: { symbol?: string; side?: string; closedSize?: string; qty?: string; avgEntryPrice?: string; avgExitPrice?: string; closedPnl: string; openFee: string; closeFee: string; updatedTime: string },
  accountType: 'Main' | 'Sub',
  index: number
): { id: string; symbol: string; side: string; qty: string; entry_price: string; exit_price: string; closed_at: string; fees: string; funding_received: string; gross_pnl: string; net_pnl: string; exit_reason: string | null; exitReason: string | null; accountType: 'Main' | 'Sub'; exchange: string } {
  const symbol = r.symbol ?? '';
  const side = r.side ?? '';
  const qty = r.closedSize ?? r.qty ?? '0';
  const entryPrice = r.avgEntryPrice ?? '0';
  const exitPrice = r.avgExitPrice ?? '0';
  const openFee = parseFloat(r.openFee) || 0;
  const closeFee = parseFloat(r.closeFee) || 0;
  const fees = openFee + closeFee;
  const closedPnl = parseFloat(r.closedPnl) || 0;
  const netPnl = closedPnl - fees;
  const updatedTime = r.updatedTime;
  const closedAt = /^\d+$/.test(updatedTime) ? new Date(parseInt(updatedTime, 10)).toISOString() : updatedTime;
  return {
    id: `bybit-${accountType}-${index}-${r.updatedTime}`,
    symbol,
    side,
    qty,
    entry_price: entryPrice,
    exit_price: exitPrice,
    closed_at: closedAt,
    fees: String(fees),
    funding_received: '0',
    gross_pnl: String(closedPnl),
    net_pnl: String(netPnl),
    exit_reason: null,
    exitReason: null,
    accountType,
    exchange: accountType === 'Sub' ? 'Bybit Sub' : 'Bybit Main',
  };
}

/**
 * GET /api/trade/history — closed trades with optional filters: from, to (date), token (symbol), profit, loss.
 * When subaccount hedging is active, fetches closed PnL from both Main and Sub via Bybit, tags accountType, merges and sorts by updatedTime desc.
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

    const subKeys = await getSubAccountKeys(userId);
    const subHedgingActive = !!subKeys;

    if (subHedgingActive && subKeys) {
      const keys = await getExchangeKeys(userId, 'Bybit');
      if (!keys) {
        res.status(400).json({ error: 'Exchange keys not found' });
        return;
      }
      const mainKey = decrypt(keys.api_key);
      const mainSecret = decrypt(keys.api_secret);
      const limit = 100;
      const [mainList, subList] = await Promise.all([
        getClosedPnl(mainKey, mainSecret, 'linear', undefined, limit),
        getClosedPnl(subKeys.subApiKey, subKeys.subApiSecret, 'linear', undefined, limit),
      ]);
      const mainRows = mainList.map((r, i) => mapBybitClosedPnlToHistoryRow(r, 'Main', i));
      const subRows = subList.map((r, i) => mapBybitClosedPnlToHistoryRow(r, 'Sub', i));
      const merged = [...mainRows, ...subRows].sort((a, b) => {
        const ta = new Date(a.closed_at).getTime();
        const tb = new Date(b.closed_at).getTime();
        return tb - ta;
      });
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const dbRows = await getClosedTrades(userId, { from: thirtyDaysAgo.toISOString().slice(0, 10) });
      const MATCH_MS = 60000;
      for (const row of merged) {
        const closedAtMs = new Date(row.closed_at).getTime();
        const dbMatch = dbRows.find(
          (d) => d.token === row.symbol && Math.abs(new Date(d.exit_time).getTime() - closedAtMs) <= MATCH_MS
        );
        if (dbMatch?.exit_reason) {
          row.exit_reason = dbMatch.exit_reason;
          row.exitReason = dbMatch.exit_reason;
        }
      }
      let filtered = merged;
      if (from) {
        const fromTime = new Date(from).getTime();
        filtered = filtered.filter((r) => new Date(r.closed_at).getTime() >= fromTime);
      }
      if (to) {
        const toEnd = new Date(to).getTime() + 86400000;
        filtered = filtered.filter((r) => new Date(r.closed_at).getTime() < toEnd);
      }
      if (token) {
        const t = token.toUpperCase();
        const match = t.endsWith('USDT') ? t : `${t}USDT`;
        filtered = filtered.filter((r) => r.symbol === match || r.symbol === t);
      }
      if (profit) filtered = filtered.filter((r) => parseFloat(r.net_pnl) > 0);
      if (loss) filtered = filtered.filter((r) => parseFloat(r.net_pnl) < 0);
      res.status(200).json(filtered);
      return;
    }

    const rows = await getClosedTrades(userId, { from, to, token, profit, loss });
    const mapped = rows.map((r) => ({
      ...r,
      symbol: r.token,
      side: r.direction,
      qty: r.quantity,
      closed_at: r.exit_time,
      accountType: r.exchange === 'Bybit Sub' ? 'Sub' as const : (r.exchange === 'Binance' ? undefined : 'Main' as const),
      exchange: r.exchange ?? 'Bybit Main',
      exitReason: r.exit_reason,
    }));
    res.status(200).json(mapped);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to load trade history';
    res.status(500).json({ error: msg });
  }
}

/**
 * GET /api/trade/execution-history — all trade_history records for the user (auto-entry execution log), ordered by created_at DESC.
 */
export async function getExecutionHistory(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const rows = await getTradeHistoryByUserId(userId);
    res.status(200).json(rows);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to load execution history';
    res.status(500).json({ error: msg });
  }
}

/**
 * GET /api/trade/last-entry — last auto-entry execution report (main and sub): when triggered, when exchange executed, price, qty, and whether sub hedged and before/after funding.
 */
export async function getLastEntry(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const report = getLastEntryReport(userId);
    if (!report) {
      res.status(200).json({ lastEntry: null, message: 'No auto-entry recorded yet.' });
      return;
    }
    const formatMs = (ms: number) => new Date(ms).toISOString();
    const mainDetail = report.main
      ? {
          triggeredAt: formatMs(report.main.triggeredAtMs),
          triggeredAtMs: report.main.triggeredAtMs,
          executedAt: formatMs(report.main.executedAtMs),
          executedAtMs: report.main.executedAtMs,
          orderId: report.main.orderId,
          execPrice: report.main.execPrice,
          execQty: report.main.execQty,
          msBeforeFunding: report.fundingTimeMs - report.main.executedAtMs,
        }
      : null;
    const subDetail = report.sub
      ? {
          triggeredAt: formatMs(report.sub.triggeredAtMs),
          triggeredAtMs: report.sub.triggeredAtMs,
          executedAt: formatMs(report.sub.executedAtMs),
          executedAtMs: report.sub.executedAtMs,
          orderId: report.sub.orderId,
          execPrice: report.sub.execPrice,
          execQty: report.sub.execQty,
          msBeforeFunding: report.fundingTimeMs - report.sub.executedAtMs,
          executedBeforeFunding: report.subExecutedBeforeFunding ?? null,
        }
      : null;
    res.status(200).json({
      lastEntry: {
        symbol: report.symbol,
        nextFundingTime: report.nextFundingTime,
        fundingTime: formatMs(report.fundingTimeMs),
        fundingTimeMs: report.fundingTimeMs,
        main: mainDetail,
        sub: subDetail,
        subHedged: report.subHedged,
        subExecutedBeforeFunding: report.subExecutedBeforeFunding,
        reasonNoSub: report.reasonNoSub,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to load last entry report';
    res.status(500).json({ error: msg });
  }
}
