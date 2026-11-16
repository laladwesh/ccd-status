import axios from 'axios';

// BASE_URL is "/ccd-status/" (vite `base`), so every request is relative to the subpath
// and works both on the host nginx and behind the IITG reverse proxy.
export const BASE = import.meta.env.BASE_URL;

export const api = axios.create({ baseURL: `${BASE}api`, timeout: 10000 });
export const STATIC_STATUS_URL = `${BASE}status.json`;

const KEY = 'ccd-status-admin-token';
export const tokenStore = {
  get() { try { return localStorage.getItem(KEY); } catch { return null; } },
  set(t) { try { localStorage.setItem(KEY, t); } catch { /* storage may be blocked */ } },
  clear() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } },
};

api.interceptors.response.use(
  (r) => r,
  (e) => {
    // Expired/invalid admin token: drop it and go back to the login page.
    if (e.response?.status === 401 && e.config?.url?.startsWith('/admin') && !e.config.url.endsWith('/login')) {
      tokenStore.clear();
      window.location.assign(`${BASE}admin/login`);
    }
    return Promise.reject(e);
  },
);

api.interceptors.request.use((cfg) => {
  const t = tokenStore.get();
  if (t && cfg.url?.startsWith('/admin')) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});
