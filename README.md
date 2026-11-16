# CCD System Status

Status page for the IIT Guwahati Centre for Career Development portals. It tells **container**, **host nginx**, **database**, **upstream (campus network / iitg.ac.in)** and **application** problems apart, so one campus outage does not show up as a dozen broken services.

Served at `/ccd-status/` (host nginx on `<SERVER_IP>` → gateway on `127.0.0.1:6059`). Later the IITG webmaster proxies `https://iitg.ac.in/ccd-status/` → `http://<SERVER_IP>/ccd-status/`. The build is path-stable (`/ccd-status/`), so it works in both places unchanged.

> See [AUDIT.md](AUDIT.md) for the Phase 1 findings this is based on, and [WEBMASTER.md](WEBMASTER.md) for the request to send to the IITG webmaster.

## Architecture

Four long-running containers plus a one-shot `init-perms`; compose project `ccd-status`, all named `ccd-status-*`. Server, worker and gateway use `network_mode: host` like the other CCD portals.

```
 browser ─► (IITG proxy) ─► host nginx :80 ─► gateway  127.0.0.1:6059   (nginx, serves client + status.json)
                                                │   ├─ /ccd-status/              static React build
                                                │   ├─ /ccd-status/status.json   written by the worker (works if the API is down)
                                                │   └─ /ccd-status/api/*  ───► server 127.0.0.1:6060 (Express: REST + SSE + admin)
 worker (checks, in-memory state) ── writes ── status.json (volume ccd_status_data) ── read-only ──► gateway, server
   ├─ probes portals at 127.0.0.1:<port>  →  host nginx  →  https://iitg.ac.in/...
   ├─ Docker state via socket-proxy 127.0.0.1:23750 (CONTAINERS=1 only, read-only)
   ├─ probes the host MongoDB (driver, {hello:1}, no credentials)
   └─ write-behind persistence ──► host mongod 127.0.0.1:27017, database "ccd-status" (MONGO_URI)
```

| Container | Network | Listens on | Notes |
|---|---|---|---|
| `ccd-status-socket-proxy` | bridge | `127.0.0.1:23750` | `tecnativa/docker-socket-proxy`, `CONTAINERS=1`, everything else `0`, `docker.sock` mounted `:ro` (root filesystem writable: haproxy renders its config at start-up) |
| `ccd-status-init-perms` | none | none | one-shot: chowns the shared status volume for the worker (uid 1000), then exits |
| `ccd-status-worker` | host | none | probes + status logic + `status.json` + DB write-behind |
| `ccd-status-server` | host | `127.0.0.1:6060` only | REST, SSE, admin. Never `0.0.0.0` |
| `ccd-status-gateway` | host | `127.0.0.1:6059` only | nginx-unprivileged |

All have `restart: unless-stopped`, `init: true`, `no-new-privileges`, memory limits (worker 256m, server 256m, gateway 64m, proxy 64m), log rotation (`10m × 3`), and run as non-root with a read-only root filesystem (`tmpfs /tmp`). Every image has a `HEALTHCHECK` and OCI labels with the git SHA and build date.

**Database:** the existing host `mongod`, own database **`ccd-status`** (`MONGO_URI`). There is no Mongo container. The status page never touches any other database.

### It keeps working when MongoDB is down (the main thing it must report)
The host mongod is shared by almost every portal, so a Mongo outage is exactly what this page has to show. Design:

