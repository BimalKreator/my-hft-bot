import { getOrderbook, getOrderBookDepth, ORDERBOOK_DEPTH_BEST } from './bybitService.js';
import { getPositionList, type LinearPosition } from './bybitService.js';
import { getExchangeKeys, getSubAccountKeys } from '../models/exchangeModel.js';
import { getSettings } from '../models/settingsModel.js';
import { decrypt } from '../utils/encryption.js';
import { FundingScanner } from './scannerService.js';

/** Decrypt if possible; if decrypt throws (e.g. value was saved as plain text), return raw string. */
function tryDecrypt(val: string | null | undefined): string {
  if (!val) return '';
  try {
    return decrypt(val);
  } catch {
    return val;
  }
}
import { getHedgeGroupByPosition } from '../models/hedgeGroupModel.js';
import { getBinanceAllPositions, getBinanceSymbol } from './binanceService.js';

const ORDERBOOK_DEPTH = 50;
const LIQUIDITY_MULTIPLIER = 1.2;

const fundingScanner = new FundingScanner();

/**
 * Calculate volume-weighted average price for closing a position.
 * - Long (Buy): simulate selling → use Bids.
 * - Short (Sell): simulate buying → use Asks.
 * Fills quantity * 1.2 (120% of position size) across the book, then VWAP = TotalValue / TotalQty.
 */
export async function calculateVWAP(
  symbol: string,
  side: 'Buy' | 'Sell',
  quantity: number
): Promise<number> {
  const requiredVolume = quantity * LIQUIDITY_MULTIPLIER;
  const { bids, asks } = await getOrderbook(symbol, ORDERBOOK_DEPTH);

  const levels = side === 'Buy' ? bids : asks;
  let totalValue = 0;
  let totalQty = 0;
  let remaining = requiredVolume;

  for (const level of levels) {
    if (remaining <= 0) break;
    const price = parseFloat(level.price) || 0;
    const size = parseFloat(level.size) || 0;
    if (price <= 0 || size <= 0) continue;

    const take = Math.min(size, remaining);
    totalValue += price * take;
    totalQty += take;
    remaining -= take;
  }

  if (totalQty <= 0) {
    return 0;
  }
  return totalValue / totalQty;
}

export type AccountType = 'main' | 'sub';

export type ExchangeLabel = 'Bybit' | 'Binance';

export interface EnrichedPosition extends LinearPosition {
  vwapPrice: number;
  pnl: number;
  slPrice: number;
  targetPrice: number;
  fundingRate: number;
  /** Set when this position is part of a spot-hedged pair */
  hedgeGroupId?: string;
  fundingAmountReceived?: number | null;
  spotQty?: number;
  spotEntryPrice?: number;
  isPaired?: boolean;
  /** Set when subaccount hedging is enabled: which account this position belongs to */
  accountType?: AccountType;
  /** Exchange this position belongs to (for cross-exchange and grouping) */
  exchange?: ExchangeLabel;
  /** True when cross-exchange funding spread has reversed against the open positions */
  isFundingFlipped?: boolean;
}

/**
 * Fetch active positions for the user and enrich each with VWAP exit price, PnL, SL price, and target price.
 * When subaccount hedging is enabled (sub keys in Exchange Setup), fetches positions from BOTH
 * main and sub accounts and injects accountType ('main' | 'sub') into each position.
 */
