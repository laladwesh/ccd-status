# CCD Status Dashboard: Phase 1 Audit

Read-only scan of `CCD/*`. Nothing outside `ccd-status/` was modified. No secret values are recorded here, only env var **names**.
Everything marked **(unverified)** is inferred from code and needs confirmation from the server (see section C).

## 0. Headline findings

1. **Almost every "no published ports" container uses `network_mode: host`.** `docker ps` shows an empty Ports column for host-networked containers, so they are not on any Docker bridge network. The brief's plan to join their Docker networks and probe `http://<container>:<port>` **will not work** for them. The worker has to probe them through the host (`host.docker.internal` via `extra_hosts: host-gateway`, or `network_mode: host`) on the ports in section B. This changes the Phase 2 architecture (section E).
2. **Public URLs are path-based on one host, not subdomains.** Everything is `https://iitg.ac.in/<app>/...` (`/placements`, `/intern`, `/intern-2026`, `/dday`, `/aipc`, `/listing-ccd`, `/phdplacement`, `/ccd-app`). There is nothing like `placement.iitg.ac.in` to resolve separately. One DNS and TLS check on `iitg.ac.in` covers all public probes, which makes "upstream outage" detection simple.
3. **Mongo for the portals is a native `systemd mongod` on the host (`127.0.0.1:27017`)** per the compose comments in dday, intern-2026, oa, dpr and aipc. All the host-networked portals share it. It is the biggest hidden single point of failure, and it is not in `docker ps`. The dashboard should probe it, but it needs a TCP check or `ping`, not a container check.
4. **Only 4 of 13 services have a real `/health` route**; none of the other 9 do (section B). The rest can only be probed with a static shell route or a harmless JSON route, which proves Express is alive but not that Mongo is reachable.
5. **`industry_backend` cannot be diagnosed from the repo.** See section D.
6. **Identity gaps:** the training `frontend`/`backend` containers and `placement_portal_frontend` look like legacy or duplicate deployments (section D).

## 1. Per-project audit

Legend: HN = `network_mode: host`. "Shell route" = an unauthenticated route that serves static HTML, with no DB access in our code reading.

### 1.1 Placement-Portal-2023 → container `placement23` (confidence: HIGH)
- **Identity evidence:** `docker-compose.prod.yaml` has `image: placement23`, `container_name: placement23`, and root `Dockerfile` (node:18-alpine, frontend build copied into backend).
- **Stack:** CRA frontend (`react-scripts` 5, React 18, Tailwind 3, **antd 5.29**); Express 4 backend (ESM); MongoDB via Mongoose 6; Node 18.
- **Runtime:** HN. `APP_PORT=5000` in `backend/.env.production`. The compose `ports: 10010:5000` is ignored under HN. API at `/placements/api` (`BASE_URL=placements/api`), SPA at `/placements` (`FD_BASEURL`). AdminBro at `/placements/api/NEXOLadmin`. No nginx config in repo.
- **Public URL:** `https://iitg.ac.in/placements/`, API `https://iitg.ac.in/placements/api/`.
- **Health:** none. Cheapest safe probe: **`GET /placements/api/`** returns `{"message":"Welcome to placement portal!!"}` (`routes/mainRouter.js:40`), no auth, no DB. Frontend probe: `GET /placements/`.
- **Dependencies (names only):** `DATABASE_URL`, `SESSIONS_DB`, `SESSION_SECRET`, `JWT_SECRET`, `EMAIL_USER`/`EMAIL_PASSWORD` (+ `TECH_EMAIL*`, `LOGI*`, `EVENT_MAIL*`), `OUTLOOK_*`, `GOOGLE_CLIENT_*`, `CCD_APP_NOTIF_URL/TOKEN`, `WHATSAPP_GROUP_AUTOMATION_URL/TOKEN`, `DDAY_PORTAL_URL`, `DDAY_SYNC_KEY`.
- **Related:** `Placement-Portal-2023/frontend/docker-compose.prod.yaml` defines `placement_portal_frontend` (see 1.12).

