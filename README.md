# CCD System Status

Status page for the IIT Guwahati Centre for Career Development portals. It tells **container**, **database**, **upstream (campus network / iitg.ac.in)** and **application** problems apart, so one campus outage does not show up as a dozen broken services.

Served at `/ccd-status/` (host nginx on `172.17.1.18` → gateway container on `127.0.0.1:6059`). Later the IITG webmaster proxies `https://iitg.ac.in/ccd-status/` → `http://172.17.1.18/ccd-status/`. The build is path-stable (`/ccd-status/`), so it works in both places unchanged.

> See [AUDIT.md](AUDIT.md) for the Phase 1 findings this is based on.

## Architecture

```
                    ┌────────────── 172.17.1.18 ──────────────┐
 browser ─► host nginx ─► gateway (nginx) 127.0.0.1:6059
                           ├─ /ccd-status/          static React build
                           ├─ /ccd-status/status.json   written by worker (works if API is down)
                           └─ /ccd-status/api/*  ─► server (Express, REST + SSE, admin JWT)
                                                        │
                      worker (network_mode: host) ──────┼──► mongo (ccd-status-mongo, 127.0.0.1:27018, own volume)
                        ├─ probes portals at 127.0.0.1:<port>
                        ├─ reads Docker state via docker-socket-proxy (127.0.0.1:23750, CONTAINERS=1 only)
                        ├─ probes host MongoDB 127.0.0.1:27017 ({hello:1}, no credentials)
                        └─ probes https://iitg.ac.in (DNS, homepage, TLS expiry)
```

- **worker** and **server** are separate containers. If the API dies, checks keep running; if the worker dies, the API serves the last data and flags it stale.
- The worker never talks to the server and vice versa. Admin actions ("check now", "send test alert") are queued as `Command` documents that the worker picks up.
- After every cycle the worker writes `status.json`; nginx serves it directly. The client falls back to it automatically ("Showing cached status from HH:mm").
- The status page has **its own MongoDB**; it shares nothing with the portals' database.
- The raw `docker.sock` is only mounted (read-only) into `docker-socket-proxy`, which exposes only `GET /containers/*`.

### Status logic (`shared/status.js`)
| State | Meaning |
|---|---|
| `operational` | container running, internal probe OK, public probe OK |
| `degraded` | up but p95 latency over 2 s, **or** internal OK while public fails and `iitg.ac.in` is fine |
| `upstream_outage` | internal OK, public failing, **and** iitg.ac.in DNS/homepage failing. One banner, not N red services |
| `db_impacted` | the shared host MongoDB is down and the service depends on it |
| `down` | container not running / restart loop, or internal probe fails |
| `maintenance` | inside an admin maintenance window (no incidents, no alerts) |

Anti-flapping: worsening needs **3** consecutive identical results, recovery **2**. Interval 60 s, timeout 10 s, 5 concurrent probes.
A restart loop (`Restarting`, or 3+ restarts in 10 min) counts as DOWN, so `industry_backend` shows DOWN.

## Local development

Requires Node 20+ and a MongoDB.

```bash
# 1. a throwaway Mongo
docker run -d --name ccd-status-dev-mongo -p 127.0.0.1:27018:27017 mongo:7

# 2. worker (probes localhost; set STATUS_DIR to somewhere writable)
cd worker && npm install
MONGO_URL=mongodb://127.0.0.1:27018/ccdstatus STATUS_DIR=./data npm start

# 3. API
cd server && npm install
MONGO_URL=mongodb://127.0.0.1:27018/ccdstatus JWT_SECRET=$(openssl rand -hex 32) \
  ADMIN_PASSWORD_HASH="$(npm run -s hash-password -- 'a-long-password')" npm start

# 4. client (proxies /ccd-status/api to :4000)
cd client && npm install && npm run dev      # http://localhost:5173/ccd-status/
```

Tests for the status logic (flapping, upstream detection, maintenance, database impact, overall banner):

```bash
cd shared && npm test
```

The portals aren't running on your laptop, so locally most services show DOWN. That is expected.

## Deploy on 172.17.1.18

