import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { buildPayload, classifyStatus, drainBounded, isConnectFailure, isRetryableStatus, MatomoClient } from "../src/matomo.ts";
import { log, registerSecret, setLogSink } from "../src/log.ts";
import { MockMatomo, sampleEvent, TEST_TOKEN } from "../test-support/helpers.ts";

const mock = new MockMatomo();
before(async () => {
  await mock.start();
});
after(async () => {
  await mock.stop();
});

function client(over: Partial<ConstructorParameters<typeof MatomoClient>[0]> = {}): MatomoClient {
  return new MatomoClient({
    endpoint: new URL(mock.url),
    siteId: 7,
    token: TEST_TOKEN,
    source: "Caddy",
    timeoutMs: 1000,
    ...over,
  });
}

describe("matomo payload", () => {
  it("contains exactly the bot-tracking fields", () => {
    const p = buildPayload(sampleEvent({ eventTs: 1_760_000_000.987 }), 7, "Caddy", TEST_TOKEN);
    assert.deepEqual(Object.fromEntries(p), {
      idsite: "7",
      rec: "1",
      recMode: "1",
      apiv: "1",
      send_image: "0",
      ua: sampleEvent().ua,
      url: "https://example.com/de/arbeit",
      cdt: "1760000000",
      http_status: "200",
      bw_bytes: "100",
      pf_srv: "12",
      source: "Caddy",
      token_auth: TEST_TOKEN,
      queuedtracking: "0",
    });
    assert.equal(buildPayload(sampleEvent(), 7, "Caddy", TEST_TOKEN, false).has("queuedtracking"), false);
  });

  it("adds download for documents and omits pf_srv when unknown", () => {
    const p = buildPayload(sampleEvent({ isDownload: true, url: "https://example.com/a.pdf", pfSrvMs: null }), 1, "Caddy", "t");
    assert.equal(p.get("download"), "https://example.com/a.pdf");
    assert.equal(p.get("url"), "https://example.com/a.pdf");
    assert.equal(p.has("pf_srv"), false);
  });

  it("never includes IP, cookie, referrer or header fields", () => {
    const p = buildPayload(sampleEvent(), 7, "Caddy", TEST_TOKEN);
    for (const k of ["cip", "urlref", "_id", "cid", "uid", "lang", "cookie", "headers"]) assert.equal(p.has(k), false, k);
  });
});