### 1.2 latest-intern-portal / Intern-Portal-2023 → container `intern24test` (confidence: MEDIUM on *which repo*)
- **Evidence:** both repos have an identical compose (`image: intern24test`, `container_name: intern24test`, HN, commented `10012:3000`). `latest-intern-portal` is Node 20, antd 6; `Intern-Portal-2023` is Node 16. Either could be running. **(unverified)**
- **Stack (latest):** CRA, React 18, Tailwind 3, **antd 6.6**; Express 4, Mongoose 6.
- **Runtime:** HN. `APP_PORT=11034`, `BASE_URL=intern/api`, `FD_BASEURL=/intern`. The `Dockerfile` `EXPOSE 3000` is irrelevant under HN.
- **Public URL:** `https://iitg.ac.in/intern/` (API `/intern/api/`).
- **Health:** none. Probe **`GET /intern/api/`** (same welcome JSON, `mainRouter.js:31`) and `GET /intern/`.
- **Dependencies:** the same set as Placement (`DATABASE_URL`, `SESSIONS_DB`, `OUTLOOK_*`, `GOOGLE_*`, `CCD_APP_NOTIF_*`, `WHATSAPP_*`, `DDAY_API_KEY`, ...).
- A leftover `intern24_frontend` compose (`10012:3000`) exists in `latest-intern-portal/frontend`, which is not in `docker ps`.

### 1.3 Intern-2026 → container `intern2026-app` (HIGH)
- **Evidence:** compose `container_name: intern2026-app`.
- **Stack:** CRA + **Tailwind 3 only (no antd)**, React 19, Express 5, Mongoose 9, Node 20.
- **Runtime:** HN, `PORT=5009`, `APP_BASE_PATH=/intern-2026`, API at `/intern-2026/api`. Mongo on host `127.0.0.1`.
- **Public URL:** `https://iitg.ac.in/intern-2026/`.
- **Health:** **`GET /intern-2026/api/health`** exists and returns `{message: "CCD Intern 2026 API is running"}`. Expect 200.
- **Dependencies:** `MONGO_URI`, `JWT_SECRET`, `AZURE_CLIENT_ID/SECRET/TENANT_ID/REDIRECT_URI`, `ADMIN_TOKEN`.

### 1.4 live-placement → container `dday2026-app`, image `live-sheet-2025-app` (HIGH on repo, MEDIUM on image name)
- **Evidence:** compose `container_name: dday2026-app`. The image name `live-sheet-2025-app` is the compose project name from an older folder name. **(unverified)**
- **Stack:** CRA (`client/`, React 19, **antd 5.29**, Tailwind 3, `react-icons`); Express 4 `src/server.js`; Mongoose 8; Node 20. AdminJS at `/dday/db-admin`.
- **Runtime:** HN, `PORT=5005`, `BASE_PATH=/dday`.
- **Public URL:** `https://iitg.ac.in/dday/` (also referenced: `/dday/team`, `/dday/login`).
- **Health:** **`GET /dday/api/health`** returns `{ok:true}` (`src/server.js:118`).
- **Dependencies:** `MONGO_URI`, `SESSION_SECRET`, `JWT_SECRET`, `AZURE_*`, `GOOGLE_*`, `SMTP_*`, `PLACEMENT_PORTAL_API`, `INTERN_PORTAL_BASE_URL/API_KEY`, `DDAY_SYNC_KEY`. It calls the Placement and Intern portals, so it depends on them.

### 1.5 PHD_PLACEMENT_PORTAL_CCD/portal → container `phdplacement-app`, image `phdplacement:latest` (HIGH)
- **Evidence:** `portal/docker-compose.yml` has `image: phdplacement:latest`, `container_name: phdplacement-app`.
- **Stack:** **Next.js 16.3 (App Router, `output: standalone`)**, React 19, Tailwind 4, Mongo; Node 22. The only project not on CRA/Express.
- **Runtime:** HN, `PORT=7002`, `basePath: "/phdplacement"`.
- **Public URL:** `https://iitg.ac.in/phdplacement/`.
- **Health:** none. Candidates: `GET /phdplacement/` (SSR shell) or `GET /phdplacement/api/programmes` (public read; whether it needs auth/DB is **unverified**). Recommend adding `/api/health`.
- **Dependencies:** `MONGODB_URI`, `AZURE_AD_*`, `PUBLIC_ORIGIN`, `UPLOAD_ROOT`.

