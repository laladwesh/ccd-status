// Single source of truth for what the status page monitors.
// The worker seeds the `services` collection from this file (`npm run seed` in worker/).
// Probes run from the worker, which uses network_mode: host, so everything is probed at 127.0.0.1.
//
// Each service can have three HTTP tiers, innermost first:
//   internal  the app's own port            http://127.0.0.1:<port><path>
//   nginx     through the host nginx        http://127.0.0.1<path>   (Host: SERVER_IP)
//   public    through the IITG proxy        https://iitg.ac.in/...
// plus a Docker `container` probe (state, restart loop) read via the socket proxy.
//
// Service fields
//   key         stable id (used in URLs and the DB; never rename)
//   name, group display
//   container   Docker container name
//   internal    { port, path, expect }
//   nginx       { path, expect }         omit for services that are not behind the host nginx
//   public      { url, expect }
//   dependsOnDb true if the app needs the shared host MongoDB ("impacted by database")
//   quality     'health' = dedicated health route, 'basic' = shell/static route (proves the process is up, not its DB)
//   expect      'ok' (HTTP 200-399, default) | 'lt500' (any response below 500)
//   knownIssue  text shown as the reason while the service is DOWN (remove once fixed)
//   intervalSec optional per-service interval (default DEFAULTS.intervalSec)

export const DEFAULTS = {
  intervalSec: 60,
  timeoutMs: 10000,
  slowMs: 2000, // p95 above this => degraded
  maxConcurrent: 5,
};

export const PUBLIC_ORIGIN = 'https://iitg.ac.in';
export const SERVER_IP = '172.17.1.148';

// "Upstream" node: if DNS or the iitg.ac.in homepage fails, public failures are
// reported as one campus/upstream issue instead of N broken services.
export const infra = {
  dnsHost: 'iitg.ac.in',
  gatewayUrl: 'https://iitg.ac.in/',
  tls: { host: 'iitg.ac.in', port: 443, warnDays: 14, recheckMin: 30 },
  // Shared host mongod: unauthenticated {hello:1}, no credentials.
  mongo: { host: '127.0.0.1', port: 27017, timeoutMs: 3000 },
  // Host nginx on this server (first server{} block, server_name = SERVER_IP). The Host header is
  // pinned so requests to 127.0.0.1 land on that server block.
  nginx: { host: '127.0.0.1', port: 80, hostHeader: SERVER_IP },
};

export const groups = ['Placement', 'Internship', 'Training', 'Industry', 'PhD', 'Others'];

export const services = [
  // ---- Placement ----
  {
    key: 'placement', name: 'Placement Portal', group: 'Placement', order: 10,
    container: 'placement23', dependsOnDb: true, quality: 'basic',
    internal: { port: 5000, path: '/placements/api/' },
    nginx: { path: '/placements/api/' },
    public: { url: 'https://iitg.ac.in/placements/' },
  },
  {
    key: 'placement-frontend', name: 'Placement Portal – Frontend (3012)', group: 'Placement', order: 11,
    container: 'placement_portal_frontend', dependsOnDb: false, quality: 'basic',
    internal: { port: 3012, path: '/' }, // not behind nginx, no public URL
  },
  {
    key: 'dday', name: 'D-Day Portal', group: 'Placement', order: 12,
    container: 'dday2026-app', dependsOnDb: true, quality: 'health',
    internal: { port: 5005, path: '/dday/api/health' },
    nginx: { path: '/dday/api/health' },
    public: { url: 'https://iitg.ac.in/dday/' },
  },
  // ---- Internship ----
  {
    key: 'intern', name: 'Intern Portal', group: 'Internship', order: 20,
    container: 'intern24test', dependsOnDb: true, quality: 'basic',
    internal: { port: 11034, path: '/intern/api/' },
    nginx: { path: '/intern/api/' },
    public: { url: 'https://iitg.ac.in/intern/' },
  },
  {
    key: 'intern-2026', name: 'Intern Portal 2026', group: 'Internship', order: 21,
    container: 'intern2026-app', dependsOnDb: true, quality: 'health',
    internal: { port: 5009, path: '/intern-2026/api/health' },
    nginx: { path: '/intern-2026/api/health' },
    public: { url: 'https://iitg.ac.in/intern-2026/' },
  },
  // ---- Training ----
  {
    // Confirmed: nginx /training -> 127.0.0.1:5001 (ccd-app).
    key: 'training-app', name: 'Training Portal – App (5001)', group: 'Training', order: 30,
    container: 'ccd-app', dependsOnDb: true, quality: 'basic',
    internal: { port: 5001, path: '/test' },
    nginx: { path: '/training/' },
    public: { url: 'https://iitg.ac.in/training/' },
  },
  {
    key: 'training-frontend', name: 'Training Portal – Frontend (3000)', group: 'Training', order: 31,
    container: 'frontend', dependsOnDb: false, quality: 'basic',
    internal: { port: 3000, path: '/' }, // not behind nginx, no public URL
  },
  {
    key: 'training-backend', name: 'Training Portal – Backend (5004)', group: 'Training', order: 32,
    container: 'backend', dependsOnDb: true, quality: 'basic',
    internal: { port: 5004, path: '/', expect: 'lt500' }, // no known route: any HTTP response < 500 = up
  },
  // ---- Industry ----
  {
    // Container check only. nginx /industry-backend points at :5002, which nothing listens on,
    // so there is deliberately no HTTP probe.
    key: 'industry', name: 'Industry Portal', group: 'Industry', order: 40,
    container: 'industry_backend', dependsOnDb: true, quality: 'basic',
    knownIssue: 'Restart loop: /app/package.json missing in image',
  },
  // ---- PhD ----
  {
    key: 'phd', name: 'PhD Placement Portal', group: 'PhD', order: 50,
    container: 'phdplacement-app', dependsOnDb: true, quality: 'basic',
    internal: { port: 7002, path: '/phdplacement/' },
    nginx: { path: '/phdplacement/' },
    public: { url: 'https://iitg.ac.in/phdplacement/' },
  },
  // ---- Others ----
  {
    key: 'ccd-app-backend', name: 'CCD App Backend', group: 'Others', order: 60,
    container: 'ccd-backend', dependsOnDb: true, quality: 'basic',
    internal: { port: 6001, path: '/ccd-app/policies' },
    nginx: { path: '/ccd-app/policies' },
    public: { url: 'https://iitg.ac.in/ccd-app/' },
  },
  {
    key: 'aipc', name: 'AIPC', group: 'Others', order: 61,
    container: 'aipc-app', dependsOnDb: true, quality: 'basic',
    internal: { port: 6025, path: '/aipc/' },
    nginx: { path: '/aipc/' },
    public: { url: 'https://iitg.ac.in/aipc/' },
  },
  {
    key: 'dpr', name: 'DPR Listing', group: 'Others', order: 62,
    container: 'dpr-app', dependsOnDb: true, quality: 'basic',
    internal: { port: 6026, path: '/listing-ccd/' },
    nginx: { path: '/listing-ccd/' },
    public: { url: 'https://iitg.ac.in/listing-ccd/' },
  },
];