```bash
git clone <repo> ccd-status && cd ccd-status
cp .env.example .env && nano .env            # see comments inside
# admin password hash (use single quotes in .env: it contains $):
docker run --rm -v "$PWD/server:/app" -w /app node:20-alpine sh -c "npm install --silent && npm run -s hash-password -- 'your-long-password'"
docker compose up -d --build
docker compose ps                            # all should become "healthy"
```

1. **Host nginx.** Add the `location /ccd-status/` block from [deploy/host-nginx-ccd-status.conf](deploy/host-nginx-ccd-status.conf) inside the existing `server { listen 80 ... }` that serves 172.17.1.18, then `sudo nginx -t && sudo systemctl reload nginx`.
   **This snippet is provisional**: the `nginx -T` output was not available when it was written. Compare it with the real config (which server block, any `include` structure) before applying.
2. **Check** `curl -s http://127.0.0.1:6059/ccd-status/api/health` and open `http://172.17.1.18/ccd-status/`.
3. **IITG webmaster:** proxy `https://iitg.ac.in/ccd-status/` → `http://172.17.1.18/ccd-status/` (keep the path as is; SSE needs response buffering off for `/ccd-status/api/stream`, otherwise the page just polls `status.json` every 30 s, which also works).

Ports used: `6059` (gateway), `27018` (status mongo), `23750` (docker proxy), all bound to `127.0.0.1` only. Every container has `restart: unless-stopped`, a HEALTHCHECK, a memory limit, and log rotation (`10m × 3`).

> **Not tested here:** the Dockerfiles, `docker-compose.yml` and nginx configs were written on a machine without Docker. The worker, server, API, probes, SSE data path and client build were exercised end-to-end locally (see "Verification" below), but run `docker compose up -d --build` and watch `docker compose logs -f` on first deploy.

## Monitoring a portal that has no published port

Most portals run with `network_mode: host`, so they are **not** on any Docker network. The worker also runs on the host network and probes them at `127.0.0.1:<port>`. You do not need to join any Docker network. If a future portal runs on a bridge network *with* a published port, probe `127.0.0.1:<published port>` the same way.

## Add a service

Edit [shared/services.config.js](shared/services.config.js):

```js
{
  key: 'my-portal',                    // stable id, never rename
  name: 'My Portal', group: 'Others',  // group: Placement | Internship | Training | Industry | PhD | Others
  order: 70,
  container: 'my-portal-app',          // docker container name
  dependsOnDb: true,                   // true if it needs the shared host MongoDB
  quality: 'basic',                    // 'health' if internal.path is a real health route
  internal: { port: 6100, path: '/my-portal/api/health' },       // optional; expect: 'lt500' to accept any non-5xx
  public:   { url: 'https://iitg.ac.in/my-portal/' },            // optional
}
```

Then `docker compose up -d --build worker` (the worker re-seeds on start; or run `cd worker && npm run seed`). Probes are GET-only. Pick routes with no auth, no DB writes and no emails. Disable a service without redeploying from **Admin → Services**.

## Admin

`/ccd-status/admin`: single admin from `.env` (`ADMIN_USERNAME`, bcrypt `ADMIN_PASSWORD_HASH`, JWT 8 h, login rate-limited). Incidents (auto-created ones can be annotated), maintenance windows, service on/off + "Check now", raw container table (name, image, state, restarts, uptime), and "Send test alert".

## Alerts

Off by default. The dashboard works fully with no alerts configured. Alerts go out only on state changes (down, recovered, upstream outage, database down), batched into one message per cycle with a per-event cooldown (`ALERT_COOLDOWN_MIN`).

