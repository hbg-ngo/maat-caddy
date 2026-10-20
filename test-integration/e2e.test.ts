import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, renameSync, truncateSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, describe, it } from "node:test";
import { Daemon } from "../test-support/daemon.ts";
import {
  caddyLine,
  GPTBOT_UA,
  MockMatomo,
  PERPLEXITY_UA,
  tempDir,
  testConfigToml,
  TEST_TOKEN,
  waitFor,
  writeToken,
} from "../test-support/helpers.ts";

const mock = new MockMatomo();
const tmp = tempDir("maat-e2e-");
let n = 0;
const daemons: Daemon[] = [];

before(async () => {
  await mock.start();
});
after(async () => {
  for (const d of daemons) await d.stop("SIGKILL").catch(() => undefined);
  await mock.stop();
  tmp.cleanup();
});
afterEach(() => {
  mock.requests.length = 0;
  mock.respond = () => 204;
});

interface Setup {
  dir: string;
  logPath: string;
  configPath: string;
  daemon: () => Daemon;
}

function setup(extra: Parameters<typeof testConfigToml>[0]["extra"] = {}): Setup {
  const dir = join(tmp.dir, `run${n++}`);
  mkdirSync(join(dir, "logs"), { recursive: true });
  writeToken(dir);
  const configPath = join(dir, "config.toml");
  writeFileSync(configPath, testConfigToml({ dir, endpoint: mock.url, extra }));
  return {
    dir,
    logPath: join(dir, "logs", "example.com.log"),
    configPath,
    daemon: () => {
      const d = new Daemon(configPath);
      daemons.push(d);
      return d;
    },
  };
}

const cli = (configPath: string, ...args: string[]) =>
  execFileSync(process.execPath, ["src/main.ts", "--config", configPath, ...args], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
  });
const line = (uri: string, ua?: string) => caddyLine({ uri, ...(ua ? { ua } : {}) }) + "\n";
const paths = () => mock.requests.map((r) => new URL(r.params.get("url")!).pathname);

