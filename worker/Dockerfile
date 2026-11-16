# syntax=docker/dockerfile:1
# Build context: ./worker.  `shared` comes from a named build context (see docker-compose.yml:
# additional_contexts), so no file outside the two directories is ever sent to the daemon.

FROM node:20-alpine AS deps
WORKDIR /app/worker
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:20-alpine AS runtime
ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="ccd-status-worker" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}"
ENV NODE_ENV=production \
    STATUS_DIR=/data
WORKDIR /app/worker
COPY --from=deps --chown=node:node /app/worker/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --from=shared --chown=node:node package.json services.config.js status.js models.js seed.js snapshot.js /app/shared/
# status.json + heartbeat volume: create it owned by the non-root user so the named volume inherits that.
RUN mkdir -p /data && chown node:node /data
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node", "src/healthcheck.js"]
CMD ["node", "src/index.js"]
