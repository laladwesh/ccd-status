const env = process.env;

export const cfg = {
  port: Number(env.PORT) || 6060,
  host: env.HOST || '127.0.0.1', // host networking: loopback only, the gateway proxies to it
  mongoUri: env.MONGO_URI || 'mongodb://127.0.0.1:27017/ccd-status', // own database "ccd-status"
  statusDir: env.STATUS_DIR || '/data', // status.json written by the worker (mounted read-only)
  jwtSecret: env.JWT_SECRET,
  adminUser: env.ADMIN_USERNAME || 'admin',
  adminHash: env.ADMIN_PASSWORD_HASH,
  corsOrigins: (env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  trustProxy: env.TRUST_PROXY || 'loopback, linklocal, uniquelocal',
  staleAfterSec: 180, // snapshot considered stale (worker not reporting) if older than this
};

export const DB_MESSAGE = 'History is temporarily unavailable: the status database (shared MongoDB) is not reachable. Live status is not affected.';

export function assertConfig() {
  if (!cfg.jwtSecret || cfg.jwtSecret.length < 24) throw new Error('JWT_SECRET must be set (24+ characters)');
  if (!cfg.adminHash) console.warn('[server] ADMIN_PASSWORD_HASH not set: admin login is disabled');
}
