import https from 'https';
import crypto from 'crypto';
import axios from 'axios';
import CryptoJS from 'crypto-js';
import { RestClientV5, WebsocketClient, WS_KEY_MAP } from 'bybit-api';

const BASE_URL = process.env.BYBIT_TESTNET === 'true'
  ? 'https://api-testnet.bybit.com'
  : 'https://api.bybit.com';
const RECV_WINDOW = '5000';
const testnet = process.env.BYBIT_TESTNET === 'true';

/** Persistent HTTPS agent for connection reuse and lower latency to Bybit. */
const keepAliveAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 10000 });

/** Axios instance using the keep-alive agent for direct Bybit REST calls (e.g. wallet-balance). */
const axiosBybit = axios.create({ httpsAgent: keepAliveAgent });

/** Network options passed to RestClientV5 so all SDK requests use the same agent. */
const restNetworkOptions = { httpsAgent: keepAliveAgent };

/**
 * Per-credential V5 Private Trade WebSocket client cache (for low-latency order placement).
 * Main and Sub accounts each get their own client when using subaccount hedging (different apiKey).
 */
const wsClientByKey = new Map<string, WebsocketClient>();

function getWsClient(apiKey: string, apiSecret: string): WebsocketClient {
  let client = wsClientByKey.get(apiKey);
  if (!client) {
    client = new WebsocketClient({
      key: apiKey,
      secret: apiSecret,
      testnet,
      market: 'v5',
      recvWindow: Number(RECV_WINDOW) || 5000,
    });
    wsClientByKey.set(apiKey, client);
  }
  return client;
}

/**
 * Submit an order via V5 Private WebSocket (order.create). Use for HFT-style execution.
 * Throws on WS failure or retCode !== 0 so caller can fallback to REST.
 */
async function submitOrderWs(
  apiKey: string,
  apiSecret: string,
  orderParams: {
    category: 'linear' | 'spot';
    symbol: string;
    side: 'Buy' | 'Sell';
    orderType: 'Limit' | 'Market';
    qty: string;
    price?: string;
    timeInForce?: string;
    reduceOnly?: boolean;
    orderFilter?: string;
    isLeverage?: 0 | 1;
  }
): Promise<{ orderId: string; orderLinkId: string }> {
  const ws = getWsClient(apiKey, apiSecret);
  await ws.connectWSAPI();
  const res = await ws.sendWSAPIRequest(WS_KEY_MAP.v5PrivateTrade, 'order.create', orderParams);
  const data = res as {
    retCode: number;
    retMsg?: string;
    data?: { orderId: string; orderLinkId: string };
    header?: { Timenow?: string };
    time?: number;
  };
  if (data.retCode !== 0) {
    throw new Error(data.retMsg ?? 'WebSocket order.create failed');
  }
  const result = data.data;
  if (!result?.orderId) {
    throw new Error('WebSocket order response missing orderId');
  }
  const bybitTime = data.header?.Timenow ?? data.time ?? 'N/A';
  console.log(`[DEBUG WS SUCCESS] Order ${orderParams.symbol} Placed. Local Time: ${Date.now()} | Bybit Time: ${bybitTime}`, res);
  return { orderId: result.orderId, orderLinkId: result.orderLinkId ?? '' };
}

function getClient(apiKey: string, apiSecret: string): RestClientV5 {
  return new RestClientV5({ key: apiKey, secret: apiSecret, testnet }, restNetworkOptions);
}

/** Public REST client for market data (no auth). */
function getPublicClient(): RestClientV5 {
  return new RestClientV5({ testnet }, restNetworkOptions);
}

/**
 * Warm up the WebSocket Private Trade connection for the given credentials so the first order
 * does not pay connection/authentication latency. Call at bot startup for each user with auto entry.
 */
