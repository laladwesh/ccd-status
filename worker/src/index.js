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

async function connectWithRetry() {
  for (let attempt = 1; !stopping; attempt++) {
    try {
      await mongoose.connect(cfg.mongoUrl, { serverSelectionTimeoutMS: 5000 });
      log.log('[worker] connected to status database');
      return;
    } catch (e) {
      log.error(`[worker] mongo connect failed (attempt ${attempt}): ${e.message}`);
      await new Promise((r) => setTimeout(r, Math.min(30000, attempt * 2000)));
    }
  }
}

async function publish() {
  const snapshot = await buildSnapshot({ models, engine });
  await models.Meta.updateOne({ key: 'snapshot' }, { $set: { value: snapshot } }, { upsert: true });
  await writeStatusFile(snapshot).catch((e) => log.error('[worker] status.json write failed', e.message));
}

async function handleCommands() {
  const { Command, Meta } = models;
  for (;;) {
    const cmd = await Command.findOneAndUpdate({ claimedAt: null, doneAt: null }, { $set: { claimedAt: new Date() } }, { sort: { createdAt: 1 }, new: true });
    if (!cmd) return false;
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

async function getDocker() {
  try {
    const map = await dockerSnapshot();
    await models.Meta.updateOne({ key: 'containers' }, { $set: { value: { updatedAt: new Date(), items: [...map.values()] } } }, { upsert: true });
    return { map, err: null };
  } catch (e) {
    log.error('[worker] docker api unavailable:', e.message);
    return { map: null, err: e };
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
  } catch (e) {
    log.error('[worker] tick failed', e);
  } finally { busy = false; }
}

async function main() {
  log.log('[worker] starting; alerts:', JSON.stringify(alerter.channels()));
  await connectWithRetry();
  await seedServices(models);
  await engine.loadState();
  await models.Meta.updateOne({ key: 'alerts' }, { $set: { value: alerter.channels() } }, { upsert: true });
  await tick();
  const timer = setInterval(tick, cfg.tickMs);
  const shutdown = async (sig) => {
    stopping = true; clearInterval(timer);
    log.log(`[worker] ${sig}, shutting down`);
    await mongoose.disconnect().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => { log.error('[worker] fatal', e); process.exit(1); });
