import { useState, useEffect, useCallback } from 'react';
import * as XLSX from 'xlsx';

const TOKEN_KEY = 'hft_token';

export interface ClosedTradeRow {
  id: number;
  user_id: number;
  symbol: string;
  side: string;
  entry_price: string;
  exit_price: string;
  qty: string;
  gross_pnl: string;
  funding: string;
  fees: string;
  net_pnl: string;
  closed_at: string;
  source: string | null;
  exit_reason?: string | null;
}

function tokenName(symbol: string): string {
  if (symbol.endsWith('USDT')) return symbol.slice(0, -4);
  return symbol;
}

function formatUsd(value: number): string {
  if (Number.isNaN(value)) return '—';
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

export default function ClosedTradesTable() {
  const [rows, setRows] = useState<ClosedTradeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tokenFilter, setTokenFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [profitOnly, setProfitOnly] = useState(false);
  const [lossOnly, setLossOnly] = useState(false);

  const fetchHistory = useCallback(async () => {
    const auth = localStorage.getItem(TOKEN_KEY);
    if (!auth) {
      setError('Please log in again.');
      setLoading(false);
      return;
    }
    setError(null);
    setLoading(true);
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
    } catch {
      setError('Network error');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate, tokenFilter, profitOnly, lossOnly]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const handleDownloadExcel = () => {
    const headers = [
      'Token',
      'Direction',
      'Trade Amount',
      'Entry Price',
      'Exit Price',
      'Time',
      'Fees',
      'Exit Reason',
      'Net PnL',
    ];
    const data = rows.map((r) => [
      tokenName(r.symbol),
      r.side,
      ((parseFloat(r.qty) || 0) * (parseFloat(r.entry_price) || 0)).toFixed(2),
      parseFloat(r.entry_price) || 0,
      parseFloat(r.exit_price) || 0,
      formatTime(r.closed_at),
      parseFloat(r.fees) || 0,
      r.exit_reason ?? '',
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
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-400" style={{ backgroundColor: 'rgba(0, 0, 0, 0.2)' }}>
                <th className="px-4 py-2.5 font-medium">Token</th>
                <th className="px-4 py-2.5 font-medium">Direction</th>
                <th className="px-4 py-2.5 font-medium">Trade Amount</th>
                <th className="px-4 py-2.5 font-medium">Entry / Exit Price</th>
                <th className="px-4 py-2.5 font-medium">Time</th>
                <th className="px-4 py-2.5 font-medium">Fees</th>
                <th className="px-4 py-2.5 font-medium">Exit Reason</th>
                <th className="px-4 py-2.5 font-medium">Net PnL</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-gray-400">
                    No closed trades match the filters.
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const netPnl = parseFloat(r.net_pnl) || 0;
                  const isProfit = netPnl >= 0;
                  const direction = r.side === 'Buy' ? 'LONG' : 'SHORT';
                  return (
                    <tr
                      key={r.id}
                      className="border-b border-gray-800/80 hover:bg-white/5"
                      style={{ borderColor: 'rgba(255,255,255,0.06)' }}
                    >
                      <td className="px-4 py-2.5 font-medium text-white">{tokenName(r.symbol)}</td>
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
                        {((parseFloat(r.qty) || 0) * (parseFloat(r.entry_price) || 0)).toFixed(2)}
                      </td>
                      <td className="px-4 py-2.5 text-gray-400">
                        {formatUsd(parseFloat(r.entry_price) || 0)} / {formatUsd(parseFloat(r.exit_price) || 0)}
                      </td>
                      <td className="px-4 py-2.5 text-gray-400">{formatTime(r.closed_at)}</td>
                      <td className="px-4 py-2.5 text-gray-400">{formatUsd(parseFloat(r.fees) || 0)}</td>
                      <td className="px-4 py-2.5">
                        <span
                          className="inline-block rounded px-2 py-0.5 text-xs font-medium"
                          style={{
                            backgroundColor: 'rgba(255, 255, 255, 0.08)',
                            color: 'rgba(255, 255, 255, 0.85)',
                            border: '1px solid rgba(255, 255, 255, 0.12)',
                          }}
                        >
                          {r.exit_reason ?? '—'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className="inline-block rounded px-2 py-0.5 text-xs font-semibold"
                          style={
                            isProfit
                              ? { backgroundColor: 'rgba(34, 197, 94, 0.2)', color: '#22c55e' }
                              : { backgroundColor: 'rgba(239, 68, 68, 0.2)', color: '#ef4444' }
                          }
                        >
                          {isProfit ? '+' : ''}{formatUsd(netPnl)}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