### 1.6 CCD-App-Backend → container `ccd-backend`, image `ccd-app-backend-ccd-backend` (HIGH)
- **Evidence:** compose service/container `ccd-backend` (project folder `CCD-App-Backend` gives the image name). HN.
- **Stack:** Express 5, Mongoose 9, AdminJS (`.adminbro`), Node 20. Serves the CCD mobile app API and admin panel.
- **Runtime:** HN, hard-coded `PORT = 6001`, `BASE_PATH = "/ccd-app"`. Uploads volume `uploads_data`.
- **Public URL:** none found in code, so probably `https://iitg.ac.in/ccd-app/` **(unverified)**.
- **Health:** none. Probe `GET /ccd-app/policies` (static policies page, `app.js:103`; whether it hits the DB is unverified). Everything else under `api` needs the auth middleware.
- **Dependencies:** `MONGO_URI`, `JWT_SECRET`, `AUTH_KEY`, `AZURE_CLIENT_ID/TENANT_ID`, `ADMIN_*`, `DASHBOARD_*`. A `serviceAccountKey.json` (Firebase) sits in the repo root: **secret file in the working tree**, never copy it.

### 1.7 ccd_training_skilling → container `ccd-app`, image `training-portal-2025-app` (HIGH)
- **Evidence:** compose `container_name: ccd-app`, `ports: 5001:5001`, Dockerfile `EXPOSE 5001`; the `training-portal-2025-*` prefix is the old project name.
- **Stack:** CRA client (React 19, Tailwind 3), Express 4, Mongoose 8, Node 20. Backend serves the built frontend. Frontend uses Microsoft login (`VITE_MICROSOFT_*`).
- **Runtime:** **not HN**; publishes `5001:5001`. No base path (`/api/...`, `/test`). Uploads bind mount `./backend/uploads/pdfs`.
- **Public URL:** none found **(unverified)**; only a `5001` published port, so possibly reached through an IITG proxy.
- **Health:** none. **`GET /test`** returns `API is running...` (`app.js:35`, no DB). Host probe: `http://172.17.1.148:5001/test`.
- **Dependencies:** `MONGODB_URI`/`MONGO_URI`, `JWT_SECRET`, `OUTLOOK_EMAIL/PASSWORD`, `FRONTEND_URL`, `PROD_FRONTEND_URL`.

### 1.8 ccdIndustry → container `industry_backend` (identity HIGH, current state UNKNOWN)
- **Evidence:** `ccdIndustry/backend/docker-compose.yml` has `container_name: industry_backend`.
- **Stack:** Express 5 (ESM), Mongoose 8, AdminJS, Node 20. Two frontends: `client/` (CRA, React 19, Tailwind 3) and `frontend/` (Vite, React 19, Tailwind 4, a Netlify config). The Dockerfile builds `client/`.
- **Runtime:** code listens on `PORT || 8081`; compose maps `8081:8081`; Dockerfile says `EXPOSE 5002`. **Three different ports in one repo.**
- **Mismatch:** compose publishes 8081, but `docker ps` shows **no** published ports and an unnamed image (`76976256732a`). The running container was probably started by something other than this compose file, or from a different build.
- **Public URL:** unknown. Only `iitg.ac.in` appears (email-style references).
- **Health:** none. Candidate `GET /` or an API route (unverified; needs the logs).
- **Dependencies:** `MONGODB_URI`, `ADMINJS_COOKIE_*`, `MASTER_ADMIN_EMAIL/PASSWORD`.

### 1.9 AIPC → container `aipc-app` (HIGH)
- **Stack:** Vite frontend (`frontend/`), Express 5, Mongoose 9, Node 20. Compose overrides `PORT: 6025`, `BASE_PATH: /aipc`, HN. (`.env` sets `PORT=5000` but compose `environment` wins.)
- **Public URL:** `https://iitg.ac.in/aipc/`.
- **Health:** none. Probe **`GET /aipc/`** (built SPA) or `GET /aipc/api/v1/auth/check-company` (unverified; check for side effects).
- **Dependencies:** `MONGO_URI`, `JWT_SECRET`, `EMAIL_USER/PASS`, `ADMIN_COMPANIES_PASSWORD`.

