import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { cfg } from './config.js';
import { createModels } from '../../shared/models.js';
import { seedServices } from '../../shared/seed.js';
import { createAlerter } from './alerts.js';
import { createEngine } from './engine.js';
import { buildSnapshot, writeStatusFile } from './snapshot.js';
import { dockerSnapshot } from './probes/docker.js';

const log = console;
const models = createModels(mongoose);
const alerter = createAlerter(log);
const engine = createEngine({ models, alerter, log });
let stopping = false;
let busy = false;
let lastSnapshot = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dbReady = () => mongoose.connection.readyState === 1;

async function connectWithRetry() {
  for (let attempt = 1; !stopping; attempt++) {
    try {
      await mongoose.connect(cfg.mongoUrl, { serverSelectionTimeoutMS: 5000 });
      log.log('[worker] connected to status database');
      return;
    } catch (e) {
      log.error(`[worker] mongo connect failed (attempt ${attempt}): ${e.message}`);
      await sleep(Math.min(30000, attempt * 2000));
    }
  }
}

// The Docker healthcheck reads this file's age (< 120 s). Written after every completed loop,
// including a loop that could not reach the database (restarting the worker would not help then).
const heartbeat = () => fs.writeFile(path.join(cfg.statusDir, 'heartbeat'), String(Date.now())).catch(() => {});

async function publish() {
  const snapshot = await buildSnapshot({ models, engine });
  lastSnapshot = snapshot;
  await models.Meta.updateOne({ key: 'snapshot' }, { $set: { value: snapshot } }, { upsert: true });
  await writeStatusFile(snapshot).catch((e) => log.error('[worker] status.json write failed', e.message));
}

// The status DB lives on the shared host mongod. When that is down we cannot save checks or build a
// fresh snapshot, but the page must still say so: re-publish the last snapshot with a database banner.
async function publishDegraded(reason) {
  if (!lastSnapshot) return;
  const s = structuredClone(lastSnapshot);
  s.generatedAt = new Date().toISOString();
  s.overall = { status: 'database', message: 'Shared database down' };
  if (s.infra?.database) s.infra.database = { ...s.infra.database, state: 'down', detail: reason };
  await writeStatusFile(s).catch((e) => log.error('[worker] status.json write failed', e.message));
}

async function getDocker() {
  try {
    const map = await dockerSnapshot();
    await models.Meta.updateOne({ key: 'containers' }, { $set: { value: { updatedAt: new Date(), items: [...map.values()] } } }, { upsert: true });
    return { map, err: null };
  } catch (e) {
    log.error('[worker] docker/db step failed:', e.message);
    return { map: null, err: e };
  }
}

async function handleCommands() {
  const { Command, Meta } = models;
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
    await Meta.updateOne({ key: 'alerts' }, { $set: { value: alerter.channels() } }, { upsert: true });
  }
}

async function tick() {
  if (busy || stopping) return;
  busy = true;
  try {
    const hadCommands = await handleCommands();
    const infraDue = engine.infraDue();
    if (infraDue) await engine.runInfra(); // infra first: services use its result
    const { map, err } = await getDocker();
    const checked = await engine.runServices(map, err);
    const flushed = await alerter.flush();
    if (infraDue || checked || hadCommands) await publish();
    if (flushed) log.log('[alerts]', JSON.stringify(flushed));
    await heartbeat();
  } catch (e) {
    log.error('[worker] tick failed', e);
    if (!dbReady()) { await publishDegraded(e.message?.slice(0, 120) || 'database unreachable'); await heartbeat(); }
  } finally { busy = false; }
}

async function main() {
  log.log('[worker] starting; alerts:', JSON.stringify(alerter.channels()));
  await connectWithRetry();
  if (stopping) return;
  await seedServices(models);
  await engine.loadState();
  await models.Meta.updateOne({ key: 'alerts' }, { $set: { value: alerter.channels() } }, { upsert: true });
  await tick();
  const timer = setInterval(tick, cfg.tickMs);

  // Graceful shutdown: stop scheduling, let the in-flight check loop finish (max 20 s), close mongoose.
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    log.log(`[worker] ${sig}: waiting for in-flight checks`);
    for (let waited = 0; busy && waited < 20000; waited += 200) await sleep(200);
    await mongoose.disconnect().catch(() => {});
    log.log('[worker] stopped');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => { log.error('[worker] fatal', e); process.exit(1); });