export async function warmupWsConnection(apiKey: string, apiSecret: string): Promise<void> {
  const ws = getWsClient(apiKey, apiSecret);
  await ws.connectWSAPI();
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
  /** Account initial margin (USD) — actual margin used by open positions. Use for "Margin Used" display. */
  totalInitialMargin: string;
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

  const { data } = await axiosBybit.get(
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
  const totalInitialMargin = list?.totalInitialMargin ?? '0';
  const accounts = list?.coin ?? [];

  const coins = accounts.map((c: { coin?: string; equity?: string; usdValue?: string; walletBalance?: string }) => ({
    coin: c.coin ?? '',
    equity: c.equity ?? '0',
    usdValue: c.usdValue ?? '0',
    walletBalance: c.walletBalance ?? '0',
  }));

  return { totalEquity, totalAvailableBalance, totalPerpUPL, totalInitialMargin, coins };
}

export interface UsdtWalletDetails {
  walletBalance: string;
  availableToWithdraw: string;
  accountType: 'UNIFIED' | 'CONTRACT';
}

/**
 * Fetch USDT wallet details for sizing:
 * - walletBalance: total capital (USDT wallet balance)
 * - availableToWithdraw: free margin
 *
 * Tries UNIFIED first, then falls back to CONTRACT.
 */
export async function getUsdtWalletDetails(
  apiKey: string,
  apiSecret: string
): Promise<UsdtWalletDetails> {
  const call = async (accountType: 'UNIFIED' | 'CONTRACT'): Promise<UsdtWalletDetails> => {
    const timestamp = Date.now().toString();
    const queryString = `accountType=${accountType}&coin=USDT`;
    const paramStr = timestamp + apiKey + RECV_WINDOW + queryString;
    const signature = sign(apiSecret, paramStr);

    const { data } = await axiosBybit.get(`${BASE_URL}/v5/account/wallet-balance?${queryString}`, {
      headers: {
        'X-BAPI-API-KEY': apiKey,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-SIGN': signature,
        'X-BAPI-RECV-WINDOW': RECV_WINDOW,
      },
    });

    if (data.retCode !== 0) {
      throw new Error(data.retMsg ?? 'Bybit API error');
    }

    const list = data?.result?.list?.[0];
    const accounts = list?.coin ?? [];
    const usdt = accounts.find((c: { coin?: string }) => c.coin === 'USDT') ?? accounts[0];
    const walletBalance = usdt?.walletBalance ?? list?.totalEquity ?? '0';
    const availableToWithdraw = usdt?.availableToWithdraw ?? list?.totalAvailableBalance ?? '0';

    return { walletBalance, availableToWithdraw, accountType };
  };

  try {
    return await call('UNIFIED');
  } catch {
    return await call('CONTRACT');
  }
}

/**
 * Get the UID (member id) for the account that owns the given API key.
 * Uses GET /v5/user/get-member-type. Required for universal transfer.
 */
export async function getMemberUid(apiKey: string, apiSecret: string): Promise<string> {
  const timestamp = Date.now().toString();
  const paramStr = timestamp + apiKey + RECV_WINDOW;
  const signature = sign(apiSecret, paramStr);
  const { data } = await axiosBybit.get(`${BASE_URL}/v5/user/get-member-type`, {
    headers: {
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-SIGN': signature,
      'X-BAPI-RECV-WINDOW': RECV_WINDOW,
    },
  });
  if (data.retCode !== 0) throw new Error(data.retMsg ?? 'Bybit get-member-type failed');
  const accounts = data?.result?.accounts ?? [];
  const first = accounts[0];
  if (!first?.uid) throw new Error('Bybit get-member-type: no uid in response');
  return String(first.uid);
}

/**
 * Get sub-account UIDs. Call with master (main) API key. Returns list of sub UIDs.
 */
export async function getSubMemberIds(apiKey: string, apiSecret: string): Promise<string[]> {
  const timestamp = Date.now().toString();
  const queryString = 'pageSize=100';
  const paramStr = timestamp + apiKey + RECV_WINDOW + queryString;
  const signature = sign(apiSecret, paramStr);
  const { data } = await axiosBybit.get(`${BASE_URL}/v5/user/submembers?${queryString}`, {
    headers: {
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-SIGN': signature,
      'X-BAPI-RECV-WINDOW': RECV_WINDOW,
    },
  });
  if (data.retCode !== 0) throw new Error(data.retMsg ?? 'Bybit submembers failed');
  const list = data?.result?.subMembers ?? [];
  return list.map((m: { uid?: string }) => String(m.uid ?? '')).filter(Boolean);
}

/**
 * Transfer funds between main and sub (UNIFIED to UNIFIED) via Bybit universal transfer.
 * fromAccount/toAccount: 'main' | 'sub'. Uses main API key for main->sub, sub API key for sub->main.
 */
export async function transferFunds(
  mainApiKey: string,
  mainApiSecret: string,
  subApiKey: string,
  subApiSecret: string,
  fromAccount: 'main' | 'sub',
  toAccount: 'main' | 'sub',
  amount: string,
  coin: string = 'USDT'
): Promise<{ transferId: string; status: string }> {
  const mainUid = await getMemberUid(mainApiKey, mainApiSecret);
  const subUids = await getSubMemberIds(mainApiKey, mainApiSecret);
  const subUid = subUids[0];
  if (!subUid) throw new Error('No sub-account UID found');
  const fromUid = fromAccount === 'main' ? mainUid : subUid;
  const toUid = toAccount === 'main' ? mainUid : subUid;
  const apiKey = fromAccount === 'main' ? mainApiKey : subApiKey;
  const apiSecret = fromAccount === 'main' ? mainApiSecret : subApiSecret;
  const transferId = crypto.randomUUID();
  const body = {
    transferId,
    coin: coin.toUpperCase(),
    amount: String(amount),
    fromMemberId: parseInt(fromUid, 10),
    toMemberId: parseInt(toUid, 10),
    fromAccountType: 'UNIFIED',
    toAccountType: 'UNIFIED',
  };
  const bodyStr = JSON.stringify(body);
  const timestamp = Date.now().toString();
  const paramStr = timestamp + apiKey + RECV_WINDOW + bodyStr;
  const signature = sign(apiSecret, paramStr);
  const { data } = await axiosBybit.post(`${BASE_URL}/v5/asset/transfer/universal-transfer`, body, {
    headers: {
      'Content-Type': 'application/json',
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-SIGN': signature,
      'X-BAPI-RECV-WINDOW': RECV_WINDOW,
    },
  });
  if (data.retCode !== 0) throw new Error(data.retMsg ?? 'Bybit universal-transfer failed');
  const result = data?.result ?? {};
  return { transferId: result.transferId ?? transferId, status: result.status ?? 'UNKNOWN' };
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
 * Set stop loss on a linear position (full position TP/SL mode). Used for Main fallback SL when Sub fails in hedge mode.
 * stopLossPrice must be formatted to symbol tick size. positionIdx 0 = one-way mode.
 */
export async function setTradingStop(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  stopLossPrice: string,
  positionIdx: 0 | 1 | 2 = 0
): Promise<void> {
  const client = getClient(apiKey, apiSecret);
  await client.setTradingStop({
    category: 'linear',
    symbol,
    stopLoss: stopLossPrice,
    tpslMode: 'Full',
    positionIdx,
  });
}

/**
 * Place a market order on linear perpetual. Uses WebSocket first, REST fallback.
 */
export async function placeMarketOrder(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  side: 'Buy' | 'Sell',
  qty: string
): Promise<{ orderId: string; orderLinkId: string }> {
  try {
    return await submitOrderWs(apiKey, apiSecret, {
      category: 'linear',
      symbol,
      side,
      orderType: 'Market',
      qty,
    });
  } catch (wsErr) {
    console.warn('[bybit] WS market order failed, falling back to REST:', (wsErr as Error)?.message ?? wsErr);
  }
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
 * Place a limit order on linear perpetual. Uses WebSocket first for low latency, falls back to REST if WS is down.
 */
export async function placeLimitOrder(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  side: 'Buy' | 'Sell',
  qty: string,
  price: string,
  timeInForce: 'GTC' | 'PostOnly' | 'IOC' = 'GTC'
): Promise<{ orderId: string; orderLinkId: string }> {
  try {
    return await submitOrderWs(apiKey, apiSecret, {
      category: 'linear',
      symbol,
      side,
      orderType: 'Limit',
      qty,
      price,
      timeInForce,
    });
  } catch (wsErr) {
    console.warn('[bybit] WS order failed, falling back to REST:', (wsErr as Error)?.message ?? wsErr);
  }
  const client = getClient(apiKey, apiSecret);
  const res = await client.submitOrder({
    category: 'linear',
    symbol,
    side,
    orderType: 'Limit',
    qty,
    price,
    timeInForce,
  });
  if (res.retCode !== 0) {
    throw new Error(res.retMsg ?? 'Bybit place limit order failed');
  }
  const result = res.result as { orderId: string; orderLinkId: string };
  return { orderId: result.orderId, orderLinkId: result.orderLinkId };
}

/**
 * Place a market reduce-only order to close a position. Uses WebSocket first, REST fallback.
 */
export async function placeMarketOrderReduceOnly(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  positionSide: 'Buy' | 'Sell',
  qty: string
): Promise<{ orderId: string; orderLinkId: string }> {
  const closeSide = positionSide === 'Buy' ? 'Sell' : 'Buy';
  try {
    return await submitOrderWs(apiKey, apiSecret, {
      category: 'linear',
      symbol,
      side: closeSide,
      orderType: 'Market',
      qty,
      reduceOnly: true,
    });
  } catch (wsErr) {
    console.warn('[bybit] WS reduce-only order failed, falling back to REST:', (wsErr as Error)?.message ?? wsErr);
  }
  const client = getClient(apiKey, apiSecret);
  const res = await client.submitOrder({
    category: 'linear',
    symbol,
    side: closeSide,
    orderType: 'Market',
    qty,
    reduceOnly: true,
  });
  if (res.retCode !== 0) {
    const msg = (res.retMsg ?? '').toLowerCase();
    if (qty && (msg.includes('position') || msg.includes('insufficient') || msg.includes('size') || msg.includes('zero'))) {
      return { orderId: '', orderLinkId: '' };
    }
    throw new Error(res.retMsg ?? 'Bybit place reduce-only order failed');
  }
  const result = res.result as { orderId: string; orderLinkId: string };
  return { orderId: result.orderId, orderLinkId: result.orderLinkId };
}

const SPOT_MARGIN_CHECK_TIMEOUT_MS = 3000;

/**
 * Check if a spot symbol supports margin trading (isMarginTrading !== 'none').
 * Wrapped in try/catch + timeout; returns false on failure so we fall back to Pure Spot (1x).
 */
export async function getSpotMarginSupport(symbol: string): Promise<boolean> {
  try {
    const client = getPublicClient();
    const res = await Promise.race([
      client.getInstrumentsInfo({ category: 'spot', symbol }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), SPOT_MARGIN_CHECK_TIMEOUT_MS)),
    ]);
    if (res.retCode !== 0) return false;
    const list = (res.result as { list?: Array<{ marginTrading?: string }> })?.list ?? [];
    const item = list[0];
    return item != null && item.marginTrading != null && item.marginTrading !== 'none';
  } catch {
    return false;
  }
}

/**
 * Place a spot order WITHOUT margin/leverage. Uses WebSocket first, REST fallback.
 */
export async function placeSpotOrder(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  side: 'Buy' | 'Sell',
  orderType: 'Market' | 'Limit',
  qty: string,
  price?: string,
  timeInForce: 'GTC' | 'IOC' | 'FOK' | 'PostOnly' = 'GTC'
): Promise<{ orderId: string; orderLinkId: string }> {
  const params = {
    category: 'spot' as const,
    symbol,
    side,
    orderType,
    qty,
    orderFilter: 'Order' as const,
    timeInForce: orderType === 'Limit' ? timeInForce : 'IOC',
    ...(orderType === 'Limit' && price != null && { price }),
  };
  try {
    return await submitOrderWs(apiKey, apiSecret, params);
  } catch (wsErr) {
    console.warn('[bybit] WS spot order failed, falling back to REST:', (wsErr as Error)?.message ?? wsErr);
  }
  const client = getClient(apiKey, apiSecret);
  const res = await client.submitOrder(params as Parameters<RestClientV5['submitOrder']>[0]);
  if (res.retCode !== 0) {
    throw new Error(res.retMsg ?? 'Bybit place spot order failed');
  }
  const result = res.result as { orderId: string; orderLinkId: string };
  return { orderId: result.orderId, orderLinkId: result.orderLinkId };
}

/**
 * Place a spot margin order (isLeverage: 1). Uses WebSocket first, REST fallback.
 */
export async function placeSpotMarginOrder(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  side: 'Buy' | 'Sell',
  orderType: 'Market' | 'Limit',
  qty: string,
  price?: string,
  timeInForce: 'GTC' | 'IOC' | 'FOK' | 'PostOnly' = 'GTC'
): Promise<{ orderId: string; orderLinkId: string }> {
  const params = {
    category: 'spot' as const,
    symbol,
    side,
    orderType,
    qty,
    isLeverage: 1 as const,
    orderFilter: 'Order' as const,
    timeInForce: orderType === 'Limit' ? timeInForce : 'IOC',
    ...(orderType === 'Limit' && price != null && { price }),
  };
  try {
    return await submitOrderWs(apiKey, apiSecret, params);
  } catch (wsErr) {
    console.warn('[bybit] WS spot margin order failed, falling back to REST:', (wsErr as Error)?.message ?? wsErr);
  }
  const client = getClient(apiKey, apiSecret);
  const res = await client.submitOrder(params as Parameters<RestClientV5['submitOrder']>[0]);
  if (res.retCode !== 0) {
    throw new Error(res.retMsg ?? 'Bybit place spot margin order failed');
  }
  const result = res.result as { orderId: string; orderLinkId: string };
  return { orderId: result.orderId, orderLinkId: result.orderLinkId };
}

/**
 * Place a limit reduce-only order to close a position. Uses WebSocket first, REST fallback.
 */
export async function placeLimitOrderReduceOnly(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  positionSide: 'Buy' | 'Sell',
  qty: string,
  price: string,
  timeInForce: 'GTC' | 'IOC' = 'GTC'
): Promise<{ orderId: string; orderLinkId: string }> {
  const closeSide = positionSide === 'Buy' ? 'Sell' : 'Buy';
  try {
    return await submitOrderWs(apiKey, apiSecret, {
      category: 'linear',
      symbol,
      side: closeSide,
      orderType: 'Limit',
      qty,
      price,
      timeInForce,
      reduceOnly: true,
    });
  } catch (wsErr) {
    console.warn('[bybit] WS limit reduce-only failed, falling back to REST:', (wsErr as Error)?.message ?? wsErr);
  }
  const client = getClient(apiKey, apiSecret);
  const res = await client.submitOrder({
    category: 'linear',
    symbol,
    side: closeSide,
    orderType: 'Limit',
    qty,
    price,
    timeInForce,
    reduceOnly: true,
  });
  if (res.retCode !== 0) {
    const msg = (res.retMsg ?? '').toLowerCase();
    if (qty && (msg.includes('position') || msg.includes('insufficient') || msg.includes('size') || msg.includes('zero'))) {
      return { orderId: '', orderLinkId: '' };
    }
    throw new Error(res.retMsg ?? 'Bybit place limit reduce-only order failed');
  }
  const result = res.result as { orderId: string; orderLinkId: string };
  return { orderId: result.orderId, orderLinkId: result.orderLinkId };
}

/**
 * Get execution list for an order (e.g. to get exec price, fee, and exec time after market order).
 * execTime is Bybit's execution timestamp in ms (string).
 */
export async function getExecutionList(
  apiKey: string,
  apiSecret: string,
  category: 'linear' | 'spot',
  orderId: string
): Promise<Array<{ execPrice: string; execQty: string; execFee?: string; execTime?: string }>> {
  const client = getClient(apiKey, apiSecret);
  const res = await client.getExecutionList({ category, orderId });
  if (res.retCode !== 0) {
    throw new Error(res.retMsg ?? 'Bybit get execution list failed');
  }
  const list = (res.result as {
    list?: Array<{ execPrice: string; execQty: string; execFee?: string; execTime?: string }>;
  })?.list ?? [];
  return list.map((e) => ({
    execPrice: e.execPrice,
    execQty: e.execQty,
    execFee: e.execFee,
    execTime: e.execTime,
  }));
}

export interface ClosedPnlRow {
  symbol?: string;
  side?: string;
  qty?: string;
  closedSize?: string;
  closedPnl: string;
  openFee: string;
  closeFee: string;
  updatedTime: string;
  avgEntryPrice?: string;
  avgExitPrice?: string;
}

/**
 * Get closed PnL records for linear. Pass symbol to limit to one symbol, or omit for all (e.g. for combined history).
 */
export async function getClosedPnl(
  apiKey: string,
  apiSecret: string,
  category: 'linear',
  symbol?: string,
  limit: number = 20
): Promise<ClosedPnlRow[]> {
  const client = getClient(apiKey, apiSecret);
  const params: { category: 'linear'; symbol?: string; limit: number } = { category, limit };
  if (symbol) params.symbol = symbol;
  const res = await client.getClosedPnL(params);
  if (res.retCode !== 0) {
    throw new Error(res.retMsg ?? 'Bybit get closed PnL failed');
  }
  const result = res.result as { list?: ClosedPnlRow[] };
  return result.list ?? [];
}

/**
 * Get open (active) orders for a linear symbol.
 */
export async function getActiveOrders(
  apiKey: string,
  apiSecret: string,
  category: 'linear',
  symbol: string
): Promise<unknown[]> {
  const client = getClient(apiKey, apiSecret);
  const res = await client.getActiveOrders({ category, symbol });
  if (res.retCode !== 0) {
    throw new Error(res.retMsg ?? 'Bybit get active orders failed');
  }
  const result = res.result as { list?: unknown[] };
  return result.list ?? [];
}

/**
 * Cancel all open orders for a linear symbol.
 */
export async function cancelAllOrders(
  apiKey: string,
  apiSecret: string,
  category: 'linear',
  symbol: string
): Promise<void> {
  const client = getClient(apiKey, apiSecret);
  const res = await client.cancelAllOrders({ category, symbol });
  if (res.retCode !== 0) {
    throw new Error(res.retMsg ?? 'Bybit cancel all orders failed');
  }
}

export interface LinearPosition {
  symbol: string;
  side: 'Buy' | 'Sell';
  size: string;
  avgPrice: string;
  markPrice?: string;
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
  const list = (res.result as { list?: Array<{ symbol: string; side: 'Buy' | 'Sell'; size: string; avgPrice?: string; markPrice?: string }> })?.list ?? [];
  return list
    .filter((p) => parseFloat(p.size) > 0)
    .map((p) => ({ symbol: p.symbol, side: p.side, size: p.size, avgPrice: p.avgPrice ?? '0', markPrice: p.markPrice }));
}

export interface OrderbookLevel {
  price: string;
  size: string;
}

export interface OrderbookResult {
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
}

export type OrderbookCategory = 'linear' | 'spot';

/**
 * Get the price at a specific orderbook depth row (1-based).
 * Long (Buy): uses asks[depthRow - 1].price (sell-to-close price).
 * Short (Sell): uses bids[depthRow - 1].price (buy-to-close price).
 * If the requested depth doesn't exist, falls back to the deepest available row.
 */
export function getDepthPrice(
  orderbook: OrderbookResult,
  positionSide: 'Buy' | 'Sell',
  depthRow: number
): number {
  const rowIndex = Math.max(0, Math.floor(depthRow) - 1);
  if (positionSide === 'Buy') {
    const asks = orderbook.asks ?? [];
    const idx = rowIndex < asks.length ? rowIndex : asks.length - 1;
    const level = asks[idx];
    return level ? parseFloat(level.price) || 0 : 0;
  } else {
    const bids = orderbook.bids ?? [];
    const idx = rowIndex < bids.length ? rowIndex : bids.length - 1;
    const level = bids[idx];
    return level ? parseFloat(level.price) || 0 : 0;
  }
}

/** Position-like shape for PnL calculation (side, entry price, size). */
export interface PositionLike {
  side: 'Buy' | 'Sell';
  avgPrice: string;
  size: string;
}

/**
 * Calculate unrealized PnL using a depth-based current price.
 * Long: (currentDepthPrice - entryPrice) * qty.
 * Short: (entryPrice - currentDepthPrice) * qty.
 */
export function calculateUnrealizedPnLByDepth(
  position: PositionLike,
  currentDepthPrice: number
): number {
  const entryPrice = parseFloat(position.avgPrice) || 0;
  const qty = parseFloat(position.size) || 0;
  if (position.side === 'Buy') {
    return (currentDepthPrice - entryPrice) * qty;
  } else {
    return (entryPrice - currentDepthPrice) * qty;
  }
}

/**
 * Get order book (public endpoint). limit 1–500, default 50.
 * @param category - 'linear' for perp, 'spot' for spot (sweep logic).
 */
export async function getOrderbook(
  symbol: string,
  limit = 50,
  category: OrderbookCategory = 'linear'
): Promise<OrderbookResult> {
  const client = getPublicClient();
  const res = await client.getOrderbook({ category, symbol, limit });
  if (res.retCode !== 0) {
    throw new Error(res.retMsg ?? 'Bybit get orderbook failed');
  }
  const result = res.result as { b?: [string, string][]; a?: [string, string][] };
  const bids = (result.b ?? []).map(([price, size]) => ({ price, size }));
  const asks = (result.a ?? []).map(([price, size]) => ({ price, size }));
  return { bids, asks };
}

/**
 * Get Spot orderbook for sweep logic. Same as getOrderbook(symbol, limit, 'spot').
 */
export async function getSpotOrderbook(symbol: string, limit = 50): Promise<OrderbookResult> {
  return getOrderbook(symbol, limit, 'spot');
}

export interface OrderBookDepthResult {
  bidPrice: number;
  askPrice: number;
}

/** Depth 1 = best bid / best ask (bid1Price, ask1Price). Use for real-time PnL and exit triggers. */
export const ORDERBOOK_DEPTH_BEST = 1;

/**
 * Get orderbook price at a specific depth (1 = best bid/ask, i.e. bid1Price and ask1Price). Fetches 50 rows, then indexes by depth (0-indexed: rowIndex = depth - 1).
 */
export async function getOrderBookDepth(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  depth: number = 2
): Promise<OrderBookDepthResult> {
  try {
    const client = getClient(apiKey, apiSecret);
    const res = await client.getOrderbook({ category: 'linear', symbol, limit: 50 });
    if (res.retCode !== 0) {
      throw new Error(res.retMsg ?? 'Bybit get orderbook failed');
    }
    const result = res.result as { b?: [string, string][]; a?: [string, string][] };
    const bids = result.b ?? [];
    const asks = result.a ?? [];
    const rowIndex = Math.max(0, depth - 1);
    const bidPrice = bids.length > rowIndex ? parseFloat(bids[rowIndex][0]) : NaN;
    const askPrice = asks.length > rowIndex ? parseFloat(asks[rowIndex][0]) : NaN;
    return { bidPrice, askPrice };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`getOrderBookDepth ${symbol}: ${msg}`);
  }
}