### 1.10 dpr → container `dpr-app` (HIGH)
- **Stack:** Vite frontend (`Frontend/`), Express 5, Mongoose 8, AdminJS, Node 20. One container. HN, `PORT 6026`, `BASE_PATH=/listing-ccd`.
- **Public URL:** `https://iitg.ac.in/listing-ccd/`.
- **Health:** none. Probe `GET /listing-ccd/` (serves the built SPA).
- **Dependencies:** `MONGODB_URI`, `AZURE_SECRET`/`AZURE_REDIRECT_URI`, `AUTH_SESSION_SECRET`, `ADMINJS_*`, `API_PUBLIC_URL`.

### 1.11 Repos with deploy configs that are **not** in `docker ps`
| Folder | Would be | Port / base | Note |
|---|---|---|---|
| oa | `oa-app` | HN 6021, `/oa-check`; **has `/oa-check/health`** | The OA proctoring helper. Placement portals also contain `oaCheck` routes, so it may be merged or retired. Confirm whether deployed. |
| industry-payment | `industry-payment-app` | HN 5011; **has `{apiBase}/health`** | Not running. Contains bank-detail env vars. |
| resume-builder | `resume_builder_frontend` | 2756→3000, external network `frontend_default` | Not running. Note the `frontend_default` external network. |
| bluebook-new | compose with own nginx on port 80, `/bluebook` | `proxy` port `HTTP_PORT:-80` | Not running (would collide with any host nginx). |
| ccd_main_website | Next 15 standalone, port 3000 | none | Probably hosted on IITG's own web server (`iitg.ac.in/ccd/`). Skip. |
| bluebook (Hugo), cvdownloader, techteam, `*-Copy`, `.worktrees`, `CCD_OLD` | n/a | n/a | Skipped per brief. |

### 1.12 Containers with no matching repo / unclear
- **`placement_portal_frontend` (3012→3000):** from `Placement-Portal-2023/frontend/docker-compose.prod.yaml` (`serve -s build`, node:16). It is a **standalone CRA build served by `serve`**, a legacy layout that `placement23` no longer needs because the backend serves the build. Very likely a stale duplicate. **(unverified)**
- **`frontend` (3000→80) and `backend` (5004→5004):** images `training-portal-2025-frontend` / `-backend`. **No repo in `CCD/` produces them.** They are almost certainly the older split version of `ccd_training_skilling`, replaced by `ccd-app`. Both still expose public host ports.

## 2. Section A: Design system extraction

### A.1 Side-by-side

| | **Placement-Portal-2023** (canonical) | **latest-intern-portal** | **live-placement (D-Day)** | Intern-2026 |
|---|---|---|---|---|
| antd | **5.29.3**, icons 5.6 | **6.6.1**, icons 6.3 | 5.29.3, icons 5.6 | **none** |
| React / build | 18, CRA 5 | 18, CRA 5 | 19, CRA 5 | 19, CRA 5 |
| Tailwind | 3.0 | 3.0 | 3.4 | 3.4, empty config |
| Font | **Geist** (100-900) | **Geist** + Geist Mono | **Inter** | Dosis |
| Primary | **`#14213D`** Oxford Blue | `#0B1F3A` navy | **`#14213D`** | `#3342c4` |
| Accent | **`#7C2D3E`** burgundy | `#1B4D8E` link blue | `#7C2D3E` | none |
| Page bg | `#F4F2F1` warm | `#F4F6F9` cool | `#F4F2F1` | white / `#f2f2f2` |
| Border radius | **0** everywhere | 0 | 0 (buttons 2px) | default |
| Icons | `@ant-design/icons` | `@ant-design/icons` | antd icons + `react-icons` | none |
| Dark mode | none | none | none | none |

**Recommendation: Placement-Portal-2023 is the canonical source.** It is the base of the Oxford Blue system. live-placement matches it exactly (same colours, same radius 0) apart from Inter instead of Geist. Intern-2026 is the odd one out (no antd, Dosis, different blue), and latest-intern uses a cooler navy variant. **There is no dark mode in any of them**, so the brief's "dark mode toggle if the portals have one" resolves to **no toggle**.

**antd version:** the brief says "same major version as the Placement Portal", which is **antd 5.29.x** (React 18). Note this differs from latest-intern (antd 6).

