import { query } from '../config/db.js';

export interface InsertClosedTradeParams {
  userId: number;
  symbol: string;
  side: 'Buy' | 'Sell';
  entryPrice: number;
  exitPrice: number;
  qty: number;
  grossPnl: number;
  funding?: number;
  fees?: number;
  /** When provided (e.g. from Bybit getClosedPnl + funding), stored directly in net_pnl with no further calculation. */
  netPnl?: number;
  source?: 'manual' | 'auto';
  exitReason?: string;
  /** Exchange label: 'Bybit Main', 'Bybit Sub', or 'Binance'. */
  exchange?: string;
}

/** Row shape from DB: closed_trades uses token, direction, quantity, entry_time, exit_time, funding_received, status, exit_reason. */
export interface ClosedTradeRow {
  id: number;
  user_id: number;
  token: string;
  direction: string;
  quantity: string;
  entry_price: string;
  exit_price: string;
  entry_time: string | null;
  exit_time: string;
  fees: string;
  funding_received: string;
  gross_pnl: string;
  net_pnl: string;
  status: string | null;
  exit_reason: string | null;
  exchange: string | null;
}

export function netPnl(grossPnl: number, funding: number, fees: number): number {
  return grossPnl + funding - fees;
}

/**
 * Strict 8-param save for closed trades. Forces absolute quantity. Inserts into closed_trades.
 * Use for simple exit logging (e.g. Binance leg) when full entry/exit prices are not needed.
 */
export async function saveClosedTrade(
  userId: number,
  symbol: string,
  direction: string,
  quantity: number | string,
  pnl: number | string,
  exitReason: string,
  fees: number | string,
  exchange: string = 'Bybit Main'
): Promise<void> {
  const absQty = Math.abs(Number(quantity));
  const pnlNum = Number(pnl);
  const feesNum = Number(fees);
  const netPnlVal = pnlNum - feesNum;
  await query(
    `INSERT INTO closed_trades (user_id, token, direction, quantity, entry_price, exit_price, entry_time, exit_time, fees, funding_received, gross_pnl, net_pnl, status, exit_reason, exchange)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, NOW(), $7, $8, $9, $10, $11, $12, $13)`,
    [userId, symbol, direction, absQty, 0, 0, feesNum, 0, pnlNum, netPnlVal, 'auto', exitReason, exchange]
  );
}

export async function insertClosedTrade(params: InsertClosedTradeParams): Promise<number> {
  const funding = params.funding ?? 0;
  const fees = params.fees ?? 0;
  const net = params.netPnl != null && !Number.isNaN(params.netPnl)
    ? params.netPnl
    : netPnl(params.grossPnl, funding, fees);
  // Store crypto prices with at least 6 decimal places; never round to 2
  const entryPrice = Number(Number(params.entryPrice).toFixed(6));
  const exitPrice = Number(Number(params.exitPrice).toFixed(6));
  const absQty = Math.abs(Number(params.qty));
  const result = await query<{ id: number }>(
    `INSERT INTO closed_trades (user_id, token, direction, quantity, entry_price, exit_price, entry_time, exit_time, fees, funding_received, gross_pnl, net_pnl, status, exit_reason, exchange)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, NOW(), $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      params.userId,
      params.symbol,
      params.side,
      absQty,
      entryPrice,
      exitPrice,
      fees,
      funding,
      params.grossPnl,
      net,
      params.source ?? null,
      params.exitReason ?? null,
      params.exchange ?? null,
    ]
  );
  const row = result.rows[0];
  return row?.id ?? 0;
}

export interface GetClosedTradesFilters {
  from?: string; // YYYY-MM-DD
  to?: string;   // YYYY-MM-DD
  token?: string;
  profit?: boolean; // net_pnl > 0
  loss?: boolean;   // net_pnl < 0
}

export async function getClosedTrades(
  userId: number,
  filters: GetClosedTradesFilters = {}
): Promise<ClosedTradeRow[]> {
  const conditions: string[] = ['user_id = $1'];
  const params: unknown[] = [userId];
  let idx = 2;

  if (filters.from) {
    conditions.push(`exit_time >= $${idx}::date`);
    params.push(filters.from);
    idx++;
  }
  if (filters.to) {
    conditions.push(`exit_time <= $${idx}::date + INTERVAL '1 day'`);
    params.push(filters.to);
    idx++;
  }
  if (filters.token) {
    conditions.push(`token = $${idx}`);
    params.push(filters.token);
    idx++;
  }
  if (filters.profit === true) {
    conditions.push('net_pnl > 0');
  }
  if (filters.loss === true) {
    conditions.push('net_pnl < 0');
  }

  const sql = `SELECT id, user_id, token, direction, quantity, entry_price, exit_price, entry_time, exit_time, fees, funding_received, gross_pnl, net_pnl, status, exit_reason, exchange
               FROM closed_trades
               WHERE ${conditions.join(' AND ')}
               ORDER BY exit_time DESC
               LIMIT 200`;
  const result = await query<ClosedTradeRow>(sql, params);
  return result.rows;
}
