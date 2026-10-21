import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { createLineProcessor } from "../src/app.ts";
import { Follower } from "../src/follower.ts";
import { Importer, parseDateArg, type ImportOptions } from "../src/importer.ts";
import { setLogSink } from "../src/log.ts";
import { Metrics } from "../src/metrics.ts";
import { Store } from "../src/store.ts";
import { caddyLine, GPTBOT_UA, tempDir, testConfig } from "../test-support/helpers.ts";

const tmp = tempDir();
after(tmp.cleanup);
setLogSink(() => undefined);
let n = 0;
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

function setup(maxQueue = 1000, seenRetentionMs = 0) {
  const dir = join(tmp.dir, `i${n++}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  const cfg = testConfig({ dir });
  const store = new Store(cfg.storage.databasePath, { maxQueueEvents: maxQueue, seenRetentionMs });
  stores.push(store);
  const importer = (o: Partial<ImportOptions> = {}) =>
    new Importer({
      store,
      lineProcessor: (m) => createLineProcessor(cfg, m),
      maxLineBytes: 4096,
      batchSize: 2,
      dryRun: false,
      since: null,
      until: null,
      queueFullWaitMs: 10,
      ...o,
    });
  const urls = () =>
    (store.db.prepare("SELECT url FROM events ORDER BY id").pluck().all() as string[]).map((u) =>
      u.replace("https://example.com", ""),
    );
  return { dir, cfg, store, importer, urls, logs: join(dir, "logs") };
}

const line = (uri: string, ts = 1_760_000_000.5) => caddyLine({ uri, ts }) + "\n";

describe("importer", () => {
  it("imports gzip and plain files with the same filters as the follower", async () => {
    const t = setup();
    const gz = join(t.logs, "example.com-2026-01-01.log.gz");
    writeFileSync(gz, gzipSync(line("/g1") + "{broken\n" + caddyLine({ uri: "/bot", ua: GPTBOT_UA }) + "\n" + line("/g2")));
    const plain = join(t.logs, "example.com-2026-01-02.log");
    writeFileSync(plain, line("/p1") + "\r\n" + line("/_next/x.js") + caddyLine({ uri: "/p2" })); // no trailing newline
    const r = await t.importer().importFiles([gz, plain]);
    assert.deepEqual(t.urls(), ["/g1", "/g2", "/p1", "/p2"]);
    assert.deepEqual(r.total, { lines: 7, malformed: 1, oversized: 0, qualifying: 4, outOfRange: 0, enqueued: 4, alreadySeen: 0, tooOld: 0 });
    assert.equal(r.files[0]!.enqueued, 2);
  });

  it("is idempotent: a second run enqueues nothing", async () => {
    const t = setup();
    const gz = join(t.logs, "a.log.gz");
    writeFileSync(gz, gzipSync(line("/a") + line("/b") + line("/c")));
    await t.importer().importFiles([gz]);
    const again = await t.importer().importFiles([gz, gz]);
    assert.equal(again.total.enqueued, 0);
    assert.equal(again.total.alreadySeen, 6);
    assert.deepEqual(t.urls(), ["/a", "/b", "/c"]);
  });

  it("re-running after an interrupted import only enqueues the rest", async () => {
    const t = setup();
    const full = join(t.logs, "full.log");
    writeFileSync(full, line("/1") + line("/2") + line("/3") + line("/4"));
    const partial = join(t.logs, "partial.log");
    writeFileSync(partial, line("/1") + line("/2"));
    await t.importer().importFiles([partial]); // simulates a run that stopped halfway
    const r = await t.importer().importFiles([full]);
    assert.equal(r.total.enqueued, 2);
    assert.equal(r.total.alreadySeen, 2);
    assert.deepEqual(t.urls(), ["/1", "/2", "/3", "/4"]);
  });

  it("does not duplicate events the live follower already queued, and vice versa", async () => {
    const t = setup();
    const live = t.cfg.log.path;
    writeFileSync(live, line("/live1") + line("/live2"));
    const metrics = new Metrics();
    const follower = new Follower({
      path: live,
      store: t.store,
      processLine: createLineProcessor(t.cfg, metrics),
      metrics,
      maxLineBytes: 4096,
      batchLines: 100,
      pollIntervalMs: 10,
      rotationGraceMs: 0,
      startPosition: "beginning",
    });
    while (follower.pollOnce()) {
      /* drain */
    }
    // Import covering the live file plus older data.
    const old = join(t.logs, "old.log.gz");
    writeFileSync(old, gzipSync(line("/old1")));
    const r = await t.importer().importFiles([old, live]);
    assert.equal(r.total.enqueued, 1);
    assert.equal(r.total.alreadySeen, 2);
    // Lines imported before the follower reaches them are skipped by the follower.
    writeFileSync(join(t.logs, "next.log"), line("/live3"));
    await t.importer().importFiles([join(t.logs, "next.log")]);
    writeFileSync(live, line("/live1") + line("/live2") + line("/live3"));
    while (follower.pollOnce()) {
      /* drain */
    }
    assert.deepEqual(t.urls(), ["/live1", "/live2", "/old1", "/live3"]);
    assert.equal(metrics.get("events_duplicate_skipped"), 1);
  });

  it("dry run counts without writing anything", async () => {
    const t = setup();
    const f = join(t.logs, "a.log");
    writeFileSync(f, line("/a") + line("/b") + line("/a"));
    await t.importer().importFiles([join(t.logs, "a.log")]);
    writeFileSync(f, line("/a") + line("/c") + line("/c"));
    const r = await t.importer({ dryRun: true }).importFiles([f]);
    assert.equal(r.total.enqueued, 1, "/c once");
    assert.equal(r.total.alreadySeen, 2, "/a (stored) and the second /c");
    assert.deepEqual(t.urls(), ["/a", "/b"]);
    assert.equal(t.store.seenCount(), 2);
  });

  it("restricts to --since/--until (until exclusive)", async () => {
    const t = setup();
    const f = join(t.logs, "a.log");
    const day = (d: string) => Date.parse(`${d}T12:00:00Z`) / 1000;
    writeFileSync(f, line("/jan", day("2026-01-15")) + line("/feb", day("2026-02-15")) + line("/mar", day("2026-03-01")));
    const r = await t.importer({ since: parseDateArg("2026-02-01", "since"), until: parseDateArg("2026-03-01T12:00:00Z", "until") }).importFiles([f]);
    assert.deepEqual(t.urls(), ["/feb"]);
    assert.equal(r.total.outOfRange, 2);
    assert.throws(() => parseDateArg("yesterday", "--since"), /invalid date/);
  });

  it("skips events beyond seen retention, in dry run and for real", async () => {
    const day = 86_400_000;
    const t = setup(1000, 30 * day);
    const ts = (daysAgo: number) => (Date.now() - daysAgo * day) / 1000;
    const f = join(t.logs, "a.log");
    writeFileSync(f, line("/old", ts(31)) + line("/new", ts(29)));
    const dry = await t.importer({ dryRun: true }).importFiles([f]);
    assert.deepEqual([dry.total.enqueued, dry.total.tooOld], [1, 1]);
    const r = await t.importer().importFiles([f]);
    assert.deepEqual([r.total.enqueued, r.total.tooOld], [1, 1]);
    assert.deepEqual(t.urls(), ["/new"]);
  });

  it("skips oversized lines with bounded memory", async () => {
    const t = setup();
    const f = join(t.logs, "a.log.gz");
    writeFileSync(f, gzipSync(line("/a") + JSON.stringify({ pad: "x".repeat(10_000) }) + "\n" + line("/b")));
    const r = await t.importer().importFiles([f]);
    assert.equal(r.total.oversized, 1);
    assert.deepEqual(t.urls(), ["/a", "/b"]);
  });

  it("waits while the queue is full and continues once there is room", async () => {
    const t = setup(2);
    const f = join(t.logs, "a.log");
    writeFileSync(f, line("/1") + line("/2") + line("/3") + line("/4"));
    let waits = 0;
    const done = t
      .importer({
        onProgress: () => {
          waits++;
          for (let ev = t.store.claim(1000); ev; ev = t.store.claim(1000)) t.store.ack(ev.id, ev.leaseToken);
        },
      })
      .importFiles([f]);
    const r = await done;
    assert.ok(waits >= 1);
    assert.equal(r.total.enqueued, 4);
    assert.deepEqual(t.urls(), ["/1", "/2", "/3", "/4"]);
  });
});
