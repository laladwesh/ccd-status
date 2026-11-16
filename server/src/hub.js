// Keeps the latest snapshot in memory and fans it out to SSE clients.
// The worker writes the snapshot to Mongo (Meta 'snapshot'); we poll it and push on change.
import { cfg } from './config.js';

export function createHub(models) {
  const clients = new Set();
  let current = null;
  let currentTs = 0;

  // Incidents and maintenance are overlaid live so admin edits show instantly instead of at the next worker cycle.
  async function overlay(snapshot) {
    const { Incident, Maintenance } = models;
    const now = new Date();
    const [active, recent, maint] = await Promise.all([
      Incident.find({ status: { $ne: 'resolved' } }).sort({ startedAt: -1 }).lean(),
      Incident.find({ status: 'resolved' }).sort({ resolvedAt: -1 }).limit(15).lean(),
      Maintenance.find({ end: { $gte: now } }).sort({ start: 1 }).lean(),
    ]);
    const slim = (i) => ({
      id: String(i._id), title: i.title, status: i.status, serviceKeys: i.serviceKeys, autoCreated: i.autoCreated,
      startedAt: i.startedAt, resolvedAt: i.resolvedAt || null,
      updates: (i.updates || []).map((u) => ({ message: u.message, status: u.status, author: u.author, ts: u.ts })),
    });
    return {
      ...snapshot,
      incidents: { active: active.map(slim), recent: recent.map(slim) },
      maintenance: maint.map((m) => ({ id: String(m._id), services: m.services, start: m.start, end: m.end, note: m.note })),
    };
  }

  async function load() {
    const doc = await models.Meta.findOne({ key: 'snapshot' }).lean();
    if (!doc?.value) return null;
    return { snapshot: doc.value, updatedAt: doc.updatedAt?.getTime?.() || 0 };
  }

  const stale = (snapshot) => !snapshot || Date.now() - new Date(snapshot.generatedAt).getTime() > cfg.staleAfterSec * 1000;

  async function get() {
    const l = await load();
    if (!l) return null;
    const full = await overlay(l.snapshot);
    return { ...full, stale: stale(l.snapshot) };
  }

  function send(payload) {
    const data = `event: status\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) res.write(data);
  }

  async function poll() {
    try {
      const l = await load();
      if (!l || l.updatedAt === currentTs) return;
      currentTs = l.updatedAt;
      current = await get();
      if (clients.size && current) send(current);
    } catch (e) { console.error('[hub] poll failed', e.message); }
  }

  return {
    start() { poll(); return setInterval(poll, 3000); },
    get,
    async broadcast() { const p = await get(); if (p && clients.size) send(p); },
    add(res) { clients.add(res); if (current) res.write(`event: status\ndata: ${JSON.stringify(current)}\n\n`); },
    remove(res) { clients.delete(res); },
    size: () => clients.size,
  };
}
