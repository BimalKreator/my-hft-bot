import { useState, useEffect, useCallback } from 'react';

const TOKEN_KEY = 'hft_token';
const POLL_MS = 1000;

export interface PositionRow {
  symbol: string;
  side: 'Buy' | 'Sell';
  size: string;
  avgPrice: string;
  vwapPrice: number;
  pnl: number;
  slPrice: number;
  targetPrice: number;
  fundingRate: number;
  /** Hedged pair: same group = one Hedge Card */
  hedgeGroupId?: string;
  fundingAmountReceived?: number | null;
  spotQty?: number;
  spotEntryPrice?: number;
  isPaired?: boolean;
}

function tokenName(symbol: string): string {
  if (symbol.endsWith('USDT')) return symbol.slice(0, -4);
  return symbol;
}

function formatNum(value: number, decimals = 4): string {
  if (Number.isNaN(value)) return '—';
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: decimals });
}

function formatPct(value: number): string {
  if (Number.isNaN(value)) return '—';
  return (value * 100).toFixed(4) + '%';
}

interface HedgeCardProps {
  pos: PositionRow;
  combinedPnl: number;
  spotPnl: number;
  funding: number;
  closingId: string | null;
  onExit: (pos: PositionRow) => void;
  formatNum: (value: number, decimals?: number) => string;
  tokenName: (symbol: string) => string;
}

