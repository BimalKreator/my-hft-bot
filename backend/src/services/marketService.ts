import type { MarketTicker } from '../models/marketModel.js';
import { FundingScanner } from './scannerService.js';
import type { FundingDataItem, FundingDataFilters } from './scannerService.js';

const fundingScanner = new FundingScanner();

/**
 * Single source of truth for cross-exchange token pipeline.
 * Delegates to FundingScanner.getCrossExchangeFundingData() which:
 * - Iterates Bybit tokens; keeps only symbols that exist in Binance map
 * - netSpread = Math.abs(Number(binance.fundingRate) - Number(bybit.fundingRate))
 * - hedgeDirection: BinanceFR > BybitFR -> 'Short Binance / Long Bybit', else 'Short Bybit / Long Binance'
 * - Trusts Bybit fundingInterval and nextFundingTime
 * - Sorted: fundingInterval ASC, then netSpread DESC
 */
export async function getCrossExchangeFundingData(filters?: FundingDataFilters): Promise<FundingDataItem[]> {
  return fundingScanner.getCrossExchangeFundingData(filters);
}

/**
 * Returns market tickers with cross-exchange data (Bybit + Binance).
 */
export async function getCrossExchangeMarketTickers(): Promise<MarketTicker[]> {
  const data = await getCrossExchangeFundingData();
  return data as MarketTicker[];
}

export type { MarketTicker } from '../models/marketModel.js';
