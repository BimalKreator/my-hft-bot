import React, { useState, useEffect, useCallback, useMemo } from 'react';
import * as XLSX from 'xlsx';

const GROUP_WINDOW_MS = 60000;

const TOKEN_KEY = 'hft_token';

export interface ClosedTradeRow {
  id: number | string;
  user_id?: number;
  symbol: string;
  side: string;
  entry_price: string;
  exit_price: string;
  qty: string;
  gross_pnl: string;
  funding?: string;
  funding_received?: string;
  fees: string;
  net_pnl: string;
  closed_at: string;
  source?: string | null;
  exit_reason?: string | null;
  /** CamelCase exit reason (e.g. 'PnL Positive Exit') for display in Reason column. */
  exitReason?: string | null;
  /** When subaccount hedging is active, backend returns Main/Sub per row. */
  accountType?: 'Main' | 'Sub';
  /** Exchange label: 'Bybit Main', 'Bybit Sub', or 'Binance'. */
  exchange?: string | null;
}

function tokenName(symbol: string): string {
  if (symbol.endsWith('USDT')) return symbol.slice(0, -4);
  return symbol;
}

function formatUsd(value: number): string {
  if (Number.isNaN(value)) return '—';
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Prices: 4–6 decimal places with $ prefix. */
function formatPrice(value: number): string {
  if (Number.isNaN(value)) return '—';
  return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 6 });
}

