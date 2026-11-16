import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { cfg } from './config.js';
import { publicRouter } from './routes/public.js';
import { adminRouter } from './routes/admin.js';

export function createApp({ models, hub }) {
  const app = express();
  app.set('trust proxy', true); // behind host nginx / the IITG proxy
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({
    origin(origin, cb) {
      // Same-origin requests send no Origin header. Cross-origin only for the allowlist.
      if (!origin || cfg.corsOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  }));
  // SSE must not be compressed/buffered, so compression skips the stream.
  app.use(compression({ filter: (req, res) => (req.path.endsWith('/stream') ? false : compression.filter(req, res)) }));
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 240, standardHeaders: true, legacyHeaders: false }));

  app.use('/api', publicRouter({ models, hub }));
  app.use('/api/admin', adminRouter({ models, hub }));

  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[server]', err);
    res.status(err.status || 500).json({ error: err.expose ? err.message : 'internal error' });
  });
  return app;
}
