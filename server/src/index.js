import mongoose from 'mongoose';
import { cfg, assertConfig } from './config.js';
import { createModels } from '../../shared/models.js';
import { createHub } from './hub.js';
import { createApp } from './app.js';

assertConfig();
// Reads only: no index management here (the worker owns it). Buffering is capped so queries fail fast
// (-> 503) instead of hanging while the database is down.
mongoose.set('autoIndex', false);
mongoose.set('bufferTimeoutMS', 2000);

const isDbUp = () => mongoose.connection.readyState === 1;
const models = createModels(mongoose);
const hub = createHub(models, isDbUp);
let timer;
let shuttingDown = false;

/** Never gives up and never crashes the process: the API serves status.json whether or not Mongo is there. */
async function connectWithRetry() {
  for (let attempt = 1; !shuttingDown; attempt++) {
    try {
      await mongoose.connect(cfg.mongoUri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 });
      console.log('[server] connected to status database');
      return;
    } catch (e) {
      console.error(`[server] mongo connect failed (attempt ${attempt}): ${(e.message || '').slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, Math.min(30000, attempt * 2000)));
    }
  }
}
mongoose.connection.on('disconnected', () => console.error('[server] database connection lost (serving status.json)'));
mongoose.connection.on('reconnected', () => console.log('[server] database reconnected'));

const app = createApp({ models, hub, isDbUp });
const httpServer = app.listen(cfg.port, cfg.host, () => console.log(`[server] listening on ${cfg.host}:${cfg.port}`));
timer = hub.start(); // file-based: works without the database

// Graceful shutdown: stop accepting, end SSE streams, drain, close mongoose. Hard exit after 8 s.
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${sig}, shutting down`);
  clearInterval(timer);
  const force = setTimeout(() => { console.error('[server] forced exit'); process.exit(1); }, 8000);
  force.unref();
  hub.closeAll();                      // SSE responses never end on their own
  httpServer.close(async () => {
    await mongoose.disconnect().catch(() => {});
    process.exit(0);
  });
  httpServer.closeIdleConnections?.();
  setTimeout(() => httpServer.closeAllConnections?.(), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => console.error('[server] unhandled rejection:', e?.message || e));

connectWithRetry();