### A.2 Source files to copy (all under `Placement-Portal-2023/frontend/`)
- **Tailwind:** `tailwind.config.js`. `theme.extend.colors.brand` is `50 #F1EDEA, 100 #E9E2DF, 200 #CBC9CF, 300 #9CA0AE, 400 #5F6A82, 500 #2E3A54, 600 #1C2C4F, 700 #14213D (primary), 800 #0B1526 (hover/ink), 900 #060B15`. Also `primary #14213D`, `primary-hover #0B1526`, `accent #7C2D3E`, `accent-hover #932F42`, `green-light #107C10`, `red-light #D83B01`. `fontFamily.sans` and `serif` are both `["Geist","system-ui","sans-serif"]`. No plugins.
- **antd theme:** `src/theme/antdTheme.js`, wired in `src/index.js` as `<StyleProvider hashPriority="high"><ConfigProvider theme={antdTheme}>`.
  - Brand palette object: `primary #14213D`, `primaryHover #1C2C4F`, `primaryActive #0B1526`, `accent #7C2D3E`, `accentHover #932F42`, `ink #161B22`, `bodyText #33383F`, `muted #666B72`, `border #E4E1E0`, `surface #FFFFFF`, `layoutBg #F4F2F1`, `tintHover #F1EDEA`, `tintActive #E9E2DF`.
  - Tokens: `colorPrimary`=primary, `colorInfo` and `colorLink`=accent, `colorBgLayout`=`#F4F2F1`, `colorBorder #E4E1E0`, `colorBorderSecondary #EDF0F5`, **all `borderRadius*` = 0**, `fontSize 14`, `controlHeight 38`, `fontFamily 'Geist', system-ui, ...`, custom `boxShadowSecondary`, `zIndexPopupBase 100001`.
  - Component overrides: Button (weight 600, no shadow), Table (`headerBg #F1F4F9`, `rowHoverBg #F5F8FD`, `cellPaddingBlock 12`), Card (radius 0, transparent header), Input/Select (height 38, tint option colours), Tabs, Menu (`itemHeight 42`), Segmented (selected = primary), Tag, Modal, Alert, Popover, Tooltip (radius 0).
- **Fonts:** `src/index.css` line 1: `@import url('https://fonts.googleapis.com/css2?family=Geist:wght@100..900&display=swap');`. No `<link>` in `public/index.html`. Global `*` uses Geist, `h1,h2,.font-display` use weight 600 with `letter-spacing:-0.02em`.
- **Global CSS** (`src/index.css`): Tailwind layers; Preflight list reset (`ul, ol { list-style: revert }`); forced antd Switch colours (`#14213D` checked, hover `#1C2C4F`); `.ant-descriptions-view table { table-layout: fixed }`. **No gradients or glassmorphism anywhere in the Placement portal**, just flat Oxford ink, warm off-white, 0 radius, hairline borders. (Intern-2026 has glass cards and a campus background image; that is *not* the look to copy.)
- **Layout:** `src/components/global/SideNavBar/SideNavBar.module.css` + `.js`, `TopNavBar/TopNavBar.js`, `Footer.jsx`.
  - Sidebar: fixed left, white, min-width 240px, `border-right: 1px solid #eceef1`, light shadow, brand header (42px logo + "Placement Portal" text 1.18rem `#1b2430`, bottom rule `#f1f2f4`). Nav rows: 14px, `#46505e`, padding 9x12, radius 8px, hover `#F1EDEA` and `#14213D`. Mobile: drawer 78vw max 300px with dim backdrop `rgba(15,23,42,.45)`.
  - Top bar: flex, `px-6 py-4`, right-aligned antd `Avatar` (`#F1EDEA` bg, `#14213D` icon) + name 14px `#14213D` + `DownOutlined`. Hamburger (`MenuOutlined`) under 1224px.
  - Footer: fixed bottom, `h-10 sm:h-12 bg-gray-200`, text "Built with heart and soul by **Team Technical Support, CCD**" linking to `https://iitg.ac.in/dday/team`. **Keep this credit.**
