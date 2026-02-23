import { useState, useEffect, useCallback, useMemo } from 'react';

const TOKEN_KEY = 'hft_token';
const POLL_MS = 1000;

export type AccountType = 'main' | 'sub';
export type ExchangeLabel = 'Bybit' | 'Binance';

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
  /** Sub-account hedging: which account this position belongs to */
  accountType?: AccountType;
  /** Exchange this position belongs to (Bybit or Binance) */
  exchange?: ExchangeLabel;
  /** True when cross-exchange funding spread has reversed against the position */
  isFundingFlipped?: boolean;
}

function tokenName(symbol: string | undefined | null): string {
  if (symbol == null || typeof symbol !== 'string') return '—';
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

/** Cross-exchange hedge: same symbol, one Bybit + one Binance. Combined PnL, both entry prices, single Close Hedge. */
interface CrossHedgeGroupCardProps {
  symbol: string;
  bybitPos: PositionRow;
  binancePos: PositionRow;
  closingId: string | null;
  onCloseHedge: (symbol: string) => void;
  formatNum: (value: number, decimals?: number) => string;
  tokenName: (symbol: string) => string;
}

function CrossHedgeGroupCard({ symbol, bybitPos, binancePos, closingId, onCloseHedge, formatNum, tokenName }: CrossHedgeGroupCardProps) {
  const combinedPnl = (bybitPos?.pnl ?? 0) + (binancePos?.pnl ?? 0);
  const side = bybitPos?.side ?? 'Buy';
  const direction = side === 'Buy' ? 'LONG' : 'SHORT';
  const safeSymbol = symbol ?? '';
  const hedgeClosingId = `hedge_${safeSymbol}`;
  const isClosing = closingId === hedgeClosingId;
  const isFundingFlipped = !!(bybitPos?.isFundingFlipped || binancePos?.isFundingFlipped);
  const qty = bybitPos?.size ?? binancePos?.size ?? '—';
  const bybitEntry = parseFloat(bybitPos?.avgPrice ?? '') || 0;
  const binanceEntry = parseFloat(binancePos?.avgPrice ?? '') || 0;

  return (
    <div
      className="px-4 py-4"
      style={{
        backgroundColor: 'rgba(234, 179, 8, 0.06)',
        borderLeft: '3px solid rgba(234, 179, 8, 0.6)',
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-semibold text-white">{tokenName(safeSymbol)}</span>
          <span className="inline-block rounded px-1.5 py-0.5 text-xs font-medium" style={{ backgroundColor: 'rgba(0, 123, 255, 0.2)', color: '#007BFF' }}>
            Bybit
          </span>
          <span className="inline-block rounded px-1.5 py-0.5 text-xs font-medium" style={{ backgroundColor: 'rgba(234, 179, 8, 0.25)', color: '#eab308' }}>
            Binance
          </span>
          <span
            className="inline-block rounded px-2 py-0.5 text-xs font-semibold"
            style={
              direction === 'LONG'
                ? { backgroundColor: 'rgba(34, 197, 94, 0.2)', color: '#22c55e' }
                : { backgroundColor: 'rgba(239, 68, 68, 0.2)', color: '#ef4444' }
            }
          >
            {direction} / Cross-hedge
          </span>
          {isFundingFlipped && (
            <span className="rounded px-2 py-0.5 text-xs font-semibold bg-red-500/20 text-red-400 border border-red-500/40">
              Funding Flip
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-xs text-gray-400">Combined PnL (Bybit + Binance)</div>
            <span
              className="text-lg font-bold tabular-nums"
              style={{
                color: combinedPnl >= 0 ? '#22c55e' : '#ef4444',
                textShadow: combinedPnl >= 0 ? '0 0 10px rgba(34,197,94,0.4)' : '0 0 10px rgba(239,68,68,0.4)',
              }}
            >
              {combinedPnl >= 0 ? '+' : ''}{formatNum(combinedPnl)}
            </span>
          </div>
          <button
            type="button"
            onClick={() => onCloseHedge(safeSymbol)}
            disabled={isClosing}
            className="rounded px-3 py-1.5 text-xs font-semibold text-white transition disabled:opacity-50 shrink-0"
            style={{ backgroundColor: '#ef4444', boxShadow: '0 0 12px rgba(239, 68, 68, 0.3)' }}
          >
            {isClosing ? 'Closing…' : 'Close Hedge'}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
        <div className="rounded-lg p-3 flex flex-wrap items-center justify-between gap-2" style={{ backgroundColor: 'rgba(0,0,0,0.2)' }}>
          <div>
            <div className="text-gray-400 text-xs font-medium uppercase tracking-wide">Bybit</div>
            <div className="text-white">Side: {bybitPos?.side ?? '—'} · Qty: {qty}</div>
            <div className="text-gray-300">Entry: {formatNum(bybitEntry)}</div>
            <div className="text-xs mt-0.5 font-medium" style={{ color: (bybitPos?.pnl ?? 0) >= 0 ? '#22c55e' : '#ef4444' }}>
              PnL: {(bybitPos?.pnl ?? 0) >= 0 ? '+' : ''}{formatNum(bybitPos?.pnl ?? 0)}
            </div>
          </div>
        </div>
        <div className="rounded-lg p-3 flex flex-wrap items-center justify-between gap-2" style={{ backgroundColor: 'rgba(0,0,0,0.2)' }}>
          <div>
            <div className="text-gray-400 text-xs font-medium uppercase tracking-wide">Binance</div>
            <div className="text-white">Side: {binancePos?.side ?? '—'} · Qty: {qty}</div>
            <div className="text-gray-300">Entry: {formatNum(binanceEntry)}</div>
            <div className="text-xs mt-0.5 font-medium" style={{ color: (binancePos?.pnl ?? 0) >= 0 ? '#22c55e' : '#ef4444' }}>
              PnL: {(binancePos?.pnl ?? 0) >= 0 ? '+' : ''}{formatNum(binancePos?.pnl ?? 0)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Grouped card for sub-account hedging: same symbol, main + sub. Combined PnL at top, single Close Hedge button, then Main/Sub rows (no per-row Exit). */
interface SubHedgeGroupCardProps {
  symbol: string;
  positions: PositionRow[];
  closingId: string | null;
  onCloseHedge: (symbol: string) => void;
  formatNum: (value: number, decimals?: number) => string;
  tokenName: (symbol: string) => string;
}

function SubHedgeGroupCard({ symbol, positions, closingId, onCloseHedge, formatNum, tokenName }: SubHedgeGroupCardProps) {
  const safePositions = Array.isArray(positions) ? positions : [];
  const combinedPnl = safePositions.reduce((sum, p) => sum + (p?.pnl ?? 0), 0);
  const side = safePositions[0]?.side ?? 'Buy';
  const direction = side === 'Buy' ? 'LONG' : 'SHORT';
  const safeSymbol = symbol ?? '';
  const hedgeClosingId = `hedge_${safeSymbol}`;
  const isClosing = closingId === hedgeClosingId;

  return (
    <div
      className="px-4 py-4"
      style={{
        backgroundColor: 'rgba(0, 123, 255, 0.06)',
        borderLeft: '3px solid rgba(0, 123, 255, 0.6)',
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-semibold text-white">{tokenName(safeSymbol)}</span>
          <span className="inline-block rounded px-1.5 py-0.5 text-xs font-medium" style={{ backgroundColor: 'rgba(0, 123, 255, 0.2)', color: '#007BFF' }}>
            Bybit
          </span>
          <span
            className="inline-block rounded px-2 py-0.5 text-xs font-semibold"
            style={
              direction === 'LONG'
                ? { backgroundColor: 'rgba(34, 197, 94, 0.2)', color: '#22c55e' }
                : { backgroundColor: 'rgba(239, 68, 68, 0.2)', color: '#ef4444' }
            }
          >
            {direction} / Sub-hedge
          </span>
          {safePositions.some((p) => p?.isFundingFlipped) && (
            <span className="rounded px-2 py-0.5 text-xs font-semibold bg-red-500/20 text-red-400 border border-red-500/40">
              Funding Flip
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-xs text-gray-400">Combined PnL (Main + Sub)</div>
            <span
              className="text-lg font-bold tabular-nums"
              style={{
                color: combinedPnl >= 0 ? '#22c55e' : '#ef4444',
                textShadow: combinedPnl >= 0 ? '0 0 10px rgba(34,197,94,0.4)' : '0 0 10px rgba(239,68,68,0.4)',
              }}
            >
              {combinedPnl >= 0 ? '+' : ''}{formatNum(combinedPnl)}
            </span>
          </div>
          <button
            type="button"
            onClick={() => onCloseHedge(safeSymbol)}
            disabled={isClosing}
            className="rounded px-3 py-1.5 text-xs font-semibold text-white transition disabled:opacity-50 shrink-0"
            style={{ backgroundColor: '#ef4444', boxShadow: '0 0 12px rgba(239, 68, 68, 0.3)' }}
          >
            {isClosing ? 'Closing…' : 'Close Hedge'}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
        {safePositions.map((pos, idx) => {
          if (pos == null) return null;
          const id = `${pos.symbol ?? ''}_${pos.side ?? 'Buy'}_${pos.accountType ?? 'main'}`;
          const accountLabel = pos.accountType === 'sub' ? 'Sub' : 'Main';
          const pnlVal = pos.pnl ?? 0;
          const entryNum = parseFloat(pos.avgPrice) || 0;
          return (
            <div
              key={id || `pos-${idx}`}
              className="rounded-lg p-3 flex flex-wrap items-center justify-between gap-2"
              style={{ backgroundColor: 'rgba(0,0,0,0.2)' }}
            >
              <div>
                <div className="text-gray-400 text-xs font-medium uppercase tracking-wide">{accountLabel}</div>
                <div className="text-white">Side: {pos.side ?? '—'} · Qty: {pos.size ?? '—'}</div>
                <div className="text-gray-300">Entry: {formatNum(entryNum)}</div>
                <div
                  className="text-xs mt-0.5 font-medium"
                  style={{ color: pnlVal >= 0 ? '#22c55e' : '#ef4444' }}
                >
                  PnL: {pnlVal >= 0 ? '+' : ''}{formatNum(pnlVal)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HedgeCard({ pos, combinedPnl, spotPnl, funding, closingId, onExit, formatNum, tokenName }: HedgeCardProps) {
  const [showDetails, setShowDetails] = useState(false);
  if (pos == null || typeof pos !== 'object') return null;
  const id = `${pos.symbol ?? ''}_${pos.side ?? ''}`;
  const isClosing = closingId === id;
  const direction = (pos.side ?? 'Buy') === 'Buy' ? 'LONG' : 'SHORT';
  const pnlVal = pos.pnl ?? 0;

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
            className="inline-block rounded px-1.5 py-0.5 text-xs font-medium"
            style={pos.exchange === 'Binance' ? { backgroundColor: 'rgba(234, 179, 8, 0.25)', color: '#eab308' } : { backgroundColor: 'rgba(0, 123, 255, 0.2)', color: '#007BFF' }}
          >
            {pos.exchange === 'Binance' ? 'Binance' : 'Bybit'}
          </span>
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
          {pos.isFundingFlipped && (
            <span className="rounded px-2 py-0.5 text-xs font-semibold bg-red-500/20 text-red-400 border border-red-500/40">
              Funding Flip
            </span>
          )}
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
              Futures {pnlVal >= 0 ? '+' : ''}{formatNum(pnlVal)} · Spot {spotPnl >= 0 ? '+' : ''}{formatNum(spotPnl)} · Funding {funding >= 0 ? '+' : ''}{formatNum(funding)}
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
            <div className="text-white">Qty: {pos.size ?? '—'}</div>
            <div className="text-gray-300">Entry: {formatNum(parseFloat(pos.avgPrice ?? '') || 0)}</div>
            <div className="text-gray-400 text-xs mt-1">Unrealized PnL: {pnlVal >= 0 ? '+' : ''}{formatNum(pnlVal)}</div>
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

  const activePositions = Array.isArray(positions) ? positions : [];

  const { subHedgeGroups, crossExchangeGroups, standalone } = useMemo(() => {
    const bySymbol = new Map<string, PositionRow[]>();
    for (const p of activePositions) {
      const symbol = p?.symbol;
      if (symbol == null) continue;
      const list = bySymbol.get(symbol) ?? [];
      list.push(p);
      bySymbol.set(symbol, list);
    }
    const subHedgeGroups: { symbol: string; positions: PositionRow[] }[] = [];
    const crossExchangeGroups: { symbol: string; bybitPos: PositionRow; binancePos: PositionRow }[] = [];
    const standalone: PositionRow[] = [];
    for (const [symbol, list] of bySymbol) {
      const safeList = Array.isArray(list) ? list : [];
      const hasMain = safeList.some((p) => p?.accountType === 'main');
      const hasSub = safeList.some((p) => p?.accountType === 'sub');
      const bybitPos = safeList.find((p) => p?.exchange === 'Bybit');
      const binancePos = safeList.find((p) => p?.exchange === 'Binance');
      const isCrossExchangePair = safeList.length === 2 && bybitPos && binancePos;
      if (safeList.length === 2 && hasMain && hasSub) {
        subHedgeGroups.push({ symbol, positions: safeList });
      } else if (isCrossExchangePair) {
        crossExchangeGroups.push({ symbol, bybitPos, binancePos });
      } else {
        standalone.push(...safeList);
      }
    }
    return { subHedgeGroups, crossExchangeGroups, standalone };
  }, [activePositions]);

  const handleExit = useCallback(
    async (pos: PositionRow) => {
      const token = localStorage.getItem(TOKEN_KEY);
      if (!token) return;
      const id = pos.accountType ? `${pos.symbol}_${pos.side}_${pos.accountType}` : `${pos.symbol}_${pos.side}`;
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
            ...(pos.accountType && { accountType: pos.accountType }),
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

  const handleCloseHedge = useCallback(
    async (symbol: string) => {
      const token = localStorage.getItem(TOKEN_KEY);
      if (!token) return;
      const id = `hedge_${symbol}`;
      setClosingId(id);
      try {
        const res = await fetch('/api/positions/close', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ symbol }),
        }).catch((e) => {
          console.error('Close hedge network error:', e);
          throw e;
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? 'Close hedge failed');
        await fetchPositions();
      } catch (e) {
        console.error('Close hedge failed:', e);
      } finally {
        setClosingId(null);
      }
    },
    [fetchPositions]
  );

  if (loading && activePositions.length === 0) {
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

      {activePositions.length === 0 && !error ? (
        <div className="px-4 py-8 text-center text-gray-400">No open positions</div>
      ) : (
        <div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
          {/* Sub-account hedge groups: group by symbol, main + sub with combined PnL */}
          {Array.isArray(subHedgeGroups) &&
            subHedgeGroups.map((group) => {
              const symbol = group?.symbol;
              const groupPositions = Array.isArray(group?.positions) ? group.positions : [];
              if (!symbol) return null;
              return (
                <SubHedgeGroupCard
                  key={`subhedge_${symbol}`}
                  symbol={symbol}
                  positions={groupPositions}
                  closingId={closingId}
                  onCloseHedge={handleCloseHedge}
                  formatNum={formatNum}
                  tokenName={tokenName}
                />
              );
            })}
          {/* Cross-exchange hedge groups: same symbol, one Bybit + one Binance */}
          {Array.isArray(crossExchangeGroups) &&
            crossExchangeGroups.map((group) => {
              const symbol = group?.symbol;
              const bybitPos = group?.bybitPos;
              const binancePos = group?.binancePos;
              if (!symbol || !bybitPos || !binancePos) return null;
              return (
                <CrossHedgeGroupCard
                  key={`crosshedge_${symbol}`}
                  symbol={symbol}
                  bybitPos={bybitPos}
                  binancePos={binancePos}
                  closingId={closingId}
                  onCloseHedge={handleCloseHedge}
                  formatNum={formatNum}
                  tokenName={tokenName}
                />
              );
            })}
          {/* Spot-hedged positions: one Hedge Card per group */}
          {(Array.isArray(standalone) ? standalone : [])
            .filter((p): p is PositionRow => p != null && typeof p === 'object')
            .filter((p): p is PositionRow & { isPaired: true } => Boolean(p?.isPaired && p?.hedgeGroupId))
            .reduce<PositionRow[]>((acc, p) => {
              const gid = p?.hedgeGroupId;
              if (gid != null && acc.some((x) => x?.hedgeGroupId === gid)) return acc;
              acc.push(p);
              return acc;
            }, [])
            .map((pos, idx) => {
              if (pos == null) return null;
              const spotQty = pos.spotQty ?? 0;
              const spotEntry = pos.spotEntryPrice ?? 0;
              const vwap = pos.vwapPrice ?? 0;
              const spotPnl =
                (pos.side ?? 'Buy') === 'Buy'
                  ? (spotEntry - vwap) * spotQty
                  : (vwap - spotEntry) * spotQty;
              const funding = pos.fundingAmountReceived ?? 0;
              const combinedPnl = (pos.pnl ?? 0) + spotPnl + funding;
              return (
                <HedgeCard
                  key={pos.hedgeGroupId ?? pos.symbol ?? `hedge-${idx}`}
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
          {(Array.isArray(standalone) ? standalone : []).some((p) => !p?.isPaired) && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-400" style={{ backgroundColor: 'rgba(0, 0, 0, 0.2)' }}>
                    <th className="px-4 py-2.5 font-medium">Token / Exchange</th>
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
                  {(Array.isArray(standalone) ? standalone : [])
                    .filter((p) => !p?.isPaired)
                    .map((pos, idx) => {
                      if (pos == null) return null;
                      const direction = pos.side === 'Buy' ? 'LONG' : 'SHORT';
                      const id = pos.accountType ? `${pos.symbol}_${pos.side}_${pos.accountType}` : `${pos.symbol}_${pos.side}`;
                      const isClosing = closingId === id;
                      const pnlVal = pos.pnl ?? 0;
                      const vwapVal = pos.vwapPrice ?? 0;
                      const fundingVal = pos.fundingRate ?? 0;
                      const targetVal = pos.targetPrice ?? 0;
                      const slVal = pos.slPrice ?? 0;
                      return (
                        <tr
                          key={id || `standalone-${idx}`}
                          className="border-b border-gray-800/80 hover:bg-white/5"
                          style={{ borderColor: 'rgba(255,255,255,0.06)' }}
                        >
                          <td className="px-4 py-2.5 font-medium text-white">
                            <div className="flex flex-wrap items-center gap-2">
                              <span>{tokenName(pos.symbol ?? '')}</span>
                              <span
                                className="inline-block rounded px-1.5 py-0.5 text-xs font-medium opacity-90"
                                style={
                                  pos.exchange === 'Binance'
                                    ? { backgroundColor: 'rgba(234, 179, 8, 0.25)', color: '#eab308' }
                                    : { backgroundColor: 'rgba(0, 123, 255, 0.2)', color: '#007BFF' }
                                }
                              >
                                {pos.exchange === 'Binance' ? 'Binance' : 'Bybit'}
                              </span>
                              {pos.isFundingFlipped && (
                                <span className="rounded px-2 py-0.5 text-xs font-semibold bg-red-500/20 text-red-400 border border-red-500/40">
                                  Funding Flip
                                </span>
                              )}
                            </div>
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
                            {formatNum(parseFloat(pos.avgPrice ?? '') || 0)}
                          </td>
                          <td className="px-4 py-2.5 text-gray-300">
                            {(parseFloat(pos.size ?? '') * parseFloat(pos.avgPrice ?? '') || 0).toFixed(2)}
                          </td>
                          <td className="px-4 py-2.5 text-gray-500 text-xs">—</td>
                          <td className="px-4 py-2.5 font-bold" style={{ color: '#007BFF' }}>
                            {formatNum(vwapVal)}
                          </td>
                          <td className="px-4 py-2.5 text-gray-500 text-xs">—</td>
                          <td className="px-4 py-2.5 text-gray-400">
                            {formatPct(fundingVal)}
                          </td>
                          <td className="px-4 py-2.5 text-gray-500 text-xs">—</td>
                          <td className="px-4 py-2.5 text-gray-300">{pos.size ?? '—'}</td>
                          <td className="px-4 py-2.5 text-gray-500 text-xs">—</td>
                          <td className="px-4 py-2.5">
                            <span
                              className="font-semibold"
                              style={{
                                color: pnlVal >= 0 ? '#22c55e' : '#ef4444',
                                textShadow: pnlVal >= 0 ? '0 0 8px rgba(34,197,94,0.4)' : '0 0 8px rgba(239,68,68,0.4)',
                              }}
                            >
                              {pnlVal >= 0 ? '+' : ''}{formatNum(pnlVal)}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-gray-400 text-xs">
                            <span className="block">T: {formatNum(targetVal)}</span>
                            <span className="block">S: {formatNum(slVal)}</span>
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
