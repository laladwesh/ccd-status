# CCD System Status

Status page for the IIT Guwahati Centre for Career Development portals. It tells **container**, **database**, **upstream (campus network / iitg.ac.in)** and **application** problems apart, so one campus outage does not show up as a dozen broken services.

Served at `/ccd-status/` (host nginx on `172.17.1.148` → gateway container on `127.0.0.1:6059`). Later the IITG webmaster proxies `https://iitg.ac.in/ccd-status/` → `http://172.17.1.148/ccd-status/`. The build is path-stable (`/ccd-status/`), so it works in both places unchanged.

> See [AUDIT.md](AUDIT.md) for the Phase 1 findings this is based on.

## Architecture

```
                    ┌────────────── 172.17.1.148 ──────────────┐
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
| `operational` | container running, app port OK, host nginx path OK, public URL OK |
| `degraded` | up but p95 latency over 2 s, **or** app + nginx OK, public fails, `iitg.ac.in` OK → "IITG proxy route issue for this path" |
| `nginx_issue` | app port OK but the **host nginx** path fails ("Server nginx issue"). If nginx refuses connections or *all* nginx routes fail while the apps are up, one **Host nginx** infra banner is shown instead of N red services |
| `upstream_outage` | app + nginx OK, public failing, **and** iitg.ac.in DNS/homepage failing. One banner, not N red services |
| `db_impacted` | the shared host MongoDB is down and the service depends on it |
| `down` | container not running / restart loop, or the app port probe fails |
| `maintenance` | inside an admin maintenance window (no incidents, no alerts) |

Three HTTP tiers per service, innermost first: **app port** (`127.0.0.1:<port>`) → **host nginx** (`http://127.0.0.1<path>` with `Host: 172.17.1.148`) → **public** (`https://iitg.ac.in/...`). A failing app port is always `down` (nginx would 502 too), never an nginx issue. Services that are not behind nginx (training `frontend`/`backend`, `placement_portal_frontend`) only have the app-port probe; `industry_backend` is container-only.

Overall banner precedence: upstream → host nginx → shared database → per-service counts.

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

## Deploy on 172.17.1.148

Server facts this was built against: Docker Compose v2.26.1; ports `6059`, `27018`, `23750` free; the server reaches `https://iitg.ac.in/` directly (no HTTP proxy).

### 1. Get the code onto the server (private GitHub repo)
Pushing is done by you from your own machine (nothing here pushes). On the server use a **read-only deploy key**, not a personal token:

```bash
# on the server, as the deploy user
ssh-keygen -t ed25519 -f ~/.ssh/ccd_status_deploy -N "" -C "ccd-status deploy"
cat ~/.ssh/ccd_status_deploy.pub          # GitHub repo -> Settings -> Deploy keys -> Add (leave "Allow write access" OFF)

cd ~ && GIT_SSH_COMMAND="ssh -i ~/.ssh/ccd_status_deploy -o IdentitiesOnly=yes" \
  git clone git@github.com:<OWNER>/<REPO>.git ccd-status
cd ccd-status && git config core.sshCommand "ssh -i ~/.ssh/ccd_status_deploy -o IdentitiesOnly=yes"
```
If campus egress blocks SSH on port 22, use GitHub's SSH-over-443: `git clone ssh://git@ssh.github.com:443/<OWNER>/<REPO>.git`.
Later updates: `git pull && docker compose up -d --build`.

### 2. Configure and start
```bash
cp .env.example .env && chmod 600 .env && nano .env     # see comments inside

# admin password hash -> put it in .env as ADMIN_PASSWORD_HASH='<hash>' (single quotes: it contains $)
docker run --rm -v "$PWD/server:/app" -w /app node:20-alpine \
  sh -c "npm install --silent && npm run -s hash-password -- 'your-long-password'"

docker compose up -d --build
docker compose ps                    # wait until all are "healthy" (worker needs ~1 min)
curl -s http://127.0.0.1:6059/ccd-status/api/health        # {"ok":true,"db":true,"worker":true,...}
curl -sI http://127.0.0.1:6059/ccd-status/ | head -1        # HTTP/1.1 200 OK
```
Ports used: `6059` (gateway), `27018` (status mongo), `23750` (docker proxy), all bound to `127.0.0.1` only. Every container has `restart: unless-stopped`, a HEALTHCHECK, a memory limit and log rotation (`10m × 3`).

### 3. Apply the nginx snippet
The location block goes inside the **first** `server { }` block (`server_name 172.17.1.148`) of `/etc/nginx/sites-enabled/default`, just before that block's closing brace. **Do not touch the second, duplicate server block.**

```bash
# a) BACK UP FIRST. Keep the backup OUTSIDE sites-enabled/: nginx loads every file in that
#    directory, so a backup left there would create yet another duplicate server block.
sudo cp /etc/nginx/sites-enabled/default /etc/nginx/default.bak-$(date +%F)

# b) look at the file and find the first server block's closing brace
sudo nano /etc/nginx/sites-enabled/default
#    paste the contents of deploy/host-nginx-ccd-status.conf just before that closing "}"

# c) test, then reload (reload is graceful: no dropped connections)
sudo nginx -t && sudo systemctl reload nginx

# d) verify
curl -sI http://172.17.1.148/ccd-status/ | head -1          # HTTP/1.1 200 OK
curl -s  http://172.17.1.148/ccd-status/api/health
curl -s  http://172.17.1.148/ccd-status/status.json | head -c 200
```
`nginx -t` will keep printing the existing "conflicting server name" warning for the duplicate block. That is pre-existing and harmless here; what matters is `syntax is ok` / `test is successful`.

