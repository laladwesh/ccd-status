import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { api, BASE, STATIC_STATUS_URL } from '../api';

// Live data via SSE. If the API or the stream is unreachable, fall back to polling the
// static /status.json (written by the worker, served directly by nginx) every 30s.
export function useStatus() {
  const [data, setData] = useState(null);
  const [source, setSource] = useState('live'); // 'live' | 'cache'
  const [connected, setConnected] = useState(false);
  const [failed, setFailed] = useState(false);
  const connectedRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get('/status', { timeout: 8000 });
      setData(r.data); setSource('live'); setFailed(false);
    } catch {
      try {
        const r = await axios.get(STATIC_STATUS_URL, { params: { t: Date.now() }, timeout: 8000 });
        setData(r.data); setSource('cache'); setFailed(false);
      } catch { setFailed(true); }
    }
  }, []);

  useEffect(() => {
    load();
    const poll = setInterval(() => { if (!connectedRef.current) load(); }, 30000);
    let es;
    try {
      es = new EventSource(`${BASE}api/stream`);
      es.onopen = () => { connectedRef.current = true; setConnected(true); };
      es.addEventListener('status', (e) => {
        try { setData(JSON.parse(e.data)); setSource('live'); setFailed(false); } catch { /* ignore bad frame */ }
      });
      es.onerror = () => { connectedRef.current = false; setConnected(false); };
    } catch { /* EventSource unsupported: polling covers it */ }
    return () => { clearInterval(poll); es?.close(); };
  }, [load]);

  return { data, source, connected, failed, reload: load };
}