export async function getEnrichedPositions(userId: number): Promise<EnrichedPosition[]> {
  const keys = await getExchangeKeys(userId, 'Bybit');
  if (!keys) return [];

  const apiKey = decrypt(keys.api_key);
  const apiSecret = decrypt(keys.api_secret);

  const subKeys = await getSubAccountKeys(userId);
  const subHedgingEnabled = !!subKeys;

  const [mainPositions, fundingData] = await Promise.all([
    getPositionList(apiKey, apiSecret, { category: 'linear', settleCoin: 'USDT' }),
    fundingScanner.getFundingData(),
  ]);

  let subPositions: LinearPosition[] = [];
  if (subHedgingEnabled && subKeys) {
    try {
      subPositions = await getPositionList(subKeys.subApiKey, subKeys.subApiSecret, { category: 'linear', settleCoin: 'USDT' });
    } catch (e) {
      console.warn('[vwapService] Sub account positions fetch failed:', e);
    }
  }

  const fundingBySymbol = new Map(
    fundingData.map((item) => [item.symbol, item.fundingRate])
  );

  const enriched: EnrichedPosition[] = [];

  let binancePositions: Awaited<ReturnType<typeof getBinanceAllPositions>> = [];
  const settings = await getSettings(userId);
  const crossExchangeMode = !!settings.crossExchangeMode && !!settings.binanceApiKey && !!settings.binanceApiSecret;
  if (crossExchangeMode) {
    try {
      const binanceApiKey = tryDecrypt(settings.binanceApiKey) || settings.binanceApiKey || '';
      const binanceApiSecret = tryDecrypt(settings.binanceApiSecret) || settings.binanceApiSecret || '';
      binancePositions = await getBinanceAllPositions(binanceApiKey, binanceApiSecret);
    } catch (e) {
      console.warn('[vwapService] Binance positions fetch failed:', e);
    }
  }
  const binanceBySymbol = new Map(binancePositions.map((p) => [p.symbol, p]));

  async function enrichList(
    positions: LinearPosition[],
    accountType: AccountType,
    keys: { apiKey: string; apiSecret: string }
  ): Promise<void> {
    for (const pos of positions) {
      const entry = parseFloat(pos.avgPrice) || 0;
      const qty = parseFloat(pos.size) || 0;
      const fundingRate = fundingBySymbol.get(pos.symbol) ?? 0;
      const binancePos = binanceBySymbol.get(pos.symbol);
      const bybitFR = fundingRate;
      const binanceFR = getBinanceSymbol(pos.symbol)?.fundingRate ?? 0;
      const fundingYield = pos.side === 'Buy' ? binanceFR - bybitFR : bybitFR - binanceFR;
      const isFundingFlipped = !!binancePos && fundingYield < 0;

      const hedgeGroup = await getHedgeGroupByPosition(userId, pos.symbol, pos.side);

      let vwapPrice = 0;
      try {
        const ob = await getOrderBookDepth(keys.apiKey, keys.apiSecret, pos.symbol, ORDERBOOK_DEPTH_BEST);
        vwapPrice = pos.side === 'Buy' ? ob.bidPrice : ob.askPrice;
        if (!Number.isFinite(vwapPrice)) vwapPrice = 0;
      } catch {
        vwapPrice = await calculateVWAP(pos.symbol, pos.side, qty);
      }

      const pnl =
        pos.side === 'Buy'
          ? (vwapPrice - entry) * qty
          : (entry - vwapPrice) * qty;

      const slPercent = fundingRate;
      const slPrice =
        pos.side === 'Buy'
          ? entry * (1 - slPercent)
          : entry * (1 + slPercent);

      const targetPrice =
        pos.side === 'Buy'
          ? entry * (1 + fundingRate)
          : entry * (1 - fundingRate);

      enriched.push({
        ...pos,
        vwapPrice,
        pnl,
        slPrice,
        targetPrice,
        fundingRate,
        accountType,
        exchange: 'Bybit',
        ...(isFundingFlipped && { isFundingFlipped: true }),
        ...(hedgeGroup != null && {
          hedgeGroupId: hedgeGroup.hedgeGroupId,
          fundingAmountReceived: hedgeGroup.fundingAmountReceived,
          spotQty: hedgeGroup.spotQty,
          spotEntryPrice: hedgeGroup.spotEntryPrice,
          isPaired: true,
        }),
      });
    }
  }

  await enrichList(mainPositions, 'main', { apiKey, apiSecret });
  if (subHedgingEnabled && subKeys) {
    await enrichList(subPositions, 'sub', { apiKey: subKeys.subApiKey, apiSecret: subKeys.subApiSecret });
  }

  for (const bp of binancePositions) {
    const bybitFR = fundingBySymbol.get(bp.symbol) ?? 0;
    const binanceFR = getBinanceSymbol(bp.symbol)?.fundingRate ?? 0;
    const binanceSide: 'Buy' | 'Sell' = bp.positionAmt > 0 ? 'Buy' : 'Sell';
    const fundingYield = binanceSide === 'Sell' ? binanceFR - bybitFR : bybitFR - binanceFR;
    const isFundingFlipped = fundingYield < 0;
    const markPrice = getBinanceSymbol(bp.symbol)?.markPrice ?? '';
    const entry = bp.entryPrice;
    const qty = Math.abs(bp.positionAmt);
    const vwapPrice = markPrice ? parseFloat(markPrice) || 0 : 0;
    const pnl = bp.unRealizedProfit;
    const slPrice = binanceSide === 'Buy' ? entry * (1 - binanceFR) : entry * (1 + binanceFR);
    const targetPrice = binanceSide === 'Buy' ? entry * (1 + binanceFR) : entry * (1 - binanceFR);
    enriched.push({
      symbol: bp.symbol,
      side: binanceSide,
      size: String(qty),
      avgPrice: String(entry),
      markPrice: markPrice || String(entry),
      vwapPrice,
      pnl,
      slPrice,
      targetPrice,
      fundingRate: binanceFR,
      exchange: 'Binance',
      ...(isFundingFlipped && { isFundingFlipped: true }),
    });
  }

  return enriched;
}
