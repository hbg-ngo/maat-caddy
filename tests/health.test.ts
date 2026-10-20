import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { HealthServer } from "../src/health.ts";
import { RateLimitedLogger, setLogSink } from "../src/log.ts";

describe("health server", () => {
  const server = new HealthServer({
    health: () => ({ healthy: state.healthy, body: { status: state.healthy ? "ok" : "unhealthy" } }),
    metrics: () => ({ queue: { pending: 3 }, counters: { events_enqueued: 5 } }),
  });
  const state = { healthy: true };
  let base = "";
  after(() => server.close());

  it("binds to loopback", async () => {
    const addr = await server.listen("127.0.0.1", 0);
    assert.equal(addr.address, "127.0.0.1");
    base = `http://127.0.0.1:${addr.port}`;
  });

  it("reports health and aggregate metrics", async () => {
    let r = await fetch(`${base}/health`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { status: "ok" });
    state.healthy = false;
    r = await fetch(`${base}/health`);
    assert.equal(r.status, 503);
    r = await fetch(`${base}/metrics`);
    assert.deepEqual(await r.json(), { queue: { pending: 3 }, counters: { events_enqueued: 5 } });
    assert.equal((await fetch(`${base}/other`)).status, 404);
    assert.equal((await fetch(`${base}/health`, { method: "POST" })).status, 405);
  });
});

describe("rate-limited logging", () => {
  it("emits at most N messages per window and reports suppressed counts", () => {
    const lines: string[] = [];
    setLogSink((l) => lines.push(l));
    let t = 0;
    const rl = new RateLimitedLogger(2, 1000, () => t);
    for (let i = 0; i < 10; i++) rl.log("warn", "malformed", { length: 10 });
    assert.equal(lines.length, 2);
    t = 1000;
    rl.log("warn", "malformed");
    setLogSink((l) => process.stdout.write(l + "\n"));
    assert.equal(lines.length, 4);
    assert.match(lines[2]!, /"suppressed":8/);
  });
});
