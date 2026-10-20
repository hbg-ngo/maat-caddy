# Architecture

```
Caddy JSON access log
  → follower.ts       rotation-aware line reader, file identity + byte-offset checkpoint
  → caddy-parser.ts   strict extraction of whitelisted fields only
  → filter.ts         host, user agent (classifier.ts), method, status, path/asset filters, URL normalisation
  → store.ts          SQLite: atomic enqueue + checkpoint, leases, retries, dead letters, retention
  → worker.ts         bounded workers, capped exponential backoff with jitter
  → matomo.ts         form POST to the Matomo Tracking API (bot tracking)
health.ts: loopback-only /health and /metrics. app.ts wires everything; main.ts is the CLI and handles signals.
```

## Checkpoint and enqueue

The follower reads from the committed byte offset and consumes only complete
lines, at most `batch_lines` per transaction. For each batch,
`Store.commitBatch` inserts the qualifying events and updates the checkpoint
(device, inode, offset and a SHA-256 fingerprint of the file's first ≤256
bytes) in **one** `BEGIN IMMEDIATE` transaction (WAL, `synchronous=FULL`).

- An event is only inserted if its fingerprint is new to the `seen_events` table, checked in the same transaction. Fingerprints are never deleted, so a request can't be queued twice. That holds even after a checkpoint reset or when the historic `import` overlaps the live log (see [import.md](import.md)). Skipped events are counted as `events_duplicate_skipped`.
- If the commit fails (I/O error, or the queue holds `max_queue_events`), nothing is committed. The follower re-reads the same lines on its next poll.
- Partial lines are never consumed. They are re-read until their newline arrives.
- A line longer than `max_line_bytes` is skipped in memory. The checkpoint never points into the middle of a line.
- Raw lines are never stored. Only the minimal event is (see [matomo.md](matomo.md)).

## Rotation

| Situation | Handling |
|---|---|
| rename/create (Caddy's roller, logrotate `create`) | Detected when the inode at the log path changes. The old descriptor is drained until the file has been idle for `rotation_grace_ms`. A trailing unterminated line is then processed, and the follower switches to the new file at offset 0. |
| Path missing for a moment | The tracker keeps draining the old descriptor and waits for the new file. |
| copy-truncate / in-place rewrite | Detected when size < offset or the head fingerprint changes. The tracker restarts at offset 0. Lines written between the copy and the truncate are lost (a limitation of copy-truncate itself). |
| Rotation during downtime | On startup, if the checkpointed inode is no longer at the log path, the uncompressed rotated siblings (`<stem>-*<ext>`, `<name>.N`) are searched for it. The rest of that file is read, then newer rotated files (by mtime), then the live file. |
| Checkpointed file gone (e.g. gzip'd while down) | The `rotation_gaps` counter is incremented and a warning is logged. Rotated files modified after the last checkpoint are read, then the live file. |
| Inode reused by a different file | The fingerprint mismatch is detected and reading restarts at offset 0. |

The log **directory** must be mounted into the container. A single-file bind
mount stays pinned to the old inode and never sees the new file.

## Delivery

Workers claim events with one atomic `UPDATE … RETURNING` that sets a lease
(`lease_seconds`) and a random lease token. Ack, retry and dead-letter only
apply if the lease token still matches, so a worker whose lease expired cannot
override the worker that re-claimed the event.

Before sending, the worker durably marks the event as `sending`. Ack, retry,
release and dead-letter clear the marker again.

Every failed delivery falls into one of three classes:

| Class | Cases | Handling |
|---|---|---|
| **Safe**: certainly not received by Matomo | connection refused, DNS errors, connect timeout, TLS errors; HTTP 408, 425, 429, 503 | retried with backoff |
| **Ambiguous**: Matomo may already have recorded it | request timeout, connection reset or other socket error after connecting; HTTP 500, 502, 504 and other 5xx; request aborted at the shutdown deadline; lease expired while the `sending` marker was set (crash mid-request) | counted in `deliveries_ambiguous`, then handled per `delivery.on_ambiguous_failure` (below) |
| **Permanent** | any other 4xx; redirects (never followed) | dead-lettered immediately |

- **Backoff:** `min(max_backoff, initial·2^(attempt-1))`, of which half is fixed and half is random jitter.
- **Exhausted:** after `max_attempts` the event is dead-lettered as `exhausted_<reason>`. Events whose lease expired too often are dead-lettered as `lease_expired_exhausted`.
- **Retention:** delivered and dead events are deleted after `delivered_retention_days` and `dead_letter_retention_days`. Pending events are never deleted.

### Duplicates and `on_ambiguous_failure`

Matomo cannot de-duplicate bot requests. `BotRequestProcessor` does a plain
`INSERT` into `log_bot_request`, which has no unique key, and the Tracking API
takes no request ID. Exactly-once delivery is therefore impossible; the only
choice is what happens after an ambiguous failure:

- `"retry"` (default), **at least once**: ambiguous failures are retried like safe ones. A duplicate appears only if Matomo did record the failed attempt.
- `"dead_letter"`, **at most once**: ambiguous failures go to the dead letters as `ambiguous_<reason>` (e.g. `ambiguous_timeout`, `ambiguous_lease_expired`, `ambiguous_aborted`) and are never re-sent automatically. Matomo may or may not have them. Replay them manually if you prefer the risk of a duplicate.

Safe failures are always retried, whichever policy is set.
`deliveries_ambiguous` gives an upper bound on possible duplicates (with
`retry`) or possible losses (with `dead_letter`). Avoid timeouts that are too
short, since every timeout is ambiguous.

## Shutdown

On SIGTERM or SIGINT:
1. The follower stops between polls, so its checkpoint is always consistent.
2. Workers stop claiming new events and wait up to `shutdown_timeout_seconds` for in-flight requests. Requests still running at the deadline are aborted and released.
3. The health server and the database are closed.

A second signal forces an immediate exit. Compose allows `stop_grace_period: 30s`.
