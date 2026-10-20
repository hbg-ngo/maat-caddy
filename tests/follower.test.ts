import assert from "node:assert/strict";
import { appendFileSync, closeSync, mkdirSync, openSync, renameSync, rmSync, truncateSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { createLineProcessor } from "../src/app.ts";
import { Follower, listRotatedFiles } from "../src/follower.ts";
import { setLogSink } from "../src/log.ts";
import { Metrics } from "../src/metrics.ts";
import { Store } from "../src/store.ts";
import { caddyLine, tempDir, testConfig } from "../test-support/helpers.ts";

const tmp = tempDir();
after(tmp.cleanup);
setLogSink(() => undefined);
let counter = 0;
const open: Store[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

interface Env {
  dir: string;
  logPath: string;
  dbPath: string;
  metrics: Metrics;
  store: Store;
  clock: { t: number };
  follower: (o?: Partial<{ startPosition: "beginning" | "end"; maxLineBytes: number; batchLines: number; maxQueue: number }>) => Follower;
  reopenStore: (maxQueue?: number) => Store;
  urls: () => string[];
}

function env(): Env {
  const dir = join(tmp.dir, `f${counter++}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  const cfg = testConfig({ dir });
  const metrics = new Metrics();
  const clock = { t: 1_000_000 };
  const e: Env = {
    dir,
    logPath: cfg.log.path,
    dbPath: cfg.storage.databasePath,
    metrics,
    clock,
    store: new Store(cfg.storage.databasePath, { maxQueueEvents: 1000 }),
    reopenStore(maxQueue = 1000) {
      e.store.close();
      e.store = new Store(e.dbPath, { maxQueueEvents: maxQueue });
      open.push(e.store);
      return e.store;
    },
    follower(o = {}) {
      if (o.maxQueue !== undefined) e.reopenStore(o.maxQueue);
      return new Follower({
        path: cfg.log.path,
        store: e.store,
        processLine: createLineProcessor(cfg, metrics),
        metrics,
        maxLineBytes: o.maxLineBytes ?? 64 * 1024,
        batchLines: o.batchLines ?? 1000,
        pollIntervalMs: 10,
        rotationGraceMs: 100,
        startPosition: o.startPosition ?? "beginning",
        now: () => clock.t,
      });
    },
    urls() {
      return (e.store.db.prepare("SELECT url FROM events ORDER BY id").pluck().all() as string[]).map((u) =>
        u.replace("https://example.com", ""),
      );
    },
  };
  open.push(e.store);
  return e;
}

const line = (path: string) => caddyLine({ uri: path }) + "\n";

/** Poll until no progress, advancing the fake clock so rotation grace periods elapse. */
function settle(f: Follower, e: Env, rounds = 20): void {
  for (let i = 0; i < rounds; i++) {
    while (f.pollOnce()) {
      /* keep going */
    }
    e.clock.t += 60;
  }
}

describe("follower", () => {
  it("processes complete lines and never consumes a partial line", () => {
    const e = env();
    const full = line("/a");
    const second = line("/b");
    writeFileSync(e.logPath, full + second.slice(0, 40));
    const f = e.follower();
    settle(f, e);
    assert.deepEqual(e.urls(), ["/a"]);
    assert.equal(e.store.getCheckpoint()?.offset, Buffer.byteLength(full), "checkpoint stops at the line boundary");
    appendFileSync(e.logPath, second.slice(40));
    settle(f, e);
    assert.deepEqual(e.urls(), ["/a", "/b"]);
    assert.equal(e.store.getCheckpoint()?.offset, Buffer.byteLength(full + second));
  });

  it("skips non-qualifying and malformed lines while advancing, and handles CRLF/blank lines", () => {
    const e = env();
    writeFileSync(
      e.logPath,
      "{garbage\n\n" + caddyLine({ uri: "/a" }) + "\r\n" + caddyLine({ ua: "curl/8" }) + "\n" + caddyLine({ uri: "/_next/x.js" }) + "\n",
    );
    const f = e.follower();
    settle(f, e);
    assert.deepEqual(e.urls(), ["/a"]);
    assert.equal(e.metrics.get("lines_malformed"), 1);
    assert.equal(e.metrics.get("skipped_not_assistant"), 1);
    assert.equal(e.metrics.get("skipped_excluded_prefix"), 1);
  });

  it("commits in batches of batch_lines", () => {
    const e = env();
    writeFileSync(e.logPath, ["/1", "/2", "/3", "/4", "/5"].map(line).join(""));
    const f = e.follower({ batchLines: 2 });
    assert.equal(f.pollOnce(), true);
    assert.deepEqual(e.urls(), ["/1", "/2"]);
    settle(f, e);
    assert.deepEqual(e.urls(), ["/1", "/2", "/3", "/4", "/5"]);
  });

  it("start_position=end skips existing content on first run", () => {
    const e = env();
    const existing = line("/old") + line("/old2");
    writeFileSync(e.logPath, existing + line("/x").slice(0, 30));
    const f = e.follower({ startPosition: "end" });
    settle(f, e);
    assert.deepEqual(e.urls(), []);
    assert.equal(e.store.getCheckpoint()?.offset, Buffer.byteLength(existing));
    appendFileSync(e.logPath, line("/x").slice(30) + line("/new"));
    settle(f, e);
    assert.deepEqual(e.urls(), ["/x", "/new"]);
  });

  it("resumes from the checkpoint after restart without duplicates", () => {
    const e = env();
    writeFileSync(e.logPath, line("/a") + line("/b"));
    settle(e.follower(), e);
    appendFileSync(e.logPath, line("/c"));
    e.reopenStore();
    settle(e.follower(), e);
    assert.deepEqual(e.urls(), ["/a", "/b", "/c"]);
  });

  it("never advances past a qualifying line when the commit fails, and recovers", () => {
    const e = env();
    writeFileSync(e.logPath, line("/a"));
    const f = e.follower();
    settle(f, e);
    e.store.db.exec("CREATE TRIGGER fail BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'io error'); END");
    appendFileSync(e.logPath, line("/b") + line("/c"));
    settle(f, e);
    const stuck = e.store.getCheckpoint()?.offset;
    assert.equal(stuck, Buffer.byteLength(line("/a")));
    assert.ok(e.metrics.get("commit_failures") > 0);

    // Simulated crash: discard the follower, restart from the durable state.
    e.store.db.exec("DROP TRIGGER fail");
    e.reopenStore();
    settle(e.follower(), e);
    assert.deepEqual(e.urls(), ["/a", "/b", "/c"]);
  });

  it("pauses on a full queue and resumes when capacity frees up", () => {
    const e = env();
    writeFileSync(e.logPath, ["/1", "/2", "/3"].map(line).join(""));
    const f = e.follower({ maxQueue: 2, batchLines: 1 });
    settle(f, e);
    assert.deepEqual(e.urls(), ["/1", "/2"]);
    assert.ok(e.metrics.get("queue_full_pauses") > 0);
    const ev = e.store.claim(1000)!;
    e.store.ack(ev.id, ev.leaseToken);
    settle(f, e);
    assert.deepEqual(e.urls(), ["/1", "/2", "/3"]);
  });

  it("does not re-enqueue lines it already processed after a checkpoint reset", () => {
    const e = env();
    writeFileSync(e.logPath, line("/a") + line("/b"));
    settle(e.follower(), e);
    e.store.db.exec("DELETE FROM checkpoint");
    appendFileSync(e.logPath, line("/c"));
    e.reopenStore();
    settle(e.follower(), e);
    assert.deepEqual(e.urls(), ["/a", "/b", "/c"]);
    assert.equal(e.metrics.get("events_duplicate_skipped"), 2);
  });

  it("skips oversized lines without checkpointing mid-line", () => {
    const e = env();
    const huge = JSON.stringify({ pad: "x".repeat(5000) }) + "\n";
    writeFileSync(e.logPath, line("/a") + huge + line("/b"));
    const f = e.follower({ maxLineBytes: 2048 });
    settle(f, e);
    assert.deepEqual(e.urls(), ["/a", "/b"]);
    assert.equal(e.metrics.get("lines_oversized"), 1);
  });

  it("detects copy-truncate and restarts at offset 0", () => {
    const e = env();
    writeFileSync(e.logPath, line("/a") + line("/b"));
    const f = e.follower();
    settle(f, e);
    truncateSync(e.logPath, 0);
    appendFileSync(e.logPath, line("/c"));
    settle(f, e);
    assert.deepEqual(e.urls(), ["/a", "/b", "/c"]);
    assert.equal(e.metrics.get("truncations"), 1);
  });

  it("detects in-place replacement that already grew past the old offset (fingerprint)", () => {
    const e = env();
    writeFileSync(e.logPath, line("/a"));
    const f = e.follower();
    settle(f, e);
    const fd = openSync(e.logPath, "r+");
    writeSync(fd, line("/zz-replaced") + line("/zz2"), 0);
    closeSync(fd);
    settle(f, e);
    assert.deepEqual(e.urls(), ["/a", "/zz-replaced", "/zz2"]);
  });

  it("handles rename/create rotation while running and drains the old descriptor first", () => {
    const e = env();
    writeFileSync(e.logPath, line("/old1"));
    const f = e.follower();
    settle(f, e);

    const writer = openSync(e.logPath, "a");
    writeSync(writer, line("/old2") + line("/old3").slice(0, 50));
    const rotated = join(e.dir, "logs", "example.com-2026-10-19T10-00-00.000.log");
    renameSync(e.logPath, rotated);
    writeFileSync(e.logPath, line("/new1"));
    // The old writer finishes its buffered line after the rename.
    writeSync(writer, line("/old3").slice(50));
    closeSync(writer);
    appendFileSync(e.logPath, line("/new2"));

    settle(f, e);
    assert.deepEqual(e.urls(), ["/old1", "/old2", "/old3", "/new1", "/new2"]);
    assert.equal(e.metrics.get("rotations"), 1);
    // Checkpoint now refers to the new file.
    appendFileSync(e.logPath, line("/new3"));
    settle(f, e);
    assert.deepEqual(e.urls().slice(-1), ["/new3"]);
  });

  it("processes an unterminated final line of a rotated file after the grace period", () => {
    const e = env();
    writeFileSync(e.logPath, line("/a") + caddyLine({ uri: "/tail" }));
    const f = e.follower();
    settle(f, e);
    assert.deepEqual(e.urls(), ["/a"]);
    renameSync(e.logPath, join(e.dir, "logs", "example.com-1.log"));
    writeFileSync(e.logPath, line("/b"));
    settle(f, e);
    assert.deepEqual(e.urls(), ["/a", "/tail", "/b"]);
  });

  it("waits while the log path is missing after rename, then follows the new file", () => {
    const e = env();
    writeFileSync(e.logPath, line("/a"));
    const f = e.follower();
    settle(f, e);
    renameSync(e.logPath, join(e.dir, "logs", "example.com-1.log"));
    settle(f, e);
    writeFileSync(e.logPath, line("/b"));
    settle(f, e);
    assert.deepEqual(e.urls(), ["/a", "/b"]);
  });

  it("recovers rotations that happened during downtime, in order", () => {
    const e = env();
    writeFileSync(e.logPath, line("/a1"));
    settle(e.follower(), e);
    // --- tracker down ---
    appendFileSync(e.logPath, line("/a2"));
    const logs = join(e.dir, "logs");
    const r1 = join(logs, "example.com-2026-10-19T10-00-00.000.log");
    const r2 = join(logs, "example.com-2026-10-19T11-00-00.000.log");
    renameSync(e.logPath, r1);
    writeFileSync(e.logPath, line("/b1"));
    renameSync(e.logPath, r2);
    writeFileSync(e.logPath, line("/c1"));
    const t = Date.now() / 1000;
    utimesSync(r1, t, t + 1);
    utimesSync(r2, t, t + 2);
    utimesSync(e.logPath, t, t + 3);
    writeFileSync(join(logs, "example.com-2026-10-19T09-00-00.000.log.gz"), "compressed");
    writeFileSync(join(logs, "other-site.log"), line("/other"));
    // --- restart ---
    e.reopenStore();
    settle(e.follower(), e);
    assert.deepEqual(e.urls(), ["/a1", "/a2", "/b1", "/c1"]);
    assert.equal(e.metrics.get("rotation_gaps"), 0);
  });

  it("counts a gap when the checkpointed file is gone, and reads newer rotated files", () => {
    const e = env();
    writeFileSync(e.logPath, line("/a1"));
    settle(e.follower(), e);
    const logs = join(e.dir, "logs");
    rmSync(e.logPath); // e.g. rotated and compressed while down
    const r2 = join(logs, "example.com.log.1");
    writeFileSync(r2, line("/b1"));
    writeFileSync(e.logPath, line("/c1"));
    const t = Date.now() / 1000 + 10;
    utimesSync(r2, t, t);
    utimesSync(e.logPath, t, t + 1);
    e.reopenStore();
    settle(e.follower(), e);
    assert.deepEqual(e.urls(), ["/a1", "/b1", "/c1"]);
    assert.equal(e.metrics.get("rotation_gaps"), 1);
  });

  it("restarts at 0 when the inode at the path was reused by a different file", () => {
    const e = env();
    writeFileSync(e.logPath, line("/a1") + line("/a2"));
    settle(e.follower(), e);
    // Same inode, different content (simulates truncate + rewrite while down).
    writeFileSync(e.logPath, line("/zzzzzzzzzz1") + line("/b2") + line("/b3"));
    e.reopenStore();
    settle(e.follower(), e);
    assert.deepEqual(e.urls(), ["/a1", "/a2", "/zzzzzzzzzz1", "/b2", "/b3"]);
  });

  it("lists only uncompressed rotated siblings", () => {
    const e = env();
    const logs = join(e.dir, "logs");
    for (const n of [
      "example.com.log",
      "example.com-2026.log",
      "example.com-2026.log.gz",
      "example.com.log.1",
      "example.com.log.2.gz",
      "example.comments.log",
      "other.log",
    ]) {
      writeFileSync(join(logs, n), "");
    }
    assert.deepEqual(
      listRotatedFiles(e.logPath).map((c) => c.path.slice(logs.length + 1)).sort(),
      ["example.com-2026.log", "example.com.log.1"],
    );
  });
});
