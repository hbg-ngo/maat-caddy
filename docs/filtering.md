# Filtering

A log line becomes an event only if all of the following hold, checked in this
order:

1. **Valid JSON** with `ts`, `status`, `request.host`, `request.method` and `request.uri`. Other lines are counted as `lines_malformed`. Only the reason and the line length are logged, at most 5 messages per minute.
2. **Host** equals `log.expected_host` (e.g. `example.com`). The port and a trailing dot are ignored. `www.` and other subdomains do not match.
3. **User agent**:
   - Training-crawler exclusions are checked first and always win: `GPTBot`, `ClaudeBot`, `Google-Extended`, `CCBot`, `Amazonbot`. They match whole product names only, case-insensitively. The UA is split on whitespace, `;`, `,`, `(` and `)`, and the name is the part before `/`. So `GPTBot/1.2` is excluded, but `MyGPTBot` is not.
   - Then the assistant allowlist. It mirrors Matomo's `BotDetector` (`plugins/BotTracking/BotDetector.php`, commit `71b5fbf`): `ChatGPT-User`, `MistralAI-User`, `Gemini-Deep-Research`, `Claude-User`, `Perplexity-User`, `Google-GeminiNotebook` and `Google-NotebookLM`. Matomo reports `Google-GeminiNotebook` as `Google-NotebookLM`.
   - Assistant names are matched **exactly like Matomo** (`stripos`): case-insensitive, anywhere in the UA. We therefore never skip a request Matomo would count. To prevent broad matches, each configured name must be at least 6 characters.
   - A request with several User-Agent headers is treated as having none.
4. **Method** in `allowed_methods` (default `GET`).
5. **Status** within `allowed_status_min`..`allowed_status_max` (default 200–299). Redirects are excluded by default; otherwise a fetch that gets redirected would count twice (redirect plus target). Set `allowed_status_max = 399` to include 3xx.
6. **Path**: the URL is normalised first (dot segments resolved, so `/de/../_next/x` counts as `/_next/x`). It is then excluded if:
   - it equals an `exclude_paths` entry (default `/robots.txt`, `/health`, `/healthz`; a trailing slash is ignored),
   - it starts with an `exclude_prefixes` entry (default `/_next/`, `/api/`; `/api` itself is excluded too), or
   - its extension is in `exclude_extensions` (static assets).
   Paths are compared case-insensitively.
7. Paths with a `document_extensions` extension (default `.pdf`) are sent as Matomo downloads.

Each skip reason is counted as `skipped_<reason>` in `/metrics`.

Keep `[ai_assistants]` in sync with Matomo's `BotDetector` for the Matomo
version you run. Agents missing from Matomo's list are discarded by Matomo,
and agents missing from ours are never sent. When you update Matomo, compare
its list with ours and update `MATOMO_AI_ASSISTANTS` in `src/config.ts`, the
example config and the sync test in `tests/classifier.test.ts`.
