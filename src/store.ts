import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { EventData, TrackEvent } from "./filter.ts";

/** Position in a specific file, identified by device + inode and a head fingerprint. */
export interface FileCheckpoint {
  dev: string;
  ino: string;
  offset: number;
  /** Number of leading file bytes covered by fpHash. */
  fpLen: number;
  fpHash: string;
}

export interface QueuedEvent extends EventData {
  id: number;
  attempts: number;
  leaseToken: string;
  /**
   * A previous holder started sending this event and never settled it (crash or
   * lease expiry mid-request), so Matomo may already have recorded it.
   */
  unsettledSend: boolean;
}

export interface QueueStats {
  pending: number;
  inflight: number;
  delivered: number;
  dead: number;
  oldestPendingCreatedAt: number | null;
}

export interface CommitResult {
  /** Events newly enqueued. */
  enqueued: number;
  /** Events skipped because their fingerprint was already seen. */
  duplicates: number;
  /** Events skipped because they are older than the fingerprint retention horizon. */
  tooOld: number;
}

export type CleanupResult = {
  delivered: number;
  dead: number;
  /** Fingerprints removed by `seenRetentionMs`. */
  seen: number;
};

const SEEN_PRUNE_BATCH = 10_000;

export class QueueFullError extends Error {
  override name = "QueueFullError";
}

