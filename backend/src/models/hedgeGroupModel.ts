import { randomUUID } from 'crypto';
import { query } from '../config/db.js';

export interface HedgeGroupRow {
  hedge_group_id: string;
  user_id: number;
  symbol: string;
  side: string;
  funding_amount_received: string | null;
  spot_qty: string;
  spot_entry_price: string;
  created_at: string;
}

export interface HedgeGroup {
  hedgeGroupId: string;
  userId: number;
  symbol: string;
  side: string;
  fundingAmountReceived: number | null;
  spotQty: number;
  spotEntryPrice: number;
  createdAt: string;
}

function rowToGroup(r: HedgeGroupRow): HedgeGroup {
  return {
    hedgeGroupId: r.hedge_group_id,
    userId: r.user_id,
    symbol: r.symbol,
    side: r.side,
    fundingAmountReceived: r.funding_amount_received != null ? parseFloat(r.funding_amount_received) : null,
    spotQty: parseFloat(r.spot_qty) || 0,
    spotEntryPrice: parseFloat(r.spot_entry_price) || 0,
    createdAt: r.created_at,
  };
}

/**
 * Create a new hedge group for a spot-hedged position. Returns the new hedgeGroupId.
 */
export async function createHedgeGroup(
  userId: number,
  symbol: string,
  side: 'Buy' | 'Sell',
  spotQty: number,
  spotEntryPrice: number
): Promise<string> {
  const hedgeGroupId = randomUUID();
  await query(
    `INSERT INTO hedge_groups (hedge_group_id, user_id, symbol, side, spot_qty, spot_entry_price)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [hedgeGroupId, userId, symbol, side, spotQty, spotEntryPrice]
  );
  return hedgeGroupId;
}

/**
 * Set the exact funding amount received for this group (after settlement).
 */
export async function setFundingReceived(hedgeGroupId: string, amount: number): Promise<void> {
  await query(
    `UPDATE hedge_groups SET funding_amount_received = $1 WHERE hedge_group_id = $2`,
    [amount, hedgeGroupId]
  );
}

/**
 * Get the active hedge group for a position by (userId, symbol, side). Returns the most recent if multiple.
 */
export async function getHedgeGroupByPosition(
  userId: number,
  symbol: string,
  side: string
): Promise<HedgeGroup | null> {
  const result = await query<HedgeGroupRow>(
    `SELECT hedge_group_id, user_id, symbol, side, funding_amount_received, spot_qty, spot_entry_price, created_at
     FROM hedge_groups
     WHERE user_id = $1 AND symbol = $2 AND side = $3
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, symbol, side]
  );
  const row = result.rows[0];
  return row ? rowToGroup(row) : null;
}

/**
 * Get all active hedge groups for a user (for dashboard grouping).
 */
export async function getHedgeGroupsByUser(userId: number): Promise<HedgeGroup[]> {
  const result = await query<HedgeGroupRow>(
    `SELECT hedge_group_id, user_id, symbol, side, funding_amount_received, spot_qty, spot_entry_price, created_at
     FROM hedge_groups
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows.map(rowToGroup);
}

/**
 * Delete the hedge group after both legs are closed.
 */
export async function deleteHedgeGroup(hedgeGroupId: string): Promise<void> {
  await query(`DELETE FROM hedge_groups WHERE hedge_group_id = $1`, [hedgeGroupId]);
}