- **Logo:** `src/assets/pics/iitglogo.png` (640x646 RGBA, 104 KB). Also `public/favicon.ico`, `logo192.png`, `logo512.png`. Copy `iitglogo.png` into `client/src/assets`. No separate CCD logo found in the Placement repo.
- **Icons:** `@ant-design/icons` only (Placement). No `react-icons` or lucide in Placement.
- **UI patterns:**
  - Stat cards: antd `Row/Col` (`xs 24, sm 12, lg 6`) + `Card` + `Statistic` with `valueStyle {color:"#15803d", fontWeight:700}` and an icon in the title (`CoordinatorHome.jsx:74`). Link inside card: `text-[#14213D] font-semibold text-sm`.
  - Tags: antd `Tag`, status colours `green` / `red` / `gold` and fixed hexes (`#62a210`, `#9D5DEF`, `#ff9500`).
  - Tables: antd `Table`/`Descriptions`, header `#F1F4F9`.
  - Loaders: antd `Spin` (17 uses), plain "Loading..." fallback, custom `Spinner.css`.
  - Notifications: antd `message.success` / `message.error` (not `notification`).
  - Alerts: antd `Alert`. Badge, Progress, Collapse also used. **No `Timeline`, `Drawer` or charts library in Placement** (`moment` is used for dates). For the dashboard I will use antd `Timeline`/`Drawer`/`Collapse` with the same theme; `recharts` is needed since no portal has a chart library.
- **Date lib:** Placement uses `moment`; the brief asks for `dayjs`. I will use `dayjs` (antd 5 uses it internally anyway).

### A.3 Status colours (proposal, to confirm in Phase 2)
The portals only define a green `#107C10`/`#15803d` and a red `#D83B01`. Proposed: operational `#107C10`, degraded `#B7791F` (amber, in the `gold` family antd Tag already uses), down `#D83B01`, upstream/maintenance `#14213D` or `#7C2D3E` accent. Confirm whether you want to stay strictly inside the existing palette.

## 3. Section B: Service inventory (proposed monitoring config)

Probe targets assume the worker reaches the host as `HOST` (see E). `Container` probes read the Docker API. "Static" = the shell route only proves Express is up, not Mongo.

| # | Service | Group | Container | Internal probe (host port + path) | Public URL | Health path | Expect | Health quality |
|---|---|---|---|---|---|---|---|---|
| 1 | Placement Portal | Placement | `placement23` | `HOST:5000` `/placements/api/` | `https://iitg.ac.in/placements/` | `/placements/api/` | 200 JSON | Cheap (no DB) |
| 2 | Placement frontend (legacy?) | Placement | `placement_portal_frontend` | `172.17.1.148:3012` `/` | none known | `/` | 200 | Static; confirm if needed |
| 3 | D-Day Portal | Placement | `dday2026-app` | `HOST:5005` `/dday/api/health` | `https://iitg.ac.in/dday/` | `/dday/api/health` | 200 `{ok:true}` | **Real health route** |
| 4 | Intern Portal (2024) | Internship | `intern24test` | `HOST:11034` `/intern/api/` | `https://iitg.ac.in/intern/` | `/intern/api/` | 200 JSON | Cheap (no DB) |
| 5 | Intern 2026 | Internship | `intern2026-app` | `HOST:5009` `/intern-2026/api/health` | `https://iitg.ac.in/intern-2026/` | `/intern-2026/api/health` | 200 | **Real health route** |
| 6 | Training Portal | Training | `ccd-app` | `172.17.1.148:5001` `/test` | unknown | `/test` | 200 text | Cheap (no DB) |
| 7 | Training (old frontend) | Training | `frontend` | `172.17.1.148:3000` `/` | unknown | `/` | 200 | nginx static; likely stale |
| 8 | Training (old backend) | Training | `backend` | `172.17.1.148:5004` path **unknown** | unknown | ? | ? | Unknown; need the logs |
| 9 | Industry Portal | Industry | `industry_backend` | `HOST:8081` (or 5002) path **unknown** | unknown | ? | ? | **Currently crash-looping** |
| 10 | PhD Placement | PhD | `phdplacement-app` | `HOST:7002` `/phdplacement/` | `https://iitg.ac.in/phdplacement/` | `/phdplacement/` | 200 | SSR shell; verify |
| 11 | CCD App Backend | Others | `ccd-backend` | `HOST:6001` `/ccd-app/policies` | `https://iitg.ac.in/ccd-app/` (unverified) | `/ccd-app/policies` | 200 | Verify no DB access |
| 12 | AIPC | Others | `aipc-app` | `HOST:6025` `/aipc/` | `https://iitg.ac.in/aipc/` | `/aipc/` | 200 | SPA shell |
| 13 | DPR / Listing | Others | `dpr-app` | `HOST:6026` `/listing-ccd/` | `https://iitg.ac.in/listing-ccd/` | `/listing-ccd/` | 200 | SPA shell |

