import mongoose from 'mongoose';
import { cfg, assertConfig } from './config.js';
import { createModels } from '../../shared/models.js';
import { createHub } from './hub.js';
import { createApp } from './app.js';

assertConfig();
const models = createModels(mongoose);
const hub = createHub(models);
let timer;
let shuttingDown = false;

async function connectWithRetry() {
  for (let attempt = 1; !shuttingDown; attempt++) {
    try {
      await mongoose.connect(cfg.mongoUrl, { serverSelectionTimeoutMS: 5000 });
      console.log('[server] connected to status database');
      return;
    } catch (e) {
      console.error(`[server] mongo connect failed (attempt ${attempt}): ${e.message}`);
      await new Promise((r) => setTimeout(r, Math.min(30000, attempt * 2000)));
    }
  }
}

// Start listening first so /api/health answers (503) even while the DB is still coming up.
const app = createApp({ models, hub });
const httpServer = app.listen(cfg.port, cfg.host, () => console.log(`[server] listening on ${cfg.host}:${cfg.port}`));

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

await connectWithRetry();
if (!shuttingDown) timer = hub.start();
