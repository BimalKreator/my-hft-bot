import { useState, useEffect, useCallback, useMemo } from 'react';
import TradeModal, { type TokenData } from '../components/TradeModal';

const TOKEN_KEY = 'hft_token';

interface FundingItem {
  symbol: string;
  fundingRate: number;
  nextFundingTime: string;
  countdownMs: number;
  lastPrice: string;
  markPrice: string;
  turnover24h: number;
  fundingIntervalHours: number;
  maxLeverage: string;
}

type FilterType = 'all' | 'positive' | 'negative';
type SortOption = 'smart' | 'highest' | 'lowest' | 'nearest' | 'leverage';

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
    <span className="inline-flex rounded px-2.5 py-1 text-xs font-semibold text-gray-400">
      NONE
    </span>
  );
}

export default function Scanner() {
  const [data, setData] = useState<FundingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [minFundingPct, setMinFundingPct] = useState<string>('');
  const [filterType, setFilterType] = useState<FilterType>('all');
  const [sortBy, setSortBy] = useState<SortOption>('smart');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isAutoRefresh, setIsAutoRefresh] = useState<boolean>(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedToken, setSelectedToken] = useState<TokenData | null>(null);

  const fetchData = useCallback(async (silent = false) => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      if (!silent) {
        setError('Please log in again.');
        setLoading(false);
      }
      return;
    }
    if (!silent) {
      setError(null);
      setLoading(true);
    }
    try {
      const res = await fetch('/api/scanner/opportunities', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (!silent) {
          setError(json.error ?? 'Failed to load data');
          setData([]);
        }
        return;
      }
      setData(Array.isArray(json) ? json : []);
    } catch {
      if (!silent) {
        setError('Network error');
        setData([]);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!isAutoRefresh) return;
    const id = setInterval(() => fetchData(true), 3000);
    return () => clearInterval(id);
  }, [isAutoRefresh, fetchData]);

  const filteredData = useMemo(() => {
    let result = data;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((item) => tokenName(item.symbol).toLowerCase().includes(q));
    }
    if (minFundingPct !== '') {
      const minRate = parseFloat(minFundingPct);
      if (!Number.isNaN(minRate)) {
        const threshold = minRate / 100;
        result = result.filter((item) => Math.abs(item.fundingRate) >= threshold);
      }
    }
    if (filterType === 'positive') result = result.filter((item) => item.fundingRate > 0);
    if (filterType === 'negative') result = result.filter((item) => item.fundingRate < 0);
    return result;
  }, [data, searchQuery, minFundingPct, filterType]);

  const sortedData = useMemo(() => {
    const arr = [...filteredData];
    if (sortBy === 'smart') {
      arr.sort((a, b) => {
        const intervalA = a.fundingIntervalHours;
        const intervalB = b.fundingIntervalHours;
        if (intervalA !== intervalB) return intervalA - intervalB;
        return Math.abs(b.fundingRate) - Math.abs(a.fundingRate);
      });
      return arr;
    }
    if (sortBy === 'highest') arr.sort((a, b) => b.fundingRate - a.fundingRate);
    else if (sortBy === 'lowest') arr.sort((a, b) => a.fundingRate - b.fundingRate);
    else if (sortBy === 'leverage') {
      arr.sort((a, b) => {
        const levA = parseFloat(a.maxLeverage) || 0;
        const levB = parseFloat(b.maxLeverage) || 0;
        return levB - levA;
      });
    } else arr.sort((a, b) => a.countdownMs - b.countdownMs);
    return arr;
  }, [filteredData, sortBy]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-white">Funding Scanner</h1>
        <div className="flex items-center gap-3">
          {isAutoRefresh && (
            <span
              className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium text-green-400"
              style={{
                backgroundColor: 'rgba(34, 197, 94, 0.15)',
                boxShadow: '0 0 8px rgba(34, 197, 94, 0.2)',
              }}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
              Live
            </span>
          )}
          <label className="flex cursor-pointer items-center gap-2">
            <span className="text-sm text-gray-400">Auto-Refresh</span>
            <button
              type="button"
              role="switch"
              aria-checked={isAutoRefresh}
              onClick={() => setIsAutoRefresh((v) => !v)}
              className={`relative h-6 w-11 rounded-full transition-colors ${
                isAutoRefresh ? 'bg-[#007BFF]' : 'bg-gray-600'
              }`}
            >
              <span
                className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-transform ${
                  isAutoRefresh ? 'left-6 translate-x-[-100%]' : 'left-1'
                }`}
              />
            </button>
          </label>
        </div>
      </div>

      {/* Single Toolbar */}
      <div
        className="rounded-xl border p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[1fr_auto_auto_auto] gap-4 items-end"
        style={{
          backgroundColor: 'rgba(255, 255, 255, 0.04)',
          borderColor: 'rgba(0, 123, 255, 0.3)',
        }}
      >
        <div className="lg:col-span-1">
          <label className="block text-xs font-medium text-gray-400 mb-1">Search Token (e.g., BTC)</label>
          <input
            type="text"
            placeholder="Search token (e.g., BTC)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-lg border bg-black/40 px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-[#007BFF]"
            style={{ borderColor: 'rgba(0, 123, 255, 0.3)' }}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Min Funding %</label>
          <input
            type="number"
            step="0.001"
            placeholder="0"
            value={minFundingPct}
            onChange={(e) => setMinFundingPct(e.target.value)}
            className="w-full min-w-[100px] rounded-lg border bg-black/40 px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-[#007BFF] text-sm"
            style={{ borderColor: 'rgba(255, 255, 255, 0.12)' }}
          />
        </div>
        <div>
          <span className="block text-xs font-medium text-gray-400 mb-1">Type</span>
          <div className="flex rounded-lg overflow-hidden border" style={{ borderColor: 'rgba(255, 255, 255, 0.12)' }}>
            {(['all', 'positive', 'negative'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setFilterType(t)}
                className={`px-3 py-2 text-sm font-medium transition ${
                  filterType === t ? 'text-white' : 'text-gray-400 hover:text-white'
                }`}
                style={{
                  backgroundColor: filterType === t ? 'rgba(0, 123, 255, 0.3)' : 'transparent',
                }}
              >
                {t === 'all' ? 'All' : t === 'positive' ? 'Positive' : 'Negative'}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Sort</label>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortOption)}
            className="w-full min-w-[140px] rounded-lg border bg-black/40 px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-[#007BFF] text-sm"
            style={{ borderColor: 'rgba(255, 255, 255, 0.12)' }}
          >
            <option value="smart">Smart Sort (Interval + Rate)</option>
            <option value="highest">Highest Funding</option>
            <option value="lowest">Lowest Funding</option>
            <option value="nearest">Nearest Time</option>
            <option value="leverage">Highest Leverage</option>
          </select>
        </div>
      </div>

      {error && (
        <div
          className="rounded-xl border px-4 py-3 text-sm text-red-400"
          style={{
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            borderColor: 'rgba(239, 68, 68, 0.3)',
          }}
        >
          {error}
        </div>
      )}

      {/* Table */}
      <div
        className="rounded-xl border overflow-hidden backdrop-blur-sm"
        style={{
          backgroundColor: 'rgba(255, 255, 255, 0.04)',
          borderColor: 'rgba(0, 123, 255, 0.3)',
          boxShadow: '0 0 24px rgba(0, 123, 255, 0.1)',
        }}
      >
        {loading && data.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <div
              className="h-10 w-10 animate-spin rounded-full border-2 border-t-transparent"
              style={{ borderColor: '#007BFF', borderTopColor: 'transparent' }}
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px]">
              <thead>
                <tr
                  className="border-b text-left text-sm font-medium text-gray-400"
                  style={{ borderColor: 'rgba(255, 255, 255, 0.08)' }}
                >
                  <th className="px-4 py-3">Token</th>
                  <th className="px-4 py-3">Price</th>
                  <th className="px-4 py-3">Funding Rate</th>
                  <th className="px-4 py-3">Direction</th>
                  <th className="px-4 py-3">Countdown</th>
                  <th
                    className={`px-4 py-3 ${sortBy === 'smart' ? 'text-[#007BFF]' : ''}`}
                    title={sortBy === 'smart' ? 'Primary sort: shortest interval first' : undefined}
                  >
                    <span className="inline-flex items-center gap-1">
                      Interval
                      {sortBy === 'smart' && (
                        <span
                          className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase"
                          style={{
                            backgroundColor: 'rgba(0, 123, 255, 0.2)',
                            color: '#007BFF',
                          }}
                        >
                          1º
                        </span>
                      )}
                    </span>
                  </th>
                  <th className="px-4 py-3">Max Lev</th>
                  <th className="px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody>
                {sortedData.length === 0 && !loading ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                      {searchQuery || minFundingPct
                        ? 'No tokens match your filters.'
                        : 'No results yet.'}
                    </td>
                  </tr>
                ) : (
                  sortedData.map((row) => (
                    <tr
                      key={row.symbol}
                      className="border-b text-white transition hover:bg-white/5"
                      style={{ borderColor: 'rgba(255, 255, 255, 0.06)' }}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span
                            className="flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium"
                            style={{ backgroundColor: 'rgba(0, 123, 255, 0.2)', color: '#007BFF' }}
                          >
                            {tokenName(row.symbol).slice(0, 2)}
                          </span>
                          <span className="font-medium">{tokenName(row.symbol)}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-300 font-mono text-sm">
                        {parseFloat(row.markPrice || row.lastPrice || '0').toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 6,
                        })}
                      </td>
                      <td className="px-4 py-3">
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
                      <td className="px-4 py-3">
                        <DirectionBadge fundingRate={row.fundingRate} />
                      </td>
                      <td className="px-4 py-3">
                        <CountdownCell nextFundingTime={row.nextFundingTime} />
                      </td>
                      <td className="px-4 py-3 text-gray-300">
                        {row.fundingIntervalHours % 1 === 0
                          ? `${row.fundingIntervalHours}h`
                          : `${row.fundingIntervalHours.toFixed(1)}h`}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className="inline-flex rounded px-2 py-0.5 text-xs font-medium"
                          style={{
                            backgroundColor: 'rgba(0, 123, 255, 0.2)',
                            color: '#007BFF',
                            boxShadow: '0 0 8px rgba(0, 123, 255, 0.2)',
                          }}
                        >
                          {row.maxLeverage ? `${row.maxLeverage}x` : '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => {
                            const price = parseFloat(row.markPrice || row.lastPrice || '0') || 0;
                            setSelectedToken({
                              symbol: row.symbol,
                              price,
                              fundingRate: row.fundingRate,
                              direction: row.fundingRate < 0 ? 'LONG' : 'SHORT',
                            });
                            setIsModalOpen(true);
                          }}
                          className="rounded-lg border px-3 py-1.5 text-sm font-medium text-white transition hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[#007BFF]"
                          style={{
                            borderColor: '#007BFF',
                            backgroundColor: '#007BFF',
                          }}
                        >
                          Trade Now
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <TradeModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setSelectedToken(null);
        }}
        tokenData={selectedToken}
      />
    </div>
  );
}
