// In-memory authoritative state + write-behind persistence.
//
// The worker's status logic reads and writes ONLY this store, never the database, so probing, state
// changes, incidents and the published snapshot all keep working while MongoDB is down. The database is
// a best-effort sink: results are buffered here (checks capped to ~1 h) and flushed when Mongo returns.
import mongoose from 'mongoose';

const HOUR = 3600 * 1000;
const DAY = 86400 * 1000;

export function createStore({
  models, log = console, isDbUp = () => true, now = () => Date.now(),
  checkMaxAgeMs = HOUR, checkMax = 20000, incidentOpsMax = 500,
}) {
  const svcStates = new Map();    // key -> state doc (services and "infra:<node>")
  const dirtyStates = new Set();
  let checkBuf = [];
  const rollups = new Map();      // serviceKey -> Map(day -> row)
  let rollupDeltas = new Map();   // "key|day" -> { serviceKey, day, dayStart, inc }
  let incidents = [];             // plain docs: { _id, serviceKeys, title, status, ... }
  const incidentOps = [];         // ordered writes waiting for the DB
  let maintenance = [];
  const enabled = new Map();      // serviceKey -> boolean (admin toggle, cached from DB)
  let flushing = false;

  // ---------- service states ----------
  const getState = (key) => svcStates.get(key) || null;
  function setState(key, doc) { svcStates.set(key, { ...doc, key }); dirtyStates.add(key); }

  // ---------- checks (buffered, capped to ~1 h) ----------
  function recordCheck(c) {
    const t = now();
    checkBuf.push({ ...c, ts: new Date(t) });
    const cutoff = t - checkMaxAgeMs;
    let drop = 0;
    while (drop < checkBuf.length && checkBuf[drop].ts.getTime() < cutoff) drop++;
    if (checkBuf.length - drop > checkMax) drop = checkBuf.length - checkMax;
    if (drop) checkBuf = checkBuf.slice(drop);
  }

  // ---------- daily rollups (memory is the source for the 90-day bars; deltas are what still has to be written) ----------
  const emptyRow = (serviceKey, day) => ({ serviceKey, day, samples: 0, up: 0, down: 0, incidentSec: 0, latSum: 0, latCount: 0, buckets: {} });
  function applyInc(row, inc) {
    for (const [k, v] of Object.entries(inc)) {
      if (k.startsWith('buckets.')) { const i = k.slice(8); row.buckets[i] = (row.buckets[i] || 0) + v; } else row[k] = (row[k] || 0) + v;
    }
  }
  function addRollup(serviceKey, day, dayStart, inc) {
    if (!rollups.has(serviceKey)) rollups.set(serviceKey, new Map());
    const days = rollups.get(serviceKey);
    if (!days.has(day)) days.set(day, emptyRow(serviceKey, day));
    applyInc(days.get(day), inc);
    const dk = `${serviceKey}|${day}`;
    const d = rollupDeltas.get(dk) || { serviceKey, day, dayStart, inc: {} };
    for (const [k, v] of Object.entries(inc)) d.inc[k] = (d.inc[k] || 0) + v;
    rollupDeltas.set(dk, d);
  }
  const rollupRows = () => {
    const cutoff = new Date(now() - 90 * DAY).toISOString().slice(0, 10);
    const out = new Map();
    for (const [key, days] of rollups) out.set(key, [...days.values()].filter((r) => r.day >= cutoff).sort((a, b) => (a.day < b.day ? -1 : 1)));
    return out;
  };

  // ---------- incidents ----------
  const isOpen = (i) => i.status !== 'resolved';
  const sameKeys = (a, b) => a.length === b.length && a.every((k, idx) => k === b[idx]);
  function openIncident(serviceKeys, title, message) {
    const existing = incidents.find((i) => isOpen(i) && sameKeys(i.serviceKeys, serviceKeys));
    if (existing) return existing;
    const doc = {
      _id: new mongoose.Types.ObjectId(), serviceKeys, title, status: 'investigating', autoCreated: true, startedAt: new Date(now()),
      updates: [{ message, status: 'investigating', author: 'system', ts: new Date(now()) }],
    };
    incidents.unshift(doc);
    pushOp({ op: 'open', doc });
    return doc;
  }
  function resolveIncident(serviceKeys, message) {
    const inc = incidents.find((i) => isOpen(i) && sameKeys(i.serviceKeys, serviceKeys));
    if (!inc) return null;
    const update = { message, status: 'resolved', author: 'system', ts: new Date(now()) };
    inc.status = 'resolved';
    inc.resolvedAt = update.ts;
    inc.updates.push(update);
    pushOp({ op: 'resolve', _id: inc._id, resolvedAt: update.ts, update });
    return inc;
  }
  function pushOp(op) { incidentOps.push(op); while (incidentOps.length > incidentOpsMax) incidentOps.shift(); }
  const slim = (i) => ({
    id: String(i._id), title: i.title, status: i.status, serviceKeys: i.serviceKeys, autoCreated: !!i.autoCreated,
    startedAt: i.startedAt, resolvedAt: i.resolvedAt || null,
    updates: (i.updates || []).map((u) => ({ message: u.message, status: u.status, author: u.author, ts: u.ts })),
  });
  function incidentsView() {
    const t = (d) => new Date(d || 0).getTime();
    return {
      active: incidents.filter(isOpen).sort((a, b) => t(b.startedAt) - t(a.startedAt)).map(slim),
      recent: incidents.filter((i) => !isOpen(i)).sort((a, b) => t(b.resolvedAt) - t(a.resolvedAt)).slice(0, 15).map(slim),
    };
  }

  // ---------- services / maintenance (cached from DB, used as-is while it is down) ----------
  const isEnabled = (key) => enabled.get(key) !== false;
  const getMaintenance = () => maintenance;
  function activeMaintenance() {
    const t = now();
    const list = maintenance.filter((m) => new Date(m.start).getTime() <= t && new Date(m.end).getTime() >= t);
    return { all: list.some((m) => !m.services?.length), keys: new Set(list.flatMap((m) => m.services || [])) };
  }
  const maintenanceView = () => maintenance
    .filter((m) => new Date(m.end).getTime() >= now())
    .map((m) => ({ id: String(m._id), services: m.services || [], start: m.start, end: m.end, note: m.note }));

  // ---------- DB: hydrate / refresh / flush ----------
  /** Merge persisted data into memory after (re)connecting. Memory wins for anything not yet flushed. */
  async function hydrate() {
    const { ServiceState, DailyRollup } = models;
    const states = await ServiceState.find({}).lean();
    for (const s of states) if (!svcStates.has(s.key)) svcStates.set(s.key, s);
    const since = new Date(now() - 90 * DAY);
    const rows = await DailyRollup.find({ dayStart: { $gte: since } }).lean();
    rollups.clear();
    for (const r of rows) {
      if (!rollups.has(r.serviceKey)) rollups.set(r.serviceKey, new Map());
      rollups.get(r.serviceKey).set(r.day, { ...emptyRow(r.serviceKey, r.day), ...r, buckets: { ...(r.buckets || {}) } });
    }
    for (const d of rollupDeltas.values()) { // unflushed increments sit on top of what the DB has
      if (!rollups.has(d.serviceKey)) rollups.set(d.serviceKey, new Map());
      const days = rollups.get(d.serviceKey);
      if (!days.has(d.day)) days.set(d.day, emptyRow(d.serviceKey, d.day));
      applyInc(days.get(d.day), d.inc);
    }
    await refresh();
  }

  async function refresh() {
    const { Service, Incident, Maintenance } = models;
    const [svcs, maint] = await Promise.all([
      Service.find({}).select('key enabled').lean(),
      Maintenance.find({ end: { $gte: new Date(now()) } }).sort({ start: 1 }).lean(),
    ]);
    for (const s of svcs) enabled.set(s.key, s.enabled !== false);
    maintenance = maint;
    if (!incidentOps.length) { // while local writes are pending, memory is newer than the DB
      const [active, recent] = await Promise.all([
        Incident.find({ status: { $ne: 'resolved' } }).sort({ startedAt: -1 }).lean(),
        Incident.find({ status: 'resolved' }).sort({ resolvedAt: -1 }).limit(15).lean(),
      ]);
      incidents = [...active, ...recent];
    }
  }

  /** Write everything buffered. Never throws: on any failure the data stays buffered for the next attempt. */
  async function flush() {
    if (flushing || !isDbUp()) return { ok: false, skipped: true };
    flushing = true;
    const { ServiceState, Check, DailyRollup, Incident } = models;
    try {
      if (dirtyStates.size) {
        const keys = [...dirtyStates]; dirtyStates.clear();
        try {
          await ServiceState.bulkWrite(keys.map((k) => {
            const { _id, createdAt, updatedAt, ...doc } = svcStates.get(k);
            return { updateOne: { filter: { key: k }, update: { $set: doc }, upsert: true } };
          }));
        } catch (e) { keys.forEach((k) => dirtyStates.add(k)); throw e; }
      }
      if (checkBuf.length) {
        const batch = checkBuf.slice();
        await Check.insertMany(batch, { ordered: false });
        checkBuf = checkBuf.slice(batch.length);
      }
      if (rollupDeltas.size) {
        const batch = rollupDeltas; rollupDeltas = new Map();
        try {
          await DailyRollup.bulkWrite([...batch.values()].map((d) => ({
            updateOne: { filter: { serviceKey: d.serviceKey, day: d.day }, update: { $inc: d.inc, $setOnInsert: { dayStart: d.dayStart } }, upsert: true },
          })));
        } catch (e) {
          for (const [k, d] of batch) { // put the increments back
            const cur = rollupDeltas.get(k) || { ...d, inc: {} };
            for (const [f, v] of Object.entries(d.inc)) cur.inc[f] = (cur.inc[f] || 0) + v;
            rollupDeltas.set(k, cur);
          }
          throw e;
        }
      }
      while (incidentOps.length) {
        const op = incidentOps[0];
        if (op.op === 'open') await Incident.updateOne({ _id: op.doc._id }, { $setOnInsert: op.doc }, { upsert: true });
        else await Incident.updateOne({ _id: op._id }, { $set: { status: 'resolved', resolvedAt: op.resolvedAt }, $push: { updates: op.update } });
        incidentOps.shift();
      }
      return { ok: true };
    } catch (e) {
      log.error('[store] flush failed, keeping data buffered:', (e.message || '').slice(0, 160));
      return { ok: false, error: e.message };
    } finally { flushing = false; }
  }

  const stats = () => ({ checksBuffered: checkBuf.length, rollupDeltas: rollupDeltas.size, incidentOps: incidentOps.length, dirtyStates: dirtyStates.size });

  return {
    getState, setState, allStates: () => svcStates,
    recordCheck, addRollup, rollupRows,
    openIncident, resolveIncident, incidentsView,
    isEnabled, activeMaintenance, getMaintenance, maintenanceView,
    hydrate, refresh, flush, stats,
  };
}
