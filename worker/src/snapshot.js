// Builds the public status snapshot. Written to Mongo (Meta 'snapshot', served by the API)
// and to <STATUS_DIR>/status.json (served straight by nginx as the static fallback).
import fs from 'node:fs/promises';
import path from 'node:path';
import { computeOverall, p95FromBuckets } from '../../shared/status.js';
import { cfg } from './config.js';

const PUBLIC_KEYS = ['container', 'internal', 'nginx', 'public', 'tls'];
const DAY_MS = 86400000;

export async function buildSnapshot({ models, engine }) {
  const { Service, ServiceState, DailyRollup, Incident, Maintenance } = models;
  const now = new Date();
  const since = new Date(now.getTime() - 90 * DAY_MS);

  const [services, states, rollups, active, recent, maint] = await Promise.all([
    Service.find({ enabled: true }).sort({ order: 1 }).lean(),
    ServiceState.find({}).lean(),
    DailyRollup.find({ dayStart: { $gte: since } }).sort({ day: 1 }).lean(),
    Incident.find({ status: { $ne: 'resolved' } }).sort({ startedAt: -1 }).lean(),
    Incident.find({ status: 'resolved' }).sort({ resolvedAt: -1 }).limit(15).lean(),
    Maintenance.find({ end: { $gte: now } }).sort({ start: 1 }).lean(),
  ]);

  const stateByKey = new Map(states.map((s) => [s.key, s]));
  const rollByKey = new Map();
  for (const r of rollups) { if (!rollByKey.has(r.serviceKey)) rollByKey.set(r.serviceKey, []); rollByKey.get(r.serviceKey).push(r); }

  const out = services.map((s) => {
    const st = stateByKey.get(s.key);
    const days = (rollByKey.get(s.key) || []).map((r) => ({
      d: r.day,
      u: r.up + r.down ? Math.round((r.up / (r.up + r.down)) * 10000) / 100 : null,
      m: Math.round(r.incidentSec / 60),
      l: r.latCount ? Math.round(r.latSum / r.latCount) : null,
      p: p95FromBuckets(r.buckets),
    }));
    const up = (rollByKey.get(s.key) || []).reduce((a, r) => a + r.up, 0);
    const down = (rollByKey.get(s.key) || []).reduce((a, r) => a + r.down, 0);
    const probes = {};
    for (const k of PUBLIC_KEYS) if (st?.probes?.[k]) probes[k] = st.probes[k];
    return {
      key: s.key, name: s.name, group: s.group, order: s.order, quality: s.quality,
      hasPublic: !!s.public?.url, publicUrl: s.public?.url || null,
      state: st?.state || 'unknown', reason: st?.reason || null, latencyMs: st?.latencyMs ?? null, lastChange: st?.lastChange || null,
      probes, uptimePct: up + down ? Math.round((up / (up + down)) * 10000) / 100 : null, days,
    };
  });

  const infra = engine.getInfra();
  const is = (n) => stateByKey.get(`infra:${n}`);
  const dns = is('dns'); const gateway = is('gateway'); const mongo = is('mongo'); const tls = is('tls'); const nginxN = is('nginx');
  const infraOut = {
    server: { label: 'Server 172.17.1.148', state: 'operational', detail: 'monitoring worker alive' },
    nginx: { label: 'Host nginx', state: nginxN?.state || 'unknown', detail: nginxN?.detail?.error || null },
    dns: { label: 'iitg.ac.in DNS', state: dns?.state || 'unknown', detail: dns?.detail?.error || dns?.detail?.detail || null },
    gateway: { label: 'Campus gateway', state: gateway?.state || 'unknown', detail: gateway?.detail?.error || (gateway?.detail?.statusCode ? `HTTP ${gateway.detail.statusCode}` : null), latencyMs: gateway?.latencyMs ?? null },
    tls: { label: 'TLS certificate', state: tls?.state || 'unknown', detail: tls?.detail?.daysLeft != null ? `${tls.detail.daysLeft} days left` : tls?.detail?.error || null, daysLeft: tls?.detail?.daysLeft ?? null },
    database: { label: 'Shared database', state: mongo?.state || 'unknown', detail: mongo?.detail?.error || null },
  };

  const slim = (i) => ({
    id: String(i._id), title: i.title, status: i.status, serviceKeys: i.serviceKeys, autoCreated: i.autoCreated,
    startedAt: i.startedAt, resolvedAt: i.resolvedAt || null,
    updates: (i.updates || []).map((u) => ({ message: u.message, status: u.status, author: u.author, ts: u.ts })),
  });

  return {
    generatedAt: now.toISOString(),
    overall: computeOverall(out, { upstreamDown: infra.upstreamDown, nginxDown: infra.nginxDown, dbDown: infra.dbDown }),
    infra: infraOut,
    services: out,
    incidents: { active: active.map(slim), recent: recent.map(slim) },
    maintenance: maint.map((m) => ({ id: String(m._id), services: m.services, start: m.start, end: m.end, note: m.note })),
  };
}

export async function writeStatusFile(snapshot) {
  const file = path.join(cfg.statusDir, 'status.json');
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.mkdir(cfg.statusDir, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(snapshot));
  await fs.rename(tmp, file);
}
