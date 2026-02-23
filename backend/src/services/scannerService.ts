import { RestClientV5 } from 'bybit-api';
import { getInstrumentsCache, type CachedInstrumentRow } from './bybitService.js';
import { getBinanceDataMap } from './binanceService.js';

export interface FundingDataFilters {
  minFundingRate?: number;
  minVolume?: number;
  type?: 'positive' | 'negative';
}

export interface FundingDataItem {
  symbol: string;
  fundingRate: number;
  nextFundingTime: string;
  countdownMs: number;
  lastPrice: string;
  markPrice: string;
  turnover24h: number;
  fundingIntervalHours: number;
  maxLeverage: string;
  maxOrderQty: string;
  /** Spot last price (only when symbol exists on spot). */
  spotPrice?: string;
  /** (futuresMarkPrice - spotPrice) / spotPrice * 100. */
  spreadPct?: number;
  /** Cross-exchange: Binance funding rate (decimal). */
  binanceFundingRate?: number;
  /** Cross-exchange: Binance funding interval in hours. */
  binanceIntervalHours?: number;
  /** Cross-exchange: Binance mark price. */
  binanceMarkPrice?: number;
  /** Cross-exchange: Binance next funding time (ms). */
  binanceNextFundingTime?: number;
  /** Cross-exchange: |binanceFundingRate - fundingRate|. */
  netSpread?: number;
  /** Cross-exchange: "Short Binance / Long Bybit" or "Short Bybit / Long Binance". */
  hedgeDirection?: string;
}

export class FundingScanner {
  private bybit: RestClientV5;

  constructor() {
    const testnet = process.env.BYBIT_TESTNET === 'true';
    this.bybit = new RestClientV5({ testnet });
  }

  async getFundingData(filters?: FundingDataFilters): Promise<FundingDataItem[]> {
    const [tickersRes, spotTickersRes, rawInstruments] = await Promise.all([
      this.bybit.getTickers({ category: 'linear' }),
      this.bybit.getTickers({ category: 'spot' }),
      getInstrumentsCache(),
    ]);

    if (tickersRes.retCode !== 0) throw new Error(tickersRes.retMsg ?? 'Bybit linear tickers failed');
    if (spotTickersRes.retCode !== 0) throw new Error(spotTickersRes.retMsg ?? 'Bybit spot tickers failed');

    const tickerList = (tickersRes.result as { list: TickerRow[] }).list ?? [];
    const spotTickerList = (spotTickersRes.result as { list: SpotTickerRow[] }).list ?? [];
    const spotSymbolSet = new Set(spotTickerList.map((t) => t.symbol));
    const spotPriceBySymbol = new Map<string, string>(
      spotTickerList.map((t) => [t.symbol, t.lastPrice ?? ''])
    );

    // Strict filter: USDT perpetuals only (no dated/quarterly/options)
    const isCleanPerpetual = (symbol: string): boolean => {
      if (symbol.includes('-')) return false;
      if (/\d{2}[A-Z]{3}/.test(symbol)) return false; // e.g. BTC29DEC, 31MAR
      return true;
    };

    const instrumentList = rawInstruments.filter(
      (i: CachedInstrumentRow) =>
        i.contractType === 'LinearPerpetual' &&
        i.quoteCoin === 'USDT' &&
        i.status === 'Trading' &&
        isCleanPerpetual(i.symbol)
    );

    const instrumentBySymbol = new Map<string, CachedInstrumentRow>(
      instrumentList.map((i: CachedInstrumentRow) => [i.symbol, i])
    );

    const now = Date.now();
    const items: FundingDataItem[] = [];

    for (const t of tickerList) {
      if (!spotSymbolSet.has(t.symbol)) continue;
      const inst = instrumentBySymbol.get(t.symbol);
      if (!inst) continue;

      const fundingRate = parseFloat(t.fundingRate ?? '0');
      const nextFundingTime = t.nextFundingTime ?? '0';
      const nextFundingMs = parseInt(nextFundingTime, 10) || 0;
      const countdownMs = Math.max(0, nextFundingMs - now);
      const turnover24h = parseFloat(t.turnover24h ?? '0');
      const fundingIntervalMinutes = inst.fundingInterval ?? 480;
      const fundingIntervalHours = fundingIntervalMinutes / 60;
      const maxLeverage = inst.leverageFilter?.maxLeverage ?? '';
      const maxOrderQty = inst.lotSizeFilter?.maxMktOrderQty ?? inst.lotSizeFilter?.maxOrderQty ?? '';

      if (filters) {
        if (filters.minFundingRate != null && Math.abs(fundingRate) < filters.minFundingRate) continue;
        if (filters.minVolume != null && turnover24h < filters.minVolume) continue;
        if (filters.type === 'positive' && fundingRate <= 0) continue;
        if (filters.type === 'negative' && fundingRate >= 0) continue;
      }

      const markPriceFutures = parseFloat(t.markPrice ?? t.lastPrice ?? '0') || 0;
      const spotPriceStr = spotPriceBySymbol.get(t.symbol) ?? '0';
      const spotPriceNum = parseFloat(spotPriceStr) || 0;
      const spreadPct =
        spotPriceNum > 0
          ? ((markPriceFutures - spotPriceNum) / spotPriceNum) * 100
          : undefined;

      items.push({
        symbol: t.symbol,
        fundingRate,
        nextFundingTime,
        countdownMs,
        lastPrice: t.lastPrice ?? '',
        markPrice: t.markPrice ?? t.lastPrice ?? '',
        turnover24h,
        fundingIntervalHours,
        maxLeverage,
        maxOrderQty,
        spotPrice: spotPriceStr || undefined,
        spreadPct,
      });
    }

    // Multi-level sort: primary = interval ascending (1h before 4h before 8h), secondary = |fundingRate| descending
    items.sort((a, b) => {
      const intervalA = a.fundingIntervalHours;
      const intervalB = b.fundingIntervalHours;
      if (intervalA !== intervalB) return intervalA - intervalB;
      return Math.abs(b.fundingRate) - Math.abs(a.fundingRate);
    });
    return items;
  }

