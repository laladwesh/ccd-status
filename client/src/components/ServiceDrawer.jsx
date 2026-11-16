import { useEffect, useState } from 'react';
import { Drawer, Segmented, Table, Tag, Spin, Empty } from 'antd';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import dayjs from 'dayjs';
import { api } from '../api';
import StatusTag from './StatusTag';
import { INCIDENT_COLOR } from '../constants';

export function humanUptime(sec) {
  if (!sec) return '–';
  const d = Math.floor(sec / 86400); const h = Math.floor((sec % 86400) / 3600); const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

const PROBE_LABEL = {
  container: 'Container', internal: 'App port (internal)', nginx: 'Host nginx', public: 'Public (iitg.ac.in)', tls: 'TLS certificate',
};

function probeDetail(k, p) {
  if (k === 'container') {
    const bits = [p.state, p.restartCount != null && `restarts: ${p.restartCount}`, p.uptimeSec ? `up ${humanUptime(p.uptimeSec)}` : null, p.error].filter(Boolean);
    return bits.join(' · ');
  }
  if (k === 'tls') return p.daysLeft != null ? `${p.daysLeft} days left` : p.error || '';
  return [p.statusCode && `HTTP ${p.statusCode}`, p.latencyMs != null && `${p.latencyMs} ms`, p.error].filter(Boolean).join(' · ');
}

export default function ServiceDrawer({ service, onClose }) {
  const [range, setRange] = useState('24h');
  const [hist, setHist] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (!service) return undefined;
    let cancelled = false;
    setLoading(true); setErr(false);
    api.get(`/services/${service.key}/history`, { params: { range } })
      .then((r) => { if (!cancelled) setHist(r.data); })
      .catch(() => { if (!cancelled) { setHist(null); setErr(true); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [service, range]);

  const rows = service ? Object.entries(service.probes || {}).map(([k, p]) => ({ key: k, probe: PROBE_LABEL[k] || k, ok: p.ok, detail: probeDetail(k, p) })) : [];
  const chart = hist?.points
    ? hist.points.map((p) => ({ t: dayjs(p.ts).format(range === '24h' ? 'HH:mm' : 'D MMM HH:mm'), ms: p.avgLatencyMs }))
    : (hist?.days || []).map((d) => ({ t: dayjs(d.day).format('D MMM'), ms: d.avgLatencyMs, p95: d.p95LatencyMs }));
  const hasLatency = chart.some((c) => c.ms != null);

  return (
    <Drawer
      open={!!service} onClose={onClose} width={typeof window !== 'undefined' && window.innerWidth < 640 ? '100%' : 560}
      title={service && (<span className="flex items-center gap-3 flex-wrap">{service.name} <StatusTag state={service.state} short /></span>)}
      destroyOnClose
    >
      {service && (
        <div className="flex flex-col gap-6">
          <section>
            <h3 className="text-sm font-semibold mb-2">Probe breakdown</h3>
            <Table
              size="small" pagination={false} rowKey="key" dataSource={rows}
              locale={{ emptyText: 'No probe data yet' }}
              columns={[
                { title: 'Probe', dataIndex: 'probe', width: 130 },
                { title: 'Result', dataIndex: 'ok', width: 90, render: (ok) => (ok === true ? <Tag color="#107C10">OK</Tag> : ok === false ? <Tag color="#D83B01">Failing</Tag> : <Tag>Unknown</Tag>) },
                { title: 'Detail', dataIndex: 'detail' },
              ]}
            />
            {service.publicUrl && <p className="text-xs text-[#666B72] mt-2 break-all">Public URL: {service.publicUrl}</p>}
          </section>

          <section>
            <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
              <h3 className="text-sm font-semibold">{range === '90d' ? 'Average latency (daily)' : 'Latency'}</h3>
              <Segmented size="small" value={range} onChange={setRange} options={['24h', '7d', '90d']} />
            </div>
            <Spin spinning={loading}>
              <div style={{ height: 220 }}>
                {hasLatency ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chart} margin={{ top: 5, right: 8, bottom: 0, left: -10 }}>
                      <CartesianGrid stroke="#EDF0F5" vertical={false} />
                      <XAxis dataKey="t" tick={{ fontSize: 11, fill: '#666B72' }} minTickGap={32} />
                      <YAxis tick={{ fontSize: 11, fill: '#666B72' }} unit=" ms" />
                      <RTooltip contentStyle={{ borderRadius: 0, border: '1px solid #E4E1E0', fontSize: 12 }} formatter={(v) => [`${v} ms`, 'Latency']} />
                      <Line type="monotone" dataKey="ms" stroke="#14213D" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
                      {range === '90d' && <Line type="monotone" dataKey="p95" stroke="#7C2D3E" strokeWidth={1.5} dot={false} isAnimationActive={false} />}
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center">
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={err ? 'History unavailable while the API is unreachable' : 'No latency data for this range'} />
                  </div>
                )}
              </div>
            </Spin>
          </section>

          <section>
            <h3 className="text-sm font-semibold mb-2">Recent checks</h3>
            <Table
              size="small" rowKey={(r) => `${r.ts}-${r.probeType}`} dataSource={hist?.recent || []} pagination={{ pageSize: 6, size: 'small', hideOnSinglePage: true }}
              locale={{ emptyText: err ? 'Unavailable' : 'No checks yet' }}
              columns={[
                { title: 'Time', dataIndex: 'ts', render: (t) => dayjs(t).format('D MMM HH:mm:ss'), width: 120 },
                { title: 'Probe', dataIndex: 'probeType', width: 80 },
                { title: 'OK', dataIndex: 'ok', width: 50, render: (ok) => (ok ? <span style={{ color: '#107C10' }}>✓</span> : <span style={{ color: '#D83B01' }}>✗</span>) },
                { title: 'Detail', render: (_, r) => [r.statusCode && `HTTP ${r.statusCode}`, r.latencyMs != null && `${r.latencyMs} ms`, r.error].filter(Boolean).join(' · ') },
              ]}
            />
          </section>

          <section>
            <h3 className="text-sm font-semibold mb-2">Incidents</h3>
            {hist?.incidents?.length ? hist.incidents.map((i) => (
              <div key={i.id} className="text-sm py-1 border-t first:border-t-0" style={{ borderColor: '#EDF0F5' }}>
                <Tag color={INCIDENT_COLOR[i.status]}>{i.status}</Tag>{i.title}
                <div className="text-xs text-[#666B72]">{dayjs(i.startedAt).format('D MMM YYYY HH:mm')}{i.resolvedAt ? ` → ${dayjs(i.resolvedAt).format('HH:mm')}` : ''}</div>
              </div>
            )) : <p className="text-sm text-[#666B72]">No incidents for this service.</p>}
          </section>
        </div>
      )}
    </Drawer>
  );
}
