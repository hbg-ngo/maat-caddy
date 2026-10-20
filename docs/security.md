# Security and privacy

## Data handling

- Only requests for `log.expected_host` are processed.
- **Never stored or sent:** IPs, cookies, referrer, authorization data, or any other request or response header.
- From each log line, only `ts`, `status`, `size`, `duration`, `host`, `method`, `uri` and the User-Agent are read.
- Query strings and fragments are stripped by default (`strip_query_string = true`).
- Raw log lines are never written to SQLite, logs, metrics or dead letters.
- Fingerprints (`seen_events`) are one-way SHA-256 hashes of data that is already stored in the queue (see [import.md](import.md)). They hold no IPs or other request data and are kept indefinitely.
  - Malformed-line diagnostics contain only the reason and the line length.
  - Dead-letter views contain only reason codes and counts.
  - Optional `[debug]` lines (off by default) contain only the matched agent name, the URL or path, status, request time and attempts. Excluded-crawler lines never include the query string.
- Matomo response bodies are never logged. At most 16 KiB of a response is read before it is discarded.

## Secrets

- The token is read from `$MATOMO_TOKEN_FILE` or `matomo.token_file`, typically a Docker secret. It is never accepted from the CLI, the environment or the config file, and never baked into the image.
- The token is redacted from every log line. Errors about the token file never include its contents.
- The token goes in the POST body, never in a URL. Redirects are never followed.

## Transport

- `https` is mandatory. Plain `http` is only accepted for loopback addresses, and only when `allow_insecure_localhost_for_tests = true`. That flag is for test mocks only.
- TLS certificate validation stays on. The tracker refuses to start if `NODE_TLS_REJECT_UNAUTHORIZED=0` is set.

## Runtime

- The runtime image is distroless (`gcr.io/distroless/nodejs24-debian13`): no shell, no package manager, only Node and its system libraries.
- The container runs as uid/gid 10001 with `cap_drop: ALL`, `no-new-privileges`, a read-only root filesystem, `init: true`, and limits on PIDs, memory and CPU.
- The Caddy log directory is mounted read-only. Only `/var/lib/maat-caddy` (SQLite) and a small `/tmp` tmpfs are writable.
- No ports are published.
  - The health endpoint must bind to a loopback IP; config validation rejects anything else.
  - The container healthcheck runs inside the container.
  - Never proxy the health endpoint through Caddy.
- Everything is bounded: queue size, number of workers, request timeouts, response reads, line length, retries and retention.
- `npm` install scripts are disabled (`.npmrc`). Dependencies are pinned exactly and locked, and CI runs `npm audit` on production dependencies.
