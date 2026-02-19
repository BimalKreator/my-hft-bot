import { useState } from 'react';

const TOKEN_KEY = 'hft_token';

export default function ExchangeSetup() {
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

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
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
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

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg py-3 font-medium text-white transition hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[#007BFF] focus:ring-offset-2 focus:ring-offset-black disabled:opacity-50 border border-[#007BFF]"
          style={{ backgroundColor: '#007BFF' }}
        >
          {loading ? 'Saving…' : 'Save keys'}
        </button>
      </form>
    </div>
  );
}
