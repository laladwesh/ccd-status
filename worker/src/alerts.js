// Alert channels. Everything is OFF unless enabled in .env; the dashboard works with no alerts.
// Alerts are sent on state change only, batched into one message per cycle, with a per-key cooldown.
import nodemailer from 'nodemailer';
import { cfg } from './config.js';

export function createAlerter(log = console) {
  const a = cfg.alerts;
  const queue = [];
  const lastSent = new Map();
  let transport;

  const channels = () => ({
    email: !!(a.email.enabled && a.email.host && a.email.to.length),
    telegram: !!(a.telegram.enabled && a.telegram.token && a.telegram.chatId),
  });

  async function sendEmail(subject, text) {
    transport ||= nodemailer.createTransport({
      host: a.email.host, port: a.email.port, secure: a.email.secure,
      auth: a.email.user ? { user: a.email.user, pass: a.email.pass } : undefined,
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
    });
    await transport.sendMail({ from: a.email.from, to: a.email.to.join(','), subject, text });
  }

  async function sendTelegram(text) {
    const res = await fetch(`https://api.telegram.org/bot${a.telegram.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: a.telegram.chatId, text }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`telegram ${res.status}`);
  }

  async function deliver(subject, text) {
    const ch = channels();
    const result = { email: null, telegram: null, enabled: ch };
    if (ch.email) { try { await sendEmail(subject, text); result.email = 'sent'; } catch (e) { result.email = `failed: ${e.message}`; log.error('[alerts] email failed', e.message); } }
    if (ch.telegram) { try { await sendTelegram(`${subject}\n\n${text}`); result.telegram = 'sent'; } catch (e) { result.telegram = `failed: ${e.message}`; log.error('[alerts] telegram failed', e.message); } }
    return result;
  }

  return {
    channels,
    /** kind: down | recovered | upstream | database ; key is used for the cooldown. */
    enqueue({ kind, key, title, text }) {
      if (!channels().email && !channels().telegram) return;
      const id = `${kind}:${key}`;
      const last = lastSent.get(id) || 0;
      if (Date.now() - last < a.cooldownMin * 60 * 1000) return;
      lastSent.set(id, Date.now());
      queue.push({ kind, title, text });
    },
    async flush() {
      if (!queue.length) return null;
      const items = queue.splice(0, queue.length);
      const subject = items.length === 1 ? `[CCD Status] ${items[0].title}` : `[CCD Status] ${items.length} status changes`;
      const text = items.map((i) => `${i.title}\n${i.text}`).join('\n\n') + '\n\n(sent by CCD System Status)';
      return deliver(subject, text);
    },
    async test() {
      return deliver('[CCD Status] Test alert', `This is a test alert from the CCD System Status worker.\nSent at ${new Date().toISOString()}`);
    },
  };
}