Infrastructure rows (not containers): `iitg.ac.in` DNS, `https://iitg.ac.in/` reachability, TLS expiry on `iitg.ac.in`, host MongoDB `HOST:27017` (TCP connect), the server itself (worker heartbeat).

## 4. Section C: Gaps and questions

### C.1 Please run on the server and paste the output
```bash
docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
docker network ls
docker inspect --format '{{.Name}} {{.HostConfig.NetworkMode}} {{range $k,$v := .NetworkSettings.Networks}}{{$k}}:{{$v.IPAddress}} {{end}}' $(docker ps -q)
sudo nginx -T 2>/dev/null | grep -E 'server_name|proxy_pass|listen'   # or the apache/caddy equivalent
docker logs --tail 50 industry_backend
```
Extra things I would like (small, safe):
```bash
sudo ss -ltnp | grep -E ':(3000|3012|5000|5001|5004|5005|5009|6001|6025|6026|7002|8081|11034|27017)\b'
docker inspect industry_backend --format '{{.Config.Image}} {{.Config.Cmd}} {{.State.ExitCode}} {{.State.Error}}'
docker inspect backend --format '{{.Config.Image}} {{.Config.Cmd}}'
```
The `.HostConfig.NetworkMode` addition above matters: it confirms my host-networking inference.

### C.2 Questions
1. Which repo is live for `/intern/`: `latest-intern-portal` or `Intern-Portal-2023`?
2. Where does the public reverse proxy (`iitg.ac.in/<path>` → `172.17.1.148:<port>`) live: nginx on this box, or an IITG-managed machine? If it is IITG's, our "public" probe measures that proxy, and we cannot see its config.
3. Are `oa-app`, `industry-payment-app` and `resume-builder` deployed anywhere? If so, where?
4. Is `placement_portal_frontend` still used (3012), and are the old `frontend`/`backend` (3000/5004) still used?
5. What is the public URL for the training portal (`ccd-app`) and for `industry_backend`?
6. Can I add `GET /health` routes to portals later? I will not touch them in this task.
7. What should alerts go to: an email list and/or a Telegram chat? Which sender account?
8. Is Docker Compose v2 installed on the server, and is port 80 or 443 free for the status page? Otherwise which port?
9. Does the campus allow outbound access to Gmail SMTP and `api.telegram.org` from this server?
10. Where should the status page be published (e.g. `https://iitg.ac.in/status/` or a different host)? It determines the nginx base path.

## 5. Section D: Red flags

