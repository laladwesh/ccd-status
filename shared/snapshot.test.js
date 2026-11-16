import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from './snapshot.js';
import { STATE } from './status.js';

const services = [
  { key: 'a', name: 'A', group: 'Placement', order: 1, quality: 'basic', enabled: true, public: { url: 'https://x/' } },
  { key: 'b', name: 'B', group: 'Others', order: 2, quality: 'health', enabled: true },
  { key: 'off', name: 'Off', group: 'Others', order: 3, enabled: false },
];

test('Mongo down: a snapshot with the "Shared database down" banner is still produced from memory alone', () => {
  const states = new Map([
    ['a', { state: STATE.DB_IMPACTED, reason: 'Shared database is down', probes: { internal: { ok: true } } }],
    ['b', { state: STATE.DB_IMPACTED, probes: {} }],
    ['infra:mongo', { state: STATE.DOWN, detail: { error: 'MongoServerSelectionError' } }],
    ['infra:dns', { state: STATE.OPERATIONAL }],
  ]);
  // no rollups, no incidents, no maintenance (nothing could be read from the database), dbConnected=false
  const snap = buildSnapshot({ services, states, infraFlags: { dbDown: true }, dbConnected: false });
  assert.equal(snap.overall.status, 'database');
  assert.equal(snap.overall.message, 'Shared database down');
  assert.equal(snap.infra.database.state, STATE.DOWN);
  assert.equal(snap.services.length, 2, 'disabled services are not published');
  assert.equal(snap.services[0].state, STATE.DB_IMPACTED);
  assert.deepEqual(snap.services[0].days, []);
  assert.equal(snap.dbConnected, false);
  assert.ok(Number.isFinite(Date.parse(snap.generatedAt)));
  JSON.parse(JSON.stringify(snap)); // serialisable for status.json
});

test('upstream outranks everything in the banner; operational otherwise', () => {
  const states = new Map([['a', { state: STATE.UPSTREAM }], ['b', { state: STATE.UPSTREAM }]]);
  assert.equal(buildSnapshot({ services, states, infraFlags: { upstreamDown: true, dbDown: true } }).overall.status, 'upstream');
  const ok = new Map([['a', { state: STATE.OPERATIONAL }], ['b', { state: STATE.OPERATIONAL }]]);
  assert.equal(buildSnapshot({ services, states: ok }).overall.status, 'operational');
});

test('90-day uptime comes from the in-memory rollups', () => {
  const rollups = new Map([['a', [
    { day: '2026-11-16', up: 99, down: 1, incidentSec: 60, latSum: 1000, latCount: 10, buckets: { 0: 10 } },
    { day: '2026-11-17', up: 10, down: 0, incidentSec: 0, latSum: 0, latCount: 0 },
  ]]]);
  const snap = buildSnapshot({ services, states: new Map(), rollups });
  const a = snap.services.find((s) => s.key === 'a');
  assert.equal(a.days[0].u, 99);
  assert.equal(a.days[0].m, 1);
  assert.equal(a.days[0].l, 100);
  assert.equal(a.uptimePct, Math.round((109 / 110) * 10000) / 100);
});