describe("end-to-end", () => {
  it("tails the log, filters, delivers minimal events and shuts down gracefully", async () => {
    const s = setup();
    writeFileSync(
      s.logPath,
      line("/de/a?utm_source=chatgpt.com") +
        line("/en/b", PERPLEXITY_UA) +
        line("/de/c", GPTBOT_UA) +
        line("/_next/static/x.js") +
        "{broken json\n" +
        caddyLine({ uri: "/other-host", host: "example.org" }) +
        "\n" +
        line("/docs/guide.pdf"),
    );
    const d = s.daemon();
    await d.start();
    await waitFor(() => mock.requests.length === 3);

    assert.deepEqual(paths().sort(), ["/de/a", "/docs/guide.pdf", "/en/b"]);
    for (const r of mock.requests) {
      assert.equal(r.method, "POST");
      assert.equal(r.params.get("idsite"), "7");
      assert.equal(r.params.get("recMode"), "1");
      assert.equal(r.params.get("token_auth"), TEST_TOKEN);
      for (const forbidden of ["203.0.113.9", "198.51.100.7", "secret-cookie", "referrer.example", "secret-auth", "utm_source"]) {
        assert.ok(!r.body.includes(forbidden), forbidden);
      }
    }
    const pdf = mock.requests.find((r) => r.params.get("url")!.endsWith(".pdf"))!;
    assert.equal(pdf.params.get("download"), "https://example.com/docs/guide.pdf");

    const health = await fetch(`http://127.0.0.1:${d.healthPort}/health`);
    assert.equal(health.status, 200);
    const m = await d.metrics();
    assert.equal(m.counters["lines_malformed"], 1);
    assert.equal(m.counters["skipped_excluded_crawler"], 1);
    assert.equal(m.counters["skipped_host"], 1);
    assert.equal(m.queue["delivered"], 3);

    const exit = await d.stop("SIGTERM");
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.ok(d.output.some((l) => l.includes("shutdown complete")));
    assert.ok(!d.output.join("\n").includes(TEST_TOKEN), "token must never be logged");
    assert.ok(!d.output.join("\n").includes("broken json"), "line content must never be logged");
  });

  it("follows rename/create rotation and copy-truncate while running", async () => {
    const s = setup();
    writeFileSync(s.logPath, line("/r1"));
    const d = s.daemon();
    await d.start();
    await waitFor(() => paths().includes("/r1"));

    appendFileSync(s.logPath, line("/r2"));
    renameSync(s.logPath, join(s.dir, "logs", "example.com-2026-10-19T10-00-00.000.log"));
    writeFileSync(s.logPath, line("/r3"));
    appendFileSync(s.logPath, line("/r4"));
    await waitFor(() => paths().includes("/r4"));

    truncateSync(s.logPath, 0);
    appendFileSync(s.logPath, line("/r5"));
    await waitFor(() => paths().includes("/r5"));

    // Workers deliver concurrently, so compare as a set; the length rules out duplicates.
    assert.deepEqual([...paths()].sort(), ["/r1", "/r2", "/r3", "/r4", "/r5"]);
    assert.deepEqual(await d.stop(), { code: 0, signal: null });
  });

  it("recovers after downtime including rotation, without duplicates", async () => {
    const s = setup();
    writeFileSync(s.logPath, line("/d1"));
    let d = s.daemon();
    await d.start();
    await waitFor(() => paths().length === 1);
    await d.stop();

    appendFileSync(s.logPath, line("/d2"));
    renameSync(s.logPath, join(s.dir, "logs", "example.com-2026-10-19T11-00-00.000.log"));
    writeFileSync(s.logPath, line("/d3"));

    d = s.daemon();
    await d.start();
    await waitFor(() => paths().length === 3);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual([...paths()].sort(), ["/d1", "/d2", "/d3"]);
    await d.stop();
  });

  it("loses no event when killed (SIGKILL) with undelivered queue", async () => {
    const s = setup({ delivery: { max_attempts: 1000, lease_seconds: 3 } });
    mock.respond = () => 503;
    const d1 = s.daemon();
    await d1.start();
    const expected = Array.from({ length: 20 }, (_, i) => `/k${i}`);
    writeFileSync(s.logPath, expected.slice(0, 10).map((p) => line(p)).join(""));
    await waitFor(() => mock.requests.length > 0);
    appendFileSync(s.logPath, expected.slice(10).map((p) => line(p)).join(""));
    await new Promise((r) => setTimeout(r, 100));
    await d1.stop("SIGKILL");

    mock.requests.length = 0;
    mock.respond = () => 204;
    const d2 = s.daemon();
    await d2.start();
    await waitFor(() => expected.every((p) => paths().includes(p)), 10_000);
    await d2.stop();
    // At-least-once: every event arrives; duplicates are only possible for in-flight events.
    assert.deepEqual([...new Set(paths())].sort(), [...expected].sort());
  });

  it("retries through a Matomo outage and dead-letters permanent rejections", async () => {
    const s = setup();
    mock.respond = (r, i) => (r.params.get("url")!.endsWith("/bad") ? 400 : i < 4 ? 503 : 204);
    writeFileSync(s.logPath, line("/ok1") + line("/bad") + line("/ok2"));
    const d = s.daemon();
    await d.start();
    let m = await d.metrics();
    for (const start = Date.now(); Date.now() - start < 10_000; await new Promise((r) => setTimeout(r, 50))) {
      m = await d.metrics();
      if (m.queue["delivered"] === 2 && m.queue["dead"] === 1) break;
    }
    assert.equal(m.queue["dead"], 1);
    assert.equal(m.queue["delivered"], 2);
    assert.ok((m.counters["deliveries_retried"] ?? 0) >= 1);
    await d.stop();

    // Operator CLI: aggregate dead-letter view (no payloads) and replay.
    const stats = JSON.parse(cli(s.configPath, "deadletter", "stats")) as { reason: string; count: number }[];
    assert.deepEqual(stats.map((r) => [r.reason, r.count]), [["http_400", 1]]);
    assert.ok(!JSON.stringify(stats).includes("/bad"));
    assert.deepEqual(JSON.parse(cli(s.configPath, "deadletter", "replay", "--reason", "http_400")), { replayed: 1 });
    assert.equal((JSON.parse(cli(s.configPath, "queue", "stats")) as { pending: number }).pending, 1);
  });

  it("dead_letter policy: a timed-out (possibly recorded) event is not sent twice", async () => {
    const s = setup({ matomo: { request_timeout_seconds: 1 }, delivery: { on_ambiguous_failure: "dead_letter" } });
    mock.respond = (r) =>
      r.params.get("url")!.endsWith("/slow") ? new Promise((res) => setTimeout(() => res(204), 1500)) : 204;
    writeFileSync(s.logPath, line("/slow") + line("/fast"));
    const d = s.daemon();
    await d.start();
    let m = await d.metrics();
    for (const start = Date.now(); Date.now() - start < 10_000; await new Promise((r) => setTimeout(r, 50))) {
      m = await d.metrics();
      if (m.queue["dead"] === 1 && m.queue["delivered"] === 1) break;
    }
    await new Promise((r) => setTimeout(r, 300));
    await d.stop();
    assert.equal(m.queue["dead"], 1);
    assert.equal(m.counters["deliveries_ambiguous"], 1);
    assert.equal(paths().filter((p) => p === "/slow").length, 1, "never re-sent");
    const stats = JSON.parse(cli(s.configPath, "deadletter", "stats")) as { reason: string }[];
    assert.deepEqual(stats.map((r) => r.reason), ["ambiguous_timeout"]);
  });

  it("imports historic gzip logs once; a second import sends nothing", async () => {
    const s = setup({ log: { start_position: "end" } });
    writeFileSync(s.logPath, line("/live-old") + line("/live-old2"));
    const rotated = join(s.dir, "logs", "example.com-2026-10-01T00-00-00.000.log.gz");
    writeFileSync(rotated, gzipSync(line("/hist1") + line("/hist2") + caddyLine({ uri: "/bot", ua: GPTBOT_UA }) + "\n"));
    const d = s.daemon();
    await d.start();
    appendFileSync(s.logPath, line("/live-new"));
    await waitFor(() => paths().includes("/live-new"));

    const dry = JSON.parse(cli(s.configPath, "import", "--dry-run", rotated, s.logPath)) as { total: { enqueued: number } };
    assert.equal(dry.total.enqueued, 4, "hist1, hist2, live-old, live-old2");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(mock.requests.length, 1, "dry run sends nothing");

    const first = JSON.parse(cli(s.configPath, "import", rotated, s.logPath)) as { total: { enqueued: number; alreadySeen: number } };
    assert.deepEqual([first.total.enqueued, first.total.alreadySeen], [4, 1]);
    await waitFor(() => mock.requests.length === 5);

    const second = JSON.parse(cli(s.configPath, "import", rotated, s.logPath)) as { total: { enqueued: number; alreadySeen: number } };
    assert.deepEqual([second.total.enqueued, second.total.alreadySeen], [0, 5]);
    await new Promise((r) => setTimeout(r, 300));
    await d.stop();
    assert.deepEqual(paths().sort(), ["/hist1", "/hist2", "/live-new", "/live-old", "/live-old2"]);
    const hist = mock.requests.find((r) => r.params.get("url")!.endsWith("/hist1"))!;
    assert.equal(hist.params.get("cdt"), "1760000000", "original timestamp");
  });

  it("refuses to start with an invalid config or missing token", async () => {
    const bad = setup({ matomo: { endpoint: "http://matomo.example.org/matomo.php" } });
    const d1 = bad.daemon();
    await assert.rejects(d1.start(), /exited with 1/);
    assert.ok(d1.output.some((l) => l.includes("invalid configuration") && l.includes("https")));

    const noToken = setup({ matomo: { token_file: "/nonexistent/token" } });
    const d2 = noToken.daemon();
    await assert.rejects(d2.start(), /exited with 1/);
    assert.ok(d2.output.some((l) => l.includes("token file")));
  });
});
