import { getOrderbook, getOrderBookDepth } from './bybitService.js';
import { getPositionList, type LinearPosition } from './bybitService.js';
import { getExchangeKeys } from '../models/exchangeModel.js';
import { getSettings } from '../models/settingsModel.js';
import { decrypt } from '../utils/encryption.js';
import { FundingScanner } from './scannerService.js';
import { getHedgeGroupByPosition } from '../models/hedgeGroupModel.js';

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
}

/**
 * Fetch active positions for the user and enrich each with VWAP exit price, PnL, SL price, and target price.
 * When subaccount hedging is enabled (settings.subApiKey + subApiSecret), fetches positions from BOTH
 * main and sub accounts and injects accountType ('main' | 'sub') into each position.
 */
export async function getEnrichedPositions(userId: number): Promise<EnrichedPosition[]> {
  const keys = await getExchangeKeys(userId, 'Bybit');
  if (!keys) return [];

  const apiKey = decrypt(keys.api_key);
  const apiSecret = decrypt(keys.api_secret);

  const settings = await getSettings(userId);
  const subHedgingEnabled = !!(settings.subApiKey && settings.subApiSecret);
  let subApiKey: string | null = null;
  let subApiSecret: string | null = null;
  if (subHedgingEnabled && settings.subApiKey && settings.subApiSecret) {
    try {
      subApiKey = decrypt(settings.subApiKey);
      subApiSecret = decrypt(settings.subApiSecret);
    } catch {
      subApiKey = settings.subApiKey;
      subApiSecret = settings.subApiSecret;
    }
    if (!subApiKey || !subApiSecret) {
      subApiKey = settings.subApiKey;
      subApiSecret = settings.subApiSecret;
    }
  }

  const [mainPositions, fundingData] = await Promise.all([
    getPositionList(apiKey, apiSecret, { category: 'linear', settleCoin: 'USDT' }),
    fundingScanner.getFundingData(),
  ]);

  let subPositions: LinearPosition[] = [];
  if (subHedgingEnabled && subApiKey && subApiSecret) {
    try {
      subPositions = await getPositionList(subApiKey, subApiSecret, { category: 'linear', settleCoin: 'USDT' });
    } catch (e) {
      console.warn('[vwapService] Sub account positions fetch failed:', e);
    }
  }

  const fundingBySymbol = new Map(
    fundingData.map((item) => [item.symbol, item.fundingRate])
  );

  const enriched: EnrichedPosition[] = [];

  async function enrichList(
    positions: LinearPosition[],
    accountType: AccountType,
    keys: { apiKey: string; apiSecret: string }
  ): Promise<void> {
    for (const pos of positions) {
      const entry = parseFloat(pos.avgPrice) || 0;
      const qty = parseFloat(pos.size) || 0;
      const fundingRate = fundingBySymbol.get(pos.symbol) ?? 0;

      const hedgeGroup = await getHedgeGroupByPosition(userId, pos.symbol, pos.side);

      let vwapPrice = 0;
      try {
        const ob = await getOrderBookDepth(keys.apiKey, keys.apiSecret, pos.symbol, 2);
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
  if (subHedgingEnabled && subApiKey && subApiSecret) {
    await enrichList(subPositions, 'sub', { apiKey: subApiKey, apiSecret: subApiSecret });
  }

  return enriched;
}
