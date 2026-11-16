# syntax=docker/dockerfile:1
# GATEWAY image: builds the React client, then serves it with nginx (unprivileged).
# Build context: ./client.  The nginx template comes from a named build context `deploy` (see docker-compose.yml).

FROM node:20-alpine AS build
ARG BASE_PATH=/ccd-status
ARG GATEWAY_PORT=6059
ENV BASE_PATH=${BASE_PATH}
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
# Render the nginx config for this BASE_PATH / port (build-time, so the runtime filesystem can stay read-only).
COPY --from=deploy gateway.nginx.conf /tmp/gateway.nginx.conf
RUN sed -e "s|__BASE_PATH__|${BASE_PATH}|g" -e "s|__GATEWAY_PORT__|${GATEWAY_PORT}|g" /tmp/gateway.nginx.conf > /tmp/default.conf

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
ARG BASE_PATH=/ccd-status
ARG GATEWAY_PORT=6059
ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="ccd-status-gateway" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}"
ENV BASE_PATH=${BASE_PATH} \
    GATEWAY_PORT=${GATEWAY_PORT}
USER root
# worker_processes: with host networking "auto" spawned one nginx worker per CPU; this is a tiny static gateway.
RUN mkdir -p /usr/share/nginx/status "/usr/share/nginx/html${BASE_PATH}" \
 && chown -R 101:101 /usr/share/nginx/status \
 && sed -i 's/^worker_processes.*/worker_processes 2;/' /etc/nginx/nginx.conf \
 && grep -q '^worker_processes 2;' /etc/nginx/nginx.conf
USER 101
COPY --from=build /tmp/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/ /usr/share/nginx/html${BASE_PATH}/
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO /dev/null "http://127.0.0.1:${GATEWAY_PORT}${BASE_PATH}/" || exit 1
