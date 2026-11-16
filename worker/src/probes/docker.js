// Read-only Docker access through tecnativa/docker-socket-proxy (CONTAINERS=1).
// Only GET /containers/* is used. The raw docker.sock is never mounted into this app.
import { cfg } from '../config.js';

async function get(path, timeoutMs = 5000) {
  const res = await fetch(`${cfg.dockerUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) { const e = new Error(`docker api ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}

// name -> recent restart counts, to catch a crash loop even in the instant it shows "running".
const history = new Map();
function trackRestarts(name, count) {
  const now = Date.now();
  const h = (history.get(name) || []).filter((x) => now - x.t < 10 * 60 * 1000);
  h.push({ t: now, count });
  history.set(name, h);
  return count - Math.min(...h.map((x) => x.count));
}

function summarize(i) {
  const st = i.State || {};
  const name = (i.Name || '').replace(/^\//, '');
  const restartCount = i.RestartCount ?? 0;
  const recentRestarts = trackRestarts(name, restartCount);
  const running = !!st.Running;
  const restarting = !!st.Restarting || st.Status === 'restarting';
  const loop = restarting || (running && recentRestarts >= 3);
  const startedAt = st.StartedAt && !st.StartedAt.startsWith('0001') ? st.StartedAt : null;
  return {
    name,
    image: i.Config?.Image,
    state: st.Status,
    running,
    restarting,
    restartLoop: loop,
    exitCode: st.ExitCode,
    restartCount,
    recentRestarts,
    health: st.Health?.Status || null,
    startedAt,
    uptimeSec: running && startedAt ? Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000)) : 0,
    ports: i.NetworkSettings?.Ports ? Object.keys(i.NetworkSettings.Ports).filter((p) => i.NetworkSettings.Ports[p]) : [],
    networkMode: i.HostConfig?.NetworkMode,
    ok: running && !loop,
    error: loop ? `restart loop (exit ${st.ExitCode})` : running ? null : `not running (${st.Status}, exit ${st.ExitCode})`,
  };
}

/** Snapshot of ALL containers on the host: Map(name -> info). Throws if the proxy is unreachable. */
export async function dockerSnapshot() {
  const list = await get('/containers/json?all=1');
  const out = new Map();
  await Promise.all(list.map(async (c) => {
    try {
      const info = summarize(await get(`/containers/${c.Id}/json`));
      out.set(info.name, info);
    } catch { /* container vanished between list and inspect */ }
  }));
  return out;
}
