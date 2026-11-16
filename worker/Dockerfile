# Build context is the repo root (it needs ../shared).
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY worker/package.json worker/package-lock.json* worker/
RUN cd worker && (npm ci --omit=dev || npm install --omit=dev) && npm cache clean --force
COPY shared shared
COPY worker/src worker/src
WORKDIR /app/worker
# status.json volume: create the dir owned by the non-root user so the named volume inherits it.
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "src/index.js"]
