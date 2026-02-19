interface BotStatusIndicatorProps {
  active?: boolean;
}

export default function BotStatusIndicator({ active = true }: BotStatusIndicatorProps) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="relative flex h-3 w-3"
        title={active ? 'Bot active' : 'Bot inactive'}
      >
        <span
          className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${
            active ? 'animate-ping' : ''
          }`}
          style={{
            backgroundColor: active ? '#22c55e' : '#6b7280',
          }}
        />
        <span
          className="relative inline-flex h-3 w-3 rounded-full border border-white/20"
          style={{
            backgroundColor: active ? '#22c55e' : '#6b7280',
            boxShadow: active ? '0 0 12px rgba(34, 197, 94, 0.6)' : 'none',
          }}
        />
      </span>
      <span className="text-sm font-medium text-gray-300">
        Bot Status: {active ? 'Active' : 'Inactive'}
      </span>
    </div>
  );
}
