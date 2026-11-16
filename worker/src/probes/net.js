import dns from 'node:dns/promises';
import tls from 'node:tls';
import net from 'node:net';
import mongoose from 'mongoose';

export async function dnsProbe(host, timeoutMs = 5000) {
  const t0 = performance.now();
  try {
    const addrs = await Promise.race([
      dns.resolve4(host),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    return { ok: addrs.length > 0, latencyMs: Math.round(performance.now() - t0), detail: addrs.join(','), error: null };
  } catch (e) {
    return { ok: false, latencyMs: Math.round(performance.now() - t0), error: e.code || e.message };
  }
}

export function tcpProbe(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const s = net.connect({ host, port, timeout: timeoutMs });
    const done = (ok, error = null) => { s.destroy(); resolve({ ok, latencyMs: Math.round(performance.now() - t0), error }); };
    s.on('connect', () => done(true));
    s.on('timeout', () => done(false, 'timeout'));
    s.on('error', (e) => done(false, e.code || e.message));
  });
}

export function tlsProbe({ host, port = 443 }, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const done = (r) => { try { socket.destroy(); } catch { /* ignore */ } resolve({ latencyMs: Math.round(performance.now() - t0), ...r }); };
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      if (!cert?.valid_to) return done({ ok: false, error: 'no certificate' });
      const validTo = new Date(cert.valid_to);
      const daysLeft = Math.floor((validTo.getTime() - Date.now()) / 86400000);
      done({
        ok: daysLeft > 0 && socket.authorized,
        daysLeft,
        validTo: validTo.toISOString(),
        authorized: socket.authorized,
        error: socket.authorized ? null : String(socket.authorizationError || 'untrusted certificate'),
      });
    });
    socket.on('timeout', () => done({ ok: false, error: 'timeout' }));
    socket.on('error', (e) => done({ ok: false, error: e.code || e.message }));
  });
}

// Shared host mongod: real driver connection, unauthenticated {hello:1}, no credentials.
export async function mongoProbe({ host, port, timeoutMs = 3000 }) {
  const t0 = performance.now();
  const client = new mongoose.mongo.MongoClient(`mongodb://${host}:${port}`, {
    directConnection: true,
    serverSelectionTimeoutMS: timeoutMs,
    connectTimeoutMS: timeoutMs,
    socketTimeoutMS: timeoutMs,
    appName: 'ccd-status-probe',
  });
  try {
    await client.connect();
    const r = await client.db('admin').command({ hello: 1 });
    return { ok: r?.ok === 1, latencyMs: Math.round(performance.now() - t0), error: null };
  } catch (e) {
    return { ok: false, latencyMs: Math.round(performance.now() - t0), error: (e.codeName || e.name || e.message || 'error').slice(0, 120) };
  } finally {
    client.close().catch(() => {});
  }
}
