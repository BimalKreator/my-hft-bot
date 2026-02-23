import React from 'react';

/** 0–30 Low, 31–70 Medium, 71–100 High */
function getZone(value: number): { label: string; colorClass: string } {
  if (value <= 30) return { label: 'Low Volatility', colorClass: 'text-emerald-500' };
  if (value <= 70) return { label: 'Medium Volatility', colorClass: 'text-yellow-500' };
  return { label: 'High Volatility', colorClass: 'text-red-500' };
}

export interface VolatilityMeterProps {
  value: number; // 0–100
}

export default function VolatilityMeter({ value }: VolatilityMeterProps) {
  const clamped = Math.max(0, Math.min(100, value));
  const rotation = (clamped / 100) * 180 - 90; // -90 is 0%, 90 is 100%
  const zone = getZone(clamped);

  return (
    <div className="flex flex-col items-center justify-center w-full">
      <div className="relative w-full max-w-[220px] aspect-[2/1]">
        {/* Semi-circle arc with 3 zones */}
        <svg viewBox="0 0 200 120" className="w-full h-full" preserveAspectRatio="xMidYMax meet">
          <defs>
            <linearGradient id="vol-low" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#10b981" />
              <stop offset="100%" stopColor="#34d399" />
            </linearGradient>
            <linearGradient id="vol-mid" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#eab308" />
              <stop offset="100%" stopColor="#facc15" />
            </linearGradient>
            <linearGradient id="vol-high" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#ef4444" />
              <stop offset="100%" stopColor="#f87171" />
            </linearGradient>
          </defs>
          {/* Background track */}
          <path
            d="M 20 100 A 80 80 0 0 1 180 100"
            fill="none"
            stroke="rgba(255,255,255,0.08)"
            strokeWidth="14"
            strokeLinecap="round"
          />
          {/* Arc length π*80 ≈ 251.33. Zones: 0–30% = 75.4, 31–70% = 100.53, 71–100% = 75.4 */}
          <path
            d="M 20 100 A 80 80 0 0 1 180 100"
            fill="none"
            stroke="url(#vol-low)"
            strokeWidth="14"
            strokeLinecap="round"
            strokeDasharray="75.4 175.93"
            strokeDashoffset="0"
            opacity={0.9}
          />
          <path
            d="M 20 100 A 80 80 0 0 1 180 100"
            fill="none"
            stroke="url(#vol-mid)"
            strokeWidth="14"
            strokeLinecap="round"
            strokeDasharray="100.53 150.8"
            strokeDashoffset="-75.4"
            opacity={0.9}
          />
          <path
            d="M 20 100 A 80 80 0 0 1 180 100"
            fill="none"
            stroke="url(#vol-high)"
            strokeWidth="14"
            strokeLinecap="round"
            strokeDasharray="75.4 175.93"
            strokeDashoffset="-175.93"
            opacity={0.9}
          />
        </svg>
        {/* Needle: pivot at bottom center (100, 100), length ~70 */}
        <div
          className="absolute left-1/2 bottom-0 -translate-x-1/2 origin-bottom"
          style={{
            width: '4px',
            height: '58%',
            transform: `translateX(-50%) rotate(${rotation}deg)`,
          }}
        >
          <div
            className="w-full h-full rounded-full"
            style={{
              background: 'linear-gradient(to top, rgba(255,255,255,0.95), rgba(255,255,255,0.6))',
              boxShadow: '0 0 8px rgba(0,0,0,0.3)',
            }}
          />
        </div>
        {/* Center dot */}
        <div
          className="absolute left-1/2 bottom-0 w-3 h-3 -translate-x-1/2 translate-y-1/2 rounded-full bg-gray-700 border-2 border-gray-500"
          style={{ boxShadow: 'inset 0 0 4px rgba(0,0,0,0.5)' }}
        />
      </div>
      <p className={`text-2xl font-bold mt-2 ${zone.colorClass}`}>{clamped}%</p>
      <p className={`text-sm font-medium mt-1 ${zone.colorClass}`}>{zone.label}</p>
    </div>
  );
}
