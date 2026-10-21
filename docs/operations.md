# Operations

All commands below run inside the container: `docker compose exec maat-caddy <cmd>`.

## Health and metrics

- `GET http://127.0.0.1:9788/health` returns 200 `{"status":"ok"}` when the follower has polled recently and the database answers. Otherwise it returns 503. The container healthcheck uses it.
- `GET http://127.0.0.1:9788/metrics` returns aggregates only:
  - `queue`: pending, inflight, delivered and dead counts, and the oldest pending event.
  - Line counters: `lines_read`, `lines_malformed`, `lines_oversized`, `skipped_<reason>`.
  - Enqueue and delivery counters: `events_enqueued`, `events_duplicate_skipped`, `events_too_old_skipped`, `deliveries_ok`, `deliveries_retried`, `deliveries_dead`, `deliveries_ambiguous`, `lease_lost`.
  - Follower counters: `rotations`, `truncations`, `rotation_gaps`, `queue_full_pauses`, `commit_failures`.
  - Gauges: `follower_lag_bytes`, `follower_offset`, `last_delivery_at`.

```sh
node -e "fetch('http://127.0.0.1:9788/metrics').then(r=>r.text()).then(console.log)"
```

What to alert on:

| Signal | Likely cause |
|---|---|
| `queue.pending` growing, or `last_delivery_at` getting old | Matomo is unreachable |
| `queue.dead` > 0 | Permanent rejections, e.g. `http_401` or `http_403` from a bad token, or `http_400` |
| `deliveries_ambiguous` > 0 | Timeouts, connection resets or 5xx from Matomo or a proxy. Each one is a possible duplicate (`retry`) or a possible loss (`dead_letter`) |
| `rotation_gaps` > 0 | A rotated log was compressed or deleted while the tracker was down. Consider `roll_uncompressed` in Caddy |
| `commit_failures` or `queue_full_pauses` | Disk problems, or a long Matomo outage |
| `follower_lag_bytes` staying high | The follower is falling behind the log |
| `events_too_old_skipped` > 0 | Downtime longer than `seen_retention_days`; those requests were not sent |

## Debug logging

Two optional flags in `[debug]` (both off by default) add `debug`-level log lines from the daemon. The `import` command never emits them.

- `log_tracked = true`: `"event tracked"` for each event Matomo accepted, with `assistant`, `url`, `httpStatus`, `eventTs` and `attempts`.
- `log_excluded_crawlers = true`: `"training crawler excluded"` for each skipped training-crawler request, with `crawler`, `url` (never the query string), `httpStatus` and `eventTs`.

Each kind is limited to 20 lines per minute. Suppressed lines are reported as `"<msg> (suppressed)"` with a count. Turning on either flag sets the log level to `debug`. Check them with `docker compose logs -f maat-caddy`.

## Dead letters

```sh
node dist/main.js deadletter stats                              # reason codes and counts only
node dist/main.js deadletter replay --reason http_401           # e.g. after fixing the token
node dist/main.js deadletter replay --limit 100                 # replay the oldest 100, any reason
node dist/main.js queue stats
```

With `on_ambiguous_failure = "dead_letter"`, reasons starting with
`ambiguous_` mark events that Matomo may or may not have recorded. Replaying
them risks a duplicate; leaving them risks a missing event.

Replay sets events back to pending with their attempt count reset. These
commands can run while the daemon is running (SQLite WAL with a busy timeout).
Do not print event rows from the database; use the aggregate commands.

## Recovery behaviour

- **Restart or crash:** the follower resumes from the checkpoint. Events that were in flight are handled once their lease (`lease_seconds`) expires: retried with `on_ambiguous_failure = "retry"`, dead-lettered as `ambiguous_lease_expired` with `"dead_letter"`. See "Duplicates and `on_ambiguous_failure`" in [architecture.md](architecture.md).
- **Downtime that spans a log rotation:** uncompressed rotated files are read first, then the live log. Caddy compresses rolled files by default. If the tracker is down when a rotated file gets compressed, that file's remaining lines are skipped and counted in `rotation_gaps`. Set `roll_uncompressed` in the Caddy log config to avoid this (disk usage goes up). While the tracker is running, compression does no harm, because the old file descriptor is drained first.
- **First start:** `start_position = "end"` skips existing log content. To backfill the live file and rotated (gzip) files, use the `import` command ([import.md](import.md)).
- **Lost checkpoint or deleted queue rows:** lines already queued once are skipped through their fingerprints (`events_duplicate_skipped`). Deleting the whole database also deletes the fingerprints.
- **Matomo outage:** events wait in the queue (up to `max_queue_events`). After that the follower pauses without losing its position. Retries use backoff up to `max_backoff_seconds`, until `max_attempts` is reached.
- **Changing the log path or file:** delete the `checkpoint` row to start reading the new file from scratch. Already-queued requests are still skipped.

## Caddy log configuration

```caddyfile
example.com {
	log {
		output file /var/log/caddy/example.com.log {
			mode 0640   # group-readable, so the container can read it
			roll_size 100MiB
			roll_keep 10
			# roll_uncompressed   # recommended for gap-free recovery after downtime
		}
		format json
	}
}
```

The default `duration` (seconds as a float) and `ts` (Unix seconds as a float)
formats are expected. ISO-8601 `ts` values are accepted too.
