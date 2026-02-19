import axios from 'axios';
import CryptoJS from 'crypto-js';
import { RestClientV5 } from 'bybit-api';

const BASE_URL = process.env.BYBIT_TESTNET === 'true'
  ? 'https://api-testnet.bybit.com'
  : 'https://api.bybit.com';
const RECV_WINDOW = '5000';
const testnet = process.env.BYBIT_TESTNET === 'true';

function getClient(apiKey: string, apiSecret: string): RestClientV5 {
  return new RestClientV5({ key: apiKey, secret: apiSecret, testnet });
}

/** Public REST client for market data (no auth). */
function getPublicClient(): RestClientV5 {
  return new RestClientV5({ testnet });
}

const INSTRUMENTS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Full instrument row from Bybit (for scanner filter + lot/leverage). */
export interface CachedInstrumentRow {
  symbol: string;
  contractType?: string;
  quoteCoin?: string;
  status?: string;
  fundingInterval?: number;
  lotSizeFilter?: { maxOrderQty?: string; maxMktOrderQty?: string };
  leverageFilter?: { maxLeverage?: string };
}

let instrumentsCache: { list: CachedInstrumentRow[]; fetchedAt: number } | null = null;

async function refreshInstrumentsCache(): Promise<void> {
  const client = getPublicClient();
  const res = await client.getInstrumentsInfo({ category: 'linear' });
  if (res.retCode !== 0) {
    throw new Error(res.retMsg ?? 'Bybit getInstrumentsInfo failed');
  }
  const list = (res.result as { list?: CachedInstrumentRow[] })?.list ?? [];
  instrumentsCache = { list, fetchedAt: Date.now() };
}

/**
 * Get full instruments list; refreshes from Bybit if cache is missing or older than 1 hour.
 */
export async function getInstrumentsCache(): Promise<CachedInstrumentRow[]> {
  if (!instrumentsCache || Date.now() - instrumentsCache.fetchedAt > INSTRUMENTS_CACHE_TTL_MS) {
    await refreshInstrumentsCache();
  }
  return instrumentsCache!.list;
}

/**
 * Read from instruments cache (refreshes if stale). Returns maxOrderQty and maxLeverage for the symbol.
 */
export async function getInstrumentDetails(
  symbol: string
): Promise<{ maxOrderQty: string; maxLeverage: string }> {
  const list = await getInstrumentsCache();
  const row = list.find((r) => r.symbol === symbol);
  const lot = row?.lotSizeFilter;
  return {
    maxOrderQty: lot?.maxMktOrderQty ?? lot?.maxOrderQty ?? '',
    maxLeverage: row?.leverageFilter?.maxLeverage ?? '',
  };
}

function sign(apiSecret: string, paramStr: string): string {
  const hash = CryptoJS.HmacSHA256(paramStr, apiSecret);
  return hash.toString(CryptoJS.enc.Hex);
}

export interface WalletBalanceResult {
  totalEquity: string;
  totalAvailableBalance: string;
  totalPerpUPL: string;
  coins: Array<{
    coin: string;
    equity: string;
    usdValue: string;
    walletBalance: string;
  }>;
}

export async function getWalletBalance(
  apiKey: string,
  apiSecret: string
): Promise<WalletBalanceResult> {
  const timestamp = Date.now().toString();
  const queryString = 'accountType=UNIFIED';
  const paramStr = timestamp + apiKey + RECV_WINDOW + queryString;
  const signature = sign(apiSecret, paramStr);

  const { data } = await axios.get(
    `${BASE_URL}/v5/account/wallet-balance?${queryString}`,
    {
      headers: {
        'X-BAPI-API-KEY': apiKey,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-SIGN': signature,
        'X-BAPI-RECV-WINDOW': RECV_WINDOW,
      },
    }
  );

  if (data.retCode !== 0) {
    throw new Error(data.retMsg ?? 'Bybit API error');
  }

  const list = data?.result?.list?.[0];
  const totalEquity = list?.totalEquity ?? '0';
  const totalAvailableBalance = list?.totalAvailableBalance ?? '0';
  const totalPerpUPL = list?.totalPerpUPL ?? '0';
  const accounts = list?.coin ?? [];

  const coins = accounts.map((c: { coin?: string; equity?: string; usdValue?: string; walletBalance?: string }) => ({
    coin: c.coin ?? '',
    equity: c.equity ?? '0',
    usdValue: c.usdValue ?? '0',
    walletBalance: c.walletBalance ?? '0',
  }));

  return { totalEquity, totalAvailableBalance, totalPerpUPL, coins };
}

/**
 * Set leverage for a linear perpetual symbol. Ignores errors (e.g. leverage already set).
 */
export async function setLeverage(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  leverage: number
): Promise<void> {
  const client = getClient(apiKey, apiSecret);
  const levStr = String(leverage);
  await client.setLeverage({
    category: 'linear',
    symbol,
    buyLeverage: levStr,
    sellLeverage: levStr,
  });
}

/**
 * Place a market order on linear perpetual. Returns orderId and orderLinkId.
 */
