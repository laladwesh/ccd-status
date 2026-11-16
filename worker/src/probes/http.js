// GET-only HTTP probe. Never follows redirects (a 302 to a login page is "up"),
// never sends credentials, reads headers only.
export async function httpProbe(url, { timeoutMs = 10000, expect = 'ok' } = {}) {
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'ccd-status-probe/1.0', accept: '*/*' },
    });
    const latencyMs = elapsed();
    try { await res.body?.cancel(); } catch { /* ignore */ }
    const s = res.status;
    const ok = expect === 'lt500' ? s < 500 : s >= 200 && s < 400;
    return { ok, statusCode: s, latencyMs, error: ok ? null : `HTTP ${s}` };
  } catch (e) {
    const code = e?.cause?.code || e?.code;
    const error = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : code || e?.message || 'error';
    return { ok: false, statusCode: null, latencyMs: elapsed(), error: String(error).slice(0, 200) };
  }
}
