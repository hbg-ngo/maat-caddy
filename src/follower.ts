import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { TrackEvent } from "./filter.ts";
import { describeError, log, RateLimitedLogger } from "./log.ts";
import type { Metrics } from "./metrics.ts";
import { QueueFullError, type CommitResult, type FileCheckpoint, type Store } from "./store.ts";

const FINGERPRINT_BYTES = 256;
const NEWLINE = 0x0a;

export interface FollowerOptions {
  path: string;
  store: Store;
  /** Converts one complete log line into an event, or null if it does not qualify. Must not throw. */
  processLine: (line: string) => TrackEvent | null;
  metrics: Metrics;
  maxLineBytes: number;
  batchLines: number;
  pollIntervalMs: number;
  rotationGraceMs: number;
  startPosition: "beginning" | "end";
  /** Called after events were durably enqueued. */
  onEnqueued?: () => void;
  now?: () => number;
}

interface FileIdentity {
  dev: string;
  ino: string;
}

interface OpenFile extends FileIdentity {
  fd: number;
  /** Path the file was opened from (may be a rotated name). */
  path: string;
  offset: number;
  fpLen: number;
  fpHash: string;
}

interface Candidate extends FileIdentity {
  path: string;
  mtimeNs: bigint;
}

function identityOf(st: { dev: bigint; ino: bigint }): FileIdentity {
  return { dev: st.dev.toString(), ino: st.ino.toString() };
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function statIdentity(path: string): (FileIdentity & { mtimeNs: bigint }) | null {
  try {
    const st = statSync(path, { bigint: true });
    if (!st.isFile()) return null;
    return { ...identityOf(st), mtimeNs: st.mtimeNs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Lists rotated siblings of the log file that are still uncompressed:
 * Caddy/lumberjack style "<stem>-<timestamp><ext>" and logrotate style "<name>.<n>".
 */
export function listRotatedFiles(logPath: string): Candidate[] {
  const dir = dirname(logPath);
  const name = basename(logPath);
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Candidate[] = [];
  for (const entry of entries) {
    if (entry === name) continue;
    const lumberjack = entry.startsWith(`${stem}-`) && entry.endsWith(ext) && ext !== "";
    const logrotate = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d+$`).test(entry);
    if (!lumberjack && !logrotate) continue;
    const id = statIdentity(join(dir, entry));
    if (id) out.push({ path: join(dir, entry), ...id });
  }
  return out.sort((a, b) => (a.mtimeNs < b.mtimeNs ? -1 : a.mtimeNs > b.mtimeNs ? 1 : a.path.localeCompare(b.path)));
}

/**
 * Rotation-safe follower for newline-delimited logs.
 *
 * Position is only ever advanced through Store.commitBatch, which enqueues the
 * qualifying events of the consumed lines and stores the new offset in one
 * transaction. Partial lines are never consumed; they are re-read on the next poll.
 */
export class Follower {
  private readonly opts: FollowerOptions;
  private readonly now: () => number;
  private readonly buf: Buffer;
  private readonly commitErrors = new RateLimitedLogger(5, 60_000);
  private current: OpenFile | null = null;
  /** Rotated files still to be read (oldest first) before returning to the live path. */
  private backlog: Candidate[] = [];
  private draining = false;
  private drainLastSize = -1;
  private drainLastChange = 0;
  /** In-memory skip state for an oversized line (never checkpointed mid-line). */
  private skipFrom: number | null = null;
  private initialized = false;
  private stopped = false;
  private loopPromise: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  lastPollAt = 0;

  constructor(opts: FollowerOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.buf = Buffer.allocUnsafe(opts.maxLineBytes);
  }

  start(): void {
    this.stopped = false;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.loopPromise;
    this.loopPromise = null;
    this.closeCurrent();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      let progressed = false;
      try {
        progressed = this.pollOnce();
      } catch (err) {
        this.opts.metrics.inc("follower_errors");
        this.commitErrors.log("error", "follower poll failed", { error: describeError(err) });
      }
      if (this.stopped) break;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, progressed ? 0 : this.opts.pollIntervalMs);
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  /** One synchronous follower step. Returns true if the position advanced. Exposed for tests. */
  pollOnce(): boolean {
    this.lastPollAt = this.now();
    if (!this.initialized) {
      this.initialize();
      this.initialized = true;
    }
    if (this.current === null && !this.openNext()) return false;
    const file = this.current!;

    // Check before reading, so content replaced in place is never read from a stale offset.
    if (!this.draining && this.detectTruncation(file)) return true;
    const progressed = this.readLines(file);
    this.updateLag(file);
    if (progressed) return true;

    if (!this.draining) {
      const atPath = statIdentity(this.opts.path);
      if (atPath === null || !sameIdentity(atPath, file) || this.backlog.length > 0) {
        this.draining = true;
        this.drainLastSize = -1;
        this.drainLastChange = this.now();
        if (file.path === this.opts.path) {
          this.opts.metrics.inc("rotations");
          log("info", "log rotation detected; draining previous file", { path: this.opts.path });
        }
      }
    }
    if (this.draining) return this.continueDrain(file);
    return false;
  }

  private initialize(): void {
    const cp = this.opts.store.getCheckpoint();
    const atPath = statIdentity(this.opts.path);
    if (cp === null) {
      if (atPath === null) return;
      const file = this.open(this.opts.path, atPath);
      if (file === null) return;
      if (this.opts.startPosition === "end") file.offset = this.lastLineBoundary(file);
      this.current = file;
      this.commit([], file, file.offset);
      log("info", "no checkpoint; starting to follow", { path: this.opts.path, startPosition: this.opts.startPosition });
      return;
    }

    if (atPath !== null && sameIdentity(atPath, cp)) {
      const file = this.open(this.opts.path, atPath);
      if (file === null) return;
      this.resumeAt(file, cp);
      return;
    }

    // The checkpointed file is no longer at the log path: it was rotated while we were down.
    const rotated = listRotatedFiles(this.opts.path);
    const match = rotated.find((c) => sameIdentity(c, cp));
    if (match) {
      const file = this.open(match.path, match);
      if (file !== null && this.fingerprintMatches(file, cp)) {
        file.offset = cp.offset;
        file.fpLen = cp.fpLen;
        file.fpHash = cp.fpHash;
        this.current = file;
        this.backlog = rotated.filter((c) => c.mtimeNs > match.mtimeNs && !sameIdentity(c, cp));
        log("info", "resuming rotated file after restart", { path: match.path, backlog: this.backlog.length });
        return;
      }
      if (file !== null) closeSync(file.fd);
    }
    this.opts.metrics.inc("rotation_gaps");
    log("warn", "checkpointed log file not found (rotated and compressed or deleted); data may have been missed", {
      path: this.opts.path,
    });
    // Rotated files modified after our last checkpoint can only contain newer lines.
    const sinceNs = BigInt(cp.updatedAt) * 1_000_000n;
    this.backlog = rotated.filter((c) => c.mtimeNs > sinceNs);
  }

  private resumeAt(file: OpenFile, cp: FileCheckpoint): void {
    const size = Number(fstatSync(file.fd).size);
    this.current = file;
    if (size >= cp.offset && this.fingerprintMatches(file, cp)) {
      file.offset = cp.offset;
      file.fpLen = cp.fpLen;
      file.fpHash = cp.fpHash;
      log("info", "resuming from checkpoint", { path: file.path, offset: cp.offset });
    } else {
      this.opts.metrics.inc("truncations");
      log("warn", "log file was truncated or replaced since checkpoint; restarting at offset 0", { path: file.path });
      this.commit([], file, 0);
    }
  }

  /** Opens the next file: oldest rotated backlog entry first, otherwise the live path. */
  private openNext(): boolean {
    while (this.backlog.length > 0) {
      const next = this.backlog.shift()!;
      const file = this.open(next.path, next);
      if (file === null) continue;
      this.current = file;
      this.commit([], file, 0);
      log("info", "reading rotated file", { path: next.path });
      return true;
    }
    const atPath = statIdentity(this.opts.path);
    if (atPath === null) return false;
    const file = this.open(this.opts.path, atPath);
    if (file === null) return false;
    this.current = file;
    this.commit([], file, 0);
    return true;
  }

  private open(path: string, expected: FileIdentity): OpenFile | null {
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const id = identityOf(fstatSync(fd, { bigint: true }));
    if (!sameIdentity(id, expected)) {
      // Replaced between stat and open; let the next poll re-evaluate.
      closeSync(fd);
      return null;
    }
    return { fd, path, ...id, offset: 0, fpLen: 0, fpHash: "" };
  }

  private closeCurrent(): void {
    if (this.current !== null) {
      closeSync(this.current.fd);
      this.current = null;
    }
  }

  private fingerprint(fd: number, len: number): string {
    const b = Buffer.alloc(len);
    const n = len > 0 ? readSync(fd, b, 0, len, 0) : 0;
    if (n !== len) return "";
    return createHash("sha256").update(b).digest("hex");
  }

  private fingerprintMatches(file: OpenFile, cp: FileCheckpoint): boolean {
    if (cp.fpLen === 0) return true;
    return this.fingerprint(file.fd, cp.fpLen) === cp.fpHash;
  }

  /** Byte offset just after the last newline in the file (start of the first incomplete line). */
  private lastLineBoundary(file: OpenFile): number {
    const size = Number(fstatSync(file.fd).size);
    let end = size;
    while (end > 0) {
      const len = Math.min(this.buf.length, end);
      const n = readSync(file.fd, this.buf, 0, len, end - len);
      const idx = this.buf.subarray(0, n).lastIndexOf(NEWLINE);
      if (idx >= 0) return end - len + idx + 1;
      end -= len;
    }
    return 0;
  }

  /** Commits events + new offset atomically. Returns false (position unchanged) on failure. */
  private commit(events: TrackEvent[], file: OpenFile, newOffset: number): boolean {
    let fpLen = file.fpLen;
    let fpHash = file.fpHash;
    if (newOffset < file.offset) {
      fpLen = 0;
      fpHash = "";
    }
    if (fpLen < FINGERPRINT_BYTES && newOffset > fpLen) {
      fpLen = Math.min(FINGERPRINT_BYTES, newOffset);
      fpHash = this.fingerprint(file.fd, fpLen);
    }
    let result: CommitResult;
    try {
      result = this.opts.store.commitBatch(events, { dev: file.dev, ino: file.ino, offset: newOffset, fpLen, fpHash });
    } catch (err) {
      if (err instanceof QueueFullError) {
        this.opts.metrics.inc("queue_full_pauses");
        this.commitErrors.log("warn", "queue full; pausing log follower", {});
      } else {
        this.opts.metrics.inc("commit_failures");
        this.commitErrors.log("error", "checkpoint commit failed; not advancing", { error: describeError(err) });
      }
      return false;
    }
    file.offset = newOffset;
    file.fpLen = fpLen;
    file.fpHash = fpHash;
    if (result.duplicates > 0) this.opts.metrics.inc("events_duplicate_skipped", result.duplicates);
    if (result.tooOld > 0) this.opts.metrics.inc("events_too_old_skipped", result.tooOld);
    if (result.enqueued > 0) {
      this.opts.metrics.inc("events_enqueued", result.enqueued);
      this.opts.onEnqueued?.();
    }
    return true;
  }

  /** Reads and commits up to batchLines complete lines. */
  private readLines(file: OpenFile): boolean {
    if (this.skipFrom !== null) return this.skipOversized(file);
    const n = readSync(file.fd, this.buf, 0, this.buf.length, file.offset);
    if (n === 0) return false;
    const chunk = this.buf.subarray(0, n);
    const events: TrackEvent[] = [];
    let pos = 0;
    let lines = 0;
    while (lines < this.opts.batchLines) {
      const nl = chunk.indexOf(NEWLINE, pos);
      if (nl < 0) break;
      this.handleLine(chunk, pos, nl, events);
      pos = nl + 1;
      lines++;
    }
    if (lines === 0) {
      if (n === this.buf.length) {
        // No newline within max_line_bytes: skip this line without checkpointing mid-line.
        this.skipFrom = file.offset + n;
        this.opts.metrics.inc("lines_oversized");
        return this.skipOversized(file);
      }
      return false;
    }
    return this.commit(events, file, file.offset + pos);
  }

  private handleLine(chunk: Buffer, start: number, end: number, events: TrackEvent[]): void {
    let e = end;
    if (e > start && chunk[e - 1] === 0x0d) e--;
    if (e === start) return;
    this.opts.metrics.inc("lines_read");
    const ev = this.opts.processLine(chunk.toString("utf8", start, e));
    if (ev !== null) events.push(ev);
  }

  private skipOversized(file: OpenFile): boolean {
    let from = this.skipFrom!;
    for (;;) {
      const n = readSync(file.fd, this.buf, 0, this.buf.length, from);
      if (n === 0) {
        this.skipFrom = from;
        return false;
      }
      const nl = this.buf.subarray(0, n).indexOf(NEWLINE);
      if (nl >= 0) {
        this.skipFrom = null;
        return this.commit([], file, from + nl + 1);
      }
      from += n;
    }
  }

  private detectTruncation(file: OpenFile): boolean {
    const size = Number(fstatSync(file.fd).size);
    const replaced = file.fpLen > 0 && (size < file.fpLen || this.fingerprint(file.fd, file.fpLen) !== file.fpHash);
    if (size >= file.offset && !replaced) return false;
    this.opts.metrics.inc("truncations");
    this.skipFrom = null;
    log("warn", "log file truncated (copy-truncate?); restarting at offset 0", { path: file.path });
    return this.commit([], file, 0);
  }

  /**
   * The current file is no longer the live log (or older rotated files are queued).
   * Keep reading it until it has been idle for rotation_grace_ms, then process a
   * trailing unterminated line, close it and move on.
   */
  private continueDrain(file: OpenFile): boolean {
    const size = Number(fstatSync(file.fd).size);
    const now = this.now();
    if (size !== this.drainLastSize) {
      this.drainLastSize = size;
      this.drainLastChange = now;
      return false;
    }
    if (now - this.drainLastChange < this.opts.rotationGraceMs) return false;

    if (this.skipFrom !== null) {
      this.skipFrom = null;
      if (!this.commit([], file, size)) return false;
    } else if (size > file.offset) {
      // Final line without trailing newline in a file that will never grow again.
      const len = size - file.offset;
      const events: TrackEvent[] = [];
      if (len <= this.buf.length) {
        const n = readSync(file.fd, this.buf, 0, len, file.offset);
        this.handleLine(this.buf, 0, n, events);
      } else {
        this.opts.metrics.inc("lines_oversized");
      }
      if (!this.commit(events, file, size)) return false;
    }

    if (this.backlog.length === 0) {
      // Pick up any further rotations that happened while draining.
      const mtime = fstatSync(file.fd, { bigint: true }).mtimeNs;
      const live = statIdentity(this.opts.path);
      this.backlog = listRotatedFiles(this.opts.path).filter(
        (c) => c.mtimeNs > mtime && !sameIdentity(c, file) && (live === null || !sameIdentity(c, live)),
      );
    }
    log("info", "finished draining file", { path: file.path });
    this.closeCurrent();
    this.draining = false;
    this.openNext();
    return true;
  }

  private updateLag(file: OpenFile): void {
    const size = Number(fstatSync(file.fd).size);
    this.opts.metrics.set("follower_lag_bytes", Math.max(0, size - file.offset));
    this.opts.metrics.set("follower_offset", file.offset);
  }
}
