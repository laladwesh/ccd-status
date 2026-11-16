import { DEFAULTS } from '../../shared/services.config.js';
import { buildMongoUrl } from '../../shared/mongo-url.js';

const env = process.env;
const bool = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());
const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);

export const cfg = {
  mongoUrl: buildMongoUrl(env),
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
