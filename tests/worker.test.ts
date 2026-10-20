import assert from "node:assert/strict";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import type { TrackEvent } from "../src/filter.ts";
import { setLogSink } from "../src/log.ts";
import type { SendResult } from "../src/matomo.ts";
import { Metrics } from "../src/metrics.ts";
import { Store } from "../src/store.ts";
import { backoffMs, WorkerPool, type Sender } from "../src/worker.ts";
import { sampleEvent, tempDir, waitFor } from "../test-support/helpers.ts";

const tmp = tempDir();
after(tmp.cleanup);
setLogSink(() => undefined);
let n = 0;
let store: Store;
let clock = 1_000_000;
const now = () => clock;
const cp = { dev: "1", ino: "1", offset: 1, fpLen: 0, fpHash: "" };

class ScriptedSender implements Sender {
  results: (SendResult | (() => Promise<SendResult>))[] = [];
  sent: TrackEvent[] = [];
  async send(ev: TrackEvent): Promise<SendResult> {
    this.sent.push(ev);
    const next = this.results.shift() ?? { ok: true, status: 204 };
    return typeof next === "function" ? next() : next;
  }
}

function pool(sender: Sender, metrics = new Metrics(), over: Partial<ConstructorParameters<typeof WorkerPool>[0]> = {}) {
  return new WorkerPool({
    store,
    sender,
    metrics,
    workers: 1,
    maxAttempts: 3,
    initialBackoffMs: 1000,
    maxBackoffMs: 8000,
    leaseMs: 30_000,
    idlePollMs: 10,
    now,
    random: () => 1,
    ...over,
  });
}

describe("backoff", () => {
  it("grows exponentially, is capped, and jitters within [cap/2, cap]", () => {
    assert.equal(backoffMs(1, 1000, 8000, () => 1), 1000);
    assert.equal(backoffMs(2, 1000, 8000, () => 1), 2000);
    assert.equal(backoffMs(3, 1000, 8000, () => 1), 4000);
    assert.equal(backoffMs(10, 1000, 8000, () => 1), 8000);
    assert.equal(backoffMs(1000, 1000, 8000, () => 1), 8000);
    assert.equal(backoffMs(3, 1000, 8000, () => 0), 2000);
    for (let i = 0; i < 100; i++) {
      const d = backoffMs(4, 1000, 900_000);
      assert.ok(d >= 4000 && d <= 8000, String(d));
    }
  });
});

