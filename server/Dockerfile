# Build context is the repo root (it needs ../shared).
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY server/package.json server/package-lock.json* server/
RUN cd server && (npm ci --omit=dev || npm install --omit=dev) && npm cache clean --force
COPY shared shared
COPY server/src server/src
COPY server/scripts server/scripts
WORKDIR /app/server
USER node
EXPOSE 4000
CMD ["node", "src/index.js"]
