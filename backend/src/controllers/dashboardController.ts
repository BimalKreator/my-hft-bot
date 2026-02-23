import { Response } from 'express';
import { query } from '../config/db.js';
import { AuthRequest } from '../middleware/authMiddleware.js';
import { getSettings } from '../models/settingsModel.js';
import { getBannedTokens } from '../models/bannedTokensModel.js';
import { FundingScanner } from '../services/scannerService.js';

const fundingScanner = new FundingScanner();

/**
 * GET /api/dashboard/next-to-trade
 * Returns the top tokens the bot is targeting for the authenticated user:
 * sorted scanner results filtered by user's min funding rate and banned list,
 * sliced to settings.maxTrades (exact number the bot will consider).
 * When cross-exchange mode is on, uses getCrossExchangeFundingData and sorts by netSpread.
 */
export async function getNextToTrade(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const [settings, bannedList] = await Promise.all([
      getSettings(userId),
      getBannedTokens(userId),
    ]);

    const isCrossExchange =
      settings.crossExchangeMode === true ||
      (settings as { cross_exchange_mode?: boolean }).cross_exchange_mode === true ||
      (settings as { crossExchangeMode?: unknown }).crossExchangeMode === 'true' ||
      (settings as { crossExchangeMode?: unknown }).crossExchangeMode === 1;

    const marketData = isCrossExchange
      ? await fundingScanner.getCrossExchangeFundingData()
      : await fundingScanner.getFundingData();

    const minFundingRate = settings.minFundingRate ?? 0;
    const maxTrades = settings.maxTrades ?? 1;

    const bannedSet = new Set(bannedList);
    let meetsMinFunding = marketData.filter((token) => {
      if (bannedSet.has(token.symbol)) return false;
      if (isCrossExchange && token.netSpread != null) {
        return token.netSpread >= minFundingRate;
      }
      return Math.abs(token.fundingRate) >= minFundingRate;
    });

    const sorted = [...meetsMinFunding].sort((a, b) => {
      const intervalA = a.fundingIntervalHours ?? 0;
      const intervalB = b.fundingIntervalHours ?? 0;
      if (intervalA !== intervalB) return intervalA - intervalB;
      if (isCrossExchange && a.netSpread != null && b.netSpread != null) {
        return b.netSpread - a.netSpread;
      }
      return Math.abs(b.fundingRate) - Math.abs(a.fundingRate);
    });

    const topTokens = sorted.slice(0, maxTrades);

    res.status(200).json({ tokens: topTokens, maxTrades, crossExchangeMode: isCrossExchange });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch next-to-trade';
    res.status(500).json({ error: msg });
  }
}

interface SnapshotRow {
  date: string;
  opening_balance: string;
  closing_balance: string;
  total_profit: string | null;
  profit_percent: string | null;
}

/**
 * GET /api/dashboard/snapshots
 * Returns the last 30 daily snapshots for the authenticated user (date, opening, closing, profit, profit_percent).
 */
export async function getSnapshots(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const limit = Math.min(Math.max(1, parseInt(String(req.query.limit), 10) || 30), 90);
    const result = await query<SnapshotRow>(
      `SELECT date, opening_balance, closing_balance, total_profit, profit_percent
       FROM daily_snapshots
       WHERE user_id = $1
       ORDER BY date DESC
       LIMIT $2`,
      [userId, limit]
    );

    const snapshots = result.rows.map((r) => ({
      date: r.date,
      openingBalance: parseFloat(r.opening_balance) || 0,
      closingBalance: parseFloat(r.closing_balance) || 0,
      totalProfit: r.total_profit != null ? parseFloat(r.total_profit) : null,
      profitPercent: r.profit_percent != null ? parseFloat(r.profit_percent) : null,
    }));

    res.status(200).json({ snapshots });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch snapshots';
    res.status(500).json({ error: msg });
  }
}
