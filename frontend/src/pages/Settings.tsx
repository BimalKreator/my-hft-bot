import { useState, useEffect, useCallback, useRef } from 'react';

const TOKEN_KEY = 'hft_token';

interface BotSettings {
  userId: number;
  autoEntryEnabled: boolean;
  autoExitEnabled: boolean;
  capitalPercent: number;
  maxTrades: number;
  entryTimeSec: number;
  exitTimeSec: number;
}

const defaultSettings: Omit<BotSettings, 'userId'> = {
  autoEntryEnabled: false,
  autoExitEnabled: false,
  capitalPercent: 10,
  maxTrades: 5,
  entryTimeSec: 300,
  exitTimeSec: 3600,
};

export default function Settings() {
  const [settings, setSettings] = useState<BotSettings | null>({ userId: 0, ...defaultSettings });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        entryTimeSec: Number(data.entryTimeSec) ?? 300,
        exitTimeSec: Number(data.exitTimeSec) ?? 3600,
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
          entryTimeSec: Number(data.entryTimeSec) ?? settings.entryTimeSec,
          exitTimeSec: Number(data.exitTimeSec) ?? settings.exitTimeSec,
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
      entryTimeSec: Number(settings.entryTimeSec),
      exitTimeSec: Number(settings.exitTimeSec),
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

          {/* Entry Time (Seconds) */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Entry Time (Seconds)
            </label>
            <input
              type="number"
              min={1}
              step={1}
              value={settings.entryTimeSec}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!Number.isNaN(v)) {
                  setSettings((s) => s ? { ...s, entryTimeSec: v } : s);
                  debouncedSave({ entryTimeSec: Number(v) });
                }
              }}
              className="w-full rounded-lg border bg-black/50 px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-[#007BFF]"
              style={{ borderColor: 'rgba(0, 123, 255, 0.3)' }}
              placeholder="e.g. 120"
            />
          </div>

          {/* Exit Time (Seconds) */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Exit Time (Seconds)
            </label>
            <input
              type="number"
              min={1}
              step={1}
              value={settings.exitTimeSec}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!Number.isNaN(v)) {
                  setSettings((s) => s ? { ...s, exitTimeSec: v } : s);
                  debouncedSave({ exitTimeSec: Number(v) });
                }
              }}
              className="w-full rounded-lg border bg-black/50 px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-[#007BFF]"
              style={{ borderColor: 'rgba(0, 123, 255, 0.3)' }}
              placeholder="e.g. 20"
            />
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
    </div>
  );
}
