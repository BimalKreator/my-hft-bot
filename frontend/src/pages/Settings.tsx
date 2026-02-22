import { useState, useEffect, useCallback, useRef } from 'react';

const TOKEN_KEY = 'hft_token';

/** Emitted after add/delete transaction so Dashboard can refetch stats. */
export const TRANSACTIONS_UPDATED_EVENT = 'dashboard-transactions-updated';

interface TransactionRow {
  id: number;
  date: string;
  type: string;
  amount: string;
  note: string | null;
}

interface BotSettings {
  userId: number;
  autoEntryEnabled: boolean;
  autoExitEnabled: boolean;
  capitalPercent: number;
  maxTrades: number;
  entryOffsetMs: number;
  exitTimeMs: number;
  leverage: number;
  orderBookDepth: number;
  hedgeTargetPct: number;
  hedgeStoplossPct: number;
  hedgePnlDepth: number;
  subEntryOffsetMs: number;
  universalStoplossPercent: number;
  hedgeMode: boolean;
  slippageBufferPct: number;
  autoEqualizeFunds: boolean;
}

const defaultSettings: Omit<BotSettings, 'userId'> = {
  autoEntryEnabled: false,
  autoExitEnabled: false,
  capitalPercent: 10,
  maxTrades: 5,
  entryOffsetMs: 300000,
  exitTimeMs: 3600000,
  leverage: 5,
  orderBookDepth: 2,
  hedgeTargetPct: 2,
  hedgeStoplossPct: 5,
  hedgePnlDepth: 1,
  subEntryOffsetMs: 10,
  universalStoplossPercent: 3,
  hedgeMode: true,
  slippageBufferPct: 2,
  autoEqualizeFunds: false,
};

