import mongoose from 'mongoose';
import { cfg, assertConfig } from './config.js';
import { createModels } from '../../shared/models.js';
import { createHub } from './hub.js';
import { createApp } from './app.js';

assertConfig();
const models = createModels(mongoose);
const hub = createHub(models);

async function connectWithRetry() {
  for (let attempt = 1; ; attempt++) {
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
const httpServer = app.listen(cfg.port, () => console.log(`[server] listening on :${cfg.port}`));
await connectWithRetry();
const timer = hub.start();

const shutdown = async (sig) => {
  console.log(`[server] ${sig}, shutting down`);
  clearInterval(timer);
  httpServer.close();
  await mongoose.disconnect().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
