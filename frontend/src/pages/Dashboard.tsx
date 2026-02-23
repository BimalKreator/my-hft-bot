import { useState, useEffect, useCallback } from 'react';
import ActivePositions from '../components/ActivePositions';
import ClosedTradesTable from '../components/ClosedTradesTable';
// import NextToTrade from '../components/NextToTrade';
import { TRANSACTIONS_UPDATED_EVENT } from './Settings';

const TOKEN_KEY = 'hft_token';

interface DashboardStats {
  capital: number;
  opening: number;
  marginUsed: number;
  available: number;
  todayProfit: number;
  todayProfitPct: number;
  dailyRoi: number;
  mainEquity?: number;
  subEquity?: number;
  binanceBalance?: number;
  crossExchangeMode?: boolean;
}

function formatUsd(value: number): string {
  if (Number.isNaN(value)) return '0.00';
  return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPct(value: number): string {
  if (Number.isNaN(value)) return '0.00';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

const cardStyle = {
  backgroundColor: 'rgba(255, 255, 255, 0.04)',
  borderColor: 'rgba(0, 123, 255, 0.3)',
};

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inrRate, setInrRate] = useState(86.5);

  useEffect(() => {
    fetch('https://api.exchangerate-api.com/v4/latest/USD')
      .then((res) => res.json())
      .then((data) => setInrRate(data.rates?.INR ?? 86.5))
      .catch(() => {});
  }, []);

  const fetchDashboardData = useCallback(async (silent = false) => {
    setError(null);
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      setError('Please log in again.');
      setLoading(false);
      return;
    }
    if (!silent) setLoading(true);
    try {
      const res = await fetch('/api/stats', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'Failed to load stats');
        setStats(null);
        return;
      }
      // Backend sends camelCase: capital, crossExchangeMode, binanceBalance (Total Capital = base + mainEquity + binanceBalance when cross-exchange)
      console.log('Dashboard Stats Data:', data);
      const crossExchangeMode = data.crossExchangeMode === true || data.cross_exchange_mode === true;
      const binanceBalanceNum = Number(data.binanceBalance ?? data.binance_balance ?? 0) || 0;
      const capitalNum = Number(data.capital ?? 0) || 0;
      setStats({
        capital: capitalNum,
        opening: Number(data.opening ?? data.opening_balance) ?? 0,
        marginUsed: Number(data.marginUsed ?? data.margin_used) ?? 0,
        available: Number(data.available) ?? 0,
        todayProfit: Number(data.todayProfit) ?? 0,
        todayProfitPct: Number(data.todayProfitPct) ?? 0,
        dailyRoi: Number(data.dailyRoi) ?? 0,
        mainEquity: Number(data.mainEquity) ?? 0,
        subEquity: Number(data.subEquity) ?? 0,
        binanceBalance: binanceBalanceNum,
        crossExchangeMode,
      });
    } catch {
      setError('Network error');
      setStats(null);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboardData();
    const interval = setInterval(() => fetchDashboardData(true), 3000);
    return () => clearInterval(interval);
  }, [fetchDashboardData]);

  useEffect(() => {
    const handler = () => fetchDashboardData();
    window.addEventListener(TRANSACTIONS_UPDATED_EVENT, handler);
    return () => window.removeEventListener(TRANSACTIONS_UPDATED_EVENT, handler);
  }, [fetchDashboardData]);

  const todayProfitStyle = stats
    ? stats.todayProfit >= 0
      ? { color: '#22c55e' }
      : { color: '#ef4444' }
    : undefined;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">Dashboard</h1>
          <p className="text-gray-400 text-sm mt-1">Capital, performance & closed trades</p>
        </div>
        <button
          type="button"
          onClick={() => fetchDashboardData()}
          disabled={loading}
          className="rounded-lg px-4 py-2 font-medium text-white border border-[#007BFF] transition hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[#007BFF] disabled:opacity-50"
          style={{ backgroundColor: '#007BFF' }}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
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

      {/* Top section: two cards */}
      <div className="grid gap-4 sm:grid-cols-1 md:grid-cols-2">
        {/* Card 1: Capital */}
        <div className="rounded-xl border p-6 backdrop-blur-sm" style={cardStyle}>
          <h2 className="text-sm font-medium text-gray-400 mb-3">Capital</h2>
          {loading && !stats ? (
            <div className="flex items-center justify-center py-8">
              <div
                className="h-8 w-8 animate-spin rounded-full border-2 border-t-transparent"
                style={{ borderColor: '#007BFF', borderTopColor: 'transparent' }}
              />
            </div>
          ) : stats ? (
            <div className="space-y-3">
              <div>
                <p className="text-2xl font-bold tracking-tight" style={{ color: '#007BFF' }}>
                  {formatUsd(stats.capital)}
                </p>
                <span className="text-sm text-gray-400">
                  ≈ ₹{(stats.capital * inrRate).toLocaleString('en-IN')}
                </span>
              </div>
              <div className="flex flex-wrap gap-4 text-sm">
                {stats.crossExchangeMode === true ? (
                  <>
                    <div>
                      <p className="text-gray-500">Bybit Main (UFA)</p>
                      <p className="font-medium text-white">{formatUsd(stats.mainEquity ?? 0)}</p>
                    </div>
                    <div>
                      <p className="text-gray-500">Binance</p>
                      <p className="font-medium text-white">{formatUsd(stats.binanceBalance ?? 0)}</p>
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <p className="text-gray-500">Main</p>
                      <p className="font-medium text-white">{formatUsd(stats.mainEquity ?? 0)}</p>
                    </div>
                    <div>
                      <p className="text-gray-500">Sub</p>
                      <p className="font-medium text-white">{formatUsd(stats.subEquity ?? 0)}</p>
                    </div>
                  </>
                )}
              </div>
              <div>
                <p className="text-xs text-gray-500">Opening Balance (today)</p>
                <p className="font-medium text-white">{formatUsd(stats.opening)}</p>
              </div>
              <div className="flex flex-wrap gap-4 text-sm">
                <div>
                  <p className="text-gray-500">Margin Used</p>
                  <p className="font-medium text-white">{formatUsd(stats.marginUsed)}</p>
                </div>
                <div>
                  <p className="text-gray-500">Available</p>
                  <p className="font-medium text-white">{formatUsd(stats.available)}</p>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-gray-400 py-2">Add API keys in Exchange Setup.</p>
          )}
        </div>

        {/* Card 2: Performance */}
        <div className="rounded-xl border p-6 backdrop-blur-sm" style={cardStyle}>
          <h2 className="text-sm font-medium text-gray-400 mb-3">Performance</h2>
          {loading && !stats ? (
            <div className="flex items-center justify-center py-8">
              <div
                className="h-8 w-8 animate-spin rounded-full border-2 border-t-transparent"
                style={{ borderColor: '#007BFF', borderTopColor: 'transparent' }}
              />
            </div>
          ) : stats ? (
            <div className="space-y-3">
              <div>
                <p className="text-xs text-gray-500">Today&apos;s Profit</p>
                <p className="text-2xl font-bold" style={todayProfitStyle}>
                  {stats.todayProfit >= 0 ? '+' : ''}{formatUsd(stats.todayProfit)}
                </p>
                <span className="text-sm text-gray-400">
                  ≈ ₹{(stats.todayProfit * inrRate).toLocaleString('en-IN')}
                </span>
              </div>
              <div>
                <p className="text-xs text-gray-500">Profit %</p>
                <p className="text-lg font-semibold" style={todayProfitStyle}>
                  {formatPct(stats.todayProfitPct)}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Daily ROI %</p>
                <p className="text-lg font-semibold text-white">{formatPct(stats.dailyRoi)}</p>
              </div>
            </div>
          ) : (
            <p className="text-gray-400 py-2">Add API keys to see performance.</p>
          )}
        </div>
      </div>

      <ActivePositions />

      {/* Next To Trade panel commented out while core logic is fixed
      <NextToTrade crossExchangeMode={stats?.crossExchangeMode === true} />
      */}

      <ClosedTradesTable />
    </div>
  );
}
