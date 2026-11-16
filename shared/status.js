// Pure status logic: no I/O, fully unit-tested (status.test.js).

export const STATE = Object.freeze({
  OPERATIONAL: 'operational',
  DEGRADED: 'degraded',
  DOWN: 'down',
  NGINX: 'nginx_issue',
  UPSTREAM: 'upstream_outage',
  DB_IMPACTED: 'db_impacted',
  MAINTENANCE: 'maintenance',
  UNKNOWN: 'unknown',
});

export const INCIDENT_STATUS = ['investigating', 'identified', 'monitoring', 'resolved'];

// How bad a state is; used to choose the debounce threshold (worse = 3 fails, better = 2 successes).
const SEVERITY = {
  operational: 0, maintenance: 0, unknown: 0,
  degraded: 1, nginx_issue: 2, upstream_outage: 2, db_impacted: 2, down: 3,
};
export const severity = (s) => SEVERITY[s] ?? 0;

export function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const idx = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return v[idx];
}

export const REASON = Object.freeze({
  nginx: 'App port is up but the host nginx path is not responding',
  upstream: 'Public URL unreachable while iitg.ac.in is down (campus network / upstream)',
  proxyRoute: 'IITG proxy route issue for this path (app and host nginx are fine, iitg.ac.in is reachable)',
  db: 'Shared database is down',
});

/**
 * Instant (pre-debounce) state of one service for this cycle, with a human reason.
 * Three probe tiers, innermost first:  internal (app port)  ->  nginx (host nginx path)  ->  public (iitg.ac.in).
 * probes.<x>.ok is true | false | null (null = could not be determined, e.g. Docker API unreachable).
 * infra = { upstreamDown, dbDown } taken from the *committed* (debounced) infra states.
 */
export function evaluateState({ service, probes = {}, infra = {}, maintenance = false, latencies = [], slowMs = 2000 }) {
  const out = (state, reason = null) => ({ state, reason });
  if (maintenance) return out(STATE.MAINTENANCE, 'Scheduled maintenance');
  const { container, internal, nginx, public: pub } = probes;

  if (container?.ok === false) return out(STATE.DOWN, container.error || 'Container not running');
  if (infra.dbDown && service?.dependsOnDb) return out(STATE.DB_IMPACTED, REASON.db);
  if (internal?.ok === false) return out(STATE.DOWN, `App port not responding${internal.error ? ` (${internal.error})` : ''}`);
  if (nginx?.ok === false) return out(STATE.NGINX, REASON.nginx);
  if (pub?.ok === false) {
    return infra.upstreamDown ? out(STATE.UPSTREAM, REASON.upstream) : out(STATE.DEGRADED, REASON.proxyRoute);
  }

  const known = [container, internal, nginx, pub].some((p) => p && p.ok === true);
  if (!known) return out(STATE.UNKNOWN, 'No probe could be evaluated');

  if (latencies.length >= 5 && percentile(latencies, 95) > slowMs) {
    return out(STATE.DEGRADED, `Slow responses (p95 above ${slowMs} ms)`);
  }
  return out(STATE.OPERATIONAL);
}

export const computeRawState = (args) => evaluateState(args).state;

/**
 * Anti-flapping. `prev` = { state, pending, pendingCount }.
 * - first ever observation commits immediately
 * - entering/leaving maintenance is immediate
 * - worsening needs `failThreshold` consecutive identical raw states (default 3)
 * - improving needs `recoverThreshold` (default 2)
 */
export function debounce(prev, raw, { failThreshold = 3, recoverThreshold = 2 } = {}) {
  const p = prev && prev.state ? prev : { state: STATE.UNKNOWN, pending: null, pendingCount: 0 };
  const commit = (state) => ({ state, pending: null, pendingCount: 0, changed: state !== p.state, from: p.state });

  if (p.state === STATE.UNKNOWN) return commit(raw);
  if (raw === STATE.MAINTENANCE || p.state === STATE.MAINTENANCE) return commit(raw);
  if (raw === p.state) return commit(raw);

  if (raw === STATE.UNKNOWN) return { state: p.state, pending: null, pendingCount: 0, changed: false, from: p.state };

  const count = raw === p.pending ? (p.pendingCount || 0) + 1 : 1;
  const need = severity(raw) < severity(p.state) ? recoverThreshold : failThreshold;
  if (count >= need) return commit(raw);
  return { state: p.state, pending: raw, pendingCount: count, changed: false, from: p.state };
}

/** Overall banner from enabled services' committed states + infra. */
export function computeOverall(services, infra = {}) {
  if (infra.upstreamDown) {
    return { status: 'upstream', message: 'Campus network (iitg.ac.in) issue detected' };
  }
  if (infra.nginxDown) {
    return { status: 'nginx', message: 'Server nginx issue detected' };
  }
  if (infra.dbDown) {
    return { status: 'database', message: 'Shared database down' };
  }
  const live = services.filter((s) => s.state !== STATE.MAINTENANCE && s.state !== STATE.UNKNOWN);
  const down = live.filter((s) => [STATE.DOWN, STATE.UPSTREAM, STATE.DB_IMPACTED, STATE.NGINX].includes(s.state)).length;
  const degraded = live.filter((s) => s.state === STATE.DEGRADED).length;
  if (live.length && down >= Math.ceil(live.length / 2)) return { status: 'major', message: 'Major outage' };
  if (down > 0) return { status: 'partial', message: 'Partial outage' };
  if (degraded > 0) return { status: 'degraded', message: 'Degraded performance' };
  if (services.length && services.every((s) => s.state === STATE.MAINTENANCE)) {
    return { status: 'maintenance', message: 'Scheduled maintenance' };
  }
  return { status: 'operational', message: 'All systems operational' };
}

/** Latency bucket upper bounds (ms) for daily p95 estimation. */
export const LATENCY_BUCKETS = [50, 100, 200, 500, 1000, 2000, 5000, Infinity];
export const bucketIndex = (ms) => LATENCY_BUCKETS.findIndex((b) => ms <= b);

export function p95FromBuckets(buckets = {}) {
  const counts = LATENCY_BUCKETS.map((_, i) => Number(buckets[i] || 0));
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  let acc = 0;
  for (let i = 0; i < counts.length; i++) {
    acc += counts[i];
    if (acc >= total * 0.95) return Number.isFinite(LATENCY_BUCKETS[i]) ? LATENCY_BUCKETS[i] : 5000;
  }
  return null;
}
