import { query } from '../config/db.js';

export interface BotSettings {
  userId: number;
  autoEntryEnabled: boolean;
  autoExitEnabled: boolean;
  capitalPercent: number;
  maxTrades: number;
  entryTimeSec: number;
  /** Exit delay after funding settlement, in milliseconds. */
  exitTimeMs: number;
  minFundingRate: number;
  leverage: number;
  slPreFundingEnabled: boolean;
  slPreMultiplier: number;
  slPostFundingEnabled: boolean;
  orderBookDepth: number;
  spotHedgingEnabled: boolean;
  hedgeTargetPct: number;
  hedgeStoplossPct: number;
  hedgePnlDepth: number;
}

interface SettingsRow {
  user_id: number;
  auto_entry_enabled: boolean;
  auto_exit_enabled: boolean;
  capital_percent: string;
  max_trades: string;
  entry_time_sec: string;
  exit_time_sec: string;
  exit_time_ms?: string | null;
  min_funding_rate?: string;
  leverage?: string;
  sl_pre_funding_enabled?: boolean;
  sl_pre_multiplier?: string;
  sl_post_funding_enabled?: boolean;
  order_book_depth?: string;
  spot_hedging_enabled?: boolean;
  hedge_target_pct?: string;
  hedge_stoploss_pct?: string;
  hedge_pnl_depth?: string;
}

function rowToSettings(row: SettingsRow): BotSettings {
  const exitTimeMs =
    row.exit_time_ms != null && row.exit_time_ms !== ''
      ? parseFloat(row.exit_time_ms) || 3600000
      : (parseFloat(row.exit_time_sec) || 3600) * 1000;
  return {
    userId: row.user_id,
    autoEntryEnabled: row.auto_entry_enabled,
    autoExitEnabled: row.auto_exit_enabled,
    capitalPercent: parseFloat(row.capital_percent) || 10,
    maxTrades: parseFloat(row.max_trades) || 5,
    entryTimeSec: parseFloat(row.entry_time_sec) || 300,
    exitTimeMs,
    minFundingRate: row.min_funding_rate != null ? parseFloat(row.min_funding_rate) : 0,
    leverage: row.leverage != null ? parseFloat(row.leverage) : 5,
    slPreFundingEnabled: row.sl_pre_funding_enabled ?? false,
    slPreMultiplier: row.sl_pre_multiplier != null ? parseFloat(row.sl_pre_multiplier) : 1,
    slPostFundingEnabled: row.sl_post_funding_enabled ?? false,
    orderBookDepth: row.order_book_depth != null ? parseInt(row.order_book_depth, 10) : 2,
    spotHedgingEnabled: row.spot_hedging_enabled ?? false,
    hedgeTargetPct: row.hedge_target_pct != null ? parseFloat(row.hedge_target_pct) : 2,
    hedgeStoplossPct: row.hedge_stoploss_pct != null ? parseFloat(row.hedge_stoploss_pct) : 5,
    hedgePnlDepth: row.hedge_pnl_depth != null ? parseInt(row.hedge_pnl_depth, 10) : 1,
  };
}

const DEFAULTS: Omit<BotSettings, 'userId'> = {
  autoEntryEnabled: false,
  autoExitEnabled: false,
  capitalPercent: 10,
  maxTrades: 5,
  entryTimeSec: 300,
  exitTimeMs: 3600000,
  minFundingRate: 0,
  leverage: 5,
  slPreFundingEnabled: false,
  slPreMultiplier: 1,
  slPostFundingEnabled: false,
  orderBookDepth: 2,
  spotHedgingEnabled: false,
  hedgeTargetPct: 2,
  hedgeStoplossPct: 5,
  hedgePnlDepth: 1,
};

export async function getUsersWithAutoEntryEnabled(): Promise<number[]> {
  const result = await query<{ user_id: number }>(
    `SELECT user_id FROM bot_settings WHERE auto_entry_enabled = true`
  );
  return result.rows.map((r) => r.user_id);
}

export async function getSettings(userId: number): Promise<BotSettings> {
  const result = await query<SettingsRow>(
    `SELECT user_id, auto_entry_enabled, auto_exit_enabled, capital_percent, max_trades, entry_time_sec, exit_time_sec, exit_time_ms, min_funding_rate, leverage,
            sl_pre_funding_enabled, sl_pre_multiplier, sl_post_funding_enabled, order_book_depth, spot_hedging_enabled,
            hedge_target_pct, hedge_stoploss_pct, hedge_pnl_depth
     FROM bot_settings WHERE user_id = $1`,
    [userId]
  );
  const row = result.rows[0];
  if (!row) {
    return { userId, ...DEFAULTS };
  }
  return rowToSettings(row);
}

