import { Response } from 'express';
import { getSettings, updateSettings, type UpdateSettingsInput } from '../models/settingsModel.js';
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
    if (typeof body.exitTimeSec === 'number' && !Number.isNaN(body.exitTimeSec)) {
      input.exitTimeSec = body.exitTimeSec;
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
    const settings = await updateSettings(userId, input);
    res.json(settings);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to update settings';
    res.status(500).json({ error: msg });
  }
}
