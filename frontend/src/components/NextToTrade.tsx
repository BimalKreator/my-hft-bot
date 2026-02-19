import { useState, useEffect, useCallback } from 'react';

const TOKEN_KEY = 'hft_token';
const POLL_MS = 5000;

interface NextToTradeToken {
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

interface NextToTradeResponse {
  tokens: NextToTradeToken[];
  maxTrades: number;
}

function tokenName(symbol: string): string {
  if (symbol.endsWith('USDT')) return symbol.slice(0, -4);
  return symbol;
}

function formatPct(value: number): string {
  return (value * 100).toFixed(4) + '%';
}

function formatCountdown(nextFundingTimeMs: number): string {
  const now = Date.now();
  const ms = Math.max(0, nextFundingTimeMs - now);
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

function CountdownCell({ nextFundingTime }: { nextFundingTime: string }) {
  const nextMs = parseInt(nextFundingTime, 10) || 0;
  const [display, setDisplay] = useState(() => formatCountdown(nextMs));

  useEffect(() => {
    const id = setInterval(() => setDisplay(formatCountdown(nextMs)), 1000);
    return () => clearInterval(id);
  }, [nextMs]);

  return <span className="font-mono text-gray-300">{display}</span>;
}

function DirectionBadge({ fundingRate }: { fundingRate: number }) {
  if (fundingRate < 0) {
    return (
      <span
        className="inline-flex rounded px-2.5 py-1 text-xs font-semibold text-green-400"
        style={{
          backgroundColor: 'rgba(34, 197, 94, 0.15)',
          boxShadow: '0 0 8px rgba(34, 197, 94, 0.3)',
        }}
      >
        LONG
      </span>
    );
  }
  if (fundingRate > 0) {
    return (
      <span
        className="inline-flex rounded px-2.5 py-1 text-xs font-semibold text-red-400"
        style={{
          backgroundColor: 'rgba(239, 68, 68, 0.15)',
          boxShadow: '0 0 8px rgba(239, 68, 68, 0.3)',
        }}
      >
        SHORT
      </span>
    );
  }
  return (
    <span className="inline-flex rounded px-2.5 py-1 text-xs font-semibold text-gray-400">NONE</span>
  );
}

/** Estimated funding per $1,000 position (before fees). */
function predictedProfitPer1k(fundingRate: number): string {
  const est = 1000 * Math.abs(fundingRate);
  return '$' + est.toFixed(4) + ' / $1k';
}

export default function NextToTrade() {
  const [data, setData] = useState<NextToTradeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async (silent = false) => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      setError('Please log in again.');
      setLoading(false);
      return;
    }
    if (!silent) setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/dashboard/next-to-trade', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? 'Failed to load next-to-trade');
        setData(null);
        return;
      }
      setData({
        tokens: Array.isArray(json.tokens) ? json.tokens : [],
        maxTrades: typeof json.maxTrades === 'number' ? json.maxTrades : 0,
      });
    } catch {
      setError('Network error');
      setData(null);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const t = setInterval(() => fetchData(true), POLL_MS);
    return () => clearInterval(t);
  }, [fetchData]);

  const tokens = data?.tokens ?? [];
  const maxTrades = data?.maxTrades ?? 0;

  if (loading && !data) {
    return (
      <div
        className="rounded-xl border overflow-hidden backdrop-blur-sm"
        style={{
          backgroundColor: 'rgba(255, 255, 255, 0.04)',
          borderColor: 'rgba(0, 123, 255, 0.3)',
        }}
      >
        <div className="flex items-center justify-center py-12">
          <div
            className="h-10 w-10 animate-spin rounded-full border-2 border-t-transparent"
            style={{ borderColor: '#007BFF', borderTopColor: 'transparent' }}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className="rounded-xl border overflow-hidden backdrop-blur-sm"
      style={{
        backgroundColor: 'rgba(255, 255, 255, 0.04)',
        borderColor: 'rgba(0, 123, 255, 0.3)',
      }}
    >
      <div className="px-4 py-3 border-b" style={{ borderColor: 'rgba(0, 123, 255, 0.2)' }}>
        <h2 className="text-lg font-semibold text-white">Next To Trade</h2>
        <p className="text-gray-400 text-sm">
          Top tokens the bot will target (up to {maxTrades}) · Refreshes every 5s
        </p>
      </div>

      {error && (
        <div className="px-4 py-3 text-sm text-red-400" style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)' }}>
          {error}
        </div>
      )}

      {tokens.length === 0 && !error ? (
        <div className="px-4 py-8 text-center text-gray-400">
          No tokens match your min funding rate and banned list, or settings not loaded.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-400" style={{ backgroundColor: 'rgba(0, 0, 0, 0.2)' }}>
                <th className="px-4 py-2.5 font-medium">Token</th>
                <th className="px-4 py-2.5 font-medium">Funding Rate</th>
                <th className="px-4 py-2.5 font-medium">Direction</th>
                <th className="px-4 py-2.5 font-medium">Countdown</th>
                <th className="px-4 py-2.5 font-medium">Interval</th>
                <th className="px-4 py-2.5 font-medium">Predicted Profit</th>
                <th className="px-4 py-2.5 font-medium">Price</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((row) => (
                <tr
                  key={row.symbol}
                  className="border-b border-gray-800/80 hover:bg-white/5"
                  style={{ borderColor: 'rgba(255,255,255,0.06)' }}
                >
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span
                        className="flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium"
                        style={{ backgroundColor: 'rgba(0, 123, 255, 0.2)', color: '#007BFF' }}
                      >
                        {tokenName(row.symbol).slice(0, 2)}
                      </span>
                      <span className="font-medium text-white">{tokenName(row.symbol)}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={
                        row.fundingRate > 0
                          ? 'text-green-500 font-medium'
                          : row.fundingRate < 0
                            ? 'text-red-500 font-medium'
                            : 'text-gray-400'
                      }
                    >
                      {formatPct(row.fundingRate)}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <DirectionBadge fundingRate={row.fundingRate} />
                  </td>
                  <td className="px-4 py-2.5">
                    <CountdownCell nextFundingTime={row.nextFundingTime} />
                  </td>
                  <td className="px-4 py-2.5 text-gray-300">
                    {row.fundingIntervalHours % 1 === 0
                      ? `${row.fundingIntervalHours}h`
                      : `${row.fundingIntervalHours.toFixed(1)}h`}
                  </td>
                  <td className="px-4 py-2.5 text-gray-300 font-mono text-xs">
                    {predictedProfitPer1k(row.fundingRate)}
                  </td>
                  <td className="px-4 py-2.5 text-gray-300 font-mono text-sm">
                    {parseFloat(row.markPrice || row.lastPrice || '0').toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 6,
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
