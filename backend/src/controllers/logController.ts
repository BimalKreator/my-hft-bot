import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware.js';
import { getLogs } from '../models/logModel.js';

/**
 * GET /api/logs — recent bot logs, ordered by created_at DESC.
 * Query: limit (default 500, max 2000).
 */
export async function getLogsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const limitRaw = req.query.limit;
    const limit =
      typeof limitRaw === 'string' && /^\d+$/.test(limitRaw)
        ? Math.min(2000, Math.max(1, parseInt(limitRaw, 10)))
        : 500;
    const logs = await getLogs(limit);
    res.status(200).json(logs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to load logs';
    res.status(500).json({ error: msg });
  }
}
