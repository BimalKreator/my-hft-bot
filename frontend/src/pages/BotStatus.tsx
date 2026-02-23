import { useState, useEffect, useCallback } from 'react';

const TOKEN_KEY = 'hft_token';

interface TradeHistoryRow {
  id: number;
  symbol: string;
  funding_time: string;
  funding_time_ms: string;
  main_exec_price: string | null;
  main_ms_before_funding: number | null;
  sub_exec_price: string | null;
  sub_ms_before_funding: number | null;
  reason_no_sub: string | null;
  exchange?: string | null;
}

function formatMsBeforeFunding(ms: number | null): string {
  if (ms == null) return '—';
  if (ms >= 0) return `${ms} ms before`;
  return `${-ms} ms after`;
}

export default function BotStatus() {
  const [executions, setExecutions] = useState<TradeHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchExecutionHistory = useCallback(async () => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      setError('Please log in.');
      setLoading(false);
      return;
    }
    setError(null);
    try {
      const res = await fetch('/api/trade/execution-history', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'Failed to load execution history');
        setExecutions([]);
        return;
      }
      setExecutions(Array.isArray(data) ? data : []);
    } catch {
      setError('Network error');
      setExecutions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchExecutionHistory();
  }, [fetchExecutionHistory]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-white">Bot Status</h1>
      <p className="text-gray-400">Monitor bot state and activity here.</p>

      <section className="rounded-lg border border-gray-700 bg-gray-900/50 p-4">
        <h2 className="text-lg font-medium text-white mb-3">Recent Trade Executions</h2>
        {loading && <p className="text-gray-400">Loading…</p>}
        {error && <p className="text-red-400 text-sm">{error}</p>}
        {!loading && !error && executions.length === 0 && (
          <p className="text-gray-500 text-sm">No trade executions recorded yet.</p>
        )}
        {!loading && !error && executions.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="text-gray-400 border-b border-gray-700">
                  <th className="py-2 pr-4">Symbol</th>
                  <th className="py-2 pr-4">Exchange</th>
                  <th className="py-2 pr-4">Target Funding Time</th>
                  <th className="py-2 pr-4">Main Exec Price</th>
                  <th className="py-2 pr-4">Main Ms Before/After</th>
                  <th className="py-2 pr-4">Sub Exec Price</th>
                  <th className="py-2 pr-4">Sub Ms Before/After</th>
                  <th className="py-2">Status / Reason</th>
                </tr>
              </thead>
              <tbody>
                {executions.map((row) => {
                  const mainAfter = row.main_ms_before_funding != null && row.main_ms_before_funding < 0;
                  const subAfter = row.sub_ms_before_funding != null && row.sub_ms_before_funding < 0;
                  return (
                    <tr key={row.id} className="border-b border-gray-800 text-gray-300">
                      <td className="py-2 pr-4 font-medium text-white">{row.symbol}</td>
                      <td className="py-2 pr-4">{row.exchange ?? '—'}</td>
                      <td className="py-2 pr-4">{row.funding_time ? new Date(row.funding_time).toISOString().replace('T', ' ').slice(0, 19) : '—'}</td>
                      <td className="py-2 pr-4">{row.main_exec_price ?? '—'}</td>
                      <td className="py-2 pr-4">
                        <span className={mainAfter ? 'text-amber-400' : ''}>
                          {formatMsBeforeFunding(row.main_ms_before_funding)}
                        </span>
                      </td>
                      <td className="py-2 pr-4">{row.sub_exec_price ?? '—'}</td>
                      <td className="py-2 pr-4">
                        <span className={subAfter ? 'text-amber-400' : ''}>
                          {formatMsBeforeFunding(row.sub_ms_before_funding)}
                        </span>
                      </td>
                      <td className="py-2 text-gray-500">{row.reason_no_sub ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