- **Email:** `ALERT_EMAIL_ENABLED=true` plus `SMTP_*`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO`. Use a **non-IITG** SMTP (e.g. Gmail + App Password): IITG mail may be down in the same outage.
- **Telegram:** `ALERT_TELEGRAM_ENABLED=true`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
- Check channel status and send a test from **Admin → Alerts**.
- The server must be able to reach the SMTP host / `api.telegram.org`. Campus egress rules are not yet confirmed.

## API

| | |
|---|---|
| `GET /api/status` | overall status + every service |
| `GET /api/services/:key/history?range=24h\|7d\|90d` | latency series / daily uptime, recent checks, incidents |
| `GET /api/incidents?limit=` | incident history |
| `GET /api/stream` | SSE `status` events |
| `GET /api/health` | health of the status page itself (DB, worker freshness) |
| `/api/admin/*` | JWT: incidents, maintenance, services, check-now, test-alert, containers |

Data: `Check` (TTL 30 d), `DailyRollup` (TTL 365 d, drives the 90-day bars), `ServiceState`, `Incident`, `Maintenance`, `Service`, plus `Command`/`Meta` for worker↔server hand-off.

## Verification done

- `cd shared && npm test`: 15/15 pass.
- `cd client && npm run build`: builds; the output has no external URLs (Geist is bundled, no Google Fonts/CDN).
- End-to-end smoke run (in-memory MongoDB, a fake portal, real worker + real server): probes, debounce to DOWN after 3 cycles, one automatic incident per down service, daily rollup, `status.json` written, `/api/status`, history 24h/90d, `/api/health`, admin routes returning 401 without a token. Docker-dependent parts (container probe, socket proxy) were **not** exercised, so with the Docker API unreachable the container check reports "unknown" and the service is judged on its HTTP probes.

## Known issues / future work (nothing in the portal repos was touched)

These are findings from the audit, listed for later. **None was changed.**

**Monitoring accuracy**
- Only `dday` (`/dday/api/health`) and `intern-2026` (`/intern-2026/api/health`) have real health routes. Every other service is probed on a shell/static route ("basic"), which proves the process is up but **not** that its database works. Suggest adding a `GET /health` that pings Mongo to: Placement, Intern, PhD, CCD App Backend, AIPC, DPR, the training backend and the industry portal.
- `training-backend` (5004): no known route, so any HTTP response below 500 counts as up.
- `industry_backend` is monitored by container state only (no public URL or known path). It was reported in a `Restarting (254)` loop; its repo has three different ports (code `8081`, compose `8081`, Dockerfile `EXPOSE 5002`) and the running image is unnamed, so the running container may not match the repo.
- `ccd-app-backend` has no public probe (public URL unconfirmed).
- The `https://iitg.ac.in/training/` public probe is attached to `training-app` (ccd-app :5001) **provisionally**. Confirm from `nginx -T` whether `/training` actually goes to `:5001` or to `frontend :3000`, then move the `public` entry in `shared/services.config.js`.

**Infrastructure / security (from AUDIT.md section D)**
- One host MongoDB (`127.0.0.1:27017`) is a single point of failure for most portals.
- Ports `5001`, `3000`, `5004`, `3012` (and possibly `8081`) are published on the host and reachable from the campus LAN, bypassing the reverse proxy.
- Secret files in working trees: `.env` files in many repos, `CCD-App-Backend/serviceAccountKey.json`, and a Sentry DSN committed in the Placement frontend.
- Stale/duplicate deployments: `Intern-Portal-2023` vs `latest-intern-portal` (same container name), `placement_portal_frontend` vs `placement23`, `ccdIndustry` has two frontends. Old Node 16/18 images and Mongoose 6 in the Placement/Intern portals.
- The status mongo here uses a password but is otherwise default; it is bound to `127.0.0.1` only.

**This project**
- `nginx -T` / `docker network ls` / `docker inspect` outputs were not provided: the host nginx snippet is provisional and host-networking is inferred from the compose files, not confirmed. Verify `docker inspect --format '{{.HostConfig.NetworkMode}}' <container>`.
- The upstream check runs from the server itself. If the server cannot resolve/reach `iitg.ac.in` for reasons unrelated to the campus link (e.g. no hairpin access to the public URL), every public probe fails and the banner reads "upstream". Confirm `curl -I https://iitg.ac.in/` works from the server.
- `tecnativa/docker-socket-proxy:0.3.0` is pinned from memory; confirm the tag pulls.

## Optional Phase 3 (not built)

A status page on `172.17.1.18` cannot report that `172.17.1.18` itself is down. Suggested: a tiny external watchdog outside campus, a GitHub Actions cron (every 5 min) that GETs the public `https://iitg.ac.in/<app>/` URLs and `https://iitg.ac.in/ccd-status/api/health`, and alerts via Telegram/email on failure (or a free hosted uptime pinger). It tests the same public path outside users see.
