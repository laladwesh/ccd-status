import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from './store.js';

const quiet = { log() {}, error() {} };

// A fake "database" whose availability can be toggled. Records what was written.
function fakeDb() {
  const db = { up: true, checks: [], states: [], rollups: [], incidents: [] };
  const guard = () => { if (!db.up) throw new Error('MongoNotConnected'); };
  db.models = {
    Check: { insertMany: async (docs) => { guard(); db.checks.push(...docs); } },
    ServiceState: { bulkWrite: async (ops) => { guard(); db.states.push(...ops); }, find: () => ({ lean: async () => [] }) },
    DailyRollup: { bulkWrite: async (ops) => { guard(); db.rollups.push(...ops); }, find: () => ({ lean: async () => [] }) },
    Incident: { updateOne: async (...a) => { guard(); db.incidents.push(a); } },
    Service: {}, Maintenance: {},
  };
  return db;
}

const mk = (db, extra = {}) => createStore({ models: db.models, log: quiet, isDbUp: () => db.up, ...extra });

test('Mongo down: state, incidents and rollups keep working in memory; flush is a safe no-op', async () => {
  const db = fakeDb(); db.up = false;
  const s = mk(db);
  s.setState('svc', { kind: 'service', state: 'down' });
  assert.equal(s.getState('svc').state, 'down');
  const inc = s.openIncident(['svc'], 'Svc is down', 'x');
  assert.equal(s.incidentsView().active.length, 1);
  assert.equal(s.openIncident(['svc'], 'dup', 'x'), inc, 'no duplicate open incident');
  s.addRollup('svc', '2026-11-17', new Date(), { samples: 1, up: 0, down: 1, incidentSec: 60 });
  assert.equal(s.rollupRows().get('svc')[0].down, 1);
  s.recordCheck({ serviceKey: 'svc', probeType: 'internal', ok: false });

  const r = await s.flush();
  assert.equal(r.skipped, true);
  assert.deepEqual(s.stats(), { checksBuffered: 1, rollupDeltas: 1, incidentOps: 1, dirtyStates: 1 });
  assert.equal(db.checks.length, 0);
});

test('buffered results are flushed when Mongo returns, and nothing is lost or duplicated', async () => {
  const db = fakeDb(); db.up = false;
  const s = mk(db);
  s.setState('svc', { kind: 'service', state: 'operational' });
  s.recordCheck({ serviceKey: 'svc', probeType: 'internal', ok: true });
  s.recordCheck({ serviceKey: 'svc', probeType: 'internal', ok: true });
  s.addRollup('svc', '2026-11-17', new Date(), { samples: 2, up: 2 });
  s.openIncident(['svc'], 't', 'm'); s.resolveIncident(['svc'], 'back');

  db.up = true;
  const r = await s.flush();
  assert.equal(r.ok, true);
  assert.equal(db.checks.length, 2);
  assert.equal(db.states.length, 1);
  assert.equal(db.rollups.length, 1);
  assert.equal(db.incidents.length, 2, 'open then resolve, in order');
  assert.deepEqual(s.stats(), { checksBuffered: 0, rollupDeltas: 0, incidentOps: 0, dirtyStates: 0 });
  await s.flush();
  assert.equal(db.checks.length, 2, 'second flush writes nothing new');
});

test('a write that fails mid-flush keeps the data buffered and never throws', async () => {
  const db = fakeDb();
  const s = mk(db);
  s.recordCheck({ serviceKey: 'svc', probeType: 'internal', ok: true });
  s.addRollup('svc', '2026-11-17', new Date(), { samples: 1, up: 1 });
  db.models.DailyRollup.bulkWrite = async () => { throw new Error('boom'); };
  const r = await s.flush();
  assert.equal(r.ok, false);
  assert.equal(s.stats().rollupDeltas, 1, 'rollup increments put back');
  assert.equal(s.rollupRows().get('svc')[0].up, 1, 'memory is unchanged');
});

test('check buffer is capped to about one hour (and a size limit)', () => {
  let t = Date.parse('2026-11-17T10:00:00Z');
  const db = fakeDb(); db.up = false;
  const s = mk(db, { now: () => t, checkMax: 50 });
  s.recordCheck({ serviceKey: 'a', probeType: 'internal', ok: true });
  t += 30 * 60 * 1000; s.recordCheck({ serviceKey: 'a', probeType: 'internal', ok: true });
  assert.equal(s.stats().checksBuffered, 2);
  t += 31 * 60 * 1000; s.recordCheck({ serviceKey: 'a', probeType: 'internal', ok: true }); // first one is now 61 min old
  assert.equal(s.stats().checksBuffered, 2);
  for (let i = 0; i < 100; i++) s.recordCheck({ serviceKey: 'a', probeType: 'internal', ok: true });
  assert.equal(s.stats().checksBuffered, 50, 'size cap');
});

test('maintenance and enabled flags fall back to the last cached value while the DB is down', async () => {
  const db = fakeDb();
  const now = Date.now();
  db.models.Service = { find: () => ({ select: () => ({ lean: async () => [{ key: 'x', enabled: false }] }) }) };
  db.models.Maintenance = { find: () => ({ sort: () => ({ lean: async () => [{ _id: 1, services: ['y'], start: new Date(now - 1000), end: new Date(now + 60000) }] }) }) };
  db.models.Incident = { find: () => ({ sort: () => ({ lean: async () => [], limit: () => ({ lean: async () => [] }) }) }) };
  const s = mk(db);
  await s.refresh();
  db.up = false; // DB goes away: cached values still answer
  assert.equal(s.isEnabled('x'), false);
  assert.equal(s.isEnabled('other'), true);
  assert.ok(s.activeMaintenance().keys.has('y'));
});