- **Status logic never reads the database.** The worker keeps all state (service states, incidents, maintenance, 90-day rollups) in memory (`worker/src/store.js`); the database is only a write-behind sink.
- **`status.json` is written every cycle**, DB up or down, including the **"Shared database down"** banner once the mongod probe fails.
- Check results are **buffered in memory (capped to ~1 h)** and flushed when Mongo returns (rollups, incident changes and states are flushed too, nothing is duplicated). Reconnect uses backoff (2 s steps up to 30 s) and never crashes the process.
- **Server:** `/api/status` and the SSE stream are served from `status.json`; history, incidents and admin endpoints return **503** with a clear message and the UI shows "History temporarily unavailable".
- **Healthchecks never depend on Mongo** (`/api/health` is 200 whenever the server can serve; the worker's check is a heartbeat file under 120 s old), so Docker does not restart the status page during a database outage.
- Services that depend on the database are shown as `db_impacted` ("Impacted by database"), not as individually down.

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

Three HTTP tiers per service, innermost first: **app port** (`127.0.0.1:<port>`) → **host nginx** (`http://127.0.0.1<path>` with `Host: <SERVER_IP>`) → **public** (`https://iitg.ac.in/...`). A failing app port is always `down` (nginx would 502 too). Services not behind nginx (training `frontend`/`backend`, `placement_portal_frontend`) only have the app-port probe; `industry_backend` is container-only.

Overall banner precedence: upstream → host nginx → shared database → per-service counts.
Anti-flapping: worsening needs **3** consecutive identical results, recovery **2**. Interval 60 s, timeout 10 s, 5 concurrent probes. A restart loop (`Restarting`, or 3+ restarts in 10 min) counts as DOWN.

## Local development

Requires Node 20+ and a MongoDB you can write a scratch database `ccd-status` to.

```bash
cd worker && npm install && MONGO_URI=mongodb://127.0.0.1:27017/ccd-status STATUS_DIR=./data npm start
cd server && npm install && MONGO_URI=mongodb://127.0.0.1:27017/ccd-status STATUS_DIR=./data \
  JWT_SECRET=$(openssl rand -hex 32) PORT=6060 npm start
cd client && npm install && npm run dev        # http://localhost:5173/ccd-status/  (proxies /ccd-status/api to :6060)
```
Tests: `cd shared && npm test` (status logic, snapshot incl. "Mongo down → banner still produced") and `cd worker && npm test` (in-memory store: buffering, ~1 h cap, flush on recovery). Locally most portals are not running, so most services show DOWN. That is expected.

---

## Deploy on the server (manual) — `<DEPLOY_DIR>`

Server facts this was built for: `<SERVER_IP>`, Docker Compose v2.26.1, ports `6059`, `6060`, `23750` free, `https://iitg.ac.in/` reachable from the server, host `mongod` on `127.0.0.1:27017`.

### 1. Clone (private GitHub repo, read-only deploy key)
```bash
ssh-keygen -t ed25519 -f ~/.ssh/ccd_status_deploy -N "" -C "ccd-status deploy"
cat ~/.ssh/ccd_status_deploy.pub       # GitHub repo -> Settings -> Deploy keys -> Add key (leave "Allow write access" OFF)

mkdir -p "$(dirname <DEPLOY_DIR>)"        # the parent directory must exist and be writable by you
GIT_SSH_COMMAND="ssh -i ~/.ssh/ccd_status_deploy -o IdentitiesOnly=yes" git clone git@github.com:<OWNER>/<REPO>.git <DEPLOY_DIR>
cd <DEPLOY_DIR> && git config core.sshCommand "ssh -i ~/.ssh/ccd_status_deploy -o IdentitiesOnly=yes"
```
If campus egress blocks SSH on port 22: `git clone ssh://git@ssh.github.com:443/<OWNER>/<REPO>.git <DEPLOY_DIR>`.

### 2. (Recommended) create a MongoDB user limited to the `ccd-status` database
Give the status page its own database user, restricted to its own database:
```bash
mongosh -u <admin-user> -p --authenticationDatabase admin      # add credentials only if your MongoDB requires them
```
```js
use ccd-status
db.createUser({ user: "ccdstatus", pwd: passwordPrompt(), roles: [{ role: "readWrite", db: "ccd-status" }] })
```
Then in `.env`: `MONGO_URI=mongodb://ccdstatus:<password>@127.0.0.1:27017/ccd-status?authSource=ccd-status` (URL-encode special characters in the password). If your MongoDB needs no credentials, the plain `mongodb://127.0.0.1:27017/ccd-status` works. Either way the page never touches another database.

### 3. Configure `.env`
```bash
cd <DEPLOY_DIR>
cp .env.example .env && chmod 600 .env
nano .env        # MONGO_URI, ADMIN_PASSWORD_HASH, JWT_SECRET (see below); alerts stay off by default
```
**Admin password hash (one command: generates it and writes it, correctly escaped, into `.env`).** Build the server image first (`docker compose build server`), then:
```bash
H=$(docker compose run --rm --no-deps --entrypoint node server scripts/hash-password.js 'your-long-password' | tail -n 1) \
  && sed -i "s|^ADMIN_PASSWORD_HASH=.*|ADMIN_PASSWORD_HASH=${H//\$/\$\$}|" .env \
  && grep '^ADMIN_PASSWORD_HASH=\$\$2' .env | cut -c1-40      # should print ADMIN_PASSWORD_HASH=$$2a$$12$$...
```
The password must be 10+ characters and must not contain a single quote. **Do not paste the raw hash and do not quote it**: see "Known deploy gotchas" below. `JWT_SECRET`: `openssl rand -hex 32`.

#### Known deploy gotchas
- **`$` in `ADMIN_PASSWORD_HASH`.** A bcrypt hash looks like `$2a$12$...`. Docker Compose interpolates `$` in `.env`, so **every `$` must be written as `$$` and the value must not be quoted**: `ADMIN_PASSWORD_HASH=$$2a$$12$$...`. Quoting it, or leaving single `$`, silently corrupts the hash and admin login fails with "invalid credentials". The one-liner above does this for you. (Compose turns `$$` back into `$` inside the container.)
- **Status volume permissions.** A one-shot `init-perms` container (the worker image, run as root) chowns the shared `ccd_status_data` volume to uid 1000 before the worker starts, so a fresh deploy needs no manual `chown`. It shows as `Exited (0)` in `docker compose ps`: that is normal.
- **Socket proxy is not `read_only`.** haproxy writes its config at start-up, so only that one container has a writable root filesystem (the Docker socket is still mounted `:ro`, only `CONTAINERS=1` is enabled, and it listens on loopback only).
- **Training portal probe path.** The training app is served under `/training/` on its port (the app-port, nginx and public probes all use `/training/`).

### 4. Build and start
```bash
cd <DEPLOY_DIR>
GIT_SHA=$(git rev-parse --short=12 HEAD) BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ) docker compose up -d --build
```
(`docker compose up -d --build` alone also works; the two variables only set the image labels and tags `ccd-status-*:<sha>`.)

### 5. Health check
```bash
docker compose ps                                                  # wait until all four are "healthy" (~1 min)
curl -s  http://127.0.0.1:6060/api/health                          # {"ok":true,"status":"ok","db":true,"worker":true,...}
curl -sI http://127.0.0.1:6059/ccd-status/ | head -1               # HTTP/1.1 200 OK
curl -s  http://127.0.0.1:6059/ccd-status/api/health
curl -s  http://127.0.0.1:6059/ccd-status/status.json | head -c 300
docker compose logs --tail 50 worker                               # shows "database ready; hydrated from storage"
```
If something is unhealthy: `docker compose logs --tail 50 <worker|server|gateway|socket-proxy>`.

### 6. Apply the nginx block (by hand)
[deploy/host-nginx-ccd-status.conf](deploy/host-nginx-ccd-status.conf) must be pasted into the **FIRST** `server { }` block (the one with `server_name <SERVER_IP>`) of `/etc/nginx/sites-enabled/default`, just before that block's closing brace. **Do not touch the second, duplicate server block.** The block is:
```nginx
location = /ccd-status { return 301 /ccd-status/; }

location /ccd-status/ {
    proxy_pass http://127.0.0.1:6059/ccd-status/;     # the /ccd-status prefix is KEPT
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
    proxy_set_header X-Forwarded-Prefix /ccd-status;
    proxy_buffering off;                               # Server-Sent Events
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_connect_timeout 5s;
}
```
```bash
# a) BACK UP FIRST. Keep the backup OUTSIDE sites-enabled/: nginx loads every file in that directory, so a
#    backup left there would become yet another duplicate server block.
sudo cp /etc/nginx/sites-enabled/default /etc/nginx/default.bak-$(date +%F)

# b) edit: paste the block just before the first server block's closing "}"
sudo nano /etc/nginx/sites-enabled/default

# c) test, then reload (graceful: no dropped connections)
sudo nginx -t && sudo systemctl reload nginx

# d) verify through nginx
curl -sI http://<SERVER_IP>/ccd-status/ | head -1             # HTTP/1.1 200 OK
curl -s  http://<SERVER_IP>/ccd-status/api/health
```
`nginx -t` keeps printing the existing "conflicting server name" warning for the duplicate block. That is pre-existing; what matters is `syntax is ok` / `test is successful`.

**Rollback nginx** (if `nginx -t` fails or anything breaks):
```bash
sudo cp /etc/nginx/default.bak-<DATE> /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```
If `nginx -t` fails, do not reload: the running nginx keeps serving the old config until you do.

### 7. IITG webmaster
Send [WEBMASTER.md](WEBMASTER.md). Until it is in place the page works at `http://<SERVER_IP>/ccd-status/`, and the public probes keep checking the other portals normally.

### Update
```bash
cd <DEPLOY_DIR>
git pull
GIT_SHA=$(git rev-parse --short=12 HEAD) BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ) docker compose up -d --build --remove-orphans
docker compose ps
```
Rebuild periodically with `docker compose build --pull` to pick up base-image security patches (`node:20-alpine`, `nginx-unprivileged:1.27-alpine`).

### Roll back the application
Images are tagged with the git SHA you built from (`docker images 'ccd-status-*'`). To go back to a known-good commit:
```bash
cd <DEPLOY_DIR>
git log --oneline | head           # pick the good <sha>
git checkout <sha>
GIT_SHA=$(git rev-parse --short=12 HEAD) BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ) docker compose up -d --build
# later, to follow the main branch again:  git checkout master && git pull
```
Data is not affected: it lives in the `ccd-status` database and the `ccd_status_data` volume. To stop everything: `docker compose down` (add nothing else; the volume survives).

### Backup (run by hand; no cron, no script)
One line: dumps **only** the `ccd-status` database (the URI names it) to a dated, gzipped archive.
```bash
mkdir -p <DEPLOY_DIR>/backups && mongodump --uri "$(grep '^MONGO_URI=' <DEPLOY_DIR>/.env | cut -d= -f2-)" --gzip --archive=<DEPLOY_DIR>/backups/$(date +%F).gz
```
Needs `mongodump` (mongodb-database-tools) on the host. If the URI contains a password it is visible in `ps` while the command runs. Restore: `mongorestore --uri "<same MONGO_URI>" --gzip --archive=<DEPLOY_DIR>/backups/<date>.gz --nsInclude 'ccd-status.*'`. `backups/` is git-ignored. The data is operational history (30 days of checks, 365 days of daily rollups), so losing it is not critical.

---

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
Then `git pull && docker compose up -d --build worker` (the worker re-seeds on start). Probes are GET-only. Pick routes with no auth, no DB writes and no emails. Disable a service without redeploying from **Admin → Services**. Most portals run with `network_mode: host`, so they are probed at `127.0.0.1:<port>`; a bridge-network portal with a published port is probed at `127.0.0.1:<published port>` the same way.

## Admin
`/ccd-status/admin`: single admin from `.env` (`ADMIN_USERNAME`, bcrypt `ADMIN_PASSWORD_HASH`, JWT 8 h, login rate-limited). Incidents (auto-created ones can be annotated), maintenance windows, service on/off + "Check now", raw container table (name, image, state, restarts, uptime) and "Send test alert". While MongoDB is down the admin data endpoints return 503; login still works.

## Alerts
Off by default; the dashboard works fully without them. Alerts go out only on state changes (down, recovered, upstream outage, host nginx issue, database down), batched into one message per cycle with a per-event cooldown (`ALERT_COOLDOWN_MIN`).
- **Email:** `ALERT_EMAIL_ENABLED=true` plus `SMTP_*`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO`. Use a **non-IITG** SMTP (e.g. Gmail + App Password): IITG mail may be down in the same outage.
- **Telegram:** `ALERT_TELEGRAM_ENABLED=true`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
- Check channel status and send a test from **Admin → Alerts**. The server must be able to reach the SMTP host / `api.telegram.org` (campus egress rules not yet confirmed).

## API
| | |
|---|---|
| `GET /api/status` | overall status + every service (from `status.json`; works with the DB down) |
| `GET /api/services/:key/history?range=24h\|7d\|90d` | latency series / daily uptime, recent checks, incidents. **503** if the DB is down |
| `GET /api/incidents?limit=` | incident history. 503 if the DB is down |
| `GET /api/stream` | SSE `status` events |
| `GET /api/health` | health of the status page itself. Always 200 while the process serves; `status:"degraded"` if the DB is down or the worker is stale |
| `/api/admin/*` | JWT: incidents, maintenance, services, check-now, test-alert, containers |

Collections in `ccd-status`: `checks` (TTL 30 d), `dailyrollups` (TTL 365 d, drives the 90-day bars), `servicestates`, `incidents`, `maintenances`, `services`, plus `commands`/`metas` for worker↔server hand-off.

## Verification done
- `cd shared && npm test`: 26/26. `cd worker && npm test`: 5/5.
- `cd client && npm run build`: builds with `BASE_PATH` configurable; no external URLs (Geist is bundled; no CDN/Google Fonts).
- End-to-end smoke runs (in-memory MongoDB, fake portal + fake host nginx, real worker + real server), including **stopping MongoDB mid-run**: `status.json` kept updating and showed the database state, `/api/status` kept serving, history returned 503 `DB_UNAVAILABLE`, `/api/health` stayed 200, no process crashed, and after Mongo came back the buffered checks (with timestamps from inside the outage) were flushed and history worked again.
- `docker-compose.yml` parses (all services as specified); `gateway.nginx.conf` template renders with no leftover placeholders. There are no deploy or backup scripts and no cron: everything is the manual steps above.
- **Not tested here (no Docker or nginx on the dev machine):** the Dockerfiles/compose build, the container healthchecks, `read_only` + tmpfs behaviour, the nginx configs. (Fixes from the first real deploy are described under "Known deploy gotchas".) Watch `docker compose logs -f` on first deploy.

## Optional Phase 3 (not built)
A status page on `<SERVER_IP>` cannot report that `<SERVER_IP>` itself is down. Suggested: a tiny external watchdog outside campus, a GitHub Actions cron (every 5 min) that GETs the public `https://iitg.ac.in/<app>/` URLs and `https://iitg.ac.in/ccd-status/api/health`, and alerts via Telegram/email on failure (or a free hosted uptime pinger). It tests the same public path outside users see.
