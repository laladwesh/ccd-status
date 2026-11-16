import { DEFAULTS, infra } from '../../shared/services.config.js';

const env = process.env;
const bool = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());
const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);

// Plain URI, own database name "ccd-status". The worker never touches any other database.
const mongoUri = env.MONGO_URI || 'mongodb://127.0.0.1:27017/ccd-status';

/** host:port of the mongod to health-probe (same server the URI points at). Falls back to the config default. */
export function mongoProbeTarget(uri = mongoUri) {
  try {
    const u = new URL(uri);
    if (u.hostname) return { host: u.hostname, port: Number(u.port) || 27017, timeoutMs: infra.mongo.timeoutMs };
  } catch { /* multi-host or unusual URI */ }
  return infra.mongo;
}

export const cfg = {
  mongoUri,
  dockerUrl: (env.DOCKER_PROXY_URL || 'http://127.0.0.1:23750').replace(/\/$/, ''),
  statusDir: env.STATUS_DIR || '/data',
  probeHost: env.PROBE_HOST || '127.0.0.1',
  tickMs: 5000,
  intervalSec: num(env.CHECK_INTERVAL_SEC, DEFAULTS.intervalSec),
  timeoutMs: num(env.PROBE_TIMEOUT_MS, DEFAULTS.timeoutMs),
  slowMs: num(env.SLOW_MS, DEFAULTS.slowMs),
  maxConcurrent: num(env.MAX_CONCURRENT_PROBES, DEFAULTS.maxConcurrent),
  // Everything alert-related is OFF unless explicitly enabled.
  alerts: {
    cooldownMin: num(env.ALERT_COOLDOWN_MIN, 10),
    email: {
      enabled: bool(env.ALERT_EMAIL_ENABLED),
      host: env.SMTP_HOST,
      port: num(env.SMTP_PORT, 587),
      secure: bool(env.SMTP_SECURE),
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      from: env.ALERT_EMAIL_FROM || env.SMTP_USER,
      to: (env.ALERT_EMAIL_TO || '').split(',').map((s) => s.trim()).filter(Boolean),
    },
    telegram: {
      enabled: bool(env.ALERT_TELEGRAM_ENABLED),
      token: env.TELEGRAM_BOT_TOKEN,
      chatId: env.TELEGRAM_CHAT_ID,
    },
  },
};