describe("matomo client", () => {
  it("POSTs form-encoded data with the token in the body, not the URL", async () => {
    mock.respond = () => 204;
    const before = mock.requests.length;
    const r = await client().send(sampleEvent());
    assert.deepEqual(r, { ok: true, status: 204 });
    const req = mock.requests[before]!;
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/matomo.php");
    assert.match(req.headers["content-type"] ?? "", /^application\/x-www-form-urlencoded/);
    assert.equal(req.params.get("token_auth"), TEST_TOKEN);
    assert.equal(req.params.get("recMode"), "1");
    assert.equal(req.headers["cookie"], undefined);
    assert.equal(req.headers["referer"], undefined);
  });

  it("classifies statuses as retryable or permanent", async () => {
    const cases: [number, boolean][] = [
      [500, true],
      [502, true],
      [503, true],
      [429, true],
      [408, true],
      [400, false],
      [401, false],
      [403, false],
      [404, false],
    ];
    for (const [status, retryable] of cases) {
      mock.respond = () => status;
      const r = await client().send(sampleEvent());
      assert.equal(r.ok, false, String(status));
      assert.equal(!r.ok && r.retryable, retryable, String(status));
      assert.equal(isRetryableStatus(status), retryable);
    }
  });

  it("does not follow redirects (token must not be replayed elsewhere)", async () => {
    mock.respond = () => 307;
    const before = mock.requests.length;
    const r = await client().send(sampleEvent());
    assert.deepEqual(r, { ok: false, retryable: false, ambiguous: false, reason: "http_307_redirect" });
    assert.equal(mock.requests.length, before + 1);
  });

  it("times out slow responses as retryable", async () => {
    mock.respond = () => new Promise((r) => setTimeout(() => r(204), 1500));
    const started = Date.now();
    const r = await client({ timeoutMs: 200 }).send(sampleEvent());
    assert.deepEqual(r, { ok: false, retryable: true, ambiguous: true, reason: "timeout" });
    assert.ok(Date.now() - started < 1000);
  });

  it("treats connection failures as retryable network errors", async () => {
    // A port that was just freed: connection refused (port 9 would be blocked by fetch itself).
    const probe = createNetServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    const r = await client({ endpoint: new URL(`http://127.0.0.1:${port}/matomo.php`) }).send(sampleEvent());
    assert.equal(r.ok, false);
    assert.deepEqual(r, { ok: false, retryable: true, ambiguous: false, reason: "network_ECONNREFUSED" });
  });

  it("reads at most a bounded amount of the response body", async () => {
    mock.respond = () => 200;
    mock.responseBody = "x".repeat(5 * 1024 * 1024);
    try {
      const r = await client({ maxResponseBytes: 1024 }).send(sampleEvent());
      assert.deepEqual(r, { ok: true, status: 200 });
      // An endless body must not be read to completion.
      let pulled = 0;
      const endless = new ReadableStream<Uint8Array>({
        pull(ctrl) {
          pulled++;
          ctrl.enqueue(new Uint8Array(256));
        },
      });
      const read = await drainBounded(new Response(endless), 1000);
      assert.ok(read > 1000 && read <= 1256, String(read));
      assert.ok(pulled < 10);
    } finally {
      mock.responseBody = "";
    }
  });

  it("aborts on the external shutdown signal", async () => {
    mock.respond = () => new Promise((r) => setTimeout(() => r(204), 1000));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const r = await client({ timeoutMs: 5000 }).send(sampleEvent(), ac.signal);
    assert.deepEqual(r, { ok: false, retryable: true, ambiguous: true, reason: "aborted" });
  });

  it("rejects untrusted TLS certificates", async () => {
    const server = createHttpsServer(
      {
        key: readFileSync(new URL("./fixtures/selfsigned-key.pem", import.meta.url)),
        cert: readFileSync(new URL("./fixtures/selfsigned-cert.pem", import.meta.url)),
      },
      (_req, res) => {
        res.writeHead(204);
        res.end();
      },
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as AddressInfo).port;
      const r = await client({ endpoint: new URL(`https://localhost:${port}/matomo.php`) }).send(sampleEvent());
      assert.deepEqual(r, { ok: false, retryable: true, ambiguous: false, reason: "tls_DEPTH_ZERO_SELF_SIGNED_CERT" });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("failure classification", () => {
  it("separates safe, ambiguous and permanent HTTP outcomes", () => {
    const cases: [number, boolean, boolean][] = [
      // status, retryable, ambiguous
      [408, true, false],
      [425, true, false],
      [429, true, false],
      [503, true, false],
      [500, true, true],
      [502, true, true],
      [504, true, true],
      [400, false, false],
      [403, false, false],
      [301, false, false],
    ];
    for (const [status, retryable, ambiguous] of cases) {
      const r = classifyStatus(status);
      assert.ok(!r.ok);
      assert.equal(r.retryable, retryable, String(status));
      assert.equal(r.ambiguous, ambiguous, String(status));
    }
    assert.deepEqual(classifyStatus(204), { ok: true, status: 204 });
  });

  it("treats only pre-connection network errors as safe", () => {
    for (const r of ["network_ECONNREFUSED", "network_ENOTFOUND", "network_EAI_AGAIN", "network_UND_ERR_CONNECT_TIMEOUT", "tls_CERT_HAS_EXPIRED"]) {
      assert.equal(isConnectFailure(r), true, r);
    }
    for (const r of ["network_ECONNRESET", "network_UND_ERR_SOCKET", "network_EPIPE", "network_error", "timeout"]) {
      assert.equal(isConnectFailure(r), false, r);
    }
  });

  it("reports a connection reset after sending as ambiguous", async () => {
    mock.respond = () => Promise.reject(new Error("drop"));
    const r = await client().send(sampleEvent());
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.retryable && r.ambiguous, JSON.stringify(r));
  });
});

describe("secret redaction", () => {
  it("never writes a registered token to the log", () => {
    const lines: string[] = [];
    setLogSink((l) => lines.push(l));
    registerSecret(TEST_TOKEN);
    log("error", `failed with ${TEST_TOKEN}`, { detail: `token_auth=${TEST_TOKEN}` });
    setLogSink((l) => process.stdout.write(l + "\n"));
    assert.equal(lines.length, 1);
    assert.ok(!lines[0]!.includes(TEST_TOKEN));
    assert.match(lines[0]!, /\[REDACTED\]/);
  });
});
