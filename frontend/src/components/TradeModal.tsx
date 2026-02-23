import { useState, useMemo, useCallback, useEffect } from 'react';
import { Check, AlertCircle } from 'lucide-react';

const TOKEN_KEY = 'hft_token';
const TRADING_FEE_RATE = 0.0012; // 0.06% entry + 0.06% exit approx

export interface TokenData {
  symbol: string;
  price: number;
  fundingRate: number;
  direction: 'LONG' | 'SHORT';
}

interface TradeModalProps {
  isOpen: boolean;
  onClose: () => void;
  tokenData: TokenData | null;
}

function tokenName(symbol: string): string {
  if (symbol.endsWith('USDT')) return symbol.slice(0, -4);
  return symbol;
}

function formatPct(value: number): string {
  return (value * 100).toFixed(4) + '%';
}

export default function TradeModal({
  isOpen,
  onClose,
  tokenData,
}: TradeModalProps) {
  const [view, setView] = useState<'form' | 'success' | 'error'>('form');
  const [message, setMessage] = useState('');
  const [mode, setMode] = useState<'manual' | 'auto'>('manual');
  const [leverage, setLeverage] = useState(5);
  const [quantityInput, setQuantityInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availableBalance, setAvailableBalance] = useState<number>(0);
  const [binanceAvailableBalance, setBinanceAvailableBalance] = useState<number | null>(null);
  const [crossExchangeMode, setCrossExchangeMode] = useState(false);
  const [balanceLoading, setBalanceLoading] = useState(false);

  const price = tokenData?.price ?? 0;
  const fundingRate = tokenData?.fundingRate ?? 0;
  const symbol = tokenData?.symbol ?? '';
  const direction = tokenData?.direction ?? (fundingRate < 0 ? 'LONG' : 'SHORT');

  useEffect(() => {
    if (!isOpen) return;
    setView('form');
    setMessage('');
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;
    setBalanceLoading(true);
    fetch('/api/exchange/balance', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => res.json().catch(() => ({})))
      .then((data) => {
        console.log('Trade Modal Balance Data:', data);
        const bal = parseFloat(data?.totalAvailableBalance ?? '0');
        setAvailableBalance(Number.isNaN(bal) ? 0 : bal);
        const isCrossExchange = data?.crossExchangeMode === true || data?.cross_exchange_mode === true;
        setCrossExchangeMode(isCrossExchange);
        if (isCrossExchange) {
          const raw = data?.binanceAvailableBalance ?? data?.binance_available_balance;
          const binanceBal = raw != null ? parseFloat(String(raw)) : 0;
          setBinanceAvailableBalance(Number.isNaN(binanceBal) ? 0 : binanceBal);
        } else {
          setBinanceAvailableBalance(null);
        }
      })
      .finally(() => setBalanceLoading(false));
  }, [isOpen]);

  const quantityTokens = useMemo(() => {
    if (mode === 'auto' && price > 0 && availableBalance > 0) {
      const usdtForAuto = availableBalance * 0.1;
      return usdtForAuto / price;
    }
    const raw = parseFloat(quantityInput) || 0;
    return raw;
  }, [mode, quantityInput, price, availableBalance]);

  const positionSizeUsdt = quantityTokens * price;
  const effectiveLeverage = mode === 'auto' ? 5 : leverage;
  const marginRequired = effectiveLeverage > 0 ? positionSizeUsdt / effectiveLeverage : 0;
  const estFunding = positionSizeUsdt * Math.abs(fundingRate);
  const tradingFee = positionSizeUsdt * TRADING_FEE_RATE;
  const netProfitEst = estFunding - tradingFee;

  const effectiveAvailable = crossExchangeMode && binanceAvailableBalance != null
    ? Math.min(availableBalance, binanceAvailableBalance)
    : availableBalance;
  const insufficientBalance = marginRequired > effectiveAvailable && marginRequired > 0;

  const resetForm = useCallback(() => {
    setView('form');
    setMessage('');
    setMode('manual');
    setLeverage(5);
    setQuantityInput('');
    setError(null);
  }, []);

  const handleClose = useCallback(() => {
    if (!loading) {
      resetForm();
      onClose();
    }
  }, [loading, resetForm, onClose]);

  const handleConfirm = useCallback(async () => {
    if (!tokenData) return;
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      setError('Please log in again.');
      return;
    }
    const side = direction === 'LONG' ? 'Buy' : 'Sell';
    const qty = quantityTokens;
    if (qty <= 0) {
      setError('Invalid quantity.');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/trade/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          symbol: tokenData.symbol,
          side,
          qty: String(qty),
          leverage: mode === 'auto' ? 5 : leverage,
          type: mode === 'auto' ? 'Auto' : 'Manual',
          ...(crossExchangeMode && { isCrossExchange: true }),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const errorReason =
          data?.error ??
          data?.retMsg ??
          data?.message ??
          (typeof data === 'object' && data !== null && 'message' in data ? String((data as { message?: string }).message) : undefined) ??
          'Trade failed';
        setView('error');
        setMessage(String(errorReason));
        setLoading(false);
        return;
      }
      setView('success');
      setMessage(`Order Placed Successfully! ID: ${data.orderId ?? '—'}`);
    } catch {
      setView('error');
      setMessage('Network error');
    } finally {
      setLoading(false);
    }
  }, [tokenData, direction, quantityTokens, leverage, mode, crossExchangeMode]);

  if (!isOpen) return null;

  const isManual = mode === 'manual';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="trade-modal-title"
    >
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={() => !loading && handleClose()}
        aria-hidden="true"
      />
      <div
        className="relative w-full max-w-md rounded-2xl border shadow-2xl"
        style={{
          backgroundColor: 'rgba(0, 0, 0, 0.9)',
          borderColor: 'rgba(0, 123, 255, 0.4)',
          boxShadow: '0 0 40px rgba(0, 123, 255, 0.15)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between border-b px-5 py-4"
          style={{ borderColor: 'rgba(0, 123, 255, 0.3)' }}
        >
          <div className="flex items-center gap-3">
            <h2 id="trade-modal-title" className="text-lg font-semibold text-white">
              {tokenName(symbol)}
            </h2>
            <span
              className={`text-sm font-medium ${fundingRate > 0 ? 'text-red-400' : fundingRate < 0 ? 'text-green-400' : 'text-gray-400'}`}
              style={{
                textShadow: fundingRate !== 0 ? `0 0 12px ${fundingRate > 0 ? 'rgba(239,68,68,0.5)' : 'rgba(34,197,94,0.5)'}` : undefined,
              }}
            >
              {formatPct(fundingRate)}
            </span>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={loading}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-white/10 hover:text-white disabled:opacity-50"
            aria-label="Close"
            style={{ visibility: loading ? 'hidden' : 'visible' }}
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-5">
          {view === 'success' && (
            <>
              <div className="flex justify-center">
                <div
                  className="flex h-16 w-16 items-center justify-center rounded-full"
                  style={{
                    backgroundColor: 'rgba(34, 197, 94, 0.2)',
                    boxShadow: '0 0 24px rgba(34, 197, 94, 0.5)',
                  }}
                >
                  <Check className="h-10 w-10 text-green-400" strokeWidth={2.5} />
                </div>
              </div>
              <p
                className="text-center text-lg font-medium"
                style={{
                  color: '#22c55e',
                  textShadow: '0 0 12px rgba(34, 197, 94, 0.6)',
                }}
              >
                {message}
              </p>
              <button
                type="button"
                onClick={handleClose}
                className="w-full rounded-xl py-3.5 text-base font-semibold text-white transition hover:opacity-90"
                style={{
                  backgroundColor: '#007BFF',
                  boxShadow: '0 0 20px rgba(0, 123, 255, 0.4)',
                }}
              >
                OK
              </button>
            </>
          )}

          {view === 'error' && (
            <>
              <div className="flex justify-center">
                <div
                  className="flex h-16 w-16 items-center justify-center rounded-full"
                  style={{
                    backgroundColor: 'rgba(239, 68, 68, 0.2)',
                    boxShadow: '0 0 24px rgba(239, 68, 68, 0.4)',
                  }}
                >
                  <AlertCircle className="h-10 w-10 text-red-400" strokeWidth={2} />
                </div>
              </div>
              <p className="text-center text-base font-medium text-red-400">
                {message}
              </p>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setView('form')}
                  className="flex-1 rounded-xl py-3 text-base font-semibold text-white transition hover:opacity-90"
                  style={{
                    backgroundColor: '#007BFF',
                    boxShadow: '0 0 16px rgba(0, 123, 255, 0.3)',
                  }}
                >
                  Try Again
                </button>
                <button
                  type="button"
                  onClick={handleClose}
                  className="flex-1 rounded-xl border py-3 text-base font-semibold text-gray-300 transition hover:bg-white/10"
                  style={{ borderColor: 'rgba(255, 255, 255, 0.3)' }}
                >
                  Close
                </button>
              </div>
            </>
          )}

          {view === 'form' && (
            <>
          {/* Badge */}
          <div className="flex justify-center">
            {direction === 'LONG' ? (
              <span
                className="inline-flex rounded-lg px-4 py-2 text-sm font-semibold text-green-400"
                style={{
                  backgroundColor: 'rgba(34, 197, 94, 0.15)',
                  boxShadow: '0 0 12px rgba(34, 197, 94, 0.3)',
                }}
              >
                Recommended: LONG
              </span>
            ) : (
              <span
                className="inline-flex rounded-lg px-4 py-2 text-sm font-semibold text-red-400"
                style={{
                  backgroundColor: 'rgba(239, 68, 68, 0.15)',
                  boxShadow: '0 0 12px rgba(239, 68, 68, 0.3)',
                }}
              >
                Recommended: SHORT
              </span>
            )}
          </div>

          {/* Mode Toggle */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-2">Mode</label>
            <div
              className="flex rounded-xl overflow-hidden border"
              style={{ borderColor: 'rgba(0, 123, 255, 0.35)' }}
            >
              <button
                type="button"
                onClick={() => setMode('manual')}
                className={`flex-1 px-4 py-2.5 text-sm font-medium transition ${
                  isManual ? 'text-white' : 'text-gray-400 hover:text-white'
                }`}
                style={{
                  backgroundColor: isManual ? 'rgba(0, 123, 255, 0.35)' : 'transparent',
                }}
              >
                Manual Confirm
              </button>
              <button
                type="button"
                onClick={() => setMode('auto')}
                className={`flex-1 px-4 py-2.5 text-sm font-medium transition ${
                  !isManual ? 'text-white' : 'text-gray-400 hover:text-white'
                }`}
                style={{
                  backgroundColor: !isManual ? 'rgba(0, 123, 255, 0.35)' : 'transparent',
                }}
              >
                Auto Execute
              </button>
            </div>
          </div>

          {/* Leverage */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-gray-400">Leverage</label>
              <span className="text-sm font-medium text-[#007BFF]">{leverage}x</span>
            </div>
            <input
              type="range"
              min={1}
              max={50}
              value={mode === 'auto' ? 5 : leverage}
              onChange={(e) => setLeverage(Number(e.target.value))}
              disabled={!isManual}
              className="w-full h-2 rounded-lg cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed accent-[#007BFF]"
            />
            {isManual && (
              <input
                type="number"
                min={1}
                max={50}
                value={leverage}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!Number.isNaN(v)) setLeverage(Math.min(50, Math.max(1, v)));
                }}
                className="mt-2 w-full rounded-lg border bg-black/50 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#007BFF]"
                style={{ borderColor: 'rgba(0, 123, 255, 0.3)' }}
              />
            )}
          </div>

          {/* Quantity (tokens) */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-2">
              Quantity ({symbol ? tokenName(symbol) : '—'})
            </label>
            <input
              type="number"
              min={0}
              step="any"
              placeholder="0"
              value={mode === 'auto' && price > 0 && availableBalance > 0
                ? (availableBalance * 0.1 / price).toFixed(6)
                : quantityInput}
              onChange={(e) => setQuantityInput(e.target.value)}
              disabled={!isManual}
              className="w-full rounded-lg border bg-black/50 px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-[#007BFF] disabled:opacity-60"
              style={{ borderColor: 'rgba(0, 123, 255, 0.3)' }}
            />
            {mode === 'auto' && (
              <p className="mt-1 text-xs text-gray-500">10% of available balance</p>
            )}
          </div>

          {/* Live calculations grid */}
          <div
            className="rounded-xl border p-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm"
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.04)',
              borderColor: 'rgba(0, 123, 255, 0.25)',
            }}
          >
            <div>
              <span className="text-gray-500">Position Size (USDT)</span>
              <p className="font-mono text-white mt-0.5">
                {positionSizeUsdt > 0 ? positionSizeUsdt.toFixed(2) : '0'} USDT
              </p>
            </div>
            <div>
              <span className="text-gray-500">Margin Required</span>
              <p className="font-mono text-white mt-0.5">
                {marginRequired > 0 ? marginRequired.toFixed(2) : '0'} USDT
              </p>
            </div>
            <div>
              <span className="text-gray-500">Est. Funding</span>
              <p className="font-mono text-green-400 mt-0.5">
                +{estFunding.toFixed(4)} USDT
              </p>
            </div>
            <div>
              <span className="text-gray-500">Trading Fee</span>
              <p className="font-mono text-red-400/90 mt-0.5">
                −{tradingFee.toFixed(4)} USDT
              </p>
            </div>
            <div className="col-span-2 pt-2 border-t" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
              <span className="text-gray-500">Net Profit Est.</span>
              <p className={`font-mono mt-0.5 ${netProfitEst >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {netProfitEst >= 0 ? '+' : ''}{netProfitEst.toFixed(4)} USDT
              </p>
            </div>
          </div>

          {error && (
            <div
              className="rounded-lg border px-4 py-2.5 text-sm text-red-400"
              style={{
                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                borderColor: 'rgba(239, 68, 68, 0.3)',
              }}
            >
              {error}
            </div>
          )}

          {insufficientBalance && (
            <div
              className="rounded-lg border px-4 py-2.5 text-sm text-red-400"
              style={{
                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                borderColor: 'rgba(239, 68, 68, 0.3)',
              }}
            >
              Insufficient Balance
            </div>
          )}

          <p
            className="text-center font-semibold text-white"
            style={{ textShadow: '0 0 12px rgba(0, 123, 255, 0.6)' }}
          >
            {balanceLoading
              ? 'Loading balance…'
              : crossExchangeMode
                ? `Bybit Available: $${availableBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · Binance Available: $${(binanceAvailableBalance ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : `Available Balance: $${availableBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          </p>

          <button
            type="button"
            onClick={handleConfirm}
            disabled={loading || quantityTokens <= 0 || insufficientBalance}
            className="w-full rounded-xl py-3.5 text-base font-semibold text-white transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            style={{
              backgroundColor: '#007BFF',
              boxShadow: '0 0 20px rgba(0, 123, 255, 0.4)',
            }}
          >
            {loading ? (
              <>
                <span
                  className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent"
                  aria-hidden
                />
                Processing…
              </>
            ) : (
              'Confirm Trade'
            )}
          </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
