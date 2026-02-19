import { getOrderbook } from './bybitService.js';
import { getPositionList, type LinearPosition } from './bybitService.js';
import { getExchangeKeys } from '../models/exchangeModel.js';
import { decrypt } from '../utils/encryption.js';
import { FundingScanner } from './scannerService.js';

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

export interface EnrichedPosition extends LinearPosition {
  vwapPrice: number;
  pnl: number;
  slPrice: number;
  targetPrice: number;
  fundingRate: number;
}

/**
 * Fetch active positions for the user and enrich each with VWAP exit price, PnL, SL price, and target price.
 */
export async function getEnrichedPositions(userId: number): Promise<EnrichedPosition[]> {
  const keys = await getExchangeKeys(userId, 'Bybit');
  if (!keys) return [];

  const apiKey = decrypt(keys.api_key);
  const apiSecret = decrypt(keys.api_secret);

  const [positions, fundingData] = await Promise.all([
    getPositionList(apiKey, apiSecret, { category: 'linear', settleCoin: 'USDT' }),
    fundingScanner.getFundingData(),
  ]);

  const fundingBySymbol = new Map(
    fundingData.map((item) => [item.symbol, item.fundingRate])
  );

  const enriched: EnrichedPosition[] = [];

  for (const pos of positions) {
    const entry = parseFloat(pos.avgPrice) || 0;
    const qty = parseFloat(pos.size) || 0;
    const fundingRate = fundingBySymbol.get(pos.symbol) ?? 0;

    const vwapPrice = await calculateVWAP(pos.symbol, pos.side, qty);

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
    });
  }

  return enriched;
}
