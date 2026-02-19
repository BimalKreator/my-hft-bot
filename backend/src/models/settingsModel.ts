import { query } from '../config/db.js';

export interface BotSettings {
  userId: number;
  autoEntryEnabled: boolean;
  autoExitEnabled: boolean;
  capitalPercent: number;
  maxTrades: number;
  entryTimeSec: number;
  exitTimeSec: number;
  minFundingRate: number;
  leverage: number;
  slPreFundingEnabled: boolean;
  slPreMultiplier: number;
  slPostFundingEnabled: boolean;
}

interface SettingsRow {
  user_id: number;
  auto_entry_enabled: boolean;
  auto_exit_enabled: boolean;
  capital_percent: string;
  max_trades: string;
  entry_time_sec: string;
  exit_time_sec: string;
  min_funding_rate?: string;
  leverage?: string;
  sl_pre_funding_enabled?: boolean;
  sl_pre_multiplier?: string;
  sl_post_funding_enabled?: boolean;
}

function rowToSettings(row: SettingsRow): BotSettings {
  return {
    userId: row.user_id,
    autoEntryEnabled: row.auto_entry_enabled,
    autoExitEnabled: row.auto_exit_enabled,
    capitalPercent: parseFloat(row.capital_percent) || 10,
    maxTrades: parseFloat(row.max_trades) || 5,
    entryTimeSec: parseFloat(row.entry_time_sec) || 300,
    exitTimeSec: parseFloat(row.exit_time_sec) || 3600,
    minFundingRate: row.min_funding_rate != null ? parseFloat(row.min_funding_rate) : 0,
    leverage: row.leverage != null ? parseFloat(row.leverage) : 5,
    slPreFundingEnabled: row.sl_pre_funding_enabled ?? false,
    slPreMultiplier: row.sl_pre_multiplier != null ? parseFloat(row.sl_pre_multiplier) : 1,
    slPostFundingEnabled: row.sl_post_funding_enabled ?? false,
  };
}

const DEFAULTS: Omit<BotSettings, 'userId'> = {
  autoEntryEnabled: false,
  autoExitEnabled: false,
  capitalPercent: 10,
  maxTrades: 5,
  entryTimeSec: 300,
  exitTimeSec: 3600,
  minFundingRate: 0,
  leverage: 5,
  slPreFundingEnabled: false,
  slPreMultiplier: 1,
  slPostFundingEnabled: false,
};

export async function getUsersWithAutoEntryEnabled(): Promise<number[]> {
  const result = await query<{ user_id: number }>(
    `SELECT user_id FROM bot_settings WHERE auto_entry_enabled = true`
  );
  return result.rows.map((r) => r.user_id);
}

export async function getSettings(userId: number): Promise<BotSettings> {
  const result = await query<SettingsRow>(
    `SELECT user_id, auto_entry_enabled, auto_exit_enabled, capital_percent, max_trades, entry_time_sec, exit_time_sec, min_funding_rate, leverage,
            sl_pre_funding_enabled, sl_pre_multiplier, sl_post_funding_enabled
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
  exitTimeSec?: number;
  minFundingRate?: number;
  leverage?: number;
  slPreFundingEnabled?: boolean;
  slPreMultiplier?: number;
  slPostFundingEnabled?: boolean;
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
    exitTimeSec: input.exitTimeSec ?? current.exitTimeSec,
    minFundingRate: input.minFundingRate ?? current.minFundingRate,
    leverage: input.leverage ?? current.leverage,
    slPreFundingEnabled: input.slPreFundingEnabled ?? current.slPreFundingEnabled,
    slPreMultiplier: input.slPreMultiplier ?? current.slPreMultiplier,
    slPostFundingEnabled: input.slPostFundingEnabled ?? current.slPostFundingEnabled,
  };
  await query(
    `INSERT INTO bot_settings (user_id, auto_entry_enabled, auto_exit_enabled, capital_percent, max_trades, entry_time_sec, exit_time_sec, min_funding_rate, leverage, sl_pre_funding_enabled, sl_pre_multiplier, sl_post_funding_enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (user_id) DO UPDATE SET
       auto_entry_enabled = EXCLUDED.auto_entry_enabled,
       auto_exit_enabled = EXCLUDED.auto_exit_enabled,
       capital_percent = EXCLUDED.capital_percent,
       max_trades = EXCLUDED.max_trades,
       entry_time_sec = EXCLUDED.entry_time_sec,
       exit_time_sec = EXCLUDED.exit_time_sec,
       min_funding_rate = EXCLUDED.min_funding_rate,
       leverage = EXCLUDED.leverage,
       sl_pre_funding_enabled = EXCLUDED.sl_pre_funding_enabled,
       sl_pre_multiplier = EXCLUDED.sl_pre_multiplier,
       sl_post_funding_enabled = EXCLUDED.sl_post_funding_enabled`,
    [
      userId,
      merged.autoEntryEnabled,
      merged.autoExitEnabled,
      merged.capitalPercent,
      merged.maxTrades,
      merged.entryTimeSec,
      merged.exitTimeSec,
      merged.minFundingRate,
      merged.leverage,
      merged.slPreFundingEnabled,
      merged.slPreMultiplier,
      merged.slPostFundingEnabled,
    ]
  );
  return getSettings(userId);
}
