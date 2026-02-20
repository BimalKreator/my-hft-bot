import { Response } from 'express';
import { getSettings, updateSettings, type UpdateSettingsInput } from '../models/settingsModel.js';
import { triggerManualMock } from '../services/autoBotService.js';
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
    const settings = await getSettings(userId);
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
    if (typeof body.entryTimeSec === 'number' && !Number.isNaN(body.entryTimeSec)) {
      input.entryTimeSec = body.entryTimeSec;
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
    if (typeof body.spotHedgingEnabled === 'boolean') input.spotHedgingEnabled = body.spotHedgingEnabled;
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
    const settings = await updateSettings(userId, input);
    res.json(settings);
  } catch (err) {
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