function HedgeCard({ pos, combinedPnl, spotPnl, funding, closingId, onExit, formatNum, tokenName }: HedgeCardProps) {
  const [showDetails, setShowDetails] = useState(false);
  const id = `${pos.symbol}_${pos.side}`;
  const isClosing = closingId === id;
  const direction = pos.side === 'Buy' ? 'LONG' : 'SHORT';

  return (
    <div
      className="px-4 py-4"
      style={{
        backgroundColor: 'rgba(0, 123, 255, 0.06)',
        borderLeft: '3px solid rgba(0, 123, 255, 0.6)',
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-semibold text-white">{tokenName(pos.symbol)}</span>
          <span
            className="inline-block rounded px-2 py-0.5 text-xs font-semibold"
            style={
              direction === 'LONG'
                ? { backgroundColor: 'rgba(34, 197, 94, 0.2)', color: '#22c55e' }
                : { backgroundColor: 'rgba(239, 68, 68, 0.2)', color: '#ef4444' }
            }
          >
            {direction} / Spot hedge
          </span>
          <span
            className="rounded px-2 py-0.5 text-xs font-medium"
            style={{ backgroundColor: 'rgba(234, 179, 8, 0.2)', color: '#eab308' }}
          >
            Waiting for Target PnL or Timeout
          </span>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-xs text-gray-400">Combined Net PnL</div>
            <span
              className="text-lg font-bold tabular-nums"
              style={{
                color: combinedPnl >= 0 ? '#22c55e' : '#ef4444',
                textShadow: combinedPnl >= 0 ? '0 0 10px rgba(34,197,94,0.4)' : '0 0 10px rgba(239,68,68,0.4)',
              }}
            >
              {combinedPnl >= 0 ? '+' : ''}{formatNum(combinedPnl)}
            </span>
            <div className="text-xs text-gray-500 mt-0.5">
              Futures {pos.pnl >= 0 ? '+' : ''}{formatNum(pos.pnl)} · Spot {spotPnl >= 0 ? '+' : ''}{formatNum(spotPnl)} · Funding {funding >= 0 ? '+' : ''}{formatNum(funding)}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowDetails(!showDetails)}
            className="rounded px-3 py-1.5 text-xs font-medium text-gray-300 border border-gray-600 hover:bg-white/5"
          >
            {showDetails ? 'Hide details' : 'Show legs'}
          </button>
          <button
            type="button"
            onClick={() => onExit(pos)}
            disabled={isClosing}
            className="rounded px-3 py-1.5 text-xs font-semibold text-white transition disabled:opacity-50"
            style={{ backgroundColor: '#ef4444', boxShadow: '0 0 12px rgba(239, 68, 68, 0.3)' }}
          >
            {isClosing ? 'Closing…' : 'Exit Now'}
          </button>
        </div>
      </div>
      {showDetails && (
        <div className="mt-4 pt-3 border-t border-gray-700/80 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <div className="rounded-lg p-3" style={{ backgroundColor: 'rgba(0,0,0,0.2)' }}>
            <div className="text-gray-400 text-xs font-medium uppercase tracking-wide mb-1">Futures leg</div>
            <div className="text-white">Qty: {pos.size}</div>
            <div className="text-gray-300">Entry: {formatNum(parseFloat(pos.avgPrice) || 0)}</div>
            <div className="text-gray-400 text-xs mt-1">Unrealized PnL: {pos.pnl >= 0 ? '+' : ''}{formatNum(pos.pnl)}</div>
          </div>
          <div className="rounded-lg p-3" style={{ backgroundColor: 'rgba(0,0,0,0.2)' }}>
            <div className="text-gray-400 text-xs font-medium uppercase tracking-wide mb-1">Spot leg</div>
            <div className="text-white">Qty: {formatNum(pos.spotQty ?? 0)}</div>
            <div className="text-gray-300">Entry: {formatNum(pos.spotEntryPrice ?? 0)}</div>
            <div className="text-gray-400 text-xs mt-1">Unrealized PnL: {spotPnl >= 0 ? '+' : ''}{formatNum(spotPnl)}</div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ActivePositions() {
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);

  const fetchPositions = useCallback(async () => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      setError('Please log in again.');
      setLoading(false);
      return;
    }
    setError(null);
    try {
      const res = await fetch('/api/trade/positions', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'Failed to load positions');
        setPositions([]);
        return;
      }
      setPositions(Array.isArray(data) ? data : []);
    } catch {
      setError('Network error');
      setPositions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPositions();
    const t = setInterval(fetchPositions, POLL_MS);
    return () => clearInterval(t);
  }, [fetchPositions]);

  const handleExit = useCallback(
    async (pos: PositionRow) => {
      const token = localStorage.getItem(TOKEN_KEY);
      if (!token) return;
      const id = `${pos.symbol}_${pos.side}`;
      setClosingId(id);
      try {
        const res = await fetch('/api/trade/close', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            symbol: pos.symbol,
            side: pos.side,
            qty: pos.size,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? 'Close failed');
        await fetchPositions();
      } catch (e) {
        console.error('Exit failed:', e);
      } finally {
        setClosingId(null);
      }
    },
    [fetchPositions]
  );

  if (loading && positions.length === 0) {
    return (
      <div
        className="rounded-xl border p-6 backdrop-blur-sm"
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
        <h2 className="text-lg font-semibold text-white">Active Positions</h2>
        <p className="text-gray-400 text-sm">VWAP-based exit price & PnL · Polling every 1s</p>
      </div>

      {error && (
        <div className="px-4 py-3 text-sm text-red-400" style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)' }}>
          {error}
        </div>
      )}

      {positions.length === 0 && !error ? (
        <div className="px-4 py-8 text-center text-gray-400">No open positions</div>
      ) : (
        <div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
          {/* Hedged positions: one Hedge Card per group */}
          {positions
            .filter((p): p is PositionRow & { isPaired: true } => Boolean(p.isPaired && p.hedgeGroupId))
            .reduce<PositionRow[]>((acc, p) => {
              if (acc.some((x) => x.hedgeGroupId === p.hedgeGroupId)) return acc;
              acc.push(p);
              return acc;
            }, [])
            .map((pos) => {
              const spotQty = pos.spotQty ?? 0;
              const spotEntry = pos.spotEntryPrice ?? 0;
              const vwap = pos.vwapPrice || 0;
              const spotPnl =
                pos.side === 'Buy'
                  ? (spotEntry - vwap) * spotQty
                  : (vwap - spotEntry) * spotQty;
              const funding = pos.fundingAmountReceived ?? 0;
              const combinedPnl = pos.pnl + spotPnl + funding;
              return (
                <HedgeCard
                  key={pos.hedgeGroupId!}
                  pos={pos}
                  combinedPnl={combinedPnl}
                  spotPnl={spotPnl}
                  funding={funding}
                  closingId={closingId}
                  onExit={handleExit}
                  formatNum={formatNum}
                  tokenName={tokenName}
                />
              );
            })}
          {/* Non-hedged positions: table */}
          {positions.some((p) => !p.isPaired) && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-400" style={{ backgroundColor: 'rgba(0, 0, 0, 0.2)' }}>
                    <th className="px-4 py-2.5 font-medium">Token</th>
                    <th className="px-4 py-2.5 font-medium">Direction</th>
                    <th className="px-4 py-2.5 font-medium">Entry</th>
                    <th className="px-4 py-2.5 font-medium">Trade Amount</th>
                    <th className="px-4 py-2.5 font-medium">Mark</th>
                    <th className="px-4 py-2.5 font-medium">VWAP Exit</th>
                    <th className="px-4 py-2.5 font-medium">Liq</th>
                    <th className="px-4 py-2.5 font-medium">Funding</th>
                    <th className="px-4 py-2.5 font-medium">Countdown</th>
                    <th className="px-4 py-2.5 font-medium">Qty</th>
                    <th className="px-4 py-2.5 font-medium">Leverage</th>
                    <th className="px-4 py-2.5 font-medium">Unrealized PnL</th>
                    <th className="px-4 py-2.5 font-medium">Target / SL</th>
                    <th className="px-4 py-2.5 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {positions
                    .filter((p) => !p.isPaired)
                    .map((pos) => {
                      const direction = pos.side === 'Buy' ? 'LONG' : 'SHORT';
                      const id = `${pos.symbol}_${pos.side}`;
                      const isClosing = closingId === id;
                      return (
                        <tr
                          key={id}
                          className="border-b border-gray-800/80 hover:bg-white/5"
                          style={{ borderColor: 'rgba(255,255,255,0.06)' }}
                        >
                          <td className="px-4 py-2.5 font-medium text-white">
                            {tokenName(pos.symbol)}
                          </td>
                          <td className="px-4 py-2.5">
                            <span
                              className="inline-block rounded px-2 py-0.5 text-xs font-semibold"
                              style={
                                direction === 'LONG'
                                  ? { backgroundColor: 'rgba(34, 197, 94, 0.2)', color: '#22c55e' }
                                  : { backgroundColor: 'rgba(239, 68, 68, 0.2)', color: '#ef4444' }
                              }
                            >
                              {direction}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-gray-300">
                            {formatNum(parseFloat(pos.avgPrice) || 0)}
                          </td>
                          <td className="px-4 py-2.5 text-gray-300">
                            {(parseFloat(pos.size) * parseFloat(pos.avgPrice) || 0).toFixed(2)}
                          </td>
                          <td className="px-4 py-2.5 text-gray-500 text-xs">—</td>
                          <td className="px-4 py-2.5 font-bold" style={{ color: '#007BFF' }}>
                            {formatNum(pos.vwapPrice)}
                          </td>
                          <td className="px-4 py-2.5 text-gray-500 text-xs">—</td>
                          <td className="px-4 py-2.5 text-gray-400">
                            {formatPct(pos.fundingRate)}
                          </td>
                          <td className="px-4 py-2.5 text-gray-500 text-xs">—</td>
                          <td className="px-4 py-2.5 text-gray-300">{pos.size}</td>
                          <td className="px-4 py-2.5 text-gray-500 text-xs">—</td>
                          <td className="px-4 py-2.5">
                            <span
                              className="font-semibold"
                              style={{
                                color: pos.pnl >= 0 ? '#22c55e' : '#ef4444',
                                textShadow: pos.pnl >= 0 ? '0 0 8px rgba(34,197,94,0.4)' : '0 0 8px rgba(239,68,68,0.4)',
                              }}
                            >
                              {pos.pnl >= 0 ? '+' : ''}{formatNum(pos.pnl)}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-gray-400 text-xs">
                            <span className="block">T: {formatNum(pos.targetPrice)}</span>
                            <span className="block">S: {formatNum(pos.slPrice)}</span>
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <button
                              type="button"
                              onClick={() => handleExit(pos)}
                              disabled={isClosing}
                              className="rounded px-3 py-1.5 text-xs font-semibold text-white transition disabled:opacity-50"
                              style={{
                                backgroundColor: '#ef4444',
                                boxShadow: '0 0 12px rgba(239, 68, 68, 0.3)',
                              }}
                            >
                              {isClosing ? 'Closing…' : 'Exit Now'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