**Rollback** (if `nginx -t` fails, or anything else breaks):
```bash
sudo cp /etc/nginx/default.bak-<DATE> /etc/nginx/sites-enabled/default    # the backup you made in (a)
sudo nginx -t && sudo systemctl reload nginx
```
If `nginx -t` fails, do not reload: the running nginx keeps serving the old config until you do. The status stack itself can be stopped independently with `docker compose down` (data survives in the named volumes).

### 4. IITG webmaster
Send them [WEBMASTER.md](WEBMASTER.md). Until it's in place the page works at `http://172.17.1.148/ccd-status/` and the **public** probes keep checking the other portals normally.

> **Not tested here:** the Dockerfiles, `docker-compose.yml` and the nginx configs were written on a machine without Docker or nginx. The worker, server, API, probes (including the Host-header nginx tier) and client build were exercised end-to-end locally (see "Verification" below), but run `docker compose logs -f` on first deploy and expect to fix small things.

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
  internal: { port: 6100, path: '/my-portal/api/health' },       // app port; expect: 'lt500' to accept any non-5xx
  nginx:    { path: '/my-portal/api/health' },                   // through the host nginx; omit if not behind nginx
  public:   { url: 'https://iitg.ac.in/my-portal/' },            // through the IITG proxy; omit if none
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

- `cd shared && npm test`: 23/23 pass (adds the nginx tier: nginx_issue, upstream vs proxy-route degraded, whole-nginx banner, precedence).
- `cd client && npm run build`: builds; the output has no external URLs (Geist is bundled, no Google Fonts/CDN).
- End-to-end smoke run (in-memory MongoDB, a fake portal, real worker + real server): probes, debounce to DOWN after 3 cycles, one automatic incident per down service, daily rollup, `status.json` written, `/api/status`, history 24h/90d, `/api/health`, admin routes returning 401 without a token. Docker-dependent parts (container probe, socket proxy) were **not** exercised, so with the Docker API unreachable the container check reports "unknown" and the service is judged on its HTTP probes.

## Known issues / future work (nothing in the portal repos was touched)

These are findings from the audit, listed for later. **None was changed.**

**Monitoring accuracy**
- Only `dday` (`/dday/api/health`) and `intern-2026` (`/intern-2026/api/health`) have real health routes. Every other service is probed on a shell/static route ("basic"), which proves the process is up but **not** that its database works. Suggest adding a `GET /health` that pings Mongo to: Placement, Intern, PhD, CCD App Backend, AIPC, DPR, the training backend and the industry portal.
- `training-backend` (5004): no known route, so any HTTP response below 500 counts as up.
- `industry_backend` is monitored by container state only, with the reason "Restart loop: /app/package.json missing in image" (`knownIssue` in `shared/services.config.js`; remove it once fixed so the real reason shows).
- `ccd-app-backend`'s public URL `https://iitg.ac.in/ccd-app/` redirects to `/ccd-app/policies`; redirects count as up (never followed).
- Confirmed with the server outputs: `/training` → `127.0.0.1:5001` (ccd-app), so the training public probe is on `training-app`.

**Infrastructure / security (from AUDIT.md section D and the server outputs). None of this was changed.**
- **CRITICAL: the host `mongod` listens on `0.0.0.0:27017`, reachable from the campus LAN.** Verify authentication is enabled, and bind it to `127.0.0.1` (`bindIp`) or firewall it. All portals use it from the host, so loopback is enough. The status page's own Mongo (`27018`) is bound to `127.0.0.1` and password-protected.
- All portal ports (`5000`, `5005`, `5009`, `6001`, `6025`, `6026`, `7002`, `11034`) listen on all interfaces and can be reached directly, bypassing nginx. `3000`, `3012`, `5001` and `5004` are published by Docker on `0.0.0.0`. Bind them to `127.0.0.1` (or firewall) where nginx is the only intended entry.
- **`industry_backend` restart loop (exit 254):** the image lacks `/app/package.json` (probably a missing bind mount or a bad build; the running image is unnamed `76976256732a`). Separately, nginx `/industry-backend` proxies to `:5002` but the code listens on `8081` (and the Dockerfile says `EXPOSE 5002`).
- **Dead nginx routes returning 502:** `/oa-check` (→ 6021), `/ccd-industry/` (→ 5011), `/industry-backend` (→ 5002). Nothing listens on those ports (oa, industry-payment are not deployed).
- **Duplicate `server` block** in `/etc/nginx/sites-enabled/default` (nginx warns "conflicting server name"). Which block wins is order-dependent; remove the duplicate when convenient.
- One host MongoDB is a single point of failure for most portals.
- Secret files in working trees: `.env` files in many repos, `CCD-App-Backend/serviceAccountKey.json`, and a Sentry DSN committed in the Placement frontend.
- Stale/duplicate repos: `Intern-Portal-2023` vs `latest-intern-portal` (live: `latest-intern-portal`), `ccdIndustry` has two frontends. Old Node 16/18 images and Mongoose 6 in the Placement/Intern portals.

**This project**
- The upstream check runs from the server itself. It reached `https://iitg.ac.in/` fine (200, 0.23 s) when tested, so this is only a caveat if that changes.
- `tecnativa/docker-socket-proxy:0.3.0` is pinned from memory; confirm the tag pulls. If not, use the newest tag.
- Not yet verified on the real server: the `Host: 172.17.1.148` header sent by the nginx probe matches the first server block (it should: that block has `server_name 172.17.1.148`).

## Optional Phase 3 (not built)

A status page on `172.17.1.148` cannot report that `172.17.1.148` itself is down. Suggested: a tiny external watchdog outside campus, a GitHub Actions cron (every 5 min) that GETs the public `https://iitg.ac.in/<app>/` URLs and `https://iitg.ac.in/ccd-status/api/health`, and alerts via Telegram/email on failure (or a free hosted uptime pinger). It tests the same public path outside users see.
