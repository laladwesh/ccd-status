import http from 'node:http';

// GET-only HTTP probes. Never follow redirects (a 302 to a login page is "up"),
// never send credentials, read headers only.

const isOk = (status, expect) => (expect === 'lt500' ? status < 500 : status >= 200 && status < 400);

// Status of one plain-HTTP GET using node:http. Needed whenever a custom Host header is required:
// fetch() (undici) silently ignores a custom `Host`, which would send the request to the wrong server block.
function getStatusRaw(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers, timeout: timeoutMs, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'timeout' })));
    req.on('error', reject);
    req.end();
  });
}

export async function httpProbe(url, { timeoutMs = 10000, expect = 'ok', headers = {} } = {}) {
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  const baseHeaders = { 'user-agent': 'ccd-status-probe/1.0', accept: '*/*', ...headers };
  try {
    let s;
    if (headers.host && url.startsWith('http://')) {
      s = await getStatusRaw(url, baseHeaders, timeoutMs);
    } else {
      const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: baseHeaders });
      try { await res.body?.cancel(); } catch { /* ignore */ }
      s = res.status;
    }
    const ok = isOk(s, expect);
    return { ok, statusCode: s, latencyMs: elapsed(), error: ok ? null : `HTTP ${s}` };
  } catch (e) {
    const code = e?.cause?.code || e?.code;
    const error = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : code || e?.message || 'error';
    return { ok: false, statusCode: null, latencyMs: elapsed(), error: String(error).slice(0, 200) };
  }
}
