# Historic import

`import` queues assistant requests from older log files, rotated and
gzip-compressed or plain. The running daemon then delivers them to Matomo with
their original timestamps (`cdt`).

```sh
docker compose exec maat-caddy node dist/main.js import [--dry-run] [--since <date>] [--until <date>] <file>...
```

- Files are read in the given order. Gzip is detected by content, not by file name.
- Lines go through exactly the same parser and filters as the live follower (host, user agents, method, status, paths).
- `--since` / `--until` take `YYYY-MM-DD` (UTC midnight) or an ISO timestamp. `--since` is inclusive, `--until` exclusive.
- `--dry-run` writes nothing. It reports what would be queued.
- The token isn't needed, because the daemon does the delivery. If the queue is full (`max_queue_events`), the import waits until the daemon has made room. If the daemon isn't running, start it first.
- The result is printed as JSON on stdout: per file and in total, `lines`, `malformed`, `oversized`, `qualifying`, `outOfRange`, `enqueued`, `alreadySeen`, `tooOld`. Log messages go to stderr.

## Safe to run more than once

Every event that is ever queued, whether by the live follower or by an import,
leaves a SHA-256 fingerprint in the `seen_events` table. An event whose
fingerprint already exists is skipped (`alreadySeen`). The check happens in the
same transaction as the insert. This covers:

- running the same import twice, or passing the same file twice;
- an import that was interrupted and is started again: only the remaining events are queued;
- overlap with the live follower in both directions, e.g. including the live log in the import;
- a lost or reset checkpoint.

The fingerprint is built from data the tracker stores anyway: the timestamp and
duration exactly as logged, the method, the normalised URL, the User-Agent, the
status and the size. No IP and no query string (unless `strip_query_string =
false`). By default fingerprints are kept forever; retention only removes the
events themselves. That's about 40–50 bytes per assistant request. See
[Disk usage](#disk-usage) to limit this.

Two caveats:
- If you change `strip_query_string` or `expected_host`, the URLs change, and with them the fingerprints. Requests imported before the change would then be queued again.
- The fingerprint stops a request from being **queued** twice. It can't stop Matomo from counting a request twice after an ambiguous delivery failure. That is controlled by `on_ambiguous_failure`, see [architecture.md](architecture.md).

## First deployment

1. Configure and start the daemon with `start_position = "end"` (see [deployment.md](deployment.md)).
2. In Matomo, check:
   - **Data retention:** under *Administration → Privacy → Anonymize data → Delete old raw data*, raw data older than the configured period is deleted, and that includes imported bot requests. Only import within that period.
   - **Site creation date:** reports are not archived for dates before the site's creation date. The oldest imported date must be later than it.
3. Dry run over all rotated files plus the live file:
   ```sh
   node dist/main.js import --dry-run /var/log/caddy/example.com-*.log.gz /var/log/caddy/example.com-*.log /var/log/caddy/example.com.log
   ```
   The `/var/log/caddy` directory is mounted read-only into the container, so these paths work as-is.
4. Run the same command without `--dry-run`.
5. Wait until the queue is empty (`node dist/main.js queue stats`, `pending` and `inflight` at 0). Check `deadletter stats`.
6. Have Matomo re-process the reports for the imported period (on the Matomo host):
   ```sh
   ./console core:invalidate-report-data --dates=<oldest-date>,<today> --sites=<site_id>
   ./console core:archive
   ```

## Disk usage

`seen_events` grows by one row per queued assistant request. At 10,000
assistant requests per day that's roughly 200 MB per year. Lookups stay fast
(primary-key index), so this is only a disk-space question.

To bound it, set `seen_retention_days` in `[storage]` (default `0` = keep
forever). The hourly retention run then deletes fingerprints of requests older
than that, plus an index on the request time (only created when the option is
set). To keep "never queued twice" true, requests older than the horizon are no
longer queued at all:

- `import` counts them as `tooOld`;
- the live follower counts them as `events_too_old_skipped` (e.g. after downtime longer than the horizon).

So choose a horizon longer than any expected downtime and older than the logs
you might import, e.g. Matomo's raw-data retention period. SQLite reuses freed
pages, so the file stops growing but doesn't shrink; run `VACUUM` with the
daemon stopped to reclaim space.

To reset everything, stop the daemon, then delete the database. Doing so drops
the queue and the protection against re-imports.