describe("worker pool", () => {
  beforeEach(() => {
    clock = 1_000_000;
    store = new Store(join(tmp.dir, `w${n++}.sqlite3`), { maxQueueEvents: 1000, now });
  });
  afterEach(() => store.close());

  it("acks successful deliveries", async () => {
    store.commitBatch([sampleEvent()], cp);
    const metrics = new Metrics();
    const p = pool(new ScriptedSender(), metrics);
    assert.equal(await p.runOnce(), true);
    assert.equal(await p.runOnce(), false);
    assert.equal(store.stats().delivered, 1);
    assert.equal(metrics.get("deliveries_ok"), 1);
    assert.equal(metrics.get("last_delivery_at"), clock);
  });

  it("calls onDelivered only for accepted events", async () => {
    store.commitBatch([sampleEvent({ url: "https://example.com/ok" }), sampleEvent({ url: "https://example.com/bad" })], cp);
    const sender = new ScriptedSender();
    sender.results = [{ ok: true, status: 204 }, { ok: false, retryable: false, ambiguous: false, reason: "http_400" }];
    const delivered: string[] = [];
    const p = pool(sender, new Metrics(), { onDelivered: (ev) => delivered.push(ev.url) });
    await p.runOnce();
    await p.runOnce();
    assert.deepEqual(delivered, ["https://example.com/ok"]);
  });

  it("retries transient failures with backoff, then succeeds", async () => {
    store.commitBatch([sampleEvent()], cp);
    const s = new ScriptedSender();
    s.results = [{ ok: false, retryable: true, ambiguous: false, reason: "http_503" }];
    const p = pool(s);
    await p.runOnce();
    assert.equal(store.stats().pending, 1);
    assert.equal(await p.runOnce(), false, "not due before backoff elapses");
    clock += 999;
    assert.equal(await p.runOnce(), false);
    clock += 1;
    assert.equal(await p.runOnce(), true);
    assert.equal(store.stats().delivered, 1);
    assert.equal(s.sent.length, 2);
  });

  it("dead-letters permanent failures immediately", async () => {
    store.commitBatch([sampleEvent()], cp);
    const s = new ScriptedSender();
    s.results = [{ ok: false, retryable: false, ambiguous: false, reason: "http_400" }];
    await pool(s).runOnce();
    assert.equal(store.stats().dead, 1);
    assert.deepEqual(store.deadLetterStats().map((r) => r.reason), ["http_400"]);
  });

  it("dead-letters after max_attempts retryable failures", async () => {
    store.commitBatch([sampleEvent()], cp);
    const s = new ScriptedSender();
    s.results = Array.from({ length: 5 }, () => ({ ok: false as const, retryable: true, ambiguous: true, reason: "timeout" }));
    const p = pool(s);
    for (let i = 0; i < 3; i++) {
      assert.equal(await p.runOnce(), true);
      clock += 10_000;
    }
    assert.equal(s.sent.length, 3);
    assert.equal(store.stats().dead, 1);
    assert.deepEqual(store.deadLetterStats().map((r) => r.reason), ["exhausted_timeout"]);
  });

  it("dead-letters events whose leases kept expiring", async () => {
    store.commitBatch([sampleEvent()], cp);
    for (let i = 0; i < 3; i++) {
      assert.ok(store.claim(1000));
      clock += 1001;
    }
    const s = new ScriptedSender();
    await pool(s).runOnce();
    assert.equal(s.sent.length, 0);
    assert.deepEqual(store.deadLetterStats().map((r) => r.reason), ["lease_expired_exhausted"]);
  });

  it("runs bounded concurrent workers without double delivery", async () => {
    store.commitBatch(Array.from({ length: 50 }, (_, i) => sampleEvent({ bwBytes: i })), cp);
    let concurrent = 0;
    let maxConcurrent = 0;
    const sent: number[] = [];
    const sender: Sender = {
      async send(ev) {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 2));
        sent.push(ev.bwBytes);
        concurrent--;
        return { ok: true, status: 204 };
      },
    };
    const p = pool(sender, new Metrics(), { workers: 4 });
    p.start();
    await waitFor(() => store.stats().delivered === 50);
    await p.stop(1000);
    assert.equal(new Set(sent).size, 50);
    assert.equal(sent.length, 50);
    assert.ok(maxConcurrent <= 4 && maxConcurrent > 1, String(maxConcurrent));
  });

  it("on shutdown waits for in-flight work, then aborts and releases at the deadline", async () => {
    store.commitBatch([sampleEvent()], cp);
    let signalSeen: AbortSignal | undefined;
    const sender: Sender = {
      send(_ev, signal) {
        signalSeen = signal;
        return new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve({ ok: false, retryable: true, ambiguous: true, reason: "aborted" }));
        });
      },
    };
    const p = pool(sender);
    p.start();
    await waitFor(() => p.inFlight === 1);
    const started = Date.now();
    await p.stop(100);
    assert.ok(Date.now() - started >= 90);
    assert.equal(signalSeen?.aborted, true);
    const s = store.stats();
    assert.equal(s.inflight, 0);
    assert.equal(s.pending, 1, "aborted event is back in the queue");
    assert.equal(store.claim(1000)?.attempts, 1, "release did not consume an attempt");
  });

  describe("ambiguous failures (Matomo may already have the event)", () => {
    const timeout: SendResult = { ok: false, retryable: true, ambiguous: true, reason: "timeout" };
    const refused: SendResult = { ok: false, retryable: true, ambiguous: false, reason: "network_ECONNREFUSED" };

    it("retry policy: retries ambiguous failures and counts them", async () => {
      store.commitBatch([sampleEvent()], cp);
      const s = new ScriptedSender();
      s.results = [timeout];
      const metrics = new Metrics();
      const p = pool(s, metrics);
      await p.runOnce();
      clock += 10_000;
      await p.runOnce();
      assert.equal(s.sent.length, 2);
      assert.equal(store.stats().delivered, 1);
      assert.equal(metrics.get("deliveries_ambiguous"), 1);
    });

    it("dead_letter policy: dead-letters ambiguous failures without re-sending", async () => {
      store.commitBatch([sampleEvent()], cp);
      const s = new ScriptedSender();
      s.results = [timeout];
      const metrics = new Metrics();
      const p = pool(s, metrics, { onAmbiguousFailure: "dead_letter" });
      await p.runOnce();
      clock += 10_000;
      assert.equal(await p.runOnce(), false);
      assert.equal(s.sent.length, 1);
      assert.deepEqual(store.deadLetterStats().map((r) => r.reason), ["ambiguous_timeout"]);
      assert.equal(metrics.get("deliveries_ambiguous"), 1);
    });

    it("dead_letter policy: still retries failures where nothing was sent", async () => {
      store.commitBatch([sampleEvent()], cp);
      const s = new ScriptedSender();
      s.results = [refused];
      const metrics = new Metrics();
      const p = pool(s, metrics, { onAmbiguousFailure: "dead_letter" });
      await p.runOnce();
      clock += 10_000;
      await p.runOnce();
      assert.equal(s.sent.length, 2);
      assert.equal(store.stats().delivered, 1);
      assert.equal(metrics.get("deliveries_ambiguous"), 0);
    });

    it("treats a lease that expired during a send (crash mid-request) as ambiguous", async () => {
      for (const policy of ["retry", "dead_letter"] as const) {
        store.commitBatch([sampleEvent()], cp);
        const crashed = store.claim(1000)!;
        assert.ok(store.markSending(crashed.id, crashed.leaseToken));
        clock += 1001; // the holder died; its lease expires
        const s = new ScriptedSender();
        const metrics = new Metrics();
        await pool(s, metrics, { onAmbiguousFailure: policy }).runOnce();
        assert.equal(metrics.get("deliveries_ambiguous"), 1, policy);
        if (policy === "retry") {
          assert.equal(s.sent.length, 1);
          assert.equal(store.stats().delivered, 1);
        } else {
          assert.equal(s.sent.length, 0);
          assert.deepEqual(store.deadLetterStats().map((r) => r.reason), ["ambiguous_lease_expired"]);
        }
      }
    });

    it("a lease that expired before sending is not ambiguous", async () => {
      store.commitBatch([sampleEvent()], cp);
      assert.ok(store.claim(1000)); // claimed, never sent
      clock += 1001;
      const s = new ScriptedSender();
      const metrics = new Metrics();
      await pool(s, metrics, { onAmbiguousFailure: "dead_letter" }).runOnce();
      assert.equal(s.sent.length, 1);
      assert.equal(store.stats().delivered, 1);
      assert.equal(metrics.get("deliveries_ambiguous"), 0);
    });

    it("dead_letter policy: a request aborted at the shutdown deadline is dead-lettered", async () => {
      store.commitBatch([sampleEvent()], cp);
      const sender: Sender = {
        send: (_ev, signal) =>
          new Promise((resolve) => signal?.addEventListener("abort", () => resolve({ ...timeout, reason: "aborted" }))),
      };
      const p = pool(sender, new Metrics(), { onAmbiguousFailure: "dead_letter" });
      p.start();
      await waitFor(() => p.inFlight === 1);
      await p.stop(50);
      assert.deepEqual(store.deadLetterStats().map((r) => r.reason), ["ambiguous_aborted"]);
    });
  });
});
