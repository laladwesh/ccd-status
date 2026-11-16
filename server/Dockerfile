# syntax=docker/dockerfile:1
# Build context: ./server.  `shared` comes from a named build context (see docker-compose.yml).

FROM node:20-alpine AS deps
WORKDIR /app/server
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:20-alpine AS runtime
ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="ccd-status-server" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}"
ENV NODE_ENV=production \
    PORT=6060 \
    HOST=127.0.0.1 \
    STATUS_DIR=/data
WORKDIR /app/server
COPY --from=deps --chown=node:node /app/server/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --from=shared --chown=node:node package.json status.js models.js /app/shared/
USER node
# Host network, bound to 127.0.0.1:6060 only. /api/health is 200 whenever the process can serve: it does NOT
# depend on MongoDB, so a database outage never makes Docker restart the status page.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:6060/api/health >/dev/null || exit 1
CMD ["node", "src/index.js"]
