import { useState, useEffect, useCallback } from 'react';

const TOKEN_KEY = 'hft_token';
const LOG_TYPES = ['All', 'INFO', 'SELECTION', 'ENTRY', 'EXIT', 'ERROR'] as const;
type FilterType = (typeof LOG_TYPES)[number];

interface BotLogRow {
  id: number;
  log_type: string | null;
  symbol: string | null;
  message: string | null;
  created_at: string;
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

function TypeBadge({ type }: { type: string | null }) {
  const t = (type ?? 'INFO').toUpperCase();
  const classes: Record<string, string> = {
    ENTRY: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40',
    EXIT: 'bg-amber-500/20 text-amber-400 border border-amber-500/40',
    ERROR: 'bg-red-500/20 text-red-400 border border-red-500/40',
    SELECTION: 'bg-blue-500/20 text-blue-400 border border-blue-500/40',
    INFO: 'bg-gray-500/20 text-gray-400 border border-gray-500/40',
  };
  const cls = classes[t] ?? classes.INFO;
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${cls}`}>
      {t || 'INFO'}
    </span>
  );
}

export default function Logs() {
  const [logs, setLogs] = useState<BotLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<FilterType>('All');
  const [filterSymbol, setFilterSymbol] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);

  const fetchLogs = useCallback(async () => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      setError('Please log in.');
      setLoading(false);
      return;
    }
    setError(null);
    try {
      const res = await fetch('/api/logs?limit=500', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'Failed to load logs');
        setLogs([]);
        return;
      }
      setLogs(Array.isArray(data) ? data : []);
    } catch {
      setError('Network error');
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchLogs]);

  const filtered = logs.filter((row) => {
    if (filterType !== 'All' && (row.log_type ?? 'INFO') !== filterType) return false;
    if (filterSymbol.trim()) {
      const sym = (row.symbol ?? '').toLowerCase();
      const q = filterSymbol.trim().toLowerCase();
      if (!sym.includes(q)) return false;
    }
    return true;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">System Logs</h1>
          <p className="text-gray-400 text-sm mt-1">Persistent bot logs: selection, entry, exit, errors.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => fetchLogs()}
            disabled={loading}
            className="rounded-lg px-4 py-2 text-sm font-medium text-white border border-[#007BFF] transition hover:opacity-90 disabled:opacity-50"
            style={{ backgroundColor: '#007BFF' }}
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          <label className="flex items-center gap-2 text-sm text-gray-400">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded"
            />
            Auto-Refresh (5s)
          </label>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-400">Type</span>
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value as FilterType)}
            className="rounded-lg bg-gray-800 border border-gray-600 text-white px-3 py-1.5 text-sm"
          >
            {LOG_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-400">Symbol</span>
          <input
            type="text"
            placeholder="Filter by symbol"
            value={filterSymbol}
            onChange={(e) => setFilterSymbol(e.target.value)}
            className="rounded-lg bg-gray-800 border border-gray-600 text-white px-3 py-1.5 text-sm w-40 placeholder-gray-500"
          />
        </div>
      </div>

      <div
        className="rounded-xl border overflow-hidden"
        style={{
          backgroundColor: 'rgba(255, 255, 255, 0.04)',
          borderColor: 'rgba(0, 123, 255, 0.3)',
        }}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left border-collapse">
            <thead>
              <tr className="border-b text-gray-400" style={{ borderColor: 'rgba(0, 123, 255, 0.2)', backgroundColor: 'rgba(0, 0, 0, 0.2)' }}>
                <th className="p-3 font-medium w-40">Time</th>
                <th className="p-3 font-medium w-28">Type</th>
                <th className="p-3 font-medium w-28">Symbol</th>
                <th className="p-3 font-medium">Message</th>
              </tr>
            </thead>
            <tbody>
              {loading && logs.length === 0 ? (
                <tr>
                  <td colSpan={4} className="p-8 text-center text-gray-500">
                    Loading…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={4} className="p-8 text-center text-gray-500">
                    No logs match the filters.
                  </td>
                </tr>
              ) : (
                filtered.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-gray-800 hover:bg-white/5"
                    style={{ borderColor: 'rgba(255,255,255,0.06)' }}
                  >
                    <td className="p-3 text-gray-400 whitespace-nowrap">{formatTime(row.created_at)}</td>
                    <td className="p-3">
                      <TypeBadge type={row.log_type} />
                    </td>
                    <td className="p-3 text-gray-300 font-mono">{row.symbol ?? '—'}</td>
                    <td className="p-3 text-gray-300 break-words">{row.message ?? '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
