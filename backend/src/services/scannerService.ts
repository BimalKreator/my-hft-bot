import { RestClientV5 } from 'bybit-api';
import { getInstrumentsCache, type CachedInstrumentRow } from './bybitService.js';

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
}

export class FundingScanner {
  private bybit: RestClientV5;

  constructor() {
    const testnet = process.env.BYBIT_TESTNET === 'true';
    this.bybit = new RestClientV5({ testnet });
  }

  async getFundingData(filters?: FundingDataFilters): Promise<FundingDataItem[]> {
    const [tickersRes, rawInstruments] = await Promise.all([
      this.bybit.getTickers({ category: 'linear' }),
      getInstrumentsCache(),
    ]);

    if (tickersRes.retCode !== 0) throw new Error(tickersRes.retMsg ?? 'Bybit tickers failed');

    const tickerList = (tickersRes.result as { list: TickerRow[] }).list ?? [];

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
}

interface TickerRow {
  symbol: string;
  fundingRate?: string;
  nextFundingTime?: string;
  lastPrice?: string;
  markPrice?: string;
  turnover24h?: string;
}

