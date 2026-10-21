import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { ConfigError } from "./config.ts";
import type { TrackEvent } from "./filter.ts";
import { log } from "./log.ts";
import { Metrics } from "./metrics.ts";
import { QueueFullError, type Store } from "./store.ts";

export interface ImportOptions {
  store: Store;
  /** Builds the same line pipeline as the live follower (parse + filters), counting into `metrics`. */
  lineProcessor: (metrics: Metrics) => (line: string) => TrackEvent | null;
  maxLineBytes: number;
  /** Max events per transaction. */
  batchSize: number;
  dryRun: boolean;
  /** Only events with since <= ts < until (Unix seconds). */
  since: number | null;
  until: number | null;
  queueFullWaitMs?: number;
  onProgress?: (msg: string, fields: Record<string, unknown>) => void;
}

export interface FileReport {
  file: string;
  lines: number;
  malformed: number;
  oversized: number;
  qualifying: number;
  outOfRange: number;
  enqueued: number;
  alreadySeen: number;
  /** Older than `seen_retention_days`, so they can't be deduplicated any more. */
  tooOld: number;
}

const GZIP_MAGIC = [0x1f, 0x8b];

async function isGzip(path: string): Promise<boolean> {
  const fh = await open(path, "r");
  try {
    const b = Buffer.alloc(2);
    const { bytesRead } = await fh.read(b, 0, 2, 0);
    return bytesRead === 2 && b[0] === GZIP_MAGIC[0] && b[1] === GZIP_MAGIC[1];
  } finally {
    await fh.close();
  }
}

/**
 * Yields complete lines (plus a final unterminated one). Lines longer than
 * maxLineBytes are dropped and reported via onOversized; memory stays bounded.
 */
async function* readLines(stream: AsyncIterable<Buffer>, maxLineBytes: number, onOversized: () => void): AsyncGenerator<string> {
  let parts: Buffer[] = [];
  let pending = 0;
  let skipping = false;
  for await (const chunk of stream) {
    let pos = 0;
    while (pos < chunk.length) {
      const nl = chunk.indexOf(0x0a, pos);
      const end = nl < 0 ? chunk.length : nl;
      if (!skipping) {
        if (pending + (end - pos) > maxLineBytes) {
          skipping = true;
          parts = [];
          pending = 0;
          onOversized();
        } else {
          parts.push(chunk.subarray(pos, end));
          pending += end - pos;
        }
      }
      if (nl < 0) break;
      if (!skipping) yield Buffer.concat(parts, pending).toString("utf8");
      parts = [];
      pending = 0;
      skipping = false;
      pos = nl + 1;
    }
  }
  if (!skipping && pending > 0) yield Buffer.concat(parts, pending).toString("utf8");
}

/**
 * One-off import of (rotated, optionally gzip-compressed) log files into the
 * delivery queue. Events whose fingerprint was ever enqueued before (by an
 * earlier import or the live follower) are skipped, so re-running is safe.
 */
export class Importer {
  private readonly opts: ImportOptions;

  constructor(opts: ImportOptions) {
    this.opts = opts;
  }

  async importFile(file: string): Promise<FileReport> {
    const report: FileReport = {
      file,
      lines: 0,
      malformed: 0,
      oversized: 0,
      qualifying: 0,
      outOfRange: 0,
      enqueued: 0,
      alreadySeen: 0,
      tooOld: 0,
    };
    const metrics = new Metrics();
    const processLine = this.opts.lineProcessor(metrics);
    const raw = createReadStream(file);
    const stream: AsyncIterable<Buffer> = (await isGzip(file)) ? raw.pipe(createGunzip()) : raw;
    const seenInDryRun = new Set<string>();
    let batch: TrackEvent[] = [];

    const flush = async () => {
      if (batch.length === 0) return;
      const events = batch;
      batch = [];
      if (this.opts.dryRun) {
        for (const e of events) {
          if (this.opts.store.isTooOld(e.eventTs)) report.tooOld++;
          else if (this.opts.store.isSeen(e.fingerprint) || seenInDryRun.has(e.fingerprint)) report.alreadySeen++;
          else {
            seenInDryRun.add(e.fingerprint);
            report.enqueued++;
          }
        }
        return;
      }
      for (;;) {
        try {
          const r = this.opts.store.commitBatch(events, null);
          report.enqueued += r.enqueued;
          report.alreadySeen += r.duplicates;
          report.tooOld += r.tooOld;
          return;
        } catch (err) {
          if (!(err instanceof QueueFullError)) throw err;
          this.opts.onProgress?.("queue full; waiting for the daemon to deliver", { file, enqueued: report.enqueued });
          await new Promise((r) => setTimeout(r, this.opts.queueFullWaitMs ?? 5000));
        }
      }
    };

    for await (const rawLine of readLines(stream, this.opts.maxLineBytes, () => report.oversized++)) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.length === 0) continue;
      report.lines++;
      const ev = processLine(line);
      if (ev === null) continue;
      report.qualifying++;
      if ((this.opts.since !== null && ev.eventTs < this.opts.since) || (this.opts.until !== null && ev.eventTs >= this.opts.until)) {
        report.outOfRange++;
        continue;
      }
      batch.push(ev);
      if (batch.length >= this.opts.batchSize) await flush();
    }
    await flush();
    report.malformed = metrics.get("lines_malformed");
    log("info", "imported file", { ...report, dryRun: this.opts.dryRun });
    return report;
  }

  async importFiles(files: readonly string[]): Promise<{ files: FileReport[]; total: Omit<FileReport, "file"> }> {
    const reports: FileReport[] = [];
    for (const f of files) reports.push(await this.importFile(f));
    const total = { lines: 0, malformed: 0, oversized: 0, qualifying: 0, outOfRange: 0, enqueued: 0, alreadySeen: 0, tooOld: 0 };
    for (const r of reports) {
      for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += r[k];
    }
    return { files: reports, total };
  }
}

/** Parses "2026-01-01" or a full ISO timestamp (UTC if no zone) into Unix seconds. */
export function parseDateArg(value: string, name: string): number {
  const v = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) throw new ConfigError(`${name}: invalid date "${value}"`);
  return ms / 1000;
}
