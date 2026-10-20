# syntax=docker/dockerfile:1
# Node.js 24 LTS, pinned by multi-arch index digest. Build on Debian trixie slim,
# run on distroless (no shell, no package manager) with the same Node version.
# Must match .nvmrc and package.json "engines": Renovate updates them together
# and CI fails if the runtime image ships a different Node version.
ARG NODE_IMAGE=node:24.22.0-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian13:latest@sha256:9ddd3f7de61d8c62337cdcbeaceb621de5e0c955ccdc70f4c3586db74a8c278f

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# better-sqlite3 13 ships N-API prebuilds for linux x64/arm64 (glibc and musl),
# so no compiler toolchain is needed.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund \
 && mkdir -p /out/var/lib/maat-caddy

FROM ${RUNTIME_IMAGE} AS runtime
ENV NODE_ENV=production
# Distroless keeps node in /nodejs/bin; put it on PATH so `docker exec ... node` works.
ENV PATH=/nodejs/bin:/usr/local/bin:/usr/bin:/bin
WORKDIR /app
COPY --from=build --chown=10001:10001 /out/var/lib/maat-caddy /var/lib/maat-caddy
# Application files stay root-owned and read-only for the runtime user.
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER 10001:10001
VOLUME ["/var/lib/maat-caddy"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:9788/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "dist/main.js"]