  /**
   * Cross-exchange scanner: merge Bybit + Binance. Include every token that exists on both exchanges.
   * We trust Bybit's nextFundingTime for both legs (funding cycles align globally). No time-match filter.
   * Uses Bybit's funding interval for display (binanceIntervalHours = row.fundingIntervalHours).
   * Sort by interval asc then netSpread desc.
   */
  async getCrossExchangeFundingData(filters?: FundingDataFilters): Promise<FundingDataItem[]> {
    const [bybitItems, binanceMap] = await Promise.all([
      this.getFundingData(filters),
      getBinanceDataMap(),
    ]);

    const merged: FundingDataItem[] = [];

    for (const row of bybitItems) {
      const binance = binanceMap.get(row.symbol);
      if (!binance) continue;

      const bybitNextMs = Number(row.nextFundingTime) || 0;
      const netSpread = Math.abs(binance.fundingRate - row.fundingRate);
      const hedgeDirection =
        binance.fundingRate > row.fundingRate
          ? 'Short Binance / Long Bybit'
          : 'Short Bybit / Long Binance';

      merged.push({
        ...row,
        binanceFundingRate: binance.fundingRate,
        binanceIntervalHours: row.fundingIntervalHours,
        binanceMarkPrice: parseFloat(binance.markPrice) || undefined,
        binanceNextFundingTime: bybitNextMs || undefined,
        netSpread,
        hedgeDirection,
      });
    }

    merged.sort((a, b) => {
      const intervalA = a.fundingIntervalHours;
      const intervalB = b.fundingIntervalHours;
      if (intervalA !== intervalB) return intervalA - intervalB;
      return (b.netSpread ?? 0) - (a.netSpread ?? 0);
    });

    return merged;
  }
}

interface TickerRow {
  symbol: string;
  fundingRate?: string;
  nextFundingTime?: string;
  lastPrice?: string;
  markPrice?: string;
  turnover24h?: string;
}

interface SpotTickerRow {
  symbol: string;
  lastPrice?: string;
}

