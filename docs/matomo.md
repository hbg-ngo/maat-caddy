# Matomo Tracking API usage

Reference: <https://developer.matomo.org/api-reference/tracking-api> (section "Tracking Bots").

Each event is sent as its own `POST` to `matomo.endpoint` with
`Content-Type: application/x-www-form-urlencoded`. The bulk API is not used;
assistant traffic is low, and one request per event keeps retries and dead
letters simple.

| Field | Value |
|---|---|
| `idsite` | `matomo.site_id` |
| `rec` | `1` |
| `recMode` | `1` (bot tracking only; non-bots are discarded by Matomo) |
| `apiv` | `1` |
| `send_image` | `0` (Matomo answers 204 with no body) |
| `queuedtracking` | `0` unless `bypass_queued_tracking = false`: Matomo processes the request immediately, skipping the QueuedTracking plugin |
| `ua` | full User-Agent of the request |
| `url` | `https://<expected_host><path>`; query string removed unless `strip_query_string = false` |
| `download` | same as `url`, only for `document_extensions` (default `.pdf`) |
| `cdt` | original request time, Unix seconds (UTC) |
| `http_status` | response status from Caddy |
| `bw_bytes` | Caddy `size` (response body bytes) |
| `pf_srv` | Caddy `duration` × 1000, rounded (ms); omitted if missing |
| `source` | `matomo.source` (default `Caddy`) |
| `token_auth` | always sent, in the POST body (never in the URL) |

`token_auth` is always sent because Matomo requires it for any `cdt` older
than 24 hours, which can happen with backlogs, retries and dead-letter
replays. Never sent: `cip`, `urlref`, `_id`/`cid`/`uid`, `lang`, cookies or any
other header.

## Prerequisites and caveats

- **Matomo ≥ 5.7.0** (bot tracking).
- The token must belong to a dedicated Matomo user with *write* permission on the site.
- **Unknown bots are dropped silently.** In `recMode=1`, Matomo runs its own bot detection, and requests from agents it does not recognise as AI assistants are discarded, most likely still with a 2xx response. That's why `[ai_assistants]` mirrors Matomo's `BotDetector` list and uses the same matching (see [filtering.md](filtering.md)). After deployment, or after changing the list, check once that events show up in Matomo's bot / AI assistant reports. For a single test request you can use `debug_on_demand` (see the Matomo docs).
- Because events carry past timestamps (`cdt`), Matomo must re-process reports for those dates. With browser-triggered archiving disabled, that is the normal archiving cron job.
- **QueuedTracking.** If the QueuedTracking plugin is active, Matomo answers 204 straight away and processes the request later. In our tests with Matomo 5.14.1, that later processing lost `token_auth` for about 0.5% of events (in groups). Matomo then rejected their old `cdt` ("Custom timestamp is … seconds old, requires &token_auth"), logged only a warning, and the events were missing. The tracker can't detect this, because the 204 was already sent. That's why the tracker sends `queuedtracking=0` by default. Matomo then checks the token while our request is still open, and the response reflects the actual processing.
- **No de-duplication in Matomo.** Bot requests are stored with a plain `INSERT` into `log_bot_request` (no unique key, no request ID), so a retried request that Matomo had already recorded is counted twice. See "Duplicates and `on_ambiguous_failure`" in [architecture.md](architecture.md).
- A success is any 2xx response. Redirects are treated as permanent failures and are never followed, so the token is never replayed to another URL.
