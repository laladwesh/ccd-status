import { Tooltip } from 'antd';
import dayjs from 'dayjs';

const NO_DATA = '#E4E1E0';
const colorFor = (u) => (u == null ? NO_DATA : u >= 99.5 ? '#107C10' : u >= 95 ? '#B7791F' : '#D83B01');

// 90 thin bars, oldest -> today. One per day, coloured by uptime %.
export default function UptimeBar({ days = [] }) {
  const byDay = new Map(days.map((d) => [d.d, d]));
  const slots = Array.from({ length: 90 }, (_, i) => {
    const day = dayjs().subtract(89 - i, 'day').format('YYYY-MM-DD');
    return { day, ...(byDay.get(day) || {}) };
  });
  return (
    <div className="flex gap-[2px] w-full" role="img" aria-label="Uptime over the last 90 days">
      {slots.map((s) => (
        <Tooltip
          key={s.day}
          title={s.u == null ? `${dayjs(s.day).format('D MMM YYYY')}: no data` : `${dayjs(s.day).format('D MMM YYYY')}: ${s.u}% uptime, ${s.m || 0} min of incident`}
        >
          <div className="flex-1 min-w-[2px] h-7" style={{ background: colorFor(s.u) }} />
        </Tooltip>
      ))}
    </div>
  );
}
