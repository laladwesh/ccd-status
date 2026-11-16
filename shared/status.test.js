import test from 'node:test';
import assert from 'node:assert/strict';
import { STATE, computeRawState, debounce, computeOverall, percentile, p95FromBuckets } from './status.js';

const svc = { key: 'x', dependsOnDb: true };
const ok = { ok: true };
const bad = { ok: false };
const run = (prev, raws) => raws.reduce((st, raw) => ({ ...debounce(st, raw) }), prev);

test('first observation commits immediately', () => {
  const r = debounce(null, STATE.DOWN);
  assert.equal(r.state, STATE.DOWN);
  assert.equal(r.changed, true);
});

test('flapping: 2 failures do not change state, the 3rd does', () => {
  let st = { state: STATE.OPERATIONAL };
  st = debounce(st, STATE.DOWN); assert.equal(st.state, STATE.OPERATIONAL); assert.equal(st.changed, false);
  st = debounce(st, STATE.DOWN); assert.equal(st.state, STATE.OPERATIONAL);
  st = debounce(st, STATE.DOWN); assert.equal(st.state, STATE.DOWN); assert.equal(st.changed, true);
});

test('flapping: alternating fail/ok never changes state', () => {
  const st = run({ state: STATE.OPERATIONAL }, [STATE.DOWN, STATE.OPERATIONAL, STATE.DOWN, STATE.OPERATIONAL, STATE.DOWN]);
  assert.equal(st.state, STATE.OPERATIONAL);
});

test('recovery needs 2 consecutive successes', () => {
  let st = debounce({ state: STATE.DOWN }, STATE.OPERATIONAL);
  assert.equal(st.state, STATE.DOWN);
  st = debounce(st, STATE.OPERATIONAL);
  assert.equal(st.state, STATE.OPERATIONAL);
  assert.equal(st.changed, true);
});

test('a different pending state restarts the count', () => {
  let st = { state: STATE.OPERATIONAL };
  st = debounce(st, STATE.DOWN);
  st = debounce(st, STATE.DOWN);
  st = debounce(st, STATE.DEGRADED); // changes the candidate, count resets
  assert.equal(st.state, STATE.OPERATIONAL);
  assert.equal(st.pendingCount, 1);
});

test('upstream detection: internal ok + public failing + iitg.ac.in down => upstream_outage', () => {
  const probes = { internal: ok, public: bad };
  assert.equal(computeRawState({ service: svc, probes, infra: { upstreamDown: true } }), STATE.UPSTREAM);
  assert.equal(computeRawState({ service: svc, probes, infra: { upstreamDown: false } }), STATE.DEGRADED);
});

test('internal failure is DOWN even while upstream is down', () => {
  const probes = { internal: bad, public: bad };
  assert.equal(computeRawState({ service: svc, probes, infra: { upstreamDown: true } }), STATE.DOWN);
});

test('restart-looping container is DOWN even if internal probe passes', () => {
  assert.equal(computeRawState({ service: svc, probes: { container: bad, internal: ok } }), STATE.DOWN);
});

test('database down => dependents are db_impacted, not down; container down still wins', () => {
  const infra = { dbDown: true };
  assert.equal(computeRawState({ service: svc, probes: { container: ok, internal: bad }, infra }), STATE.DB_IMPACTED);
  assert.equal(computeRawState({ service: { dependsOnDb: false }, probes: { internal: bad }, infra }), STATE.DOWN);
  assert.equal(computeRawState({ service: svc, probes: { container: bad }, infra }), STATE.DOWN);
});

test('maintenance overrides everything and is immediate in and out', () => {
  assert.equal(computeRawState({ service: svc, probes: { internal: bad }, maintenance: true }), STATE.MAINTENANCE);
  const into = debounce({ state: STATE.OPERATIONAL }, STATE.MAINTENANCE);
  assert.equal(into.state, STATE.MAINTENANCE);
  const out = debounce({ state: STATE.MAINTENANCE }, STATE.DOWN);
  assert.equal(out.state, STATE.DOWN);
});

test('slow p95 => degraded; needs enough samples', () => {
  const slow = [3000, 3100, 2900, 3200, 3000, 3300];
  assert.equal(computeRawState({ service: svc, probes: { internal: ok }, latencies: slow }), STATE.DEGRADED);
  assert.equal(computeRawState({ service: svc, probes: { internal: ok }, latencies: [3000, 3000] }), STATE.OPERATIONAL);
});

test('unknown when nothing could be determined (e.g. Docker API unreachable)', () => {
  assert.equal(computeRawState({ service: svc, probes: { container: { ok: null } } }), STATE.UNKNOWN);
});

test('overall banner: upstream/database take precedence over per-service counts', () => {
  const s = [{ state: STATE.UPSTREAM }, { state: STATE.UPSTREAM }];
  assert.equal(computeOverall(s, { upstreamDown: true }).status, 'upstream');
  assert.equal(computeOverall(s, { dbDown: true }).status, 'database');
});

test('overall banner: operational / partial / major / maintenance', () => {
  const o = STATE.OPERATIONAL;
  assert.equal(computeOverall([{ state: o }, { state: o }]).status, 'operational');
  assert.equal(computeOverall([{ state: o }, { state: o }, { state: o }, { state: STATE.DOWN }]).status, 'partial');
  assert.equal(computeOverall([{ state: o }, { state: STATE.DOWN }]).status, 'major');
  assert.equal(computeOverall([{ state: STATE.MAINTENANCE }]).status, 'maintenance');
});

test('percentile helpers', () => {
  assert.equal(percentile([1, 2, 3, 4, 100], 95), 100);
  assert.equal(percentile([], 95), null);
  assert.equal(p95FromBuckets({ 0: 90, 3: 10 }), 500);
});
