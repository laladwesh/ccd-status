// Check engine. All state lives in the in-memory `store` (see store.js): this file never touches the
// database, so every probe, state change, incident and alert keeps working while MongoDB is down.
import pLimit from 'p-limit';
import { cfg } from './config.js';
import { infra as infraCfg } from '../../shared/services.config.js';
import { STATE, evaluateState, debounce, bucketIndex } from '../../shared/status.js';
import { httpProbe } from './probes/http.js';
import { dnsProbe, tlsProbe, mongoProbe, tcpProbe } from './probes/net.js';

const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
const dayKey = (d = new Date()) => DAY_FMT.format(d);

export function createEngine({ store, alerter, getServices, mongoTarget = infraCfg.mongo, log = console }) {
  const limit = pLimit(cfg.maxConcurrent);
  const latencies = new Map();   // serviceKey -> last 30 internal latencies
  const lastRun = new Map();     // serviceKey | 'infra' -> ms
  const infraStates = {};        // dns|gateway|tls|mongo|nginx -> committed state
  let upstreamDown = false;
  let dbDown = false;
  let nginxDown = false;
  let tlsCache = { at: 0, result: null };

  // ---------- helpers ----------
  const record = (serviceKey, probeType, r) => {
    if (!r) return;
    store.recordCheck({ serviceKey, probeType, ok: r.ok ?? null, statusCode: r.statusCode ?? null, latencyMs: r.latencyMs ?? null, error: r.error ?? null });
  };

  /** Debounce against the in-memory previous state and commit the new state. */
  function commit(key, kind, raw, extra = {}, reasonFor) {
    const prev = store.getState(key);
    const next = debounce(prev, raw);
    const doc = {
      ...(prev || {}), kind, state: next.state, pending: next.pending, pendingCount: next.pendingCount,
      lastChange: next.changed ? new Date() : prev?.lastChange, ...extra,
    };
    if (reasonFor) doc.reason = reasonFor(next);
    store.setState(key, doc);
    return next;
  }

  function rollup(key, state, latencyMs, intervalSec) {
    if (state === STATE.MAINTENANCE || state === STATE.UNKNOWN) return;
    const up = state === STATE.OPERATIONAL || state === STATE.DEGRADED;
    const day = dayKey();
    const inc = { samples: 1, up: up ? 1 : 0, down: up ? 0 : 1, incidentSec: up ? 0 : intervalSec };
    if (Number.isFinite(latencyMs)) {
      inc.latSum = latencyMs; inc.latCount = 1;
      inc[`buckets.${bucketIndex(latencyMs)}`] = 1;
    }
    store.addRollup(key, day, new Date(`${day}T00:00:00+05:30`), inc);
  }

  // ---------- infrastructure ----------
  async function runInfra() {
    lastRun.set('infra', Date.now());
    const tlsDue = Date.now() - tlsCache.at > infraCfg.tls.recheckMin * 60 * 1000;
    const [dns, gateway, mongo, tls, nginxTcp] = await Promise.all([
      dnsProbe(infraCfg.dnsHost),
      httpProbe(infraCfg.gatewayUrl, { timeoutMs: cfg.timeoutMs }),
      mongoProbe(mongoTarget),
      tlsDue ? tlsProbe(infraCfg.tls) : Promise.resolve(tlsCache.result),
      tcpProbe(infraCfg.nginx.host, infraCfg.nginx.port),
    ]);
    if (tlsDue) tlsCache = { at: Date.now(), result: tls };

    // Host nginx is down if its port refuses connections, or if EVERY service whose app port is
    // healthy fails through nginx (needs 2+ such services, so one bad route is not an nginx outage).
    const withNginx = [...store.allStates().values()].filter((s) => s.kind === 'service' && s.probes?.nginx && s.probes?.internal?.ok === true);
    const nginxAllFail = withNginx.length >= 2 && withNginx.every((s) => s.probes.nginx.ok === false);
    const nginx = nginxTcp.ok && !nginxAllFail
      ? { ok: true, latencyMs: nginxTcp.latencyMs, error: null }
      : { ok: false, latencyMs: nginxTcp.latencyMs, error: nginxTcp.ok ? 'all nginx routes failing while the apps are up' : nginxTcp.error };

    const tlsRaw = tls?.ok && tls.daysLeft >= infraCfg.tls.warnDays ? STATE.OPERATIONAL : STATE.DEGRADED;
    const raws = {
      dns: dns.ok ? STATE.OPERATIONAL : STATE.DOWN,
      gateway: gateway.ok ? STATE.OPERATIONAL : STATE.DOWN,
      mongo: mongo.ok ? STATE.OPERATIONAL : STATE.DOWN,
      nginx: nginx.ok ? STATE.OPERATIONAL : STATE.DOWN,
      tls: tlsRaw,
    };
    const results = { dns, gateway, mongo, tls, nginx };
    for (const [name, raw] of Object.entries(raws)) {
      const next = commit(`infra:${name}`, 'infra', raw, { latencyMs: results[name]?.latencyMs ?? null, detail: results[name] });
      infraStates[name] = next.state;
      if (name !== 'tls' || tlsDue) record(`infra:${name}`, name, results[name]);
    }

    // Derived nodes. One incident + one alert for the whole upstream / database / nginx problem.
    const upNow = infraStates.dns === STATE.DOWN || infraStates.gateway === STATE.DOWN;
    const dbNow = infraStates.mongo === STATE.DOWN;
    const nginxNow = infraStates.nginx === STATE.DOWN;
    if (upNow !== upstreamDown) {
      if (upNow) {
        store.openIncident(['infra:upstream'], 'Campus network (iitg.ac.in) issue', 'iitg.ac.in DNS or the campus gateway is not reachable from the server. Portals may be healthy; public access is affected.');
        alerter.enqueue({ kind: 'upstream', key: 'upstream', title: 'Upstream / campus network issue', text: 'iitg.ac.in is not reachable from the server (DNS or gateway). Applications may still be running.' });
      } else {
        store.resolveIncident(['infra:upstream'], 'iitg.ac.in is reachable again.');
        alerter.enqueue({ kind: 'recovered', key: 'upstream', title: 'Upstream recovered', text: 'iitg.ac.in is reachable again.' });
      }
      upstreamDown = upNow;
    }
    if (dbNow !== dbDown) {
      if (dbNow) {
        store.openIncident(['infra:database'], 'Shared database down', 'The shared MongoDB on the server is not responding. Dependent portals are impacted. History is temporarily unavailable.');
        alerter.enqueue({ kind: 'database', key: 'database', title: 'Shared database down', text: 'The host MongoDB is not responding. Dependent portals are impacted.' });
      } else {
        store.resolveIncident(['infra:database'], 'The shared database is responding again.');
        alerter.enqueue({ kind: 'recovered', key: 'database', title: 'Shared database recovered', text: 'The host MongoDB is responding again.' });
      }
      dbDown = dbNow;
    }
    if (nginxNow !== nginxDown) {
      if (nginxNow) {
        store.openIncident(['infra:nginx'], 'Server nginx issue', 'The host nginx is not serving the portals correctly (port refused, or every route fails while the apps are up). Public access is affected; the apps themselves may be running.');
        alerter.enqueue({ kind: 'nginx', key: 'nginx', title: 'Server nginx issue', text: 'Host nginx on the server is not serving the portal routes. The apps themselves may be running.' });
      } else {
        store.resolveIncident(['infra:nginx'], 'Host nginx is serving the portals again.');
        alerter.enqueue({ kind: 'recovered', key: 'nginx', title: 'Host nginx recovered', text: 'Host nginx is serving the portal routes again.' });
      }
      nginxDown = nginxNow;
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
    if (svc.nginx?.path) {
      const n = infraCfg.nginx;
      probes.nginx = await httpProbe(`http://${n.host}:${n.port}${svc.nginx.path}`, {
        timeoutMs: cfg.timeoutMs, expect: svc.nginx.expect, headers: { host: n.hostHeader },
      });
    }
    if (svc.public?.url) {
      probes.public = await httpProbe(svc.public.url, { timeoutMs: cfg.timeoutMs, expect: svc.public.expect });
    }
    if (svc.public?.url && tlsCache.result) {
      probes.tls = { ok: tlsCache.result.ok, daysLeft: tlsCache.result.daysLeft, validTo: tlsCache.result.validTo, error: tlsCache.result.error };
    }

    for (const t of ['container', 'internal', 'nginx', 'public']) record(key, t, probes[t]);

    if (probes.internal?.latencyMs != null && probes.internal.ok) {
      const l = latencies.get(key) || [];
      l.push(probes.internal.latencyMs);
      latencies.set(key, l.slice(-30));
    }

    const verdict = evaluateState({
      service: svc,
      probes: { container: probes.container, internal: probes.internal, nginx: probes.nginx, public: probes.public },
      infra: { upstreamDown, dbDown, nginxDown }, maintenance: maintenanceNow, latencies: latencies.get(key) || [], slowMs: cfg.slowMs,
    });
    // The reason shown to users follows the *committed* state (the instant verdict may still be debouncing).
    const next = commit(key, 'service', verdict.state, {
      latencyMs: probes.internal?.latencyMs ?? probes.public?.latencyMs ?? null, probes,
    }, (n) => (n.state === STATE.DOWN && svc.knownIssue ? svc.knownIssue : n.state === verdict.state ? verdict.reason : null));
    rollup(key, next.state, probes.internal?.ok ? probes.internal.latencyMs : null, intervalSec);

    if (next.changed) onTransition(svc, next.from, next.state, probes, verdict.reason);
    return next.state;
  }

  function onTransition(svc, from, to, probes, reason) {
    log.log(`[state] ${svc.key}: ${from} -> ${to}`);
    if (to === STATE.DOWN) {
      const why = probes.container?.error || probes.internal?.error || 'probe failed';
      store.openIncident([svc.key], `${svc.name} is down`, `Automatic: ${why}`);
      alerter.enqueue({ kind: 'down', key: svc.key, title: `DOWN: ${svc.name}`, text: `Reason: ${why}` });
    } else if (from === STATE.DOWN && to !== STATE.MAINTENANCE) {
      store.resolveIncident([svc.key], `${svc.name} recovered.`);
      alerter.enqueue({ kind: 'recovered', key: svc.key, title: `RECOVERED: ${svc.name}`, text: `Now ${to}.` });
    }
    if (to === STATE.NGINX && !nginxDown) {
      // One route failing through nginx (not a whole-nginx outage) is its own incident.
      store.openIncident([svc.key], `${svc.name} unreachable through host nginx`, `Automatic: ${reason}`);
      alerter.enqueue({ kind: 'down', key: svc.key, title: `NGINX ROUTE: ${svc.name}`, text: reason });
    } else if (from === STATE.NGINX && to !== STATE.MAINTENANCE) {
      store.resolveIncident([svc.key], `${svc.name} is reachable through host nginx again.`);
    }
    // upstream_outage / db_impacted / whole-nginx outage are covered by one infra-level incident + alert, not per service.
  }

  /** Runs every due (or forced) service check. Returns the number of services checked. */
  async function runServices(dockerMap, dockerError, { only, force } = {}) {
    const services = getServices();
    const m = store.activeMaintenance();
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

  /** Re-derive the committed infra flags from the store (after a hydrate). */
  function syncFromStore() {
    for (const [key, s] of store.allStates()) if (key.startsWith('infra:')) infraStates[key.replace('infra:', '')] = s.state;
    upstreamDown = infraStates.dns === STATE.DOWN || infraStates.gateway === STATE.DOWN;
    dbDown = infraStates.mongo === STATE.DOWN;
    nginxDown = infraStates.nginx === STATE.DOWN;
  }

  return {
    runInfra, runServices, infraDue, syncFromStore,
    getInfra: () => ({ upstreamDown, dbDown, nginxDown, states: { ...infraStates } }),
  };
}
