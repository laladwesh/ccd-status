import { Alert, Tag, Timeline } from 'antd';
import dayjs from 'dayjs';
import { INCIDENT_COLOR } from '../constants';

const fmt = (d) => dayjs(d).format('D MMM YYYY, HH:mm');
const isInfra = (k) => typeof k === 'string' && k.startsWith('infra:');

export function ActiveNotices({ incidents = [], maintenance = [], nameOf }) {
  const nowMs = Date.now();
  return (
    <div className="flex flex-col gap-3">
      {incidents.map((i) => {
        const last = i.updates?.[i.updates.length - 1];
        const named = (i.serviceKeys || []).filter((k) => !isInfra(k));
        return (
          <Alert
            key={i.id} type="error" showIcon
            message={<span className="font-semibold">{i.title}</span>}
            description={
              <div className="text-sm">
                <Tag color={INCIDENT_COLOR[i.status]}>{i.status}</Tag>
                <span className="text-[#666B72]">since {fmt(i.startedAt)}</span>
                {named.length > 0 && <span className="text-[#666B72]"> · {named.map(nameOf).join(', ')}</span>}
                {last?.message && <div className="mt-1">{last.message}</div>}
              </div>
            }
          />
        );
      })}
      {maintenance.map((m) => {
        const active = new Date(m.start).getTime() <= nowMs;
        return (
          <Alert
            key={m.id} type="info" showIcon
            message={<span className="font-semibold">{active ? 'Maintenance in progress' : 'Scheduled maintenance'}</span>}
            description={
              <div className="text-sm">
                {fmt(m.start)} – {fmt(m.end)} · {m.services?.length ? m.services.map(nameOf).join(', ') : 'all services'}
                {m.note && <div className="mt-1">{m.note}</div>}
              </div>
            }
          />
        );
      })}
    </div>
  );
}

export function IncidentHistory({ incidents = [] }) {
  if (!incidents.length) return <p className="text-sm text-[#666B72]">No incidents recorded recently.</p>;
  return (
    <Timeline
      items={incidents.map((i) => ({
        color: INCIDENT_COLOR[i.status],
        children: (
          <div>
            <div className="font-medium text-[#161B22]">{i.title} <Tag color={INCIDENT_COLOR[i.status]}>{i.status}</Tag></div>
            <div className="text-xs text-[#666B72]">
              {fmt(i.startedAt)}{i.resolvedAt ? ` → ${fmt(i.resolvedAt)} (${dayjs(i.resolvedAt).diff(dayjs(i.startedAt), 'minute')} min)` : ''}
            </div>
            {(i.updates || []).slice(-3).map((u, idx) => (
              <div key={idx} className="text-sm mt-1"><span className="text-[#666B72]">{dayjs(u.ts).format('HH:mm')}</span> {u.message}</div>
            ))}
          </div>
        ),
      }))}
    />
  );
}