/** USD amount with $ prefix (2 decimals). */
function formatUsdWithSign(value: number): string {
  if (Number.isNaN(value)) return '—';
  return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatQty(value: number): string {
  if (Number.isNaN(value)) return '—';
  return value.toLocaleString('en-US', { maximumFractionDigits: 6, minimumFractionDigits: 0 });
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

function buildQuery(params: {
  from?: string;
  to?: string;
  token?: string;
  profit?: boolean;
  loss?: boolean;
}): string {
  const sp = new URLSearchParams();
  if (params.from) sp.set('from', params.from);
  if (params.to) sp.set('to', params.to);
  if (params.token) sp.set('token', params.token);
  if (params.profit) sp.set('profit', 'true');
  if (params.loss) sp.set('loss', 'true');
  const q = sp.toString();
  return q ? `?${q}` : '';
}

const ITEMS_PER_PAGE = 15;

type GroupedItem = { isGroup: boolean; trades: ClosedTradeRow[] };

export default function ClosedTradesTable() {
  const [rows, setRows] = useState<ClosedTradeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tokenFilter, setTokenFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [profitOnly, setProfitOnly] = useState(false);
  const [lossOnly, setLossOnly] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);

  const fetchHistory = useCallback(async (silent = false) => {
    const auth = localStorage.getItem(TOKEN_KEY);
    if (!auth) {
      setError('Please log in again.');
      setLoading(false);
      return;
    }
    setError(null);
    if (!silent) setLoading(true);
    try {
      const query = buildQuery({
        from: fromDate || undefined,
        to: toDate || undefined,
        token: tokenFilter.trim() || undefined,
        profit: profitOnly,
        loss: lossOnly,
      });
      const res = await fetch(`/api/trade/history${query}`, {
        headers: { Authorization: `Bearer ${auth}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'Failed to load closed trades');
        setRows([]);
        return;
      }
      setRows(Array.isArray(data) ? data : []);
      setCurrentPage(1);
    } catch {
      setError('Network error');
      setRows([]);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [fromDate, toDate, tokenFilter, profitOnly, lossOnly]);

  useEffect(() => {
    fetchHistory();
    const interval = setInterval(() => fetchHistory(true), 3000);
    return () => clearInterval(interval);
  }, [fetchHistory]);

  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => new Date(b.closed_at).getTime() - new Date(a.closed_at).getTime()),
    [rows]
  );

  const groupedTrades = useMemo((): GroupedItem[] => {
    const groups: GroupedItem[] = [];
    let skipNext = false;
    for (let i = 0; i < sortedRows.length; i++) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      const current = sortedRows[i]!;
      const next = sortedRows[i + 1];
      const currentTime = new Date(current.closed_at).getTime();
      const nextTime = next ? new Date(next.closed_at).getTime() : 0;
      if (
        next &&
        (current.symbol || (current as { token?: string }).token) === (next.symbol || (next as { token?: string }).token) &&
        Math.abs(currentTime - nextTime) < GROUP_WINDOW_MS
      ) {
        groups.push({ isGroup: true, trades: [current, next] });
        skipNext = true;
      } else {
        groups.push({ isGroup: false, trades: [current] });
      }
    }
    return groups;
  }, [sortedRows]);

  const indexOfLastItem = currentPage * ITEMS_PER_PAGE;
  const indexOfFirstItem = indexOfLastItem - ITEMS_PER_PAGE;
  const currentItems = useMemo(
    () => groupedTrades.slice(indexOfFirstItem, indexOfLastItem),
    [groupedTrades, indexOfFirstItem, indexOfLastItem]
  );
  const totalPages = Math.max(1, Math.ceil(groupedTrades.length / ITEMS_PER_PAGE));

  const handleDownloadExcel = () => {
    const headers = [
      'Token',
      'Exchange',
      'Direction',
      'Trade Amount',
      'Entry Price',
      'Exit Price',
      'Time',
      'Fees',
      'Exit Reason',
      'Funding Earned',
      'Net PnL',
    ];
    const data = rows.map((r) => [
      tokenName(r.symbol),
      r.exchange ?? (r.accountType === 'Sub' ? 'Bybit Sub' : 'Bybit Main'),
      r.side,
      ((parseFloat(r.qty) || 0) * (parseFloat(r.entry_price) || 0)).toFixed(2),
      parseFloat(r.entry_price) || 0,
      parseFloat(r.exit_price) || 0,
      formatTime(r.closed_at),
      parseFloat(r.fees) || 0,
      r.exitReason ?? r.exit_reason ?? '',
      parseFloat(r.funding_received ?? r.funding ?? '0') || 0,
      parseFloat(r.net_pnl) || 0,
    ]);
    const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Closed Trades');
    XLSX.writeFile(wb, `closed-trades-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  return (
    <div
      className="rounded-xl border overflow-hidden backdrop-blur-sm"
      style={{
        backgroundColor: 'rgba(255, 255, 255, 0.04)',
        borderColor: 'rgba(0, 123, 255, 0.3)',
      }}
    >
      <div className="px-4 py-3 border-b flex flex-wrap items-center justify-between gap-4" style={{ borderColor: 'rgba(0, 123, 255, 0.2)' }}>
        <h2 className="text-lg font-semibold text-white">Closed Trades</h2>
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="text"
            placeholder="Token name"
            value={tokenFilter}
            onChange={(e) => setTokenFilter(e.target.value)}
            className="rounded-lg px-3 py-1.5 text-sm bg-black/30 border text-white placeholder-gray-500"
            style={{ borderColor: 'rgba(255,255,255,0.2)' }}
          />
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="rounded-lg px-3 py-1.5 text-sm bg-black/30 border text-white"
            style={{ borderColor: 'rgba(255,255,255,0.2)' }}
          />
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="rounded-lg px-3 py-1.5 text-sm bg-black/30 border text-white"
            style={{ borderColor: 'rgba(255,255,255,0.2)' }}
          />
          <label className="flex items-center gap-1.5 text-sm text-gray-300">
            <input
              type="checkbox"
              checked={profitOnly}
              onChange={(e) => {
                setProfitOnly(e.target.checked);
                if (e.target.checked) setLossOnly(false);
              }}
              className="rounded"
            />
            Profit only
          </label>
          <label className="flex items-center gap-1.5 text-sm text-gray-300">
            <input
              type="checkbox"
              checked={lossOnly}
              onChange={(e) => {
                setLossOnly(e.target.checked);
                if (e.target.checked) setProfitOnly(false);
              }}
              className="rounded"
            />
            Loss only
          </label>
          <button
            type="button"
            onClick={handleDownloadExcel}
            disabled={rows.length === 0}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-white border transition disabled:opacity-50"
            style={{ backgroundColor: '#007BFF', borderColor: 'rgba(0, 123, 255, 0.5)' }}
          >
            Download Excel
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-3 text-sm text-red-400" style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)' }}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div
            className="h-10 w-10 animate-spin rounded-full border-2 border-t-transparent"
            style={{ borderColor: '#007BFF', borderTopColor: 'transparent' }}
          />
        </div>
      ) : (
        <>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left border-collapse">
            <thead>
              <tr className="border-b border-gray-800 text-gray-400 text-sm" style={{ backgroundColor: 'rgba(0, 0, 0, 0.2)' }}>
                <th className="p-3 font-medium">Symbol / Exchange</th>
                <th className="p-3 font-medium">Direction</th>
                <th className="p-3 font-medium">Quantity</th>
                <th className="p-3 font-medium">PnL</th>
                <th className="p-3 font-medium">Reason</th>
                <th className="p-3 font-medium">Time</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-3 text-center text-gray-500">
                    No closed trades match the filters.
                  </td>
                </tr>
              ) : currentItems.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-3 text-center text-gray-500">
                    No closed trades on this page.
                  </td>
                </tr>
              ) : (
                currentItems.map((group, groupIdx) => (
                  <React.Fragment key={groupIdx}>
                    {group.trades.map((trade: ClosedTradeRow, idx: number) => {
                      const sym = trade.symbol || (trade as { token?: string }).token || '—';
                      const dir = (trade.side || (trade as { direction?: string }).direction || '').toLowerCase();
                      const isLong = dir === 'buy';
                      const dirLabel = isLong ? 'LONG' : 'SHORT';
                      const dirClass = isLong ? 'text-green-500' : 'text-red-500';
                      const qty = Math.abs(Number(trade.qty ?? (trade as { quantity?: string }).quantity ?? 0));
                      const exchangeName = trade.exchange ?? (trade.accountType === 'Sub' ? 'Bybit Sub' : trade.accountType === 'Main' ? 'Bybit Main' : 'Bybit Main');
                      const pnl = Number(trade.net_pnl ?? trade.gross_pnl ?? 0);
                      const createdAt = trade.closed_at || (trade as { exit_time?: string }).exit_time || '';
                      return (
                        <tr
                          key={trade.id ?? `${groupIdx}-${idx}`}
                          className={`border-b border-gray-800 hover:bg-gray-800/50 ${group.isGroup ? 'bg-gray-800/20' : ''}`}
                          style={{ borderColor: 'rgba(255,255,255,0.06)' }}
                        >
                          <td className="p-3 whitespace-nowrap">
                            <div className="font-medium text-white">{tokenName(sym)}</div>
                            <div className="text-xs text-gray-500">{exchangeName}</div>
                          </td>
                          <td className="p-3 whitespace-nowrap">
                            <span className={`px-2 py-1 text-xs font-semibold rounded bg-gray-800/50 ${dirClass}`}>
                              {dirLabel}
                            </span>
                          </td>
                          <td className="p-3 whitespace-nowrap font-medium text-gray-300">{formatQty(qty)}</td>
                          <td className="p-3 whitespace-nowrap">
                            <span className={pnl >= 0 ? 'text-green-500' : 'text-red-500'}>
                              ${pnl.toFixed(4)}
                            </span>
                          </td>
                          <td className="p-3 whitespace-nowrap text-sm text-gray-400">{trade.exitReason ?? trade.exit_reason ?? 'Auto Exit'}</td>
                          <td className="p-3 whitespace-nowrap text-sm text-gray-400">{createdAt ? formatTime(createdAt) : '—'}</td>
                        </tr>
                      );
                    })}
                    {group.isGroup && group.trades.length >= 2 && (
                      <tr className="border-b-[3px] border-gray-700 bg-gray-900/50" style={{ borderColor: 'rgba(0, 123, 255, 0.25)' }}>
                        <td colSpan={3} className="p-2 text-right text-xs text-gray-400 font-bold">Hedge Net PnL:</td>
                        <td
                          colSpan={3}
                          className={`p-2 text-sm font-bold ${(Number(group.trades[0]?.net_pnl ?? 0) + Number(group.trades[1]?.net_pnl ?? 0)) >= 0 ? 'text-green-500' : 'text-red-500'}`}
                        >
                          $
                          {(Number(group.trades[0]?.net_pnl ?? 0) + Number(group.trades[1]?.net_pnl ?? 0)).toFixed(4)}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>
        {groupedTrades.length > 0 && (
          <div className="px-4 py-3 border-t flex justify-between items-center gap-4" style={{ borderColor: 'rgba(0, 123, 255, 0.2)' }}>
            <span className="text-sm text-gray-400">
              Page {currentPage} of {totalPages} ({groupedTrades.length} groups / {rows.length} trades)
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage <= 1}
                className="px-3 py-1 bg-gray-800 rounded text-sm disabled:opacity-50 disabled:cursor-not-allowed text-white border transition"
                style={{ borderColor: 'rgba(255,255,255,0.2)' }}
              >
                Prev
              </button>
              <button
                type="button"
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage >= totalPages || totalPages === 0}
                className="px-3 py-1 bg-gray-800 rounded text-sm disabled:opacity-50 disabled:cursor-not-allowed text-white border transition"
                style={{ borderColor: 'rgba(255,255,255,0.2)' }}
              >
                Next
              </button>
            </div>
          </div>
        )}
        </>
      )}
    </div>
  );
}
