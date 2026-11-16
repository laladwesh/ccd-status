import StatusTag from './StatusTag';
import UptimeBar from './UptimeBar';

export default function ServiceRow({ service, onOpen }) {
  const { name, state, latencyMs, uptimePct, days, reason } = service;
  const showReason = reason && state !== 'operational' && state !== 'unknown';
  return (
    <button
      type="button"
      onClick={() => onOpen(service)}
      className="w-full text-left px-4 py-3 border-t first:border-t-0 hover:bg-brand-50 transition-colors bg-transparent cursor-pointer block"
      style={{ borderColor: '#EDF0F5' }}
    >
      <div className="flex items-center justify-between gap-3 mb-2">
        <span className="font-medium text-[#161B22] truncate">{name}</span>
        <span className="flex items-center gap-3 shrink-0">
          {latencyMs != null && state !== 'down' && <span className="text-xs text-[#666B72] hidden sm:inline">{latencyMs} ms</span>}
          <StatusTag state={state} short />
        </span>
      </div>
      {showReason && <p className="text-xs mb-2" style={{ color: '#7C2D3E' }}>{reason}</p>}
      <UptimeBar days={days} />
      <div className="flex justify-between text-xs text-[#666B72] mt-1">
        <span>90 days ago</span>
        <span>{uptimePct != null ? `${uptimePct}% uptime` : 'No data yet'}</span>
        <span>Today</span>
      </div>
    </button>
  );
}
