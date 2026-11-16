// Pure snapshot builder: NO database access. Everything comes from the worker's in-memory state, so the
// public snapshot (status.json) can be produced even when MongoDB is down.
import { computeOverall, p95FromBuckets } from './status.js';

const PUBLIC_PROBES = ['container', 'internal', 'nginx', 'public', 'tls'];

/**
 * @param services      [{key,name,group,order,quality,public?,enabled}]
 * @param states        Map(key -> {state, reason, latencyMs, lastChange, probes, detail})  (service keys + "infra:<node>")
 * @param rollups       Map(serviceKey -> [{day, up, down, incidentSec, latSum, latCount, buckets}])  (last 90 days)
 * @param incidents     { active: [], recent: [] }   already slimmed
 * @param maintenance   [{id, services, start, end, note}]
 * @param infraFlags    { upstreamDown, nginxDown, dbDown }   committed (debounced) flags
 * @param dbConnected   whether the worker currently has a live database connection (informational)
 */
export function buildSnapshot({
  now = new Date(), services = [], states = new Map(), rollups = new Map(),
  incidents = { active: [], recent: [] }, maintenance = [], infraFlags = {}, dbConnected = true, serverLabel = 'Server',
}) {
  const out = services.filter((s) => s.enabled !== false).sort((a, b) => (a.order || 0) - (b.order || 0)).map((s) => {
    const st = states.get(s.key);
    const rows = rollups.get(s.key) || [];
    const up = rows.reduce((a, r) => a + r.up, 0);
    const down = rows.reduce((a, r) => a + r.down, 0);
    const probes = {};
    for (const k of PUBLIC_PROBES) if (st?.probes?.[k]) probes[k] = st.probes[k];
    return {
      key: s.key, name: s.name, group: s.group, order: s.order, quality: s.quality,
      hasPublic: !!s.public?.url, publicUrl: s.public?.url || null,
      state: st?.state || 'unknown', reason: st?.reason || null, latencyMs: st?.latencyMs ?? null, lastChange: st?.lastChange || null,
      probes,
      uptimePct: up + down ? Math.round((up / (up + down)) * 10000) / 100 : null,
      days: rows.map((r) => ({
        d: r.day,
        u: r.up + r.down ? Math.round((r.up / (r.up + r.down)) * 10000) / 100 : null,
        m: Math.round(r.incidentSec / 60),
        l: r.latCount ? Math.round(r.latSum / r.latCount) : null,
        p: p95FromBuckets(r.buckets),
      })),
    };
  });

  const node = (name) => states.get(`infra:${name}`);
  const infra = {
    server: { label: serverLabel, state: 'operational', detail: 'monitoring worker alive' },
    nginx: { label: 'Host nginx', state: node('nginx')?.state || 'unknown', detail: node('nginx')?.detail?.error || null },
    dns: { label: 'iitg.ac.in DNS', state: node('dns')?.state || 'unknown', detail: node('dns')?.detail?.error || node('dns')?.detail?.detail || null },
    gateway: {
      label: 'Campus gateway', state: node('gateway')?.state || 'unknown', latencyMs: node('gateway')?.latencyMs ?? null,
      detail: node('gateway')?.detail?.error || (node('gateway')?.detail?.statusCode ? `HTTP ${node('gateway').detail.statusCode}` : null),
    },
    tls: {
      label: 'TLS certificate', state: node('tls')?.state || 'unknown', daysLeft: node('tls')?.detail?.daysLeft ?? null,
      detail: node('tls')?.detail?.daysLeft != null ? `${node('tls').detail.daysLeft} days left` : node('tls')?.detail?.error || null,
    },
    database: { label: 'Shared database', state: node('mongo')?.state || 'unknown', detail: node('mongo')?.detail?.error || null },
  };

  return {
    generatedAt: now.toISOString(),
    overall: computeOverall(out, infraFlags),
    infra,
    services: out,
    incidents,
    maintenance,
    dbConnected: !!dbConnected,
  };
}
