# Deployment

The tracker runs as a container next to Caddy on the same host and reads
Caddy's log directory. Released images are published to
`ghcr.io/hbg-ngo/maat-caddy` (tags `vX.Y.Z` and `latest`, linux/amd64 and
linux/arm64).

A deployment directory (e.g. `/opt/maat-caddy`) holds:

| Path | Purpose | Owner / mode |
|---|---|---|
| `compose.yaml` | from this repo | any |
| `.env` | `CADDY_GID`, optionally `APP_VERSION` | any |
| `config/config.toml` | tracker configuration | readable by uid 10001 |
| `secrets/matomo-token` | Matomo `token_auth` | `10001`, 0400 |
| `data/` (SQLite queue, checkpoint, fingerprints) | written by the container | `10001`, 0700 |

## Setup

1. **Directory**
   ```sh
   mkdir -p /opt/maat-caddy/config && cd /opt/maat-caddy
   curl -fsSLO https://raw.githubusercontent.com/hbg-ngo/maat-caddy/main/compose.yaml
   install -d -m 0750 secrets
   install -d -o 10001 -g 10001 -m 0700 data
   ```

2. **Config:** copy [`config/config.example.toml`](../config/config.example.toml) to `config/config.toml`. Set at least `matomo.endpoint`, `matomo.site_id`, `log.path` and `log.expected_host`. Keep the container paths (`token_file`, `database_path`, `health_listen`) unless you also change `compose.yaml`.

3. **Token:** create a dedicated Matomo user with *write* access to the site only, and store its `token_auth`:
   ```sh
   printf '%s' '<token_auth>' > secrets/matomo-token
   chown 10001:10001 secrets/matomo-token && chmod 0400 secrets/matomo-token
   ```

4. **Log access.** The container (uid 10001) reads the logs through the host's `caddy` group:
   - Put its GID into `.env`: `echo "CADDY_GID=$(getent group caddy | cut -d: -f3)" >> .env`
   - Caddy must create the log group-readable (`mode 0640`), see [Caddy log configuration](operations.md#caddy-log-configuration).
   - Make files that already exist readable once: `chmod g+r /var/log/caddy/example.com*.log*`.
   - A default ACL on the directory doesn't help, because Caddy's default file mode 0600 masks it out.
   - The whole directory is mounted read-only. Mounting only the single log file would break rotation handling.

5. **Start**
   ```sh
   echo "APP_VERSION=vX.Y.Z" >> .env   # optional, defaults to latest
   docker compose up -d
   docker compose ps                    # wait for "healthy"
   docker compose logs -f
   ```

Compose reads `.env` automatically, so later commands (`docker compose exec maat-caddy ...`) use the same image.

## Updating

Change `APP_VERSION` in `.env`, then:

```sh
docker compose pull && docker compose up -d
```

The shutdown is graceful, and the queue and checkpoint in `data/` are kept.
After editing `config/config.toml`, run `docker compose up -d --force-recreate`.
Invalid config makes the container exit immediately, so check `docker compose ps`.

## Building locally

```sh
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

## Verify in Matomo

After the first assistant fetch, check that it shows up in Matomo's AI assistant reports. Matomo silently drops agents it doesn't recognise (see [matomo.md](matomo.md)).

## Updating the Node.js version

Change `.nvmrc`, `package.json` `engines`, and the `NODE_IMAGE` and `RUNTIME_IMAGE` digests in the `Dockerfile`, all together. Get the digests with:

```sh
docker buildx imagetools inspect node:<version>-trixie-slim
docker buildx imagetools inspect gcr.io/distroless/nodejs24-debian13
```

The distroless image has no version tag. Check that it ships the same Node version as `NODE_IMAGE` before pinning it (the release workflow checks this too):

```sh
docker run --rm gcr.io/distroless/nodejs24-debian13@sha256:<digest> --version
```

The runtime image has no shell. Use `node` for everything inside the container (`docker compose exec maat-caddy node ...`).