export default function Settings() {
  const [settings, setSettings] = useState<BotSettings | null>({ userId: 0, ...defaultSettings });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Deposit & Withdrawal state
  const [txDate, setTxDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [txType, setTxType] = useState<'DEPOSIT' | 'WITHDRAWAL'>('DEPOSIT');
  const [txAmount, setTxAmount] = useState('');
  const [txNote, setTxNote] = useState('');
  const [transactions, setTransactions] = useState<TransactionRow[]>([]);
  const [txLoading, setTxLoading] = useState(false);
  const [txListLoading, setTxListLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [mockTriggerLoading, setMockTriggerLoading] = useState(false);
  const [mockCancelLoading, setMockCancelLoading] = useState(false);
  const [transferAmount, setTransferAmount] = useState('');
  const [transferLoading, setTransferLoading] = useState(false);

  const fetchSettings = useCallback(async () => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      setError('Please log in again.');
      setLoading(false);
      return;
    }
    setError(null);
    try {
      const res = await fetch('/api/settings', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'Failed to load settings. Edit below and click Save.');
        setSettings((prev) => ({ userId: prev?.userId ?? 0, ...defaultSettings }));
        return;
      }
      setSettings({
        userId: data.userId ?? 0,
        autoEntryEnabled: data.autoEntryEnabled ?? false,
        autoExitEnabled: data.autoExitEnabled ?? false,
        capitalPercent: Number(data.capitalPercent) ?? 10,
        maxTrades: Number(data.maxTrades) ?? 5,
        entryOffsetMs: Number(data.entryOffsetMs ?? data.entry_offset_ms) ?? 300000,
        exitTimeMs: Number(data.exitTimeMs) ?? 3600000,
        leverage: Number(data.leverage) ?? 5,
        orderBookDepth: Math.max(1, Math.min(50, Number(data.orderBookDepth) || 2)),
        hedgeTargetPct: Number(data.hedgeTargetPct) ?? 2,
        hedgeStoplossPct: Number(data.hedgeStoplossPct) ?? 5,
        hedgePnlDepth: Math.max(1, Math.min(50, Number(data.hedgePnlDepth) || 1)),
        subEntryOffsetMs: Number(data.subEntryOffsetMs ?? data.sub_entry_offset_ms) ?? 10,
        universalStoplossPercent: Number(data.universalStoplossPercent ?? data.universal_stoploss_percent) ?? 3,
        hedgeMode: data.hedgeMode ?? data.hedge_mode ?? true,
        slippageBufferPct: Number(data.slippageBufferPct ?? data.slippage_buffer_pct) ?? 2,
        autoEqualizeFunds: Boolean(data.autoEqualizeFunds ?? data.auto_equalize_funds ?? false),
      });
    } catch {
      setError('Network error. Edit below and click Save to retry.');
      setSettings((prev) => ({ userId: prev?.userId ?? 0, ...defaultSettings }));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const saveSettings = useCallback(
    async (patch: Partial<Omit<BotSettings, 'userId'>>) => {
      const token = localStorage.getItem(TOKEN_KEY);
      if (!token || !settings) return;
      setSaving(true);
      setError(null);
      setSuccessMessage(null);
      try {
        const res = await fetch('/api/settings', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(patch),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data.error ?? 'Failed to save settings');
          return;
        }
        setSettings({
          userId: data.userId ?? settings.userId,
          autoEntryEnabled: data.autoEntryEnabled ?? settings.autoEntryEnabled,
          autoExitEnabled: data.autoExitEnabled ?? settings.autoExitEnabled,
          capitalPercent: Number(data.capitalPercent) ?? settings.capitalPercent,
          maxTrades: Number(data.maxTrades) ?? settings.maxTrades,
          entryOffsetMs: Number(data.entryOffsetMs ?? data.entry_offset_ms) ?? settings.entryOffsetMs,
          exitTimeMs: Number(data.exitTimeMs) ?? settings.exitTimeMs,
          leverage: Number(data.leverage) ?? settings.leverage,
          orderBookDepth: Number(data.orderBookDepth) ?? settings.orderBookDepth,
          hedgeTargetPct: Number(data.hedgeTargetPct) ?? settings.hedgeTargetPct,
          hedgeStoplossPct: Number(data.hedgeStoplossPct) ?? settings.hedgeStoplossPct,
          hedgePnlDepth: Number(data.hedgePnlDepth) ?? settings.hedgePnlDepth,
          subEntryOffsetMs: Number(data.subEntryOffsetMs ?? data.sub_entry_offset_ms) ?? settings.subEntryOffsetMs,
          universalStoplossPercent: Number(data.universalStoplossPercent ?? data.universal_stoploss_percent) ?? settings.universalStoplossPercent,
          hedgeMode: data.hedgeMode ?? data.hedge_mode ?? settings.hedgeMode,
          slippageBufferPct: Number(data.slippageBufferPct ?? data.slippage_buffer_pct) ?? settings.slippageBufferPct,
          autoEqualizeFunds: Boolean(data.autoEqualizeFunds ?? data.auto_equalize_funds ?? settings.autoEqualizeFunds),
        });
        setSuccessMessage('Success — bot updated.');
        setTimeout(() => setSuccessMessage(null), 3000);
      } catch {
        setError('Network error');
      } finally {
        setSaving(false);
      }
    },
    [settings]
  );

  const handleSaveAll = useCallback(() => {
    if (!settings) return;
    saveSettings({
      autoEntryEnabled: Boolean(settings.autoEntryEnabled),
      autoExitEnabled: Boolean(settings.autoExitEnabled),
      capitalPercent: Number(settings.capitalPercent),
      maxTrades: Number(settings.maxTrades),
      entryOffsetMs: Math.round(Number(settings.entryOffsetMs)),
      exitTimeMs: Number(settings.exitTimeMs),
      leverage: Number(settings.leverage),
      orderBookDepth: Math.max(1, Math.min(50, Number(settings.orderBookDepth) || 2)),
      hedgeTargetPct: Number(settings.hedgeTargetPct) ?? 2,
      hedgeStoplossPct: Number(settings.hedgeStoplossPct) ?? 5,
      hedgePnlDepth: Math.max(1, Math.min(50, Number(settings.hedgePnlDepth) || 1)),
      subEntryOffsetMs: Math.round(Number(settings.subEntryOffsetMs) ?? 10),
      universalStoplossPercent: Math.max(0, Number(settings.universalStoplossPercent) ?? 3),
      hedgeMode: Boolean(settings.hedgeMode),
      slippageBufferPct: Math.max(0, Number(settings.slippageBufferPct) ?? 2),
      autoEqualizeFunds: Boolean(settings.hedgeMode && settings.autoEqualizeFunds),
    });
  }, [settings, saveSettings]);

  const debouncedSave = useCallback(
    (patch: Partial<Omit<BotSettings, 'userId'>>) => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => saveSettings(patch), 500);
    },
    [saveSettings]
  );

  const toggleAutoEntry = () => {
    if (!settings) return;
    const next = !settings.autoEntryEnabled;
    setSettings((s) => (s ? { ...s, autoEntryEnabled: next } : s));
    saveSettings({ autoEntryEnabled: next });
  };

  const toggleAutoExit = () => {
    if (!settings) return;
    const next = !settings.autoExitEnabled;
    setSettings((s) => (s ? { ...s, autoExitEnabled: next } : s));
    saveSettings({ autoExitEnabled: next });
  };

  const toggleHedgeMode = () => {
    if (!settings) return;
    const next = !settings.hedgeMode;
    setSettings((s) => (s ? { ...s, hedgeMode: next, ...(next ? {} : { autoEqualizeFunds: false }) } : s));
    saveSettings({ hedgeMode: next, ...(next ? {} : { autoEqualizeFunds: false }) });
  };

  const handleTransfer = useCallback(
    async (direction: 'main_to_sub' | 'sub_to_main') => {
      const token = localStorage.getItem(TOKEN_KEY);
      if (!token) return;
      const amount = parseFloat(transferAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        setError('Enter a valid positive amount (USDT).');
        return;
      }
      setTransferLoading(true);
      setError(null);
      try {
        const res = await fetch('/api/settings/transfer-funds', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ direction, amount }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data.error ?? 'Transfer failed');
          return;
        }
        setSuccessMessage(`Transferred ${amount} USDT ${direction === 'main_to_sub' ? 'Main → Sub' : 'Sub → Main'}.`);
        setTimeout(() => setSuccessMessage(null), 3000);
        setTransferAmount('');
      } catch {
        setError('Network error');
      } finally {
        setTransferLoading(false);
      }
    },
    [transferAmount]
  );

  const toggleAutoEqualize = () => {
    if (!settings || !settings.hedgeMode) return;
    const next = !settings.autoEqualizeFunds;
    setSettings((s) => (s ? { ...s, autoEqualizeFunds: next } : s));
    debouncedSave({ autoEqualizeFunds: next });
  };

  const fetchTransactions = useCallback(async () => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;
    setTxListLoading(true);
    try {
      const res = await fetch('/api/transactions', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json().catch(() => []);
      if (res.ok) setTransactions(Array.isArray(data) ? data : []);
    } catch {
      // Do not clear list on network error so optimistic updates after add are preserved
    } finally {
      setTxListLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTransactions();
  }, [fetchTransactions]);

  const handleAddTransaction = useCallback(async () => {
    setError(null);
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      setError('Please log in again.');
      return;
    }
    const trimmedAmount = String(txAmount).trim();
    const amountNum = parseFloat(trimmedAmount);
    if (trimmedAmount === '' || Number.isNaN(amountNum) || amountNum <= 0) {
      setError('Please enter a valid amount greater than 0.');
      return;
    }
    setTxLoading(true);
    try {
      const res = await fetch('/api/transactions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          transaction_date: txDate,
          type: txType,
          amount: amountNum,
          note: txNote.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Failed to add');
      setTxAmount('');
      setTxNote('');
      const newRow: TransactionRow = {
        id: data.id ?? 0,
        date: data.date ?? txDate,
        type: data.type ?? txType,
        amount: String(data.amount ?? amountNum),
        note: (data.note ?? txNote.trim()) || null,
      };
      setTransactions((prev) => [newRow, ...prev]);
      window.dispatchEvent(new CustomEvent(TRANSACTIONS_UPDATED_EVENT));
      setSuccessMessage(txType === 'DEPOSIT' ? 'Deposit added. Balance impact reflected in today\'s profit.' : 'Withdrawal added. Balance impact reflected in today\'s profit.');
      setTimeout(() => setSuccessMessage(null), 4000);
      fetchTransactions().catch(() => { /* keep optimistic list on refetch failure */ });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add entry');
    } finally {
      setTxLoading(false);
    }
  }, [txDate, txType, txAmount, txNote, fetchTransactions]);

  const handleDeleteTransaction = useCallback(
    async (id: number) => {
      const token = localStorage.getItem(TOKEN_KEY);
      if (!token) return;
      setDeletingId(id);
      try {
        const res = await fetch(`/api/transactions/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? 'Delete failed');
        }
        await fetchTransactions();
        window.dispatchEvent(new CustomEvent(TRANSACTIONS_UPDATED_EVENT));
        setSuccessMessage('Entry deleted. Today\'s profit will update on Dashboard.');
        setTimeout(() => setSuccessMessage(null), 4000);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to delete');
      } finally {
        setDeletingId(null);
      }
    },
    [fetchTransactions]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div
          className="h-10 w-10 animate-spin rounded-full border-2 border-t-transparent"
          style={{ borderColor: '#007BFF', borderTopColor: 'transparent' }}
        />
      </div>
    );
  }

  if (!settings) return null;

  return (
    <div className="space-y-6 max-w-xl">
      <h1 className="text-2xl font-semibold text-white">Settings</h1>

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

      {successMessage && (
        <div
          className="rounded-lg border px-3 py-2 text-sm text-green-400 inline-flex items-center gap-2"
          style={{
            backgroundColor: 'rgba(34, 197, 94, 0.12)',
            borderColor: 'rgba(34, 197, 94, 0.35)',
            boxShadow: '0 0 10px rgba(34, 197, 94, 0.2)',
          }}
          role="status"
          aria-live="polite"
        >
          <span className="font-medium">{successMessage}</span>
        </div>
      )}

      <section
        className="rounded-2xl border p-6"
        style={{
          backgroundColor: 'rgba(255, 255, 255, 0.04)',
          borderColor: 'rgba(0, 123, 255, 0.4)',
          boxShadow: '0 0 24px rgba(0, 123, 255, 0.1)',
        }}
      >
        <h2 className="text-lg font-semibold text-white mb-5 flex items-center gap-2">
          <span aria-hidden>⚙</span> AUTO ENTRY SETTINGS
        </h2>

        <div className="space-y-5">
          {/* Auto Entry Toggle */}
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-gray-300">Auto Entry</label>
            <button
              type="button"
              role="switch"
              aria-checked={settings.autoEntryEnabled}
              onClick={toggleAutoEntry}
              className={`relative h-8 w-14 rounded-full transition-colors ${
                settings.autoEntryEnabled ? 'bg-[#007BFF]' : 'bg-gray-600'
              }`}
              style={
                settings.autoEntryEnabled
                  ? { boxShadow: '0 0 16px rgba(0, 123, 255, 0.5)' }
                  : undefined
              }
            >
              <span
                className={`absolute top-1 h-6 w-6 rounded-full bg-white transition-transform ${
                  settings.autoEntryEnabled ? 'left-7' : 'left-1'
                }`}
              />
            </button>
          </div>

          {/* Capital % Per Trade */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Capital % Per Trade
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={100}
                step={0.5}
                value={settings.capitalPercent}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (!Number.isNaN(v)) {
                    setSettings((s) => s ? { ...s, capitalPercent: v } : s);
                    debouncedSave({ capitalPercent: Number(v) });
                  }
                }}
                className="w-full rounded-lg border bg-black/50 px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-[#007BFF]"
                style={{ borderColor: 'rgba(0, 123, 255, 0.3)' }}
              />
              <span className="text-gray-400 font-medium">%</span>
            </div>
          </div>

          {/* Leverage (x) */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Leverage (x)
            </label>
            <input
              type="number"
              min={1}
              max={50}
              step={1}
              value={settings.leverage}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!Number.isNaN(v)) {
                  setSettings((s) => s ? { ...s, leverage: v } : s);
                  debouncedSave({ leverage: Number(v) });
                }
              }}
              className="w-full rounded-lg border bg-black/50 px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-[#007BFF]"
              style={{ borderColor: 'rgba(0, 123, 255, 0.3)' }}
              placeholder="e.g. 5"
            />
          </div>

          {/* Max Concurrent Trades */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Max Concurrent Trades
            </label>
            <input
              type="number"
              min={1}
              max={50}
              step={1}
              value={settings.maxTrades}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!Number.isNaN(v)) {
                  setSettings((s) => s ? { ...s, maxTrades: v } : s);
                  debouncedSave({ maxTrades: Number(v) });
                }
              }}
              className="w-full rounded-lg border bg-black/50 px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-[#007BFF]"
              style={{ borderColor: 'rgba(0, 123, 255, 0.3)' }}
            />
          </div>

          {/* Order Book Depth Level */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Order Book Depth Level
            </label>
            <input
              type="number"
              min={1}
              max={50}
              step={1}
              value={settings.orderBookDepth}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!Number.isNaN(v)) {
                  const clamped = Math.max(1, Math.min(50, v));
                  setSettings((s) => s ? { ...s, orderBookDepth: clamped } : s);
                  debouncedSave({ orderBookDepth: clamped });
                }
              }}
              className="w-full rounded-lg border bg-black/50 px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-[#007BFF]"
              style={{ borderColor: 'rgba(0, 123, 255, 0.3)' }}
              placeholder="e.g. 2"
            />
          </div>

          {/* Entry Time Offset (Milliseconds) — positive = before funding, negative = after */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Entry Time Offset (Milliseconds)
            </label>
            <input
              type="number"
              step={1}
              value={settings.entryOffsetMs}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!Number.isNaN(v)) {
                  setSettings((s) => s ? { ...s, entryOffsetMs: v } : s);
                  debouncedSave({ entryOffsetMs: v });
                }
              }}
              className="w-full rounded-lg border bg-black/50 px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-[#007BFF]"
              style={{ borderColor: 'rgba(0, 123, 255, 0.3)' }}
              placeholder="e.g. 500 = 0.5s before funding, -50 = 50ms after"
            />
            <p className="text-xs text-gray-500 mt-1">Ms before funding to place entry (positive = before, negative = after, e.g. -50)</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">Entry Slippage Buffer (%)</label>
            <input
              type="number"
              step={0.1}
              min={0}
              value={settings.slippageBufferPct}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (!Number.isNaN(v) && v >= 0) {
                  setSettings((s) => s ? { ...s, slippageBufferPct: v } : s);
                  debouncedSave({ slippageBufferPct: v });
                }
              }}
              className="w-full rounded-lg border bg-black/50 px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-[#007BFF]"
              style={{ borderColor: 'rgba(0, 123, 255, 0.3)' }}
              placeholder="e.g. 2"
            />
            <p className="text-xs text-gray-500 mt-1">Slippage buffer for entry limit orders (Long: price × (1 + pct/100), Short: price × (1 − pct/100)). Default: 2</p>
          </div>

          {/* Subaccount Hedging */}
          <div className="space-y-4">
            <h3 className="text-base font-semibold text-white mt-6 mb-2">Subaccount Hedging</h3>
            <p className="text-xs text-gray-500">Sub-account API keys are configured in Exchange Setup.</p>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Sub-Account Entry Offset (ms)</label>
              <input
                type="number"
                step={1}
                value={settings.subEntryOffsetMs}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!Number.isNaN(v)) {
                    setSettings((s) => (s ? { ...s, subEntryOffsetMs: v } : s));
                    debouncedSave({ subEntryOffsetMs: v });
                  }
                }}
                className="w-full rounded-lg border bg-black/50 px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-[#007BFF]"
                style={{ borderColor: 'rgba(0, 123, 255, 0.3)' }}
                placeholder="e.g. 10 or -50"
              />
              <p className="text-xs text-gray-500 mt-1">Ms before funding (positive = before, negative = after). Default: 10</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Universal Stoploss (%)</label>
              <input
                type="number"
                min={0}
                step={0.1}
                value={settings.universalStoplossPercent}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (!Number.isNaN(v) && v >= 0) {
                    setSettings((s) => (s ? { ...s, universalStoplossPercent: v } : s));
                    debouncedSave({ universalStoplossPercent: v });
                  }
                }}
                className="w-full rounded-lg border bg-black/50 px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-[#007BFF]"
                style={{ borderColor: 'rgba(0, 123, 255, 0.3)' }}
                placeholder="3"
              />
              <p className="text-xs text-gray-500 mt-1">Combined (main+sub) loss limit as % of total capital. Triggers immediate exit for both accounts even before funding. Default: 3</p>
            </div>
          </div>

          {/* Auto Exit Toggle */}
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-gray-300">Auto Exit</label>
            <button
              type="button"
              role="switch"
              aria-checked={settings.autoExitEnabled}
              onClick={toggleAutoExit}
              className={`relative h-8 w-14 rounded-full transition-colors ${
                settings.autoExitEnabled ? 'bg-[#007BFF]' : 'bg-gray-600'
              }`}
              style={
                settings.autoExitEnabled
                  ? { boxShadow: '0 0 16px rgba(0, 123, 255, 0.5)' }
                  : undefined
              }
            >
              <span
                className={`absolute top-1 h-6 w-6 rounded-full bg-white transition-transform ${
                  settings.autoExitEnabled ? 'left-7' : 'left-1'
                }`}
              />
            </button>
          </div>

          {/* Hedge Mode (Main + Sub) Toggle */}
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-gray-300">Hedge Mode (Main + Sub)</label>
            <button
              type="button"
              role="switch"
              aria-checked={settings.hedgeMode}
              onClick={toggleHedgeMode}
              className={`relative h-8 w-14 rounded-full transition-colors ${
                settings.hedgeMode ? 'bg-[#007BFF]' : 'bg-gray-600'
              }`}
              style={
                settings.hedgeMode
                  ? { boxShadow: '0 0 16px rgba(0, 123, 255, 0.5)' }
                  : undefined
              }
            >
              <span
                className={`absolute top-1 h-6 w-6 rounded-full bg-white transition-transform ${
                  settings.hedgeMode ? 'left-7' : 'left-1'
                }`}
              />
            </button>
          </div>
          <p className="text-xs text-gray-500 -mt-1">On: Main + Sub accounts. Off: Naked (Main only).</p>

          {/* Capital Management */}
          <h3 className="text-base font-semibold text-white mt-6 mb-2">Capital Management</h3>
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Amount (USDT)</label>
              <input
                type="number"
                step={0.01}
                min={0}
                value={transferAmount}
                onChange={(e) => setTransferAmount(e.target.value)}
                placeholder="e.g. 100"
                className="w-full rounded-lg border bg-black/50 px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-[#007BFF]"
                style={{ borderColor: 'rgba(0, 123, 255, 0.3)' }}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => handleTransfer('main_to_sub')}
                disabled={transferLoading || !transferAmount}
                className="rounded-lg px-4 py-2 text-sm font-medium text-white border border-[#007BFF] hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: '#007BFF' }}
              >
                Transfer Main ➔ Sub
              </button>
              <button
                type="button"
                onClick={() => handleTransfer('sub_to_main')}
                disabled={transferLoading || !transferAmount}
                className="rounded-lg px-4 py-2 text-sm font-medium text-white border border-gray-500 hover:opacity-90 disabled:opacity-50 bg-gray-700"
              >
                Transfer Sub ➔ Main
              </button>
            </div>
            <div className="flex items-center justify-between pt-2">
              <label className="text-sm font-medium text-gray-300">Auto Equalize Balances</label>
              <button
                type="button"
                role="switch"
                aria-checked={settings.hedgeMode ? settings.autoEqualizeFunds : false}
                disabled={!settings.hedgeMode}
                onClick={toggleAutoEqualize}
                className={`relative h-8 w-14 rounded-full transition-colors ${
                  settings.hedgeMode && settings.autoEqualizeFunds ? 'bg-[#007BFF]' : 'bg-gray-600'
                } ${!settings.hedgeMode ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <span
                  className={`absolute top-1 h-6 w-6 rounded-full bg-white transition-transform ${
                    settings.hedgeMode && settings.autoEqualizeFunds ? 'left-7' : 'left-1'
                  }`}
                />
              </button>
            </div>
            <p className="text-xs text-gray-500 -mt-1">
              {settings.hedgeMode
                ? 'When no positions, transfer USDT between Main and Sub to equalize. Disabled when Hedge Mode is off.'
                : 'Enable Hedge Mode (Main + Sub) to use Auto Equalize.'}
            </p>
          </div>

        </div>

        {saving && (
          <p className="mt-4 text-sm text-[#007BFF]" style={{ textShadow: '0 0 8px rgba(0,123,255,0.5)' }}>
            Saving…
          </p>
        )}

        <button
          type="button"
          onClick={handleSaveAll}
          disabled={saving}
          className="mt-6 w-full rounded-xl py-3.5 text-base font-semibold text-white transition disabled:opacity-50"
          style={{
            backgroundColor: '#007BFF',
            boxShadow: '0 0 20px rgba(0, 123, 255, 0.3)',
          }}
        >
          Save Settings
        </button>
      </section>

      <section
        className="rounded-2xl border p-6"
        style={{
          backgroundColor: 'rgba(255, 255, 255, 0.04)',
          borderColor: 'rgba(234, 88, 12, 0.4)',
          boxShadow: '0 0 24px rgba(234, 88, 12, 0.1)',
        }}
      >
        <h2 className="text-lg font-semibold text-white mb-5 flex items-center gap-2">
          <span aria-hidden>🛠️</span> Developer Tools
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={mockTriggerLoading}
            onClick={async () => {
              const token = localStorage.getItem(TOKEN_KEY);
              if (!token) {
                setError('Please log in again.');
                return;
              }
              setMockTriggerLoading(true);
              setError(null);
              setSuccessMessage(null);
              try {
                const res = await fetch('/api/settings/trigger-mock', {
                  method: 'POST',
                  headers: { Authorization: `Bearer ${token}` },
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                  setError(data.error ?? 'Failed to trigger mock');
                  return;
                }
                setSuccessMessage('Mock cycle started! Countdown set to 30s');
                setTimeout(() => setSuccessMessage(null), 4000);
              } catch {
                setError('Failed to trigger mock');
              } finally {
                setMockTriggerLoading(false);
              }
            }}
            className="rounded-xl px-4 py-2.5 text-sm font-semibold text-white transition disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-orange-500"
            style={{
              backgroundColor: '#ea580c',
              boxShadow: '0 0 12px rgba(234, 88, 12, 0.4)',
            }}
          >
            {mockTriggerLoading ? 'Triggering…' : '🚀 Trigger 30s Mock Funding'}
          </button>
          <button
            type="button"
            disabled={mockCancelLoading}
            onClick={async () => {
              const token = localStorage.getItem(TOKEN_KEY);
              if (!token) {
                setError('Please log in again.');
                return;
              }
              setMockCancelLoading(true);
              setError(null);
              setSuccessMessage(null);
              try {
                const res = await fetch('/api/settings/cancel-mock', {
                  method: 'POST',
                  headers: { Authorization: `Bearer ${token}` },
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                  setError(data.error ?? 'Failed to cancel mock');
                  return;
                }
                setSuccessMessage('Mock test cancelled, returning to live sync.');
                setTimeout(() => setSuccessMessage(null), 4000);
              } catch {
                setError('Failed to cancel mock');
              } finally {
                setMockCancelLoading(false);
              }
            }}
            className="rounded-xl px-4 py-2.5 text-sm font-semibold text-red-400 transition disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-red-500 border border-red-500/60 hover:bg-red-500/10"
          >
            {mockCancelLoading ? 'Cancelling…' : '🛑 Cancel Mock Test'}
          </button>
        </div>
      </section>

      <section
        className="rounded-2xl border p-6"
        style={{
          backgroundColor: 'rgba(255, 255, 255, 0.04)',
          borderColor: 'rgba(0, 123, 255, 0.4)',
          boxShadow: '0 0 24px rgba(0, 123, 255, 0.1)',
        }}
      >
        <h2 className="text-lg font-semibold text-white mb-5 flex items-center gap-2">
          <span aria-hidden>💰</span> Deposit & Withdrawal Management
        </h2>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Date</label>
            <input
              type="date"
              value={txDate}
              onChange={(e) => setTxDate(e.target.value)}
              className="w-full rounded-lg border bg-black/50 px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-[#007BFF]"
              style={{ borderColor: 'rgba(0, 123, 255, 0.3)' }}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Type</label>
            <select
              value={txType}
              onChange={(e) => setTxType(e.target.value as 'DEPOSIT' | 'WITHDRAWAL')}
              className="w-full rounded-lg border bg-black/50 px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-[#007BFF]"
              style={{ borderColor: 'rgba(0, 123, 255, 0.3)' }}
            >
              <option value="DEPOSIT">Deposit</option>
              <option value="WITHDRAWAL">Withdrawal</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Amount</label>
            <input
              type="number"
              min={0}
              step={0.01}
              value={txAmount}
              onChange={(e) => setTxAmount(e.target.value)}
              placeholder="0.00"
              className="w-full rounded-lg border bg-black/50 px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-[#007BFF]"
              style={{ borderColor: 'rgba(0, 123, 255, 0.3)' }}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Notes</label>
            <input
              type="text"
              value={txNote}
              onChange={(e) => setTxNote(e.target.value)}
              placeholder="Optional"
              className="w-full rounded-lg border bg-black/50 px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-[#007BFF]"
              style={{ borderColor: 'rgba(0, 123, 255, 0.3)' }}
            />
          </div>
        </div>
        <button
          type="button"
          onClick={handleAddTransaction}
          disabled={txLoading || !txAmount || parseFloat(txAmount) <= 0}
          className="rounded-xl px-5 py-2.5 text-sm font-semibold text-white transition disabled:opacity-50"
          style={{
            backgroundColor: '#007BFF',
            boxShadow: '0 0 16px rgba(0, 123, 255, 0.3)',
          }}
        >
          {txLoading ? 'Adding…' : 'Add Entry'}
        </button>

        <h3 className="text-sm font-medium text-gray-400 mt-6 mb-3">Recent transactions</h3>
        {txListLoading ? (
          <div className="flex items-center justify-center py-8">
            <div
              className="h-8 w-8 animate-spin rounded-full border-2 border-t-transparent"
              style={{ borderColor: '#007BFF', borderTopColor: 'transparent' }}
            />
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 bg-black/30">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Amount</th>
                  <th className="px-3 py-2 font-medium">Notes</th>
                  <th className="px-3 py-2 font-medium w-20">Action</th>
                </tr>
              </thead>
              <tbody>
                {transactions.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-gray-500">
                      No transactions yet. Add one above.
                    </td>
                  </tr>
                ) : (
                  transactions.map((tx) => (
                    <tr
                      key={tx.id}
                      className="border-t border-gray-800/80"
                      style={{ borderColor: 'rgba(255,255,255,0.06)' }}
                    >
                      <td className="px-3 py-2 text-white">{tx.date}</td>
                      <td className="px-3 py-2">
                        <span
                          className="inline-block rounded px-2 py-0.5 text-xs font-medium"
                          style={
                            tx.type === 'DEPOSIT'
                              ? { backgroundColor: 'rgba(34, 197, 94, 0.2)', color: '#22c55e' }
                              : { backgroundColor: 'rgba(239, 68, 68, 0.2)', color: '#ef4444' }
                          }
                        >
                          {tx.type}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-gray-300">
                        {Number(tx.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td className="px-3 py-2 text-gray-400">{tx.note ?? '—'}</td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => handleDeleteTransaction(tx.id)}
                          disabled={deletingId === tx.id}
                          className="rounded px-2 py-1 text-xs font-medium text-red-400 hover:bg-red-500/20 disabled:opacity-50"
                        >
                          {deletingId === tx.id ? '…' : 'Delete'}
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
