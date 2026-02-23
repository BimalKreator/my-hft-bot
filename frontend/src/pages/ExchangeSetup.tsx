import { useState, useEffect } from 'react';

const TOKEN_KEY = 'hft_token';

export default function ExchangeSetup() {
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [subApiKey, setSubApiKey] = useState('');
  const [subApiSecret, setSubApiSecret] = useState('');
  const [binanceApiKey, setBinanceApiKey] = useState('');
  const [binanceApiSecret, setBinanceApiSecret] = useState('');
  const [loading, setLoading] = useState(false);
  const [binanceLoading, setBinanceLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [binanceSuccess, setBinanceSuccess] = useState(false);
  const [binanceError, setBinanceError] = useState('');

  useEffect(() => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;
    fetch('/api/settings', { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && typeof data.binanceApiKey === 'string') {
          setBinanceApiKey(data.binanceApiKey);
        }
      })
      .catch(() => {});
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess(false);
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      setError('Please log in again.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/exchange/add', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          exchange: 'Bybit',
          apiKey,
          apiSecret,
          ...(subApiKey.trim() && subApiSecret.trim() ? { subApiKey: subApiKey.trim(), subApiSecret: subApiSecret.trim() } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'Failed to save keys');
        return;
      }
      setSuccess(true);
      setApiKey('');
      setApiSecret('');
      setSubApiKey('');
      setSubApiSecret('');
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }

  async function handleBinanceSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBinanceError('');
    setBinanceSuccess(false);
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      setBinanceError('Please log in again.');
      return;
    }
    setBinanceLoading(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          binanceApiKey: binanceApiKey.trim() || undefined,
          binanceApiSecret: binanceApiSecret ? binanceApiSecret.trim() : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setBinanceError(data.error ?? 'Failed to save Binance keys');
        return;
      }
      setBinanceSuccess(true);
      if (binanceApiSecret) setBinanceApiSecret('');
      setTimeout(() => setBinanceSuccess(false), 3000);
    } catch {
      setBinanceError('Network error');
    } finally {
      setBinanceLoading(false);
    }
  }

  return (
    <div className="space-y-6 max-w-xl">
      <h1 className="text-2xl font-semibold text-white">Exchange Setup</h1>
      <p className="text-gray-400">
        Add your Bybit API key and secret. They are stored encrypted.
      </p>

      {success && (
        <div
          className="rounded-lg border px-4 py-3 text-sm text-green-400"
          style={{
            backgroundColor: 'rgba(34, 197, 94, 0.1)',
            borderColor: 'rgba(34, 197, 94, 0.3)',
          }}
        >
          Keys saved successfully.
        </div>
      )}
      {error && (
        <div
          className="rounded-lg border px-4 py-3 text-sm text-red-400"
          style={{
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            borderColor: 'rgba(239, 68, 68, 0.3)',
          }}
        >
          {error}
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="rounded-xl border p-6 space-y-5"
        style={{
          backgroundColor: 'rgba(255, 255, 255, 0.04)',
          borderColor: 'rgba(0, 123, 255, 0.3)',
        }}
      >
        <div>
          <label
            htmlFor="exchange"
            className="block text-sm font-medium text-gray-300 mb-2"
          >
            Exchange Name
          </label>
          <input
            id="exchange"
            type="text"
            value="Bybit"
            disabled
            className="w-full rounded-lg border bg-black/40 px-4 py-3 text-gray-400 cursor-not-allowed border-[#007BFF]/30 focus:outline-none"
          />
        </div>

        <div>
          <label
            htmlFor="apiKey"
            className="block text-sm font-medium text-gray-300 mb-2"
          >
            API Key
          </label>
          <input
            id="apiKey"
            type="text"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            required
            className="w-full rounded-lg border bg-black/40 px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-[#007BFF] border-[#007BFF]/30"
            placeholder="Your API key"
          />
        </div>

        <div>
          <label
            htmlFor="apiSecret"
            className="block text-sm font-medium text-gray-300 mb-2"
          >
            API Secret
          </label>
          <input
            id="apiSecret"
            type="password"
            value={apiSecret}
            onChange={(e) => setApiSecret(e.target.value)}
            required
            className="w-full rounded-lg border bg-black/40 px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-[#007BFF] border-[#007BFF]/30"
            placeholder="Your API secret"
          />
        </div>

        <h3 className="text-base font-semibold text-white mt-6 mb-3 pt-2 border-t border-white/10">
          Subaccount API Keys (optional)
        </h3>
        <p className="text-sm text-gray-500 mb-3">
          For sub-account hedging: enter the sub-account API key and secret. Leave blank to only save main account keys.
        </p>
        <div>
          <label
            htmlFor="subApiKey"
            className="block text-sm font-medium text-gray-300 mb-2"
          >
            Subaccount API Key
          </label>
          <input
            id="subApiKey"
            type="text"
            value={subApiKey}
            onChange={(e) => setSubApiKey(e.target.value)}
            className="w-full rounded-lg border bg-black/40 px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-[#007BFF] border-[#007BFF]/30"
            placeholder="Subaccount API key (optional)"
          />
        </div>
        <div>
          <label
            htmlFor="subApiSecret"
            className="block text-sm font-medium text-gray-300 mb-2"
          >
            Subaccount API Secret
          </label>
          <input
            id="subApiSecret"
            type="password"
            value={subApiSecret}
            onChange={(e) => setSubApiSecret(e.target.value)}
            className="w-full rounded-lg border bg-black/40 px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-[#007BFF] border-[#007BFF]/30"
            placeholder="Subaccount API secret (optional)"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg py-3 font-medium text-white transition hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[#007BFF] focus:ring-offset-2 focus:ring-offset-black disabled:opacity-50 border border-[#007BFF]"
          style={{ backgroundColor: '#007BFF' }}
        >
          {loading ? 'Saving…' : 'Save keys'}
        </button>
      </form>

      <div
        className="rounded-xl border p-6 space-y-5 mt-8"
        style={{
          backgroundColor: 'rgba(255, 255, 255, 0.04)',
          borderColor: 'rgba(245, 158, 11, 0.4)',
        }}
      >
        <h2 className="text-lg font-semibold text-white">Binance Futures API</h2>
        <p className="text-sm text-gray-400">
          For cross-exchange mode (Bybit + Binance). API key and secret are stored encrypted.
        </p>
        {binanceSuccess && (
          <div
            className="rounded-lg border px-4 py-3 text-sm text-green-400"
            style={{
              backgroundColor: 'rgba(34, 197, 94, 0.1)',
              borderColor: 'rgba(34, 197, 94, 0.3)',
            }}
          >
            Binance keys saved successfully.
          </div>
        )}
        {binanceError && (
          <div
            className="rounded-lg border px-4 py-3 text-sm text-red-400"
            style={{
              backgroundColor: 'rgba(239, 68, 68, 0.1)',
              borderColor: 'rgba(239, 68, 68, 0.3)',
            }}
          >
            {binanceError}
          </div>
        )}
        <form onSubmit={handleBinanceSubmit} className="space-y-5">
          <div>
            <label htmlFor="binanceApiKey" className="block text-sm font-medium text-gray-300 mb-2">
              Binance API Key
            </label>
            <input
              id="binanceApiKey"
              type="text"
              value={binanceApiKey}
              onChange={(e) => setBinanceApiKey(e.target.value)}
              className="w-full rounded-lg border bg-black/40 px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-amber-500 border-amber-500/30"
              placeholder="Binance Futures API key"
            />
          </div>
          <div>
            <label htmlFor="binanceApiSecret" className="block text-sm font-medium text-gray-300 mb-2">
              Binance API Secret
            </label>
            <input
              id="binanceApiSecret"
              type="password"
              value={binanceApiSecret}
              onChange={(e) => setBinanceApiSecret(e.target.value)}
              className="w-full rounded-lg border bg-black/40 px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-amber-500 border-amber-500/30"
              placeholder="Leave blank to keep existing secret"
            />
          </div>
          <button
            type="submit"
            disabled={binanceLoading}
            className="w-full rounded-lg py-3 font-medium text-white transition hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 focus:ring-offset-black disabled:opacity-50 border border-amber-500/50"
            style={{ backgroundColor: 'rgba(245, 158, 11, 0.2)' }}
          >
            {binanceLoading ? 'Saving…' : 'Save Binance keys'}
          </button>
        </form>
      </div>
    </div>
  );
}