| Severity | Finding |
|---|---|
| **High** | **`industry_backend` restarting (254) in a loop.** Cannot be diagnosed from the repo: compose says `8081:8081` but the running container shows no ports and an unnamed image; Dockerfile says `EXPOSE 5002`; the code listens on 8081. Likely a mismatched or manually built image, or a missing/invalid `.env`. Need the logs. The status page should show DOWN (restart loop) and not hide it. |
| **High** | **Single shared host MongoDB** (`systemd mongod` on `127.0.0.1:27017`) serves most portals. Not visible in `docker ps`; one failure takes down placement, intern, D-Day, AIPC, dpr, PhD, and more at once. The dashboard needs an explicit Mongo probe so a DB outage is reported once, not as many service failures. |
| **High** | **Exposed ports that should not be public:** `5001` (training app), `3000`, `5004` (old training frontend/backend), `3012` (Placement frontend) are published on the host and reachable from the campus LAN, bypassing the reverse proxy. Also `8081` for industry if the compose is accurate. |
| **High** | **Secret files in working trees:** `.env` files in nearly every repo (`AIPC`, `ccdIndustry`, `CCD-App-Backend`, ...) and `CCD-App-Backend/serviceAccountKey.json` (Firebase). A hard-coded Sentry DSN is in `Placement-Portal-2023/frontend/src/index.js`. I did not read secret values. The status repo must never copy these. |
| **Medium** | **Only 4 real health routes** (dday, intern-2026, oa, industry-payment; the last two are not deployed) and **9 services have none.** Shell-route probes pass even if Mongo is down, so the dashboard can show "operational" while logins fail. Recommend adding `/health` that pings Mongo to each portal (a separate task). |
| **Medium** | **Duplicated / stale portals:** `Intern-Portal-2023` vs `latest-intern-portal` vs `Intern-Portal-2023 - Copy` (same container name `intern24test`); `placement_portal_frontend` vs `placement23`; training `frontend`/`backend` vs `ccd-app`; `ccdIndustry` has two frontends (`client/` CRA and `frontend/` Vite). Which is live is not recorded in the repos. |
| **Medium** | **Old images (13-15 months):** `ccd-app` (`training-portal-2025-*`), `dday2026-app` (`live-sheet-2025-app`), `frontend`, `backend`. Many are on Node 16/18 (Placement: 18, Intern 2023: 16). Node 16 is end-of-life. Mongoose 6 in Placement and Intern. Confirm actual image ages from `docker ps -a`. |
| **Medium** | **Port plan has no registry:** ports 3000, 3012, 5000, 5001, 5004, 5005, 5009, 6001, 6025, 6026, 7002, 8081, 10010 (ignored), 11034 are all in use or documented. The status page needs a free port. Placement on 5000 under HN collides with any other app defaulting to 5000. |
| **Low** | `AIPC/.env` has `PORT=5000` but compose forces `6025`; if someone runs without compose it collides with Placement. |
| **Low** | Compose files `extra_hosts: host.docker.internal` exist only for Placement and Intern, so some services may not reach the host by name. Irrelevant under HN. |
| **Low** | `live-placement` mentions `placement.iitg.ac.in` and a `privkey.pem` path in code or docs. It looks like a leftover from an earlier TLS setup. Ignore for probes. |

## 6. Section E: Impact on the Phase 2 design (proposal, not yet built)

1. **Reaching the portals.** Because the portals are HN, the status stack cannot join a Docker network to reach them. Options:
   - **(Recommended)** Worker gets `extra_hosts: ["host.docker.internal:host-gateway"]` and probes `http://host.docker.internal:<port>`. This works only if portals bind to `0.0.0.0` (Express `listen(PORT)` does) and the host firewall allows `docker0` → host. Needs verifying.
   - Alternative: worker with `network_mode: host`. Simpler and robust, but then the worker is not isolated, and its Mongo connection needs a published `127.0.0.1:<port>` on a non-27017 port (27017 is taken by the host's mongod).
   - The Docker network and `docker network ls` outputs (C.1) will confirm which networks exist. `ccd-app`, `frontend`, `backend` and `placement_portal_frontend` are on bridge networks.
2. **Own Mongo:** `ccd-status-mongo` on the compose-internal network only (no published port). It must not conflict with the host `mongod` on 27017.
3. **Docker state:** `tecnativa/docker-socket-proxy` with `CONTAINERS=1` still works for HN containers (the container API does not depend on the network mode). Restart count, state and uptime come from there.
4. **Public probe:** one HTTPS check per app path on `iitg.ac.in`, and one global `iitg.ac.in` DNS/TLS/home-page check. The upstream detection rule becomes: internal OK + public failing + `iitg.ac.in` home page failing → `upstream_outage`.
5. **Mongo probe:** add a TCP probe `HOST:27017` as a shared-dependency node. If Mongo is down while containers are up, show one "Database (host MongoDB) down" banner rather than many app failures.
6. **Design:** build on Placement's Oxford Blue system: Geist, `#14213D` / `#7C2D3E`, warm `#F4F2F1`, radius 0, antd 5.29 + `StyleProvider hashPriority="high"`, no dark mode, no gradients.
7. **Mongoose version:** for the status app I will use Mongoose 8, Express 4 (matching live-placement), and Vite + React 18 (the brief says Vite). I will copy the Placement theme files into `client/src/theme`.

## 7. Proposed Phase 3 (not to be built unless you ask)
A status page on `172.17.1.148` cannot report that `172.17.1.148` is down. Propose a tiny external watchdog outside campus: a GitHub Actions cron (every 5 min) that GETs the public `https://iitg.ac.in/<app>/` URLs and the status page `/api/health`, and sends a Telegram/email alert on failure; or a free hosted uptime pinger. Note that GitHub runners are outside the campus network, so they test the *public* path, which is exactly what users outside campus see.
