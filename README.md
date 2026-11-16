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

A status page on `172.17.1.148` cannot report that `172.17.1.148` itself is down. Suggested: a tiny external watchdog outside campus, a GitHub Actions cron (every 5 min) that GETs the public `https://iitg.ac.in/<app>/` URLs and `https://iitg.ac.in/ccd-status/api/health`, and alerts via Telegram/email on failure (or a free hosted uptime pinger). It tests the same public path outside users see.