export interface InstrumentLotSize {
  qtyStep: string;
  minOrderQty: string;
  maxOrderQty: string;
  maxMktOrderQty: string;
  tickSize?: string;
}

type InstrumentListRow = {
  lotSizeFilter?: { qtyStep?: string; minOrderQty?: string; maxOrderQty?: string; maxMktOrderQty?: string };
  priceFilter?: { tickSize?: string };
};

function parseInstrumentLotSize(inst: InstrumentListRow | undefined): InstrumentLotSize {
  const filter = inst?.lotSizeFilter;
  const priceFilter = inst?.priceFilter;
  return {
    qtyStep: filter?.qtyStep ?? '0.1',
    minOrderQty: filter?.minOrderQty ?? '0',
    maxOrderQty: filter?.maxOrderQty ?? '999999',
    maxMktOrderQty: filter?.maxMktOrderQty ?? '',
    tickSize: priceFilter?.tickSize ?? '0.01',
  };
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
  const list = (res.result as { list?: InstrumentListRow[] })?.list ?? [];
  return parseInstrumentLotSize(list[0]);
}

/**
 * Fetch lot size / step size for a spot symbol so quantities can be formatted properly.
 * Uses public market endpoint (no auth required).
 */
export async function getSpotInstrumentLotSize(symbol: string): Promise<InstrumentLotSize> {
  const client = getPublicClient();
  const res = await client.getInstrumentsInfo({ category: 'spot', symbol });
  if (res.retCode !== 0) {
    throw new Error(res.retMsg ?? 'Bybit get spot instruments info failed');
  }
  const list = (res.result as { list?: InstrumentListRow[] })?.list ?? [];
  return parseInstrumentLotSize(list[0]);
}

