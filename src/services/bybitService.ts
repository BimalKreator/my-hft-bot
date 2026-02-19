import { WebsocketClient } from 'bybit-api';
import dotenv from 'dotenv';

dotenv.config();

const testnet = process.env.BYBIT_TESTNET === 'true';

export function createBybitWebSocketClient(): WebsocketClient {
  const client = new WebsocketClient({
    testnet,
    market: 'v5',
  });

  client.on('open', (ev) => {
    console.log('[open] wsKey:', ev.wsKey);
    if (ev.wsKey === 'v5LinearPublic') {
      client.subscribeV5('tickers.BTCUSDT', 'linear');
      console.log('[open] Subscribed to tickers.BTCUSDT (linear)');
    }
  });

  client.on('update', (payload: unknown) => {
    const p = payload as {
      topic?: string;
      data?: {
        lastPrice?: string;
        symbol?: string;
        list?: Array<{ lastPrice?: string; symbol?: string }>;
      };
    };
    const data = p?.data;
    const lastPrice = data?.lastPrice ?? data?.list?.[0]?.lastPrice;
    const symbol = data?.symbol ?? data?.list?.[0]?.symbol;
    if (lastPrice != null) {
      console.log('[update]', symbol ?? p?.topic, 'lastPrice:', lastPrice);
    } else {
      console.log('[update]', p);
    }
  });

  return client;
}

export function connectBybitPublic(client: WebsocketClient): void {
  client.connectPublic();
  console.log('Bybit V5 WebSocket – tickers.BTCUSDT (Ctrl+C to stop)');
  console.log('Environment:', testnet ? 'testnet' : 'mainnet');
}