interface EventRow {
  id: number;
  event_ts: number;
  url: string;
  is_download: number;
  ua: string;
  http_status: number;
  bw_bytes: number;
  pf_srv_ms: number | null;
  attempts: number;
  lease_token: string;
  sending: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checkpoint (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  dev TEXT NOT NULL,
  ino TEXT NOT NULL,
  offset INTEGER NOT NULL CHECK (offset >= 0),
  fp_len INTEGER NOT NULL,
  fp_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  event_ts REAL NOT NULL,
  url TEXT NOT NULL,
  is_download INTEGER NOT NULL,
  ua TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  bw_bytes INTEGER NOT NULL,
  pf_srv_ms INTEGER,
  state TEXT NOT NULL CHECK (state IN ('pending', 'inflight', 'delivered', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_until INTEGER,
  lease_token TEXT,
  sending INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  finished_at INTEGER
);
-- Fingerprints of every event ever enqueued, so a request can never be enqueued
-- twice (re-imports, checkpoint resets, overlap). Kept forever unless
-- seenRetentionMs is set; older events are then refused instead.
CREATE TABLE IF NOT EXISTS seen_events (
  fingerprint BLOB PRIMARY KEY,
  event_ts REAL NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS events_pending ON events (state, next_attempt_at);
CREATE INDEX IF NOT EXISTS events_lease ON events (state, lease_until);
CREATE INDEX IF NOT EXISTS events_finished ON events (state, finished_at);
`;

export interface StoreOptions {
  maxQueueEvents: number;
  /**
   * Keep fingerprints only for events newer than this (0 = forever). Events
   * older than the horizon can no longer be deduplicated and are refused.
   */
  seenRetentionMs?: number;
  now?: () => number;
}

export class Store {
  readonly db: Database.Database;
  private readonly maxQueueEvents: number;
  private readonly seenRetentionMs: number;
  private readonly now: () => number;
  private readonly stmts;
  private readonly commitTx: Database.Transaction<
    (events: readonly TrackEvent[], cp: FileCheckpoint | null) => CommitResult
  >;

  constructor(path: string, opts: StoreOptions) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
    this.migrate();
    this.maxQueueEvents = opts.maxQueueEvents;
    this.seenRetentionMs = opts.seenRetentionMs ?? 0;
    this.now = opts.now ?? Date.now;
    // Only needed for pruning; it would roughly double the table size otherwise.
    if (this.seenRetentionMs > 0) this.db.exec("CREATE INDEX IF NOT EXISTS seen_events_ts ON seen_events (event_ts)");

    this.stmts = {
      getCheckpoint: this.db.prepare<
        [],
        { dev: string; ino: string; offset: number; fp_len: number; fp_hash: string; updated_at: number }
      >("SELECT dev, ino, offset, fp_len, fp_hash, updated_at FROM checkpoint WHERE id = 1"),
      putCheckpoint: this.db.prepare(
        `INSERT INTO checkpoint (id, dev, ino, offset, fp_len, fp_hash, updated_at)
         VALUES (1, @dev, @ino, @offset, @fpLen, @fpHash, @now)
         ON CONFLICT (id) DO UPDATE SET dev = excluded.dev, ino = excluded.ino, offset = excluded.offset,
           fp_len = excluded.fp_len, fp_hash = excluded.fp_hash, updated_at = excluded.updated_at`,
      ),
      activeCount: this.db
        .prepare<[], number>("SELECT COUNT(*) FROM events WHERE state IN ('pending', 'inflight')")
        .pluck(),
      markSeen: this.db.prepare("INSERT OR IGNORE INTO seen_events (fingerprint, event_ts) VALUES (@fp, @eventTs)"),
      isSeen: this.db.prepare<[Buffer], number>("SELECT 1 FROM seen_events WHERE fingerprint = ?").pluck(),
      seenCount: this.db.prepare<[], number>("SELECT COUNT(*) FROM seen_events").pluck(),
      insert: this.db.prepare(
        `INSERT INTO events (created_at, event_ts, url, is_download, ua, http_status, bw_bytes, pf_srv_ms, state, next_attempt_at)
         VALUES (@now, @eventTs, @url, @isDownload, @ua, @httpStatus, @bwBytes, @pfSrvMs, 'pending', @now)`,
      ),
      claim: this.db.prepare<[{ now: number; leaseUntil: number; token: string }], EventRow>(
        `UPDATE events SET state = 'inflight', lease_until = @leaseUntil, lease_token = @token, attempts = attempts + 1
         WHERE id = (
           SELECT id FROM events
           WHERE (state = 'pending' AND next_attempt_at <= @now) OR (state = 'inflight' AND lease_until <= @now)
           ORDER BY next_attempt_at, id LIMIT 1)
         RETURNING id, event_ts, url, is_download, ua, http_status, bw_bytes, pf_srv_ms, attempts, lease_token, sending`,
      ),
      markSending: this.db.prepare(
        "UPDATE events SET sending = 1 WHERE id = @id AND state = 'inflight' AND lease_token = @token",
      ),
      ack: this.db.prepare(
        `UPDATE events SET state = 'delivered', sending = 0, finished_at = @now, lease_until = NULL, lease_token = NULL, last_error = NULL
         WHERE id = @id AND state = 'inflight' AND lease_token = @token`,
      ),
      retry: this.db.prepare(
        `UPDATE events SET state = 'pending', sending = 0, next_attempt_at = @next, lease_until = NULL, lease_token = NULL, last_error = @reason
         WHERE id = @id AND state = 'inflight' AND lease_token = @token`,
      ),
      release: this.db.prepare(
        `UPDATE events SET state = 'pending', sending = 0, attempts = MAX(attempts - 1, 0), lease_until = NULL, lease_token = NULL
         WHERE id = @id AND state = 'inflight' AND lease_token = @token`,
      ),
      dead: this.db.prepare(
        `UPDATE events SET state = 'dead', sending = 0, finished_at = @now, lease_until = NULL, lease_token = NULL, last_error = @reason
         WHERE id = @id AND state = 'inflight' AND lease_token = @token`,
      ),
      cleanup: this.db.prepare("DELETE FROM events WHERE state = @state AND finished_at < @before"),
      pruneSeen: this.db.prepare(
        `DELETE FROM seen_events WHERE fingerprint IN (
           SELECT fingerprint FROM seen_events WHERE event_ts < @before LIMIT ${SEEN_PRUNE_BATCH})`,
      ),
      stats: this.db.prepare<[], { state: string; n: number }>("SELECT state, COUNT(*) AS n FROM events GROUP BY state"),
      oldestPending: this.db
        .prepare<[], number | null>("SELECT MIN(created_at) FROM events WHERE state IN ('pending', 'inflight')")
        .pluck(),
      deadStats: this.db.prepare<[], { reason: string; count: number; oldest: number; newest: number }>(
        `SELECT COALESCE(last_error, 'unknown') AS reason, COUNT(*) AS count, MIN(finished_at) AS oldest, MAX(finished_at) AS newest
         FROM events WHERE state = 'dead' GROUP BY reason ORDER BY count DESC`,
      ),
      replay: this.db.prepare(
        `UPDATE events SET state = 'pending', sending = 0, attempts = 0, next_attempt_at = @now, finished_at = NULL, last_error = NULL
         WHERE id IN (SELECT id FROM events WHERE state = 'dead' AND (@reason IS NULL OR last_error = @reason) ORDER BY id LIMIT @limit)`,
      ),
    };

    this.commitTx = this.db.transaction((events: readonly TrackEvent[], cp: FileCheckpoint | null) => {
      const now = this.now();
      const result: CommitResult = { enqueued: 0, duplicates: 0, tooOld: 0 };
      if (events.length > 0) {
        const active = this.stmts.activeCount.get() ?? 0;
        const horizon = this.seenHorizon(now);
        for (const e of events) {
          if (e.eventTs < horizon) {
            result.tooOld++;
            continue;
          }
          const fp = Buffer.from(e.fingerprint, "hex");
          if (this.stmts.markSeen.run({ fp, eventTs: e.eventTs }).changes === 0) {
            result.duplicates++;
            continue;
          }
          if (active + result.enqueued + 1 > this.maxQueueEvents) {
            throw new QueueFullError(`queue full (${active} active, limit ${this.maxQueueEvents})`);
          }
          result.enqueued++;
          this.stmts.insert.run({
            now,
            eventTs: e.eventTs,
            url: e.url,
            isDownload: e.isDownload ? 1 : 0,
            ua: e.ua,
            httpStatus: e.httpStatus,
            bwBytes: e.bwBytes,
            pfSrvMs: e.pfSrvMs,
          });
        }
      }
      if (cp !== null) this.stmts.putCheckpoint.run({ ...cp, now });
      return result;
    });
  }

  private migrate(): void {
    const cols = this.db.prepare<[], { name: string }>("PRAGMA table_info(events)").all().map((c) => c.name);
    if (!cols.includes("sending")) this.db.exec("ALTER TABLE events ADD COLUMN sending INTEGER NOT NULL DEFAULT 0");
  }

  getCheckpoint(): (FileCheckpoint & { updatedAt: number }) | null {
    const row = this.stmts.getCheckpoint.get();
    if (!row) return null;
    return {
      dev: row.dev,
      ino: row.ino,
      offset: row.offset,
      fpLen: row.fp_len,
      fpHash: row.fp_hash,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Atomically enqueues events whose fingerprint was never seen before and
   * advances the checkpoint (if given). Either everything commits or nothing
   * does; throws on queue overflow or DB error.
   */
  commitBatch(events: readonly TrackEvent[], cp: FileCheckpoint | null): CommitResult {
    return this.commitTx.immediate(events, cp);
  }

  /** True if an event with this fingerprint was ever enqueued (within the retention horizon). */
  isSeen(fingerprint: string): boolean {
    return this.stmts.isSeen.get(Buffer.from(fingerprint, "hex")) === 1;
  }

  /** True if an event with this timestamp (Unix seconds) is beyond the fingerprint retention and would be refused. */
  isTooOld(eventTs: number): boolean {
    return eventTs < this.seenHorizon(this.now());
  }

  /** Oldest accepted event timestamp in Unix seconds (-Infinity when fingerprints are kept forever). */
  private seenHorizon(now: number): number {
    return this.seenRetentionMs > 0 ? (now - this.seenRetentionMs) / 1000 : -Infinity;
  }

  seenCount(): number {
    return this.stmts.seenCount.get() ?? 0;
  }

  /** Atomically claims one due event (or one whose lease expired) under a fresh lease. */
  claim(leaseMs: number): QueuedEvent | null {
    const now = this.now();
    const row = this.stmts.claim.get({ now, leaseUntil: now + leaseMs, token: randomUUID() });
    if (!row) return null;
    return {
      id: row.id,
      eventTs: row.event_ts,
      url: row.url,
      isDownload: row.is_download === 1,
      ua: row.ua,
      httpStatus: row.http_status,
      bwBytes: row.bw_bytes,
      pfSrvMs: row.pf_srv_ms,
      attempts: row.attempts,
      leaseToken: row.lease_token,
      unsettledSend: row.sending === 1,
    };
  }

  /**
   * Durably records that the event is about to be handed to Matomo. If the
   * process dies before settling it, the next claim reports `unsettledSend`.
   */
  markSending(id: number, token: string): boolean {
    return this.stmts.markSending.run({ id, token }).changes === 1;
  }

  /** The lease token guards against acting on an event whose lease expired and was re-claimed. */
  ack(id: number, token: string): boolean {
    return this.stmts.ack.run({ id, token, now: this.now() }).changes === 1;
  }

  retry(id: number, token: string, nextAttemptAt: number, reason: string): boolean {
    return this.stmts.retry.run({ id, token, next: nextAttemptAt, reason }).changes === 1;
  }

  /** Returns an unsent event to the queue without consuming an attempt (used on shutdown). */
  release(id: number, token: string): boolean {
    return this.stmts.release.run({ id, token }).changes === 1;
  }

  deadLetter(id: number, token: string, reason: string): boolean {
    return this.stmts.dead.run({ id, token, reason, now: this.now() }).changes === 1;
  }

  cleanup(deliveredRetentionMs: number, deadRetentionMs: number): CleanupResult {
    const now = this.now();
    const delivered = this.stmts.cleanup.run({ state: "delivered", before: now - deliveredRetentionMs }).changes;
    const dead = this.stmts.cleanup.run({ state: "dead", before: now - deadRetentionMs }).changes;
    let seen = 0;
    if (this.seenRetentionMs > 0) {
      // Small batches, each its own transaction, so a large first prune doesn't block the follower.
      const before = this.seenHorizon(now);
      let n: number;
      do {
        n = this.stmts.pruneSeen.run({ before }).changes;
        seen += n;
      } while (n === SEEN_PRUNE_BATCH);
    }
    return { delivered, dead, seen };
  }

  stats(): QueueStats {
    const s: QueueStats = { pending: 0, inflight: 0, delivered: 0, dead: 0, oldestPendingCreatedAt: null };
    for (const row of this.stmts.stats.all()) {
      if (row.state === "pending" || row.state === "inflight" || row.state === "delivered" || row.state === "dead") {
        s[row.state] = row.n;
      }
    }
    s.oldestPendingCreatedAt = this.stmts.oldestPending.get() ?? null;
    return s;
  }

  /** Aggregate dead-letter view: reason codes and counts only, never payloads. */
  deadLetterStats(): { reason: string; count: number; oldest: number; newest: number }[] {
    return this.stmts.deadStats.all();
  }

  replayDeadLetters(reason: string | null, limit: number): number {
    return this.stmts.replay.run({ reason, limit, now: this.now() }).changes;
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}
