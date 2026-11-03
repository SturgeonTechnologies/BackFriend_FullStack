# The BackFriend on-prem image: the API and the built web app, in one process.
# Build from the repo root: docker build -f deploy/docker/Dockerfile -t backfriend .
FROM node:22-alpine AS web
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Same-origin paths, so this one image works on any domain.
ENV VITE_API_BASE=/api \
    VITE_OIDC_ISSUER_PATH=/idp/realms/backfriend \
    VITE_USER_POOL_CLIENT_ID=backfriend-web \
    VITE_APP_TITLE=BackFriend
RUN npm run build && rm -f dist/assets/*.map

FROM node:22-alpine AS api
WORKDIR /src/backend/onprem
COPY backend/onprem/package.json backend/onprem/package-lock.json ./
RUN npm ci --omit=optional
COPY backend/onprem/ ./
COPY backend/src/ ../src/
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 STATIC_ROOT=/app/public CONTENT_ROOT=/data/content
WORKDIR /app
# esbuild bundled every dependency, so there is no node_modules in the image.
COPY --from=api /src/backend/onprem/dist/ ./
COPY --from=web /src/frontend/dist/ ./public/
RUN rm -f /usr/local/bin/npm /usr/local/bin/npx && rm -rf /usr/local/lib/node_modules/npm
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "server.mjs"]
