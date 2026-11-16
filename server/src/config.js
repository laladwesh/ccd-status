const env = process.env;

export const cfg = {
  port: Number(env.PORT) || 4000,
  mongoUrl: env.MONGO_URL || 'mongodb://127.0.0.1:27018/ccdstatus',
  jwtSecret: env.JWT_SECRET,
  adminUser: env.ADMIN_USERNAME || 'admin',
  adminHash: env.ADMIN_PASSWORD_HASH,
  corsOrigins: (env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  staleAfterSec: 180, // worker considered down if the snapshot is older than this
};

export function assertConfig() {
  if (!cfg.jwtSecret || cfg.jwtSecret.length < 24) throw new Error('JWT_SECRET must be set (24+ characters)');
  if (!cfg.adminHash) console.warn('[server] ADMIN_PASSWORD_HASH not set: admin login is disabled');
}
