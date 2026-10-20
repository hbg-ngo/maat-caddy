import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { createLineProcessor, trackedLogger } from "../src/app.ts";
import { setLogLevel, setLogSink } from "../src/log.ts";
import { Metrics } from "../src/metrics.ts";
import type { QueuedEvent } from "../src/store.ts";
import { caddyLine, GPTBOT_UA, sampleEvent, tempDir, testConfig } from "../test-support/helpers.ts";

const tmp = tempDir();
after(tmp.cleanup);
let lines: Record<string, unknown>[] = [];
setLogSink((l) => {
  const entry = JSON.parse(l) as Record<string, unknown>;
  delete entry["time"];
  lines.push(entry);
});
setLogLevel("debug");
beforeEach(() => {
  lines = [];
});

const queued = (over: Partial<QueuedEvent> = {}): QueuedEvent => ({
  ...sampleEvent(),
  id: 1,
  attempts: 2,
  leaseToken: "t",
  unsettledSend: false,
  ...over,
});

describe("debug logging", () => {
  it("logs excluded training crawlers without query string, only when enabled", () => {
    const cfg = testConfig({ dir: tmp.dir });
    const line = caddyLine({ ua: GPTBOT_UA, uri: "/de/arbeit?secret=1", ts: 1_760_000_000.5 });
    createLineProcessor(cfg, new Metrics())(line);
    assert.equal(lines.length, 0);

    createLineProcessor(cfg, new Metrics(), { logExcludedCrawlers: true })(line);
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0], {
      level: "debug",
      msg: "training crawler excluded",
      crawler: "GPTBot",
      url: "https://example.com/de/arbeit",
      httpStatus: 200,
      eventTs: 1_760_000_000.5,
    });
    assert.doesNotMatch(JSON.stringify(lines), /secret|remote_ip|127\.0\.0\.1/);
  });

  it("does not log other skips", () => {
    const cfg = testConfig({ dir: tmp.dir });
    createLineProcessor(cfg, new Metrics(), { logExcludedCrawlers: true })(caddyLine({ method: "POST" }));
    assert.equal(lines.length, 0);
  });

  it("rate-limits excluded-crawler lines", () => {
    const cfg = testConfig({ dir: tmp.dir });
    const process = createLineProcessor(cfg, new Metrics(), { logExcludedCrawlers: true });
    for (let i = 0; i < 50; i++) process(caddyLine({ ua: GPTBOT_UA }));
    assert.equal(lines.length, 20);
  });

  it("logs tracked events with the matched assistant", () => {
    const log = trackedLogger(testConfig({ dir: tmp.dir }));
    log(queued());
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0], {
      level: "debug",
      msg: "event tracked",
      assistant: "ChatGPT-User",
      url: "https://example.com/de/arbeit",
      httpStatus: 200,
      eventTs: 1_760_000_000.5,
      attempts: 2,
    });
  });

  it("rate-limits tracked-event lines", () => {
    const log = trackedLogger(testConfig({ dir: tmp.dir }));
    for (let i = 0; i < 50; i++) log(queued());
    assert.equal(lines.length, 20);
  });
});
