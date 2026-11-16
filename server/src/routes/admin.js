import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { INCIDENT_STATUS } from '../../../shared/status.js';
import { cfg } from '../config.js';

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const bad = (msg) => Object.assign(new Error(msg), { status: 400, expose: true });
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 100) : []);

function auth(req, res, next) {
  const h = req.get('authorization') || '';
  try {
    req.admin = jwt.verify(h.replace(/^Bearer /, ''), cfg.jwtSecret, { algorithms: ['HS256'] });
    next();
  } catch { res.status(401).json({ error: 'unauthorized' }); }
}

export function adminRouter({ models, hub, isDbUp = () => true }) {
  const r = Router();
  const { Service, Incident, Maintenance, Command, Meta } = models;

  r.post('/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false }), wrap(async (req, res) => {
    const username = str(req.body?.username, 100);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    // Always run bcrypt so response time does not reveal whether the username exists.
    const hash = cfg.adminHash || '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali';
    const okPw = await bcrypt.compare(password, hash).catch(() => false);
    if (!cfg.adminHash || username !== cfg.adminUser || !okPw) return res.status(401).json({ error: 'invalid credentials' });
    const token = jwt.sign({ sub: username, role: 'admin' }, cfg.jwtSecret, { algorithm: 'HS256', expiresIn: '8h' });
    res.json({ token, expiresIn: 8 * 3600 });
  }));

  r.use(auth);
  r.get('/me', (req, res) => res.json({ user: req.admin.sub }));

  // Everything below reads or writes the status database: answer 503 clearly while it is unreachable.
  r.use((req, res, next) => (isDbUp() ? next() : res.status(503).json({
    error: 'Admin data is temporarily unavailable: the status database (shared MongoDB) is not reachable.', code: 'DB_UNAVAILABLE',
  })));

  // ---- incidents ----
  r.get('/incidents', wrap(async (req, res) => {
    const list = await Incident.find({}).sort({ startedAt: -1 }).limit(100).lean();
    res.json(list.map((i) => ({ ...i, id: String(i._id) })));
  }));

  r.post('/incidents', wrap(async (req, res) => {
    const title = str(req.body?.title, 200);
    if (!title) throw bad('title required');
    const status = INCIDENT_STATUS.includes(req.body?.status) ? req.body.status : 'investigating';
    const message = str(req.body?.message, 2000);
    const inc = await Incident.create({
      title, status, serviceKeys: strList(req.body?.serviceKeys), autoCreated: false,
      resolvedAt: status === 'resolved' ? new Date() : undefined,
      updates: message ? [{ message, status, author: req.admin.sub }] : [],
    });
    hub.broadcast();
    res.status(201).json({ id: String(inc._id) });
  }));

  r.post('/incidents/:id/updates', wrap(async (req, res) => {
    const inc = await Incident.findById(req.params.id);
    if (!inc) return res.status(404).json({ error: 'not found' });
    const message = str(req.body?.message, 2000);
    if (!message) throw bad('message required');
    const status = INCIDENT_STATUS.includes(req.body?.status) ? req.body.status : inc.status;
    inc.updates.push({ message, status, author: req.admin.sub });
    inc.status = status;
    inc.resolvedAt = status === 'resolved' ? inc.resolvedAt || new Date() : undefined;
    await inc.save();
    hub.broadcast();
    res.json({ ok: true });
  }));

  r.delete('/incidents/:id', wrap(async (req, res) => {
    await Incident.deleteOne({ _id: req.params.id });
    hub.broadcast();
    res.json({ ok: true });
  }));

  // ---- maintenance ----
  r.get('/maintenance', wrap(async (req, res) => {
    const list = await Maintenance.find({}).sort({ start: -1 }).limit(100).lean();
    res.json(list.map((m) => ({ ...m, id: String(m._id) })));
  }));

  r.post('/maintenance', wrap(async (req, res) => {
    const start = new Date(req.body?.start); const end = new Date(req.body?.end);
    if (Number.isNaN(+start) || Number.isNaN(+end) || end <= start) throw bad('valid start and end (end after start) required');
    const m = await Maintenance.create({ services: strList(req.body?.services), start, end, note: str(req.body?.note, 1000) });
    hub.broadcast();
    res.status(201).json({ id: String(m._id) });
  }));

  r.delete('/maintenance/:id', wrap(async (req, res) => {
    await Maintenance.deleteOne({ _id: req.params.id });
    hub.broadcast();
    res.json({ ok: true });
  }));

  // ---- services ----
  r.get('/services', wrap(async (req, res) => {
    const list = await Service.find({}).sort({ order: 1 }).lean();
    const states = await models.ServiceState.find({ kind: 'service' }).lean();
    const byKey = new Map(states.map((s) => [s.key, s]));
    res.json(list.map((s) => ({
      key: s.key, name: s.name, group: s.group, enabled: s.enabled, container: s.container, quality: s.quality,
      internal: s.internal, nginx: s.nginx, public: s.public, state: byKey.get(s.key)?.state || 'unknown', lastChange: byKey.get(s.key)?.lastChange || null,
    })));
  }));

  r.patch('/services/:key', wrap(async (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') throw bad('enabled (boolean) required');
    const s = await Service.findOneAndUpdate({ key: req.params.key }, { $set: { enabled: req.body.enabled } }, { new: true });
    if (!s) return res.status(404).json({ error: 'not found' });
    res.json({ key: s.key, enabled: s.enabled });
  }));

  // ---- worker commands ----
  const enqueue = async (type, payload) => (await Command.create({ type, payload }))._id;

  r.post('/check-now', wrap(async (req, res) => {
    const serviceKey = req.body?.serviceKey ? str(req.body.serviceKey, 100) : null;
    res.status(202).json({ id: String(await enqueue('check_now', { serviceKey })) });
  }));

  r.post('/test-alert', wrap(async (req, res) => {
    res.status(202).json({ id: String(await enqueue('test_alert', {})) });
  }));

  r.get('/commands/:id', wrap(async (req, res) => {
    const c = await Command.findById(req.params.id).lean();
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json({ type: c.type, done: !!c.doneAt, result: c.result || null });
  }));

  // ---- raw container table + alert channel status (both written by the worker) ----
  r.get('/containers', wrap(async (req, res) => {
    const m = await Meta.findOne({ key: 'containers' }).lean();
    res.json({ updatedAt: m?.value?.updatedAt || null, items: m?.value?.items || [] });
  }));

  r.get('/alerts', wrap(async (req, res) => {
    const m = await Meta.findOne({ key: 'alerts' }).lean();
    res.json(m?.value || { email: false, telegram: false });
  }));

  return r;
}
