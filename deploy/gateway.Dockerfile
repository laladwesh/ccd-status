# Build context is the repo root. Stage 1 builds the React client; stage 2 is nginx.
FROM node:20-alpine AS client
WORKDIR /app
COPY client/package.json client/package-lock.json* ./
RUN npm ci || npm install
COPY client/ ./
RUN npm run build

FROM nginx:1.27-alpine
COPY deploy/gateway.nginx.conf /etc/nginx/conf.d/default.conf
# The app lives under /ccd-status/ so the same build works on the host nginx and behind the IITG proxy.
COPY --from=client /app/dist /usr/share/nginx/html/ccd-status
RUN mkdir -p /usr/share/nginx/status
EXPOSE 80
