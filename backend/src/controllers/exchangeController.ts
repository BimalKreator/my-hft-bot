import { Response } from 'express';
import { addExchangeKeys, getExchangeKeys } from '../models/exchangeModel.js';
import { decrypt } from '../utils/encryption.js';
import { getWalletBalance } from '../services/bybitService.js';
import { AuthRequest } from '../middleware/authMiddleware.js';

export async function getBalance(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const keys = await getExchangeKeys(userId, 'Bybit');
    if (!keys) {
      res.status(404).json({ error: 'No Bybit keys found. Add keys in Exchange Setup.' });
      return;
    }

    const apiKey = decrypt(keys.api_key);
    const apiSecret = decrypt(keys.api_secret);
    const balance = await getWalletBalance(apiKey, apiSecret);

    res.json({
      totalEquity: balance.totalEquity,
      totalAvailableBalance: balance.totalAvailableBalance,
      totalPerpUPL: balance.totalPerpUPL,
      coins: balance.coins,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch balance';
    res.status(500).json({ error: msg });
  }
}

export async function addKeys(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { exchange, apiKey, apiSecret } = req.body;
    if (!exchange || !apiKey || !apiSecret) {
      res.status(400).json({
        error: 'exchange, apiKey, and apiSecret are required',
      });
      return;
    }

    await addExchangeKeys(userId, exchange, apiKey, apiSecret);
    res.status(201).json({ message: 'Exchange keys saved successfully' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to save keys';
    res.status(500).json({ error: msg });
  }
}
