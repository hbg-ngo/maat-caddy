# MAAT for Caddy — Matomo AI Assistant Tracker

[![CI](https://github.com/hbg-ngo/maat-caddy/actions/workflows/ci.yml/badge.svg)](https://github.com/hbg-ngo/maat-caddy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A small Node.js/TypeScript daemon that follows a [Caddy](https://caddyserver.com/)
JSON access log, finds requests made by AI assistants on behalf of users
(the agents Matomo detects: `ChatGPT-User`, `Claude-User`, `Perplexity-User`,
`MistralAI-User`, `Gemini-Deep-Research`, `Google-NotebookLM`), and reports them
to [Matomo](https://matomo.org/)'s bot tracking (`recMode=1`, Matomo ≥ 5.7).

AI assistants fetch pages server-side and never run your JavaScript tracker, so
these visits are invisible to Matomo otherwise. MAAT picks them up from the web
server log instead, without any change to your site.

```
Caddy JSON log ─▶ rotation-safe follower ─▶ parser + filters ─▶ SQLite queue + checkpoint ─▶ workers ─▶ Matomo
```

- **Privacy:** no IPs, cookies, referrers, auth data or other headers are stored or sent, query strings are stripped, and raw log lines are never persisted.
- **Durability:** each event is queued in the same SQLite transaction that advances the log checkpoint. Delivery is at least once by default. Matomo cannot de-duplicate, so `delivery.on_ambiguous_failure` lets you choose at-most-once instead.
- **No double queuing:** every queued request leaves a fingerprint, so neither a re-read log nor a repeated historic import can queue it twice.
- **Historic import:** `import` backfills rotated (gzip) logs. It is safe to run repeatedly (see [docs/import.md](docs/import.md)).
- **Rotation:** handles rename/create, copy-truncate and partial lines, and recovers rotations that happened while the tracker was down.
- **Hardened container:** distroless, non-root, read-only, no published ports.

One instance tracks one host (`log.expected_host`) into one Matomo site.

## Requirements

- Matomo ≥ 5.7.0, plus a Matomo user with *write* access to the site (its `token_auth`).
- Caddy writing a JSON access log for the site.
- Docker with Compose, on the Caddy host.

## Quick start

```sh
mkdir -p /opt/maat-caddy/config && cd /opt/maat-caddy
curl -fsSLO https://raw.githubusercontent.com/hbg-ngo/maat-caddy/main/compose.yaml
curl -fsSL -o config/config.toml https://raw.githubusercontent.com/hbg-ngo/maat-caddy/main/config/config.example.toml
# edit config/config.toml: matomo.endpoint, matomo.site_id, log.path, log.expected_host
install -d -m 0750 secrets && install -d -o 10001 -g 10001 -m 0700 data
printf '%s' '<token_auth>' > secrets/matomo-token
chown 10001:10001 secrets/matomo-token && chmod 0400 secrets/matomo-token
echo "CADDY_GID=$(getent group caddy | cut -d: -f3)" > .env
docker compose up -d
```

See [docs/deployment.md](docs/deployment.md) for the full setup (token, permissions, log access, updates).

## Operations

```sh
docker compose exec maat-caddy node -e "fetch('http://127.0.0.1:9788/metrics').then(r=>r.text()).then(console.log)"
docker compose exec maat-caddy node dist/main.js queue stats
docker compose exec maat-caddy node dist/main.js deadletter stats
docker compose exec maat-caddy node dist/main.js deadletter replay --reason http_400
docker compose exec maat-caddy node dist/main.js import --dry-run /var/log/caddy/example.com-*.log.gz
```

## Development

Node.js **24.22.0**, pinned in `.nvmrc`, `package.json`, the Dockerfile and CI.

```sh
npm ci                      # install scripts are disabled via .npmrc (not needed)
npm run typecheck
npm run lint
npm test                    # unit tests
npm run test:integration    # end-to-end tests with a mock Matomo; container tests run when Docker is available
npm run build               # compile to dist/
```

Tests run the TypeScript sources directly through Node's type stripping. A
preloaded network guard (`test-support/network-guard.ts`) blocks every
non-loopback request, so no test can reach a real Matomo instance. Set
`SKIP_CONTAINER_TESTS=1` to skip the Docker tests, or set
`CONTAINER_TEST_IMAGE=<tag>` to test an image you already built.

**Releases:** pushing a tag `vX.Y.Z` builds, smoke-tests and publishes the image
to `ghcr.io/hbg-ngo/maat-caddy` (see `.github/workflows/release.yml`).

## Documentation

- [docs/deployment.md](docs/deployment.md): setup, updates, local builds
- [docs/architecture.md](docs/architecture.md): components, data flow and guarantees
- [docs/matomo.md](docs/matomo.md): the Matomo Tracking API request and its prerequisites
- [docs/filtering.md](docs/filtering.md): user-agent policy and request filters
- [docs/security.md](docs/security.md): security and privacy
- [docs/operations.md](docs/operations.md): monitoring, dead letters, recovery, Caddy log config
- [docs/import.md](docs/import.md): one-off import of historic logs

## License

[MIT](LICENSE) © Handbook Germany gGmbH
