import { useState, useEffect, useCallback } from 'react';

const TOKEN_KEY = 'hft_token';

interface BalanceData {
  totalEquity: string;
  totalAvailableBalance: string;
  totalPerpUPL: string;
  coins: Array<{
    coin: string;
    equity: string;
    usdValue: string;
    walletBalance: string;
  }>;
}

function formatUsd(value: string): string {
  const n = parseFloat(value);
  if (Number.isNaN(n)) return '0.00';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function Dashboard() {
  const [balance, setBalance] = useState<BalanceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchBalance = useCallback(async () => {
    setError(null);
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      setError('Please log in again.');
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/exchange/balance', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'Failed to load balance');
        setBalance(null);
        return;
      }
      setBalance({
        totalEquity: data.totalEquity ?? '0',
        totalAvailableBalance: data.totalAvailableBalance ?? '0',
        totalPerpUPL: data.totalPerpUPL ?? '0',
        coins: data.coins ?? [],
      });
    } catch {
      setError('Network error');
      setBalance(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);

  const upl = balance ? parseFloat(balance.totalPerpUPL) : 0;
  const uplIsProfit = upl >= 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">Dashboard</h1>
          <p className="text-gray-400 text-sm mt-1">Live balance from Bybit</p>
        </div>
        <button
          type="button"
          onClick={() => fetchBalance()}
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

      <div
        className="rounded-xl border p-6 backdrop-blur-sm"
        style={{
          backgroundColor: 'rgba(255, 255, 255, 0.04)',
          borderColor: 'rgba(0, 123, 255, 0.3)',
        }}
      >
        {loading && !balance ? (
          <div className="flex items-center justify-center py-12">
            <div
              className="h-10 w-10 animate-spin rounded-full border-2 border-t-transparent"
              style={{ borderColor: '#007BFF', borderTopColor: 'transparent' }}
            />
          </div>
        ) : balance ? (
          <div className="grid gap-6 sm:grid-cols-1 md:grid-cols-3">
            <div className="md:col-span-2">
              <p className="text-sm font-medium text-gray-400 mb-1">Total Equity (USDT)</p>
              <p className="text-4xl font-bold tracking-tight" style={{ color: '#007BFF' }}>
                {formatUsd(balance.totalEquity)}
              </p>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-400 mb-1">Available Balance</p>
              <p className="text-xl font-semibold text-white">
                {formatUsd(balance.totalAvailableBalance)}
              </p>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-400 mb-1">Unrealized P&L</p>
              <p
                className={`text-xl font-semibold ${uplIsProfit ? 'text-green-500' : 'text-red-500'}`}
              >
                {uplIsProfit ? '+' : ''}{formatUsd(balance.totalPerpUPL)}
              </p>
            </div>
          </div>
        ) : !error ? (
          <p className="text-gray-400 py-4">No balance data. Add API keys in Exchange Setup.</p>
        ) : null}
      </div>
    </div>
  );
}
