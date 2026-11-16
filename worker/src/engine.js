import pLimit from 'p-limit';
import { cfg } from './config.js';
import { infra as infraCfg } from '../../shared/services.config.js';
import { STATE, computeRawState, debounce, bucketIndex } from '../../shared/status.js';
import { httpProbe } from './probes/http.js';
import { dnsProbe, tlsProbe, mongoProbe } from './probes/net.js';

const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
const dayKey = (d = new Date()) => DAY_FMT.format(d);
const BAD = new Set([STATE.DOWN, STATE.UPSTREAM, STATE.DB_IMPACTED]);

export function createEngine({ models, alerter, log = console }) {
  const { Service, Check, DailyRollup, ServiceState, Incident, Maintenance } = models;
  const limit = pLimit(cfg.maxConcurrent);
  const latencies = new Map();   // serviceKey -> last 30 internal latencies
  const lastRun = new Map();     // serviceKey|'infra' -> ms
  const infraStates = {};        // dns|gateway|tls|mongo -> committed state
  let upstreamDown = false;
  let dbDown = false;
  let tlsCache = { at: 0, result: null };
  let lastInfraResult = {};

  // ---------- helpers ----------
  async function record(serviceKey, probeType, r) {
    if (!r) return;
    await Check.create({
      serviceKey, probeType, ok: r.ok ?? null, statusCode: r.statusCode ?? null,
      latencyMs: r.latencyMs ?? null, error: r.error ?? null,
    }).catch((e) => log.error('[check] save failed', e.message));
  }

  async function applyState(key, kind, raw, extra = {}) {
    const doc = await ServiceState.findOne({ key }).lean();
    const next = debounce(doc, raw);
    const set = { kind, state: next.state, pending: next.pending, pendingCount: next.pendingCount, ...extra };
    if (next.changed) set.lastChange = new Date();
    await ServiceState.updateOne({ key }, { $set: set }, { upsert: true });
    return next;
  }

  async function openIncident(serviceKeys, title, message) {
    const exists = await Incident.findOne({ serviceKeys, status: { $ne: 'resolved' } }).lean();
    if (exists) return exists;
    return Incident.create({
      serviceKeys, title, autoCreated: true, status: 'investigating',
      updates: [{ message, status: 'investigating', author: 'system' }],
    });
  }

  async function resolveIncident(serviceKeys, message) {
    const inc = await Incident.findOne({ serviceKeys, status: { $ne: 'resolved' } });
    if (!inc) return;
    inc.status = 'resolved';
    inc.resolvedAt = new Date();
    inc.updates.push({ message, status: 'resolved', author: 'system' });
    await inc.save();
  }

  async function rollup(key, state, latencyMs, intervalSec) {
    if (state === STATE.MAINTENANCE || state === STATE.UNKNOWN) return;
    const up = state === STATE.OPERATIONAL || state === STATE.DEGRADED;
    const day = dayKey();
    const inc = { samples: 1, up: up ? 1 : 0, down: up ? 0 : 1, incidentSec: up ? 0 : intervalSec };
    if (Number.isFinite(latencyMs)) {
      inc.latSum = latencyMs; inc.latCount = 1;
      inc[`buckets.${bucketIndex(latencyMs)}`] = 1;
    }
    await DailyRollup.updateOne(
      { serviceKey: key, day },
      { $inc: inc, $setOnInsert: { dayStart: new Date(`${day}T00:00:00+05:30`) } },
      { upsert: true },
    ).catch((e) => log.error('[rollup] failed', e.message));
  }

  // ---------- infrastructure ----------
  async function runInfra() {
    lastRun.set('infra', Date.now());
    const tlsDue = Date.now() - tlsCache.at > infraCfg.tls.recheckMin * 60 * 1000;
    const [dns, gateway, mongo, tls] = await Promise.all([
      dnsProbe(infraCfg.dnsHost),
      httpProbe(infraCfg.gatewayUrl, { timeoutMs: cfg.timeoutMs }),
      mongoProbe(infraCfg.mongo),
      tlsDue ? tlsProbe(infraCfg.tls) : Promise.resolve(tlsCache.result),
    ]);
    if (tlsDue) tlsCache = { at: Date.now(), result: tls };
    lastInfraResult = { dns, gateway, mongo, tls };

    const tlsRaw = tls?.ok && tls.daysLeft >= infraCfg.tls.warnDays ? STATE.OPERATIONAL : STATE.DEGRADED;
    const raws = {
      dns: dns.ok ? STATE.OPERATIONAL : STATE.DOWN,
      gateway: gateway.ok ? STATE.OPERATIONAL : STATE.DOWN,
      mongo: mongo.ok ? STATE.OPERATIONAL : STATE.DOWN,
      tls: tlsRaw,
    };
    const results = { dns, gateway, mongo, tls };
    for (const [name, raw] of Object.entries(raws)) {
      const next = await applyState(`infra:${name}`, 'infra', raw, {
        latencyMs: results[name]?.latencyMs ?? null, detail: results[name],
      });
      infraStates[name] = next.state;
      if (name !== 'tls' || tlsDue) await record(`infra:${name}`, name, results[name]);
    }

    // Derived nodes. One incident + one alert for the whole upstream / database problem.
    const upNow = infraStates.dns === STATE.DOWN || infraStates.gateway === STATE.DOWN;
    const dbNow = infraStates.mongo === STATE.DOWN;
    if (upNow !== upstreamDown) {
      if (upNow) {
        await openIncident(['infra:upstream'], 'Campus network (iitg.ac.in) issue', 'iitg.ac.in DNS or the campus gateway is not reachable from the server. Portals may be healthy; public access is affected.');
        alerter.enqueue({ kind: 'upstream', key: 'upstream', title: 'Upstream / campus network issue', text: 'iitg.ac.in is not reachable from the server (DNS or gateway). Applications may still be running.' });
      } else {
        await resolveIncident(['infra:upstream'], 'iitg.ac.in is reachable again.');
        alerter.enqueue({ kind: 'recovered', key: 'upstream', title: 'Upstream recovered', text: 'iitg.ac.in is reachable again.' });
      }
      upstreamDown = upNow;
    }
    if (dbNow !== dbDown) {
      if (dbNow) {
        await openIncident(['infra:database'], 'Shared database down', 'The shared MongoDB on the server is not responding. Dependent portals are impacted.');
        alerter.enqueue({ kind: 'database', key: 'database', title: 'Shared database down', text: 'The host MongoDB (127.0.0.1:27017) is not responding. Dependent portals are impacted.' });
      } else {
        await resolveIncident(['infra:database'], 'The shared database is responding again.');
        alerter.enqueue({ kind: 'recovered', key: 'database', title: 'Shared database recovered', text: 'The host MongoDB is responding again.' });
      }
      dbDown = dbNow;
    }
  }

  // ---------- services ----------
  async function checkService(svc, dockerMap, dockerError, maintenanceNow) {
    const key = svc.key;
    const intervalSec = svc.intervalSec || cfg.intervalSec;
    lastRun.set(key, Date.now());
    const probes = {};

    if (svc.container) {
      if (dockerError || !dockerMap) probes.container = { ok: null, error: 'docker api unavailable' };
      else {
        const c = dockerMap.get(svc.container);
        probes.container = c
          ? { ok: c.ok, state: c.state, restartCount: c.restartCount, uptimeSec: c.uptimeSec, restartLoop: c.restartLoop, exitCode: c.exitCode, error: c.error }
          : { ok: false, state: 'missing', error: 'container not found' };
      }
    }
    if (svc.internal?.port) {
      const url = `http://${cfg.probeHost}:${svc.internal.port}${svc.internal.path || '/'}`;
      probes.internal = await httpProbe(url, { timeoutMs: cfg.timeoutMs, expect: svc.internal.expect });
    }
    if (svc.public?.url) {
      probes.public = await httpProbe(svc.public.url, { timeoutMs: cfg.timeoutMs, expect: svc.public.expect });
    }
    if (svc.public?.url && tlsCache.result) {
      probes.tls = { ok: tlsCache.result.ok, daysLeft: tlsCache.result.daysLeft, validTo: tlsCache.result.validTo, error: tlsCache.result.error };
    }

    for (const t of ['container', 'internal', 'public']) await record(key, t, probes[t]);

    if (probes.internal?.latencyMs != null && probes.internal.ok) {
      const l = latencies.get(key) || [];
      l.push(probes.internal.latencyMs);
      latencies.set(key, l.slice(-30));
    }

    const raw = computeRawState({
      service: svc, probes: { container: probes.container, internal: probes.internal, public: probes.public },
      infra: { upstreamDown, dbDown }, maintenance: maintenanceNow, latencies: latencies.get(key) || [], slowMs: cfg.slowMs,
    });
    const next = await applyState(key, 'service', raw, {
      latencyMs: probes.internal?.latencyMs ?? probes.public?.latencyMs ?? null, probes,
    });
    await rollup(key, next.state, probes.internal?.ok ? probes.internal.latencyMs : null, intervalSec);

    if (next.changed) await onTransition(svc, next.from, next.state, probes);
    return next.state;
  }

  async function onTransition(svc, from, to, probes) {
    log.log(`[state] ${svc.key}: ${from} -> ${to}`);
    if (to === STATE.DOWN) {
      const why = probes.container?.error || probes.internal?.error || 'probe failed';
      await openIncident([svc.key], `${svc.name} is down`, `Automatic: ${why}`);
      alerter.enqueue({ kind: 'down', key: svc.key, title: `DOWN: ${svc.name}`, text: `Reason: ${why}` });
    } else if (from === STATE.DOWN && to !== STATE.MAINTENANCE) {
      await resolveIncident([svc.key], `${svc.name} recovered.`);
      alerter.enqueue({ kind: 'recovered', key: svc.key, title: `RECOVERED: ${svc.name}`, text: `Now ${to}.` });
    }
    // upstream_outage / db_impacted are covered by one infra-level incident + alert, not per service.
  }

  async function activeMaintenance() {
    const now = new Date();
    const list = await Maintenance.find({ start: { $lte: now }, end: { $gte: now } }).lean();
    const all = list.some((m) => !m.services?.length);
    return { all, keys: new Set(list.flatMap((m) => m.services || [])) };
  }

  /** Runs every due (or forced) service check. Returns the number of services checked. */
  async function runServices(dockerMap, dockerError, { only, force } = {}) {
    const services = await Service.find({ enabled: true }).lean();
    const m = await activeMaintenance();
    const now = Date.now();
    const due = services.filter((s) => {
      if (only) return only === s.key;
      if (force) return true;
      return now - (lastRun.get(s.key) || 0) >= (s.intervalSec || cfg.intervalSec) * 1000 - 500;
    });
    await Promise.all(due.map((s) => limit(() =>
      checkService(s, dockerMap, dockerError, m.all || m.keys.has(s.key)).catch((e) => log.error(`[check] ${s.key} failed`, e)))));
    return due.length;
  }

  const infraDue = () => Date.now() - (lastRun.get('infra') || 0) >= cfg.intervalSec * 1000 - 500;

  async function loadState() {
    const docs = await ServiceState.find({ kind: 'infra' }).lean();
    for (const d of docs) infraStates[d.key.replace('infra:', '')] = d.state;
    upstreamDown = infraStates.dns === STATE.DOWN || infraStates.gateway === STATE.DOWN;
    dbDown = infraStates.mongo === STATE.DOWN;
  }

  return {
    runInfra, runServices, infraDue, loadState,
    getInfra: () => ({ upstreamDown, dbDown, states: { ...infraStates }, last: lastInfraResult }),
  };
}
