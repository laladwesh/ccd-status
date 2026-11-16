// Serves the latest snapshot and fans it out to SSE clients.
// Source of truth = status.json (written by the worker every cycle, even while MongoDB is down).
// When the database is reachable, incidents/maintenance are overlaid live so admin edits show instantly.
import fs from 'node:fs/promises';
import path from 'node:path';
import { cfg } from './config.js';

export function createHub(models, isDbUp = () => true) {
  const clients = new Set();
  const file = path.join(cfg.statusDir, 'status.json');
  let lastMtime = 0;

  async function overlay(snapshot) {
    if (!isDbUp()) return snapshot;
    try {
      const { Incident, Maintenance } = models;
      const now = new Date();
      const [active, recent, maint] = await Promise.all([
        Incident.find({ status: { $ne: 'resolved' } }).sort({ startedAt: -1 }).lean().maxTimeMS(2000),
        Incident.find({ status: 'resolved' }).sort({ resolvedAt: -1 }).limit(15).lean().maxTimeMS(2000),
        Maintenance.find({ end: { $gte: now } }).sort({ start: 1 }).lean().maxTimeMS(2000),
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
    } catch {
      return snapshot; // database trouble: serve the file as-is, never error
    }
  }

  async function get() {
    let raw;
    try { raw = JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
    const full = await overlay(raw);
    const stale = Date.now() - new Date(raw.generatedAt).getTime() > cfg.staleAfterSec * 1000;
    return { ...full, stale };
  }

  function send(payload) {
    const data = `event: status\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) res.write(data);
  }

  async function poll() {
    try {
      const m = (await fs.stat(file)).mtimeMs;
      if (m === lastMtime) return;
      lastMtime = m;
      if (clients.size) { const p = await get(); if (p) send(p); }
    } catch { /* no status.json yet */ }
  }

  return {
    start() { poll(); return setInterval(poll, 3000); },
    get,
    async broadcast() { const p = await get(); if (p && clients.size) send(p); },
    add(res) { clients.add(res); get().then((p) => { if (p) res.write(`event: status\ndata: ${JSON.stringify(p)}\n\n`); }).catch(() => {}); },
    remove(res) { clients.delete(res); },
    closeAll() { for (const res of clients) { try { res.end(); } catch { /* already closed */ } } clients.clear(); },
    size: () => clients.size,
  };
}
