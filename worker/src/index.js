import mongoose from 'mongoose';
import { cfg, mongoProbeTarget } from './config.js';
import { createModels } from '../../shared/models.js';
import { seedServices } from '../../shared/seed.js';
import { services as configuredServices, SERVER_IP } from '../../shared/services.config.js';
import { buildSnapshot } from '../../shared/snapshot.js';
import { createAlerter } from './alerts.js';
import { createEngine } from './engine.js';
import { createStore } from './store.js';
import { writeStatusFile, writeHeartbeat } from './statusFile.js';
import { dockerSnapshot } from './probes/docker.js';

const log = console;
// Indexes are created explicitly after each (re)connect; without this, a failed initial connect would
// leave the TTL indexes missing. Buffering is capped so DB calls fail fast instead of hanging.
mongoose.set('autoIndex', false);
mongoose.set('bufferTimeoutMS', 3000);

const models = createModels(mongoose);
const alerter = createAlerter(log);
const dbReady = () => mongoose.connection.readyState === 1;
const store = createStore({ models, log, isDbUp: dbReady });
const getServices = () => configuredServices.filter((s) => store.isEnabled(s.key));
const engine = createEngine({ store, alerter, getServices, mongoTarget: mongoProbeTarget(), log });

let stopping = false;
let busy = false;
let lastRefresh = 0;
let containersCache = null;
let setupDone = false;       // per connection: indexes + seed + hydrate
let connecting = null;
let attempt = 0;
let nextAttemptAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mongoose.connection.on('disconnected', () => { setupDone = false; log.error('[worker] database connection lost: running from memory, results are buffered'); });
mongoose.connection.on('reconnected', () => log.log('[worker] database reconnected'));

/** Runs once per (re)connection. Everything here is best-effort: a failure just retries on the next tick. */
async function onConnected() {
  await Promise.all(Object.values(models).map((m) => m.createIndexes()));
  await seedServices(models);
  await store.hydrate();
  engine.syncFromStore();
  setupDone = true;
  log.log('[worker] database ready; hydrated from storage');
}

/** Non-blocking connection manager: reconnect with backoff (2 s steps up to 30 s), never throws, never crashes. */
function ensureDb() {
  if (dbReady()) {
    if (!setupDone && !connecting) {
      connecting = onConnected().catch((e) => log.error('[worker] post-connect setup failed:', e.message)).finally(() => { connecting = null; });
    }
    return;
  }
  if (connecting || Date.now() < nextAttemptAt) return;
  connecting = mongoose.connect(cfg.mongoUri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 })
    .then(() => { attempt = 0; return onConnected(); })
    .catch((e) => {
      attempt += 1;
      nextAttemptAt = Date.now() + Math.min(30000, attempt * 2000);
      log.error(`[worker] mongo connect failed (attempt ${attempt}, retry in ${Math.round((nextAttemptAt - Date.now()) / 1000)}s): ${(e.message || '').slice(0, 120)}`);
    })
    .finally(() => { connecting = null; });
}

function snapshotNow() {
  return buildSnapshot({
    services: getServices().map((s) => ({ ...s, enabled: true })),
    states: store.allStates(),
    rollups: store.rollupRows(),
    incidents: store.incidentsView(),
    maintenance: store.maintenanceView(),
    infraFlags: engine.getInfra(),
    dbConnected: dbReady() && setupDone,
    serverLabel: `Server ${SERVER_IP}`,
  });
}

async function getDocker() {
  try {
    const map = await dockerSnapshot();
    containersCache = { updatedAt: new Date(), items: [...map.values()] };
    return { map, err: null };
  } catch (e) {
    log.error('[worker] docker api unavailable:', e.message);
    return { map: null, err: e };
  }
}

async function handleCommands() {
  const { Command } = models;
  let any = false;
  for (;;) {
    const cmd = await Command.findOneAndUpdate({ claimedAt: null, doneAt: null }, { $set: { claimedAt: new Date() } }, { sort: { createdAt: 1 }, new: true });
    if (!cmd) return any;
    any = true;
    let result;
    try {
      if (cmd.type === 'test_alert') result = await alerter.test();
      else if (cmd.type === 'check_now') {
        const { map, err } = await getDocker();
        if (!cmd.payload?.serviceKey) await engine.runInfra();
        const n = await engine.runServices(map, err, { only: cmd.payload?.serviceKey || undefined, force: true });
        result = { checked: n };
      } else result = { error: `unknown command ${cmd.type}` };
    } catch (e) { result = { error: e.message }; }
    await Command.updateOne({ _id: cmd._id }, { $set: { doneAt: new Date(), result } });
  }
}

/** Database-dependent extras. Failure here must never affect probing or status.json. */
async function dbExtras() {
  if (!dbReady() || !setupDone) return false;
  let hadCommands = false;
  try {
    hadCommands = await handleCommands();
    if (Date.now() - lastRefresh > 30000) { await store.refresh(); lastRefresh = Date.now(); }
    const { Meta } = models;
    await Meta.updateOne({ key: 'alerts' }, { $set: { value: alerter.channels() } }, { upsert: true });
    if (containersCache) await Meta.updateOne({ key: 'containers' }, { $set: { value: containersCache } }, { upsert: true });
  } catch (e) { log.error('[worker] database extras failed:', (e.message || '').slice(0, 120)); }
  return hadCommands;
}

async function tick() {
  if (busy || stopping) return;
  busy = true;
  try {
    ensureDb();                                   // reconnect in the background, never awaited here
    const hadCommands = await dbExtras();
    const infraDue = engine.infraDue();
    if (infraDue) await engine.runInfra();        // infra first: services use its result
    const { map, err } = await getDocker();
    const checked = await engine.runServices(map, err);
    const flushed = await alerter.flush();
    if (infraDue || checked || hadCommands) await writeStatusFile(snapshotNow()); // every cycle, DB up or down
    if (flushed) log.log('[alerts]', JSON.stringify(flushed));
    await store.flush();                          // write-behind; no-op while the DB is down, buffers keep growing (capped)
  } catch (e) {
    log.error('[worker] tick failed', e);
    // Last resort: still publish what we know so the page does not go stale.
    try { await writeStatusFile(snapshotNow()); } catch { /* ignore */ }
  } finally {
    await writeHeartbeat();                       // healthy = loop alive; independent of the database
    busy = false;
  }
}

async function main() {
  log.log('[worker] starting; alerts:', JSON.stringify(alerter.channels()), '; db:', cfg.mongoUri.replace(/\/\/[^@/]*@/, '//***@'));
  ensureDb();
  for (let i = 0; i < 12 && !(dbReady() && setupDone) && connecting; i++) await sleep(500); // short grace; never required
  await tick();
  const timer = setInterval(tick, cfg.tickMs);

  // Graceful shutdown: stop scheduling, let the in-flight loop finish (max 20 s), flush buffers once, close mongoose.
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    log.log(`[worker] ${sig}: waiting for in-flight checks`);
    for (let waited = 0; busy && waited < 20000; waited += 200) await sleep(200);
    try { await writeStatusFile(snapshotNow()); await store.flush(); } catch { /* best effort */ }
    await mongoose.disconnect().catch(() => {});
    log.log('[worker] stopped');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (e) => log.error('[worker] unhandled rejection:', e?.message || e));
main().catch((e) => { log.error('[worker] fatal', e); process.exit(1); });