export interface ExecutionSettlementCallback {
  (userId: number, symbol: string, side: 'Buy' | 'Sell'): void;
}

/**
 * Subscribe to the private execution stream and invoke onSettlement when execType === 'Settle' (funding settlement).
 * Returns a handle with close() to disconnect. One stream per (apiKey, apiSecret) / user.
 */
export function startExecutionStream(
  apiKey: string,
  apiSecret: string,
  userId: number,
  onSettlement: ExecutionSettlementCallback
): { close: () => void } {
  const ws = new WebsocketClient({
    key: apiKey,
    secret: apiSecret,
    testnet,
    market: 'v5',
  });

  const handler = (payload: unknown) => {
    const msg = payload as { topic?: string; data?: Array<{ execType?: string; symbol?: string; side?: string }> };
    if (msg.topic !== 'execution' || !Array.isArray(msg.data)) return;
    for (const item of msg.data) {
      if (item.execType === 'Settle' || item.execType === 'Settlement') {
        const symbol = item.symbol ?? '';
        const side = item.side === 'Sell' ? 'Sell' : 'Buy';
        if (symbol) onSettlement(userId, symbol, side);
      }
    }
  };

  ws.on('update', handler);
  ws.connectPrivate();
  ws.subscribeV5('execution', 'linear', true);

  return {
    close: () => {
      ws.removeAllListeners('update');
      try {
        ws.unsubscribeV5('execution', 'linear', true);
      } catch {
        // ignore
      }
    },
  };
}
