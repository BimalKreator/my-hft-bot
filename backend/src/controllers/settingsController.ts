import { Response } from 'express';
import { getSettings, updateSettings, type UpdateSettingsInput } from '../models/settingsModel.js';
import { triggerManualMock, cancelManualMock } from '../services/autoBotService.js';
import { AuthRequest } from '../middleware/authMiddleware.js';

export async function getSettingsHandler(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    let settings = await getSettings(userId);
    if (settings.subApiSecret) {
      settings = { ...settings, subApiSecret: '********' };
    }
    res.json(settings);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to load settings';
    res.status(500).json({ error: msg });
  }
}

export async function updateSettingsHandler(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const body = req.body as Record<string, unknown>;
    // Persistence uses INSERT ... ON CONFLICT (user_id) DO UPDATE SET in settingsModel
    const input: UpdateSettingsInput = {};
    if (typeof body.autoEntryEnabled === 'boolean') input.autoEntryEnabled = body.autoEntryEnabled;
    if (typeof body.autoExitEnabled === 'boolean') input.autoExitEnabled = body.autoExitEnabled;
    if (typeof body.capitalPercent === 'number' && !Number.isNaN(body.capitalPercent)) {
      input.capitalPercent = body.capitalPercent;
    }
    if (typeof body.maxTrades === 'number' && !Number.isNaN(body.maxTrades)) {
      input.maxTrades = body.maxTrades;
    }
    const entryOffsetRaw = body.entryOffsetMs ?? body.entry_offset_ms;
    if (typeof entryOffsetRaw === 'number' && !Number.isNaN(entryOffsetRaw)) {
      input.entryOffsetMs = Math.round(entryOffsetRaw);
    } else if (typeof entryOffsetRaw === 'string') {
      const parsed = parseInt(entryOffsetRaw, 10);
      if (!Number.isNaN(parsed)) input.entryOffsetMs = parsed;
    }
    const exitTimeMsRaw = body.exitTimeMs ?? body.exit_time_ms;
    if (typeof exitTimeMsRaw === 'number' && !Number.isNaN(exitTimeMsRaw) && exitTimeMsRaw >= 0) {
      input.exitTimeMs = Math.round(exitTimeMsRaw);
    }
    const minFundingRateRaw = body.minFundingRate ?? body.min_funding_rate;
    if (typeof minFundingRateRaw === 'number' && !Number.isNaN(minFundingRateRaw)) {
      input.minFundingRate = minFundingRateRaw;
    }
    const leverageRaw = body.leverage;
    if (typeof leverageRaw === 'number' && !Number.isNaN(leverageRaw)) {
      input.leverage = leverageRaw;
    } else if (typeof leverageRaw === 'string') {
      const parsed = parseInt(leverageRaw, 10);
      if (!Number.isNaN(parsed) && parsed >= 1) input.leverage = parsed;
    }
    if (typeof body.slPreFundingEnabled === 'boolean') input.slPreFundingEnabled = body.slPreFundingEnabled;
    const slPreMultiplierRaw = body.slPreMultiplier ?? body.sl_pre_multiplier;
    if (typeof slPreMultiplierRaw === 'number' && !Number.isNaN(slPreMultiplierRaw)) {
      input.slPreMultiplier = slPreMultiplierRaw;
    }
    if (typeof body.slPostFundingEnabled === 'boolean') input.slPostFundingEnabled = body.slPostFundingEnabled;
    const orderBookDepthRaw = body.orderBookDepth ?? body.order_book_depth;
    if (typeof orderBookDepthRaw === 'number' && !Number.isNaN(orderBookDepthRaw) && orderBookDepthRaw >= 1 && orderBookDepthRaw <= 50) {
      input.orderBookDepth = Math.round(orderBookDepthRaw);
    } else if (typeof orderBookDepthRaw === 'string') {
      const parsed = parseInt(orderBookDepthRaw, 10);
      if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 50) input.orderBookDepth = parsed;
    }
    const spotHedgingRaw = body.spotHedgingEnabled ?? body.spot_hedging_enabled;
    if (typeof spotHedgingRaw === 'boolean') {
      input.spotHedgingEnabled = spotHedgingRaw;
    } else if (spotHedgingRaw === 'true' || spotHedgingRaw === 1) {
      input.spotHedgingEnabled = true;
    } else if (spotHedgingRaw === 'false' || spotHedgingRaw === 0) {
      input.spotHedgingEnabled = false;
    }
    const hedgeTargetRaw = body.hedgeTargetPct ?? body.hedge_target_pct;
    if (typeof hedgeTargetRaw === 'number' && !Number.isNaN(hedgeTargetRaw) && hedgeTargetRaw >= 0) {
      input.hedgeTargetPct = hedgeTargetRaw;
    } else if (typeof hedgeTargetRaw === 'string') {
      const v = parseFloat(hedgeTargetRaw);
      if (!Number.isNaN(v) && v >= 0) input.hedgeTargetPct = v;
    }
    const hedgeStoplossRaw = body.hedgeStoplossPct ?? body.hedge_stoploss_pct;
    if (typeof hedgeStoplossRaw === 'number' && !Number.isNaN(hedgeStoplossRaw) && hedgeStoplossRaw >= 0) {
      input.hedgeStoplossPct = hedgeStoplossRaw;
    } else if (typeof hedgeStoplossRaw === 'string') {
      const v = parseFloat(hedgeStoplossRaw);
      if (!Number.isNaN(v) && v >= 0) input.hedgeStoplossPct = v;
    }
    const hedgePnlDepthRaw = body.hedgePnlDepth ?? body.hedge_pnl_depth;
    if (typeof hedgePnlDepthRaw === 'number' && !Number.isNaN(hedgePnlDepthRaw) && hedgePnlDepthRaw >= 1 && hedgePnlDepthRaw <= 50) {
      input.hedgePnlDepth = Math.round(hedgePnlDepthRaw);
    } else if (typeof hedgePnlDepthRaw === 'string') {
      const v = parseInt(hedgePnlDepthRaw, 10);
      if (!Number.isNaN(v) && v >= 1 && v <= 50) input.hedgePnlDepth = v;
    }
    if (typeof body.subApiKey === 'string') input.subApiKey = body.subApiKey;
    if (typeof body.subApiSecret === 'string' && body.subApiSecret !== '********') {
      input.subApiSecret = body.subApiSecret;
    }
    const subEntryOffsetRaw = body.subEntryOffsetMs ?? body.sub_entry_offset_ms;
    if (typeof subEntryOffsetRaw === 'number' && !Number.isNaN(subEntryOffsetRaw)) {
      input.subEntryOffsetMs = Math.round(subEntryOffsetRaw);
    } else if (typeof subEntryOffsetRaw === 'string') {
      const parsed = parseInt(subEntryOffsetRaw, 10);
      if (!Number.isNaN(parsed)) input.subEntryOffsetMs = parsed;
    }
    const universalStoplossRaw = body.universalStoplossPercent ?? body.universal_stoploss_percent;
    if (typeof universalStoplossRaw === 'number' && !Number.isNaN(universalStoplossRaw) && universalStoplossRaw >= 0) {
      input.universalStoplossPercent = universalStoplossRaw;
    } else if (typeof universalStoplossRaw === 'string') {
      const v = parseFloat(universalStoplossRaw);
      if (!Number.isNaN(v) && v >= 0) input.universalStoplossPercent = v;
    }
    const hedgeModeRaw = body.hedgeMode ?? body.hedge_mode;
    if (typeof hedgeModeRaw === 'boolean') {
      input.hedgeMode = hedgeModeRaw;
    } else if (hedgeModeRaw === 'true' || hedgeModeRaw === 1) {
      input.hedgeMode = true;
    } else if (hedgeModeRaw === 'false' || hedgeModeRaw === 0) {
      input.hedgeMode = false;
    }
    let settings = await updateSettings(userId, input);
    if (settings.subApiSecret) {
      settings = { ...settings, subApiSecret: '********' };
    }
    res.json(settings);
  } catch (err) {
    const e = err as Error & { code?: string; detail?: string };
    console.error('[settingsController] updateSettings failed:', e?.message ?? err, e?.code ?? '', e?.detail ?? '');
    const msg = err instanceof Error ? err.message : 'Failed to update settings';
    res.status(500).json({ error: msg });
  }
}

export async function triggerMockHandler(
  _req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    triggerManualMock();
    res.status(200).json({ ok: true, message: 'Manual mock triggered; countdown forced to 30s for one cycle.' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Trigger mock failed';
    res.status(500).json({ error: msg });
  }
}

export async function cancelMockHandler(
  _req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    cancelManualMock();
    res.status(200).json({ ok: true, message: 'Mock test cancelled, returning to live sync.' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Cancel mock failed';
    res.status(500).json({ error: msg });
  }
}
