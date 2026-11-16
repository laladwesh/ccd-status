# Request to the IITG webmaster: publish the CCD System Status page

**From:** Technical Support Team, Centre for Career Development (CCD)

Please add one route to the `iitg.ac.in` reverse proxy:

| Public URL | Backend |
|---|---|
| `https://iitg.ac.in/ccd-status/` | `http://<SERVER_IP>/ccd-status/` |

It is a read-only status page that shows whether the CCD portals (Placement, Intern, D-Day, Training, PhD, ...) are up. It is served by the same host and nginx as the other CCD portals, in the same way as `https://iitg.ac.in/placements/` and `https://iitg.ac.in/intern/`.

## Requirements

1. **Keep the path unchanged.** Forward `/ccd-status/...` to `/ccd-status/...` on the backend (no prefix stripping or rewriting). The application is built for the `/ccd-status/` sub-path.
2. **Forward the standard headers:** `Host`, `X-Forwarded-For`, and `X-Forwarded-Proto: https`.
3. **Live updates (Server-Sent Events).** `/ccd-status/api/stream` is a long-lived response. If possible disable response buffering for that path and allow a read timeout of at least 1 hour. If this is not possible nothing breaks: the page falls back to polling every 30 seconds.
4. **Do not cache** `/ccd-status/api/*` or `/ccd-status/status.json` (they change every minute). `/ccd-status/assets/*` may be cached.
5. **TLS is terminated at your end**; the backend is plain HTTP on the campus network.

## Example (nginx)

```nginx
location /ccd-status/ {
    proxy_pass http://<SERVER_IP>;          # no trailing slash: the path is preserved
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_buffering off;                      # for /ccd-status/api/stream (SSE)
    proxy_read_timeout 3600s;
}
location = /ccd-status { return 301 /ccd-status/; }
```

## How to check it works

```
curl -sI https://iitg.ac.in/ccd-status/                 # 200
curl -s  https://iitg.ac.in/ccd-status/api/health       # {"ok":true,...}
curl -s  https://iitg.ac.in/ccd-status/status.json      # JSON snapshot
```

The page needs no outbound internet access and loads no third-party scripts or fonts.

Contact: Technical Support Team, CCD, IIT Guwahati.
