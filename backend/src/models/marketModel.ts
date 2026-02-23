/**
 * Central type for scanner / cross-exchange market ticker data.
 * Aligned with FundingDataItem and getCrossExchangeFundingData() return shape.
 */
export interface MarketTicker {
  symbol: string;
  fundingRate: number;
  nextFundingTime: string;
  countdownMs: number;
  lastPrice: string;
  markPrice: string;
  turnover24h?: number;
  fundingIntervalHours?: number;
  maxLeverage?: string;
  maxOrderQty?: string;
  spotPrice?: string;
  spreadPct?: number;
  /** Cross-exchange: Binance funding rate (decimal). */
  binanceFundingRate?: number;
  /** Cross-exchange: Binance mark price. */
  binanceMarkPrice?: number;
  /** Cross-exchange: Binance next funding time (ms). */
  binanceNextFundingTime?: number;
  /** Cross-exchange: Binance funding interval in hours. */
  binanceIntervalHours?: number;
  /** Cross-exchange: |binanceFundingRate - fundingRate|. */
  netSpread?: number;
  /** Cross-exchange: "Short Binance / Long Bybit" or "Short Bybit / Long Binance". */
  hedgeDirection?: string;
}