export interface UpdateSettingsInput {
  autoEntryEnabled?: boolean;
  autoExitEnabled?: boolean;
  capitalPercent?: number;
  maxTrades?: number;
  entryTimeSec?: number;
  exitTimeMs?: number;
  minFundingRate?: number;
  leverage?: number;
  slPreFundingEnabled?: boolean;
  slPreMultiplier?: number;
  slPostFundingEnabled?: boolean;
  orderBookDepth?: number;
  spotHedgingEnabled?: boolean;
  hedgeTargetPct?: number;
  hedgeStoplossPct?: number;
  hedgePnlDepth?: number;
}

export async function updateSettings(
  userId: number,
  input: UpdateSettingsInput
): Promise<BotSettings> {
  const current = await getSettings(userId);
  const merged: BotSettings = {
    userId,
    autoEntryEnabled: input.autoEntryEnabled ?? current.autoEntryEnabled,
    autoExitEnabled: input.autoExitEnabled ?? current.autoExitEnabled,
    capitalPercent: input.capitalPercent ?? current.capitalPercent,
    maxTrades: input.maxTrades ?? current.maxTrades,
    entryTimeSec: input.entryTimeSec ?? current.entryTimeSec,
    exitTimeMs: input.exitTimeMs ?? current.exitTimeMs,
    minFundingRate: input.minFundingRate ?? current.minFundingRate,
    leverage: input.leverage ?? current.leverage,
    slPreFundingEnabled: input.slPreFundingEnabled ?? current.slPreFundingEnabled,
    slPreMultiplier: input.slPreMultiplier ?? current.slPreMultiplier,
    slPostFundingEnabled: input.slPostFundingEnabled ?? current.slPostFundingEnabled,
    orderBookDepth: input.orderBookDepth ?? current.orderBookDepth,
    spotHedgingEnabled: input.spotHedgingEnabled ?? current.spotHedgingEnabled,
    hedgeTargetPct: input.hedgeTargetPct ?? current.hedgeTargetPct,
    hedgeStoplossPct: input.hedgeStoplossPct ?? current.hedgeStoplossPct,
    hedgePnlDepth: input.hedgePnlDepth ?? current.hedgePnlDepth,
  };
  const depthInt = Math.max(1, Math.min(50, Math.round(merged.orderBookDepth) || 2));
  const exitTimeMsInt = Math.max(0, Math.round(merged.exitTimeMs));
  const hedgeTargetNum = Math.max(0, merged.hedgeTargetPct);
  const hedgeStoplossNum = Math.max(0, merged.hedgeStoplossPct);
  const hedgePnlDepthInt = Math.max(1, Math.min(50, Math.round(merged.hedgePnlDepth) || 1));
  // Requires spot_hedging_enabled (and hedge_*) columns. Run: npx tsx update-settings-table.ts
  await query(
    `INSERT INTO bot_settings (user_id, auto_entry_enabled, auto_exit_enabled, capital_percent, max_trades, entry_time_sec, exit_time_sec, exit_time_ms, min_funding_rate, leverage, sl_pre_funding_enabled, sl_pre_multiplier, sl_post_funding_enabled, order_book_depth, spot_hedging_enabled, hedge_target_pct, hedge_stoploss_pct, hedge_pnl_depth)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     ON CONFLICT (user_id) DO UPDATE SET
       auto_entry_enabled = EXCLUDED.auto_entry_enabled,
       auto_exit_enabled = EXCLUDED.auto_exit_enabled,
       capital_percent = EXCLUDED.capital_percent,
       max_trades = EXCLUDED.max_trades,
       entry_time_sec = EXCLUDED.entry_time_sec,
       exit_time_sec = EXCLUDED.exit_time_sec,
       exit_time_ms = EXCLUDED.exit_time_ms,
       min_funding_rate = EXCLUDED.min_funding_rate,
       leverage = EXCLUDED.leverage,
       sl_pre_funding_enabled = EXCLUDED.sl_pre_funding_enabled,
       sl_pre_multiplier = EXCLUDED.sl_pre_multiplier,
       sl_post_funding_enabled = EXCLUDED.sl_post_funding_enabled,
       order_book_depth = EXCLUDED.order_book_depth,
       spot_hedging_enabled = EXCLUDED.spot_hedging_enabled,
       hedge_target_pct = EXCLUDED.hedge_target_pct,
       hedge_stoploss_pct = EXCLUDED.hedge_stoploss_pct,
       hedge_pnl_depth = EXCLUDED.hedge_pnl_depth`,
    [
      userId,
      merged.autoEntryEnabled,
      merged.autoExitEnabled,
      merged.capitalPercent,
      merged.maxTrades,
      merged.entryTimeSec,
      Math.floor(merged.exitTimeMs / 1000),
      exitTimeMsInt,
      merged.minFundingRate,
      merged.leverage,
      merged.slPreFundingEnabled,
      merged.slPreMultiplier,
      merged.slPostFundingEnabled,
      depthInt,
      merged.spotHedgingEnabled,
      hedgeTargetNum,
      hedgeStoplossNum,
      hedgePnlDepthInt,
    ]
  );
  return getSettings(userId);
}
