// Single source of truth for what the status page monitors.
// The worker seeds the `services` collection from this file (`npm run seed` in worker/).
// Probes run from the worker, which uses network_mode: host, so `internal.port`
// is probed at 127.0.0.1:<port> (portals run with host networking or published ports).
//
// Service fields
//   key         stable id (used in URLs and the DB; never rename)
//   name, group display
//   container   Docker container name (read via docker-socket-proxy)
//   internal    { port, path, expect }   probed at http://127.0.0.1:<port><path>
//   public      { url, expect }          probed at the public https://iitg.ac.in/... URL
//   dependsOnDb true if the app needs the shared host MongoDB (see "impacted by database")
//   quality     'health' = dedicated health route, 'basic' = shell/static route, so it only proves the process is up
//   expect      'ok' (HTTP 200-399, default) | 'lt500' (any response below 500)
//   intervalSec optional per-service interval (default DEFAULTS.intervalSec)

export const DEFAULTS = {
  intervalSec: 60,
  timeoutMs: 10000,
  slowMs: 2000, // p95 above this => degraded
  maxConcurrent: 5,
};

export const PUBLIC_ORIGIN = 'https://iitg.ac.in';

// "Upstream" node: if DNS or the iitg.ac.in homepage fails, public failures are
// reported as one campus/upstream issue instead of N broken services.
export const infra = {
  dnsHost: 'iitg.ac.in',
  gatewayUrl: 'https://iitg.ac.in/',
  tls: { host: 'iitg.ac.in', port: 443, warnDays: 14, recheckMin: 30 },
  // Shared host mongod: unauthenticated {hello:1}, no credentials.
  mongo: { host: '127.0.0.1', port: 27017, timeoutMs: 3000 },
};

export const groups = ['Placement', 'Internship', 'Training', 'Industry', 'PhD', 'Others'];

export const services = [
  // ---- Placement ----
  {
    key: 'placement', name: 'Placement Portal', group: 'Placement', order: 10,
    container: 'placement23', dependsOnDb: true, quality: 'basic',
    internal: { port: 5000, path: '/placements/api/' },
    public: { url: 'https://iitg.ac.in/placements/' },
  },
  {
    key: 'placement-frontend', name: 'Placement Portal – Frontend (3012)', group: 'Placement', order: 11,
    container: 'placement_portal_frontend', dependsOnDb: false, quality: 'basic',
    internal: { port: 3012, path: '/' },
  },
  {
    key: 'dday', name: 'D-Day Portal', group: 'Placement', order: 12,
    container: 'dday2026-app', dependsOnDb: true, quality: 'health',
    internal: { port: 5005, path: '/dday/api/health' },
    public: { url: 'https://iitg.ac.in/dday/' },
  },
  // ---- Internship ----
  {
    key: 'intern', name: 'Intern Portal', group: 'Internship', order: 20,
    container: 'intern24test', dependsOnDb: true, quality: 'basic',
    internal: { port: 11034, path: '/intern/api/' },
    public: { url: 'https://iitg.ac.in/intern/' },
  },
  {
    key: 'intern-2026', name: 'Intern Portal 2026', group: 'Internship', order: 21,
    container: 'intern2026-app', dependsOnDb: true, quality: 'health',
    internal: { port: 5009, path: '/intern-2026/api/health' },
    public: { url: 'https://iitg.ac.in/intern-2026/' },
  },
  // ---- Training ----
  {
    // PROVISIONAL: https://iitg.ac.in/training/ is attached here. Move `public` to
    // `training-frontend` below if the proxy (nginx -T) shows /training -> :3000.
    key: 'training-app', name: 'Training Portal – App (5001)', group: 'Training', order: 30,
    container: 'ccd-app', dependsOnDb: true, quality: 'basic',
    internal: { port: 5001, path: '/test' },
    public: { url: 'https://iitg.ac.in/training/' },
  },
  {
    key: 'training-frontend', name: 'Training Portal – Frontend (3000)', group: 'Training', order: 31,
    container: 'frontend', dependsOnDb: false, quality: 'basic',
    internal: { port: 3000, path: '/' },
  },
  {
    key: 'training-backend', name: 'Training Portal – Backend (5004)', group: 'Training', order: 32,
    container: 'backend', dependsOnDb: true, quality: 'basic',
    internal: { port: 5004, path: '/', expect: 'lt500' }, // no known route: any HTTP response < 500 = up
  },
  // ---- Industry ----
  {
    // Container check only: no known public URL / probe path. A restart loop = DOWN.
    key: 'industry', name: 'Industry Portal', group: 'Industry', order: 40,
    container: 'industry_backend', dependsOnDb: true, quality: 'basic',
  },
  // ---- PhD ----
  {
    key: 'phd', name: 'PhD Placement Portal', group: 'PhD', order: 50,
    container: 'phdplacement-app', dependsOnDb: true, quality: 'basic',
    internal: { port: 7002, path: '/phdplacement/' },
    public: { url: 'https://iitg.ac.in/phdplacement/' },
  },
  // ---- Others ----
  {
    key: 'ccd-app-backend', name: 'CCD App Backend', group: 'Others', order: 60,
    container: 'ccd-backend', dependsOnDb: true, quality: 'basic',
    internal: { port: 6001, path: '/ccd-app/policies' },
  },
  {
    key: 'aipc', name: 'AIPC', group: 'Others', order: 61,
    container: 'aipc-app', dependsOnDb: true, quality: 'basic',
    internal: { port: 6025, path: '/aipc/' },
    public: { url: 'https://iitg.ac.in/aipc/' },
  },
  {
    key: 'dpr', name: 'DPR Listing', group: 'Others', order: 62,
    container: 'dpr-app', dependsOnDb: true, quality: 'basic',
    internal: { port: 6026, path: '/listing-ccd/' },
    public: { url: 'https://iitg.ac.in/listing-ccd/' },
  },
];
