import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware.js';
import { getDashboardStats } from '../services/statsService.js';

/**
 * GET /api/stats — dashboard stats: capital, margin used, available, today's profit, profit %, daily ROI.
 */
export async function getStats(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const stats = await getDashboardStats(userId);
    if (!stats) {
      res.status(404).json({ error: 'No exchange keys. Add keys in Exchange Setup.' });
      return;
    }
    res.status(200).json(stats);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to load stats';
    res.status(500).json({ error: msg });
  }
}
