import assert from "node:assert/strict";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { QueueFullError, Store, type FileCheckpoint } from "../src/store.ts";
import { sampleEvent, tempDir } from "../test-support/helpers.ts";

const tmp = tempDir();
after(tmp.cleanup);
let n = 0;
let dbPath = "";
let clock = 1_000_000;
const now = () => clock;

const cp = (offset: number): FileCheckpoint => ({ dev: "1", ino: "2", offset, fpLen: 0, fpHash: "" });

function open(max = 100): Store {
  return new Store(dbPath, { maxQueueEvents: max, now });
}

describe("store", () => {
  beforeEach(() => {
    dbPath = join(tmp.dir, `q${n++}`, "queue.sqlite3");
    clock = 1_000_000;
  });

  it("commits events and checkpoint together and persists across reopen", () => {
    const s = open();
    s.commitBatch([sampleEvent(), sampleEvent({ url: "https://example.com/b", isDownload: true })], cp(123));
    s.close();
    const s2 = open();
    assert.equal(s2.getCheckpoint()?.offset, 123);
    assert.equal(s2.stats().pending, 2);
    const ev = s2.claim(1000);
    assert.ok(ev);
    assert.equal(ev.url, "https://example.com/de/arbeit");
    assert.equal(ev.pfSrvMs, 12);
    s2.close();
  });

  it("never enqueues the same fingerprint twice, even after retention cleanup", () => {
    const s = open();
    const a = sampleEvent();
    const b = sampleEvent();
    assert.deepEqual(s.commitBatch([a, b, a], cp(1)), { enqueued: 2, duplicates: 1, tooOld: 0 });
    assert.deepEqual(s.commitBatch([b], null), { enqueued: 0, duplicates: 1, tooOld: 0 });
    assert.equal(s.getCheckpoint()?.offset, 1, "null checkpoint leaves it untouched");
    for (let ev = s.claim(1000); ev; ev = s.claim(1000)) s.ack(ev.id, ev.leaseToken);
    clock += 10_000;
    assert.deepEqual(s.cleanup(0, 0), { delivered: 2, dead: 0, seen: 0 });
    assert.equal(s.seenCount(), 2);
    assert.ok(s.isSeen(a.fingerprint));
    assert.equal(s.isSeen(sampleEvent().fingerprint), false);
    assert.deepEqual(s.commitBatch([a, b], null), { enqueued: 0, duplicates: 2, tooOld: 0 });
    s.close();
    const reopened = open();
    assert.deepEqual(reopened.commitBatch([a], null), { enqueued: 0, duplicates: 1, tooOld: 0 }, "persisted");
    reopened.close();
  });

  it("with seen retention, prunes old fingerprints and refuses events beyond the horizon", () => {
    const day = 86_400_000;
    clock = 100 * day;
    const s = new Store(dbPath, { maxQueueEvents: 100, seenRetentionMs: 10 * day, now });
    const ts = (daysAgo: number) => (clock - daysAgo * day) / 1000;
    const old = sampleEvent({ eventTs: ts(9) });
    const recent = sampleEvent({ eventTs: ts(1) });
    assert.deepEqual(s.commitBatch([old, recent, sampleEvent({ eventTs: ts(11) })], cp(1)), { enqueued: 2, duplicates: 0, tooOld: 1 });
    assert.equal(s.isTooOld(ts(11)), true);
    assert.equal(s.isTooOld(ts(9)), false);

    clock += 2 * day; // `old` is now 11 days old
    assert.equal(s.cleanup(day, day).seen, 1);
    assert.equal(s.isSeen(old.fingerprint), false);
    assert.ok(s.isSeen(recent.fingerprint));
    assert.deepEqual(s.commitBatch([old, recent], null), { enqueued: 0, duplicates: 1, tooOld: 1 }, "never re-queued");
    s.close();
  });

  it("prunes many fingerprints in batches", () => {
    const s = new Store(dbPath, { maxQueueEvents: 30_000, seenRetentionMs: 1000, now });
    const evs = Array.from({ length: 25_000 }, () => sampleEvent({ eventTs: clock / 1000 }));
    s.commitBatch(evs, null);
    clock += 2000;
    assert.equal(s.cleanup(1e12, 1e12).seen, 25_000);
    assert.equal(s.seenCount(), 0);
    s.close();
  });

  it("rolls back fingerprints together with a failed batch", () => {
    const s = open(1);
    const a = sampleEvent();
    assert.throws(() => s.commitBatch([sampleEvent(), a], cp(1)), QueueFullError);
    assert.equal(s.isSeen(a.fingerprint), false);
    assert.equal(s.seenCount(), 0);
    s.close();
  });

  it("rolls back events when the checkpoint write fails (no partial commit)", () => {
    const s = open();
    s.commitBatch([], cp(10));
    s.db.exec("CREATE TRIGGER fail_cp BEFORE UPDATE ON checkpoint BEGIN SELECT RAISE(ABORT, 'boom'); END");
    assert.throws(() => s.commitBatch([sampleEvent(), sampleEvent()], cp(500)), /boom/);
    assert.equal(s.stats().pending, 0, "events must not be committed without checkpoint");
    assert.equal(s.getCheckpoint()?.offset, 10, "checkpoint must not advance");
    s.close();
  });

  it("does not advance the checkpoint when an event insert fails", () => {
    const s = open();
    s.commitBatch([], cp(10));
    s.db.exec("CREATE TRIGGER fail_ev BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    assert.throws(() => s.commitBatch([sampleEvent()], cp(500)), /disk full/);
    assert.equal(s.getCheckpoint()?.offset, 10);
    s.close();
  });

  it("rejects a batch that would exceed the queue bound, without advancing", () => {
    const s = open(3);
    s.commitBatch([sampleEvent(), sampleEvent()], cp(1));
    assert.throws(() => s.commitBatch([sampleEvent(), sampleEvent()], cp(2)), QueueFullError);
    assert.equal(s.getCheckpoint()?.offset, 1);
    assert.equal(s.stats().pending, 2);
    s.commitBatch([], cp(2)); // non-qualifying lines can still advance
    assert.equal(s.getCheckpoint()?.offset, 2);
    const ev = s.claim(1000)!;
    s.ack(ev.id, ev.leaseToken);
    s.commitBatch([sampleEvent(), sampleEvent()], cp(3)); // delivered events free capacity
    s.close();
  });

  it("claims atomically across concurrent connections (no double processing)", async () => {
    const a = open(1000);
    a.commitBatch(Array.from({ length: 200 }, (_, i) => sampleEvent({ bwBytes: i })), cp(1));
    const b = open(1000);
    const seen: number[] = [];
    const worker = async (s: Store) => {
      for (;;) {
        const ev = s.claim(60_000);
        if (!ev) return;
        seen.push(ev.id);
        await new Promise((r) => setImmediate(r));
        assert.ok(s.ack(ev.id, ev.leaseToken));
      }
    };
    await Promise.all([worker(a), worker(b), worker(a), worker(b)]);
    assert.equal(seen.length, 200);
    assert.equal(new Set(seen).size, 200);
    assert.equal(a.stats().delivered, 200);
    a.close();
    b.close();
  });

  it("re-claims an event after its lease expires and fences the stale holder", () => {
    const s = open();
    s.commitBatch([sampleEvent()], cp(1));
    const first = s.claim(1000)!;
    assert.equal(first.attempts, 1);
    assert.equal(s.claim(1000), null, "leased event is not claimable");
    clock += 1001;
    const second = s.claim(1000)!;
    assert.equal(second.id, first.id);
    assert.equal(second.attempts, 2);
    assert.equal(s.ack(first.id, first.leaseToken), false, "stale lease cannot ack");
    assert.equal(s.ack(second.id, second.leaseToken), true);
    s.close();
  });

  it("remembers an unsettled send across lease expiry and clears it when settled", () => {
    const s = open();
    s.commitBatch([sampleEvent()], cp(1));
    const a = s.claim(1000)!;
    assert.equal(a.unsettledSend, false);
    assert.ok(s.markSending(a.id, a.leaseToken));
    clock += 1001;
    const b = s.claim(1000)!;
    assert.equal(b.unsettledSend, true, "previous holder died mid-send");
    assert.equal(s.markSending(a.id, a.leaseToken), false, "stale holder cannot mark");
    assert.ok(s.retry(b.id, b.leaseToken, clock, "timeout"));
    assert.equal(s.claim(1000)!.unsettledSend, false, "settling clears the marker");
    s.close();
  });

  it("schedules retries, dead-letters, releases and replays", () => {
    const s = open();
    s.commitBatch([sampleEvent(), sampleEvent()], cp(1));
    const a = s.claim(1000)!;
    assert.ok(s.retry(a.id, a.leaseToken, clock + 5000, "http_503"));
    const b = s.claim(1000)!;
    assert.notEqual(b.id, a.id);
    assert.ok(s.deadLetter(b.id, b.leaseToken, "http_400"));
    assert.equal(s.claim(1000), null, "retry not due yet");
    clock += 5000;
    const a2 = s.claim(1000)!;
    assert.equal(a2.id, a.id);
    assert.equal(a2.attempts, 2);
    assert.ok(s.release(a2.id, a2.leaseToken));
    assert.equal(s.claim(1000)!.attempts, 2, "release does not consume an attempt");

    assert.deepEqual(
      s.deadLetterStats().map((r) => [r.reason, r.count]),
      [["http_400", 1]],
    );
    assert.equal(s.replayDeadLetters("http_500", 10), 0);
    assert.equal(s.replayDeadLetters("http_400", 10), 1);
    assert.equal(s.stats().dead, 0);
    const replayed = s.claim(1000)!;
    assert.equal(replayed.id, b.id);
    assert.equal(replayed.attempts, 1);
    s.close();
  });

  it("deletes delivered and dead events after their retention period only", () => {
    const s = open();
    s.commitBatch([sampleEvent(), sampleEvent(), sampleEvent()], cp(1));
    const a = s.claim(1000)!;
    s.ack(a.id, a.leaseToken);
    const b = s.claim(1000)!;
    s.deadLetter(b.id, b.leaseToken, "http_400");
    clock += 10_000;
    assert.deepEqual(s.cleanup(20_000, 20_000), { delivered: 0, dead: 0, seen: 0 });
    assert.deepEqual(s.cleanup(5_000, 20_000), { delivered: 1, dead: 0, seen: 0 });
    assert.deepEqual(s.cleanup(5_000, 5_000), { delivered: 0, dead: 1, seen: 0 });
    assert.equal(s.seenCount(), 3, "fingerprints are kept forever by default");
    assert.equal(s.stats().pending, 1, "pending events are never removed by retention");
    s.close();
  });

  it("stores no raw log data, only the minimal event columns", () => {
    const s = open();
    const cols = (s.db.prepare("PRAGMA table_info(events)").all() as { name: string }[]).map((c) => c.name);
    for (const forbidden of ["ip", "remote_ip", "cookie", "referer", "referrer", "headers", "raw", "line"]) {
      assert.ok(!cols.includes(forbidden), forbidden);
    }
    s.close();
  });
});
