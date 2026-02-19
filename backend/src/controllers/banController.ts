import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware.js';
import { getBannedTokens, addBannedToken, removeBannedToken } from '../models/bannedTokensModel.js';

/**
 * GET /api/ban — list banned tokens for the authenticated user.
 */
export async function getBanned(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const tokens = await getBannedTokens(userId);
    res.status(200).json(tokens);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to load banned tokens';
    res.status(500).json({ error: msg });
  }
}

/**
 * POST /api/ban/add — add a token to the banned list. Body: { token: string, reason?: string }.
 */
export async function addBan(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const { token } = req.body;
    if (!token || typeof token !== 'string' || !token.trim()) {
      res.status(400).json({ error: 'token (string) required' });
      return;
    }
    const reason = typeof req.body.reason === 'string' ? req.body.reason : undefined;
    await addBannedToken(userId, token.trim(), reason);
    res.status(200).json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to add banned token';
    res.status(500).json({ error: msg });
  }
}

/**
 * POST /api/ban/remove — remove a token from the banned list. Body: { token: string }.
 */
export async function removeBan(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const { token } = req.body;
    if (!token || typeof token !== 'string' || !token.trim()) {
      res.status(400).json({ error: 'token (string) required' });
      return;
    }
    const removed = await removeBannedToken(userId, token.trim());
    res.status(200).json({ ok: true, removed });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to remove banned token';
    res.status(500).json({ error: msg });
  }
}
