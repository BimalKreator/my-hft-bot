import { query } from '../config/db.js';

/** Shape passed from autoBotService last-entry report for DB persist. */
export interface TradeHistoryInsert {
  userId: number;
  symbol: string;
  nextFundingTime: string;
  fundingTimeMs: number;
  main: { triggeredAtMs: number; orderId: string; execPrice: string; execQty: string; executedAtMs: number } | null;
  sub: { triggeredAtMs: number; orderId: string; execPrice: string; execQty: string; executedAtMs: number } | null;
  subHedged: boolean;
  subExecutedBeforeFunding: boolean | null;
  reasonNoSub: string | null;
}

/**
 * Upsert a trade history row from the in-memory last-entry report.
 * Uses (user_id, symbol, funding_time_ms) as unique key.
 */
export async function insertTradeHistoryEntry(report: TradeHistoryInsert): Promise<void> {
  const fundingTimeIso = new Date(report.fundingTimeMs).toISOString();
  const mainTriggeredAtMs = report.main?.triggeredAtMs ?? null;
  const mainOrderId = report.main?.orderId ?? null;
  const mainExecPrice = report.main ? parseFloat(report.main.execPrice) || null : null;
  const mainExecQty = report.main ? parseFloat(report.main.execQty) || null : null;
  const mainExecutedAtMs = report.main?.executedAtMs ?? null;
  const mainMsBeforeFunding = report.main != null ? report.fundingTimeMs - report.main.executedAtMs : null;
  const subTriggeredAtMs = report.sub?.triggeredAtMs ?? null;
  const subOrderId = report.sub?.orderId ?? null;
  const subExecPrice = report.sub ? parseFloat(report.sub.execPrice) || null : null;
  const subExecQty = report.sub ? parseFloat(report.sub.execQty) || null : null;
  const subExecutedAtMs = report.sub?.executedAtMs ?? null;
  const subMsBeforeFunding = report.sub != null ? report.fundingTimeMs - report.sub.executedAtMs : null;
  const subExecutedBeforeFunding = report.subExecutedBeforeFunding ?? null;
  const reasonNoSub = report.reasonNoSub ?? null;

  await query(
    `INSERT INTO trade_history (
      user_id, symbol, funding_time_ms, funding_time,
      main_triggered_at_ms, main_order_id, main_exec_price, main_exec_qty, main_executed_at_ms, main_ms_before_funding,
      sub_triggered_at_ms, sub_order_id, sub_exec_price, sub_exec_qty, sub_executed_at_ms, sub_ms_before_funding, sub_executed_before_funding,
      reason_no_sub, updated_at
    ) VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW())
    ON CONFLICT (user_id, symbol, funding_time_ms) DO UPDATE SET
      main_triggered_at_ms = COALESCE(EXCLUDED.main_triggered_at_ms, trade_history.main_triggered_at_ms),
      main_order_id = COALESCE(EXCLUDED.main_order_id, trade_history.main_order_id),
      main_exec_price = COALESCE(EXCLUDED.main_exec_price, trade_history.main_exec_price),
      main_exec_qty = COALESCE(EXCLUDED.main_exec_qty, trade_history.main_exec_qty),
      main_executed_at_ms = COALESCE(EXCLUDED.main_executed_at_ms, trade_history.main_executed_at_ms),
      main_ms_before_funding = COALESCE(EXCLUDED.main_ms_before_funding, trade_history.main_ms_before_funding),
      sub_triggered_at_ms = COALESCE(EXCLUDED.sub_triggered_at_ms, trade_history.sub_triggered_at_ms),
      sub_order_id = COALESCE(EXCLUDED.sub_order_id, trade_history.sub_order_id),
      sub_exec_price = COALESCE(EXCLUDED.sub_exec_price, trade_history.sub_exec_price),
      sub_exec_qty = COALESCE(EXCLUDED.sub_exec_qty, trade_history.sub_exec_qty),
      sub_executed_at_ms = COALESCE(EXCLUDED.sub_executed_at_ms, trade_history.sub_executed_at_ms),
      sub_ms_before_funding = COALESCE(EXCLUDED.sub_ms_before_funding, trade_history.sub_ms_before_funding),
      sub_executed_before_funding = COALESCE(EXCLUDED.sub_executed_before_funding, trade_history.sub_executed_before_funding),
      reason_no_sub = COALESCE(EXCLUDED.reason_no_sub, trade_history.reason_no_sub),
      updated_at = NOW()`,
    [
      report.userId,
      report.symbol,
      report.fundingTimeMs,
      fundingTimeIso,
      mainTriggeredAtMs,
      mainOrderId,
      mainExecPrice,
      mainExecQty,
      mainExecutedAtMs,
      mainMsBeforeFunding,
      subTriggeredAtMs,
      subOrderId,
      subExecPrice,
      subExecQty,
      subExecutedAtMs,
      subMsBeforeFunding,
      subExecutedBeforeFunding,
      reasonNoSub,
    ]
  );
}

export interface TradeHistoryRow {
  id: number;
  user_id: number;
  symbol: string;
  funding_time_ms: string;
  funding_time: string;
  main_triggered_at_ms: string | null;
  main_order_id: string | null;
  main_exec_price: string | null;
  main_exec_qty: string | null;
  main_executed_at_ms: string | null;
  main_ms_before_funding: number | null;
  sub_triggered_at_ms: string | null;
  sub_order_id: string | null;
  sub_exec_price: string | null;
  sub_exec_qty: string | null;
  sub_executed_at_ms: string | null;
  sub_ms_before_funding: number | null;
  sub_executed_before_funding: boolean | null;
  reason_no_sub: string | null;
  created_at: string;
  updated_at: string;
}

export async function getTradeHistoryByUserId(userId: number): Promise<TradeHistoryRow[]> {
  const result = await query<TradeHistoryRow>(
    `SELECT id, user_id, symbol, funding_time_ms::text, funding_time::text,
            main_triggered_at_ms::text, main_order_id, main_exec_price::text, main_exec_qty::text, main_executed_at_ms::text, main_ms_before_funding,
            sub_triggered_at_ms::text, sub_order_id, sub_exec_price::text, sub_exec_qty::text, sub_executed_at_ms::text, sub_ms_before_funding, sub_executed_before_funding,
            reason_no_sub, created_at::text, updated_at::text
     FROM trade_history
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows;
}
