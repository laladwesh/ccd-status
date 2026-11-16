import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { p95FromBuckets } from '../../../shared/status.js';
import { cfg, DB_MESSAGE } from '../config.js';

const RANGES = { '24h': { ms: 86400000, bin: 15 }, '7d': { ms: 7 * 86400000, bin: 60 } };
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

export function publicRouter({ models, hub, isDbUp }) {
  const r = Router();
  const { Service, Check, DailyRollup, Incident } = models;

  // Database-backed endpoints answer 503 with a clear message instead of hanging or erroring.
  const requireDb = (req, res, next) => (isDbUp() ? next() : res.status(503).json({ error: DB_MESSAGE, code: 'DB_UNAVAILABLE' }));

  // Health of the status page itself. ALWAYS 200 while this process can serve: it must NOT fail just because
  // MongoDB is down, otherwise Docker would restart the status page in the middle of the outage it is reporting.
  r.get('/health', wrap(async (req, res) => {
    let ageSec = null;
    try { ageSec = Math.round((Date.now() - (await fs.stat(path.join(cfg.statusDir, 'status.json'))).mtimeMs) / 1000); } catch { /* none yet */ }
    const workerOk = ageSec != null && ageSec < cfg.staleAfterSec;
    const db = isDbUp();
    res.json({ ok: true, status: db && workerOk ? 'ok' : 'degraded', db, worker: workerOk, snapshotAgeSec: ageSec, sseClients: hub.size(), uptimeSec: Math.round(process.uptime()) });
  }));

  // Latest snapshot. Served from status.json, so it works with the database down.
  r.get('/status', wrap(async (req, res) => {
    const s = await hub.get();
    if (!s) return res.status(503).json({ error: 'no data yet: the worker has not published a snapshot' });
    res.set('Cache-Control', 'no-store').json(s);
  }));

  r.get('/incidents', requireDb, wrap(async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const list = await Incident.find({}).sort({ startedAt: -1 }).limit(limit).lean().maxTimeMS(3000);
    res.json(list.map((i) => ({ ...i, id: String(i._id), _id: undefined })));
  }));

  r.get('/services/:key/history', requireDb, wrap(async (req, res) => {
    const range = req.query.range || '24h';
    if (!['24h', '7d', '90d'].includes(range)) return res.status(400).json({ error: 'range must be 24h, 7d or 90d' });
    const svc = await Service.findOne({ key: req.params.key }).lean().maxTimeMS(3000);
    if (!svc) return res.status(404).json({ error: 'unknown service' });

    const recent = await Check.find({ serviceKey: svc.key }).sort({ ts: -1 }).limit(30).select('-_id -__v').lean().maxTimeMS(3000);
    const incidents = await Incident.find({ serviceKeys: svc.key }).sort({ startedAt: -1 }).limit(10).lean().maxTimeMS(3000);
    const base = { key: svc.key, range, recent, incidents: incidents.map((i) => ({ id: String(i._id), title: i.title, status: i.status, startedAt: i.startedAt, resolvedAt: i.resolvedAt || null })) };

    if (range === '90d') {
      const since = new Date(Date.now() - 90 * 86400000);
      const rows = await DailyRollup.find({ serviceKey: svc.key, dayStart: { $gte: since } }).sort({ day: 1 }).lean().maxTimeMS(3000);
      return res.json({
        ...base,
        days: rows.map((x) => ({
          day: x.day,
          uptime: x.up + x.down ? Math.round((x.up / (x.up + x.down)) * 10000) / 100 : null,
          incidentMinutes: Math.round(x.incidentSec / 60),
          avgLatencyMs: x.latCount ? Math.round(x.latSum / x.latCount) : null,
          p95LatencyMs: p95FromBuckets(x.buckets),
        })),
      });
    }

    const { ms, bin } = RANGES[range];
    const probeType = svc.internal ? 'internal' : 'container';
    const points = await Check.aggregate([
      { $match: { serviceKey: svc.key, probeType, ts: { $gte: new Date(Date.now() - ms) } } },
      { $group: {
        _id: { $dateTrunc: { date: '$ts', unit: 'minute', binSize: bin } },
        avgLatencyMs: { $avg: { $cond: [{ $eq: ['$ok', true] }, '$latencyMs', null] } },
        maxLatencyMs: { $max: '$latencyMs' },
        total: { $sum: 1 },
        okCount: { $sum: { $cond: [{ $eq: ['$ok', true] }, 1, 0] } },
      } },
      { $sort: { _id: 1 } },
    ]).option({ maxTimeMS: 5000 });
    res.json({
      ...base,
      points: points.map((p) => ({
        ts: p._id,
        avgLatencyMs: p.avgLatencyMs == null ? null : Math.round(p.avgLatencyMs),
        maxLatencyMs: p.maxLatencyMs,
        okPct: Math.round((p.okCount / p.total) * 100),
      })),
    });
  }));

  // Server-Sent Events: pushes the full snapshot on every change. Clients fall back to polling /status.json.
  r.get('/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 5000\n\n');
    hub.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); hub.remove(res); });
  });

  return r;
}