export async function placeMarketOrder(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  side: 'Buy' | 'Sell',
  qty: string
): Promise<{ orderId: string; orderLinkId: string }> {
  const client = getClient(apiKey, apiSecret);
  const res = await client.submitOrder({
    category: 'linear',
    symbol,
    side,
    orderType: 'Market',
    qty,
  });
  if (res.retCode !== 0) {
    throw new Error(res.retMsg ?? 'Bybit place order failed');
  }
  const result = res.result as { orderId: string; orderLinkId: string };
  return { orderId: result.orderId, orderLinkId: result.orderLinkId };
}

/**
 * Place a market reduce-only order to close a position. Opposite side of position.
 */
export async function placeMarketOrderReduceOnly(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  positionSide: 'Buy' | 'Sell',
  qty: string
): Promise<{ orderId: string; orderLinkId: string }> {
  const client = getClient(apiKey, apiSecret);
  const closeSide = positionSide === 'Buy' ? 'Sell' : 'Buy';
  const res = await client.submitOrder({
    category: 'linear',
    symbol,
    side: closeSide,
    orderType: 'Market',
    qty,
    reduceOnly: true,
  });
  if (res.retCode !== 0) {
    throw new Error(res.retMsg ?? 'Bybit place reduce-only order failed');
  }
  const result = res.result as { orderId: string; orderLinkId: string };
  return { orderId: result.orderId, orderLinkId: result.orderLinkId };
}

/**
 * Get execution list for an order (e.g. to get exec price and fee after market order).
 */
export async function getExecutionList(
  apiKey: string,
  apiSecret: string,
  category: 'linear',
  orderId: string
): Promise<Array<{ execPrice: string; execQty: string; execFee?: string }>> {
  const client = getClient(apiKey, apiSecret);
  const res = await client.getExecutionList({ category, orderId });
  if (res.retCode !== 0) {
    throw new Error(res.retMsg ?? 'Bybit get execution list failed');
  }
  const list = (res.result as {
    list?: Array<{ execPrice: string; execQty: string; execFee?: string }>;
  })?.list ?? [];
  return list.map((e) => ({
    execPrice: e.execPrice,
    execQty: e.execQty,
    execFee: e.execFee,
  }));
}

export interface LinearPosition {
  symbol: string;
  side: 'Buy' | 'Sell';
  size: string;
  avgPrice: string;
}

/**
 * Get open linear positions (size > 0). Uses category 'linear' and settleCoin 'USDT' by default.
 */
export async function getPositionList(
  apiKey: string,
  apiSecret: string,
  options: { category?: 'linear'; settleCoin?: string } = {}
): Promise<LinearPosition[]> {
  const client = getClient(apiKey, apiSecret);
  const category = options.category ?? 'linear';
  const settleCoin = options.settleCoin ?? 'USDT';
  const res = await client.getPositionInfo({ category, settleCoin });
  if (res.retCode !== 0) {
    throw new Error(res.retMsg ?? 'Bybit get position list failed');
  }
  const list = (res.result as { list?: Array<{ symbol: string; side: 'Buy' | 'Sell'; size: string; avgPrice?: string }> })?.list ?? [];
  return list
    .filter((p) => parseFloat(p.size) > 0)
    .map((p) => ({ symbol: p.symbol, side: p.side, size: p.size, avgPrice: p.avgPrice ?? '0' }));
}

export interface OrderbookLevel {
  price: string;
  size: string;
}

export interface OrderbookResult {
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
}

/**
 * Get order book for a linear perpetual (public endpoint). limit 1–500, default 50.
 */
export async function getOrderbook(symbol: string, limit = 50): Promise<OrderbookResult> {
  const client = getPublicClient();
  const res = await client.getOrderbook({ category: 'linear', symbol, limit });
  if (res.retCode !== 0) {
    throw new Error(res.retMsg ?? 'Bybit get orderbook failed');
  }
  const result = res.result as { b?: [string, string][]; a?: [string, string][] };
  const bids = (result.b ?? []).map(([price, size]) => ({ price, size }));
  const asks = (result.a ?? []).map(([price, size]) => ({ price, size }));
  return { bids, asks };
}

export interface InstrumentLotSize {
  qtyStep: string;
  minOrderQty: string;
  maxOrderQty: string;
  maxMktOrderQty: string;
}

/**
 * Fetch lot size filter for a linear symbol (qtyStep, minOrderQty, maxOrderQty, maxMktOrderQty).
 * Use maxMktOrderQty for market orders; fall back to maxOrderQty when absent.
 */
export async function getInstrumentLotSize(
  apiKey: string,
  apiSecret: string,
  symbol: string
): Promise<InstrumentLotSize> {
  const client = getClient(apiKey, apiSecret);
  const res = await client.getInstrumentsInfo({ category: 'linear', symbol });
  if (res.retCode !== 0) {
    throw new Error(res.retMsg ?? 'Bybit get instruments info failed');
  }
  const list = (res.result as {
    list?: Array<{ lotSizeFilter?: { qtyStep?: string; minOrderQty?: string; maxOrderQty?: string; maxMktOrderQty?: string } }>;
  })?.list ?? [];
  const inst = list[0];
  const filter = inst?.lotSizeFilter;
  const qtyStep = filter?.qtyStep ?? '0.1';
  const minOrderQty = filter?.minOrderQty ?? '0';
  const maxOrderQty = filter?.maxOrderQty ?? '999999';
  const maxMktOrderQty = filter?.maxMktOrderQty ?? '';
  return { qtyStep, minOrderQty, maxOrderQty, maxMktOrderQty };
}
