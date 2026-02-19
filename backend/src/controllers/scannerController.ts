import { Request, Response } from 'express';
import { FundingScanner } from '../services/scannerService.js';

const scanner = new FundingScanner();

export async function getFundingOpportunities(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const minFundingRate = req.query.minFundingRate != null
      ? parseFloat(String(req.query.minFundingRate))
      : undefined;
    const minVolume = req.query.minVolume != null
      ? parseFloat(String(req.query.minVolume))
      : undefined;
    const type = req.query.type === 'positive' || req.query.type === 'negative'
      ? req.query.type
      : undefined;

    const filters =
      minFundingRate !== undefined || minVolume !== undefined || type !== undefined
        ? { minFundingRate, minVolume, type }
        : undefined;

    const data = await scanner.getFundingData(filters);
    res.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch funding data';
    res.status(500).json({ error: msg });
  }
}
