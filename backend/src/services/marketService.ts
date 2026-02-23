import type { MarketTicker } from '../models/marketModel.js';
import { FundingScanner } from './scannerService.js';

const fundingScanner = new FundingScanner();

/**
 * Returns market tickers with cross-exchange data (Bybit + Binance).
 * Result is sorted by interval asc, then netSpread desc; only symbols on both exchanges with matching interval.
 */
export async function getCrossExchangeMarketTickers(): Promise<MarketTicker[]> {
  const data = await fundingScanner.getCrossExchangeFundingData();
  return data as MarketTicker[];
}

export type { MarketTicker } from '../models/marketModel.js';
