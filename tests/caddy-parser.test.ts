import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeHost, parseCaddyLine } from "../src/caddy-parser.ts";
import { caddyLine, CHATGPT_UA } from "../test-support/helpers.ts";

describe("caddy parser", () => {
  it("extracts only the whitelisted fields", () => {
    const r = parseCaddyLine(caddyLine());
    assert.ok(r.ok);
    assert.deepEqual(r.record, {
      ts: 1_760_000_000.123456,
      status: 200,
      size: 5120,
      durationSec: 0.0421,
      host: "example.com",
      method: "GET",
      uri: "/de/arbeit?utm_source=chatgpt.com",
      userAgent: CHATGPT_UA,
    });
    const serialized = JSON.stringify(r.record);
    for (const forbidden of ["203.0.113.9", "198.51.100.7", "secret-cookie", "referrer.example", "secret-auth", "Set-Cookie"]) {
      assert.ok(!serialized.includes(forbidden), forbidden);
    }
  });

  it("accepts ISO timestamps and missing optional fields", () => {
    const line = JSON.stringify({
      ts: "2026-10-19T10:00:00.500Z",
      status: 200,
      request: { host: "example.com", method: "get", uri: "/" },
    });
    const r = parseCaddyLine(line);
    assert.ok(r.ok);
    assert.equal(r.record.ts, Date.parse("2026-10-19T10:00:00.500Z") / 1000);
    assert.equal(r.record.size, 0);
    assert.equal(r.record.durationSec, null);
    assert.equal(r.record.userAgent, "");
    assert.equal(r.record.method, "GET");
  });

  it("rejects malformed lines with a reason and never throws", () => {
    const cases: [string, string][] = [
      ["{not json", "invalid_json"],
      ["[1,2,3]", "not_object"],
      ["null", "not_object"],
      ['"string"', "not_object"],
      [JSON.stringify({ ts: 1_760_000_000, status: 200 }), "missing_request"],
      [JSON.stringify({ ts: "yesterday", status: 200, request: {} }), "invalid_ts"],
      [JSON.stringify({ ts: 12, status: 200, request: {} }), "invalid_ts"],
      [JSON.stringify({ ts: 1_760_000_000, status: "200", request: {} }), "invalid_status"],
      [JSON.stringify({ ts: 1_760_000_000, status: 200, request: { host: 5, method: "GET", uri: "/" } }), "invalid_host"],
      [JSON.stringify({ ts: 1_760_000_000, status: 200, request: { host: "h", method: "G T", uri: "/" } }), "invalid_method"],
      [JSON.stringify({ ts: 1_760_000_000, status: 200, request: { host: "h", method: "GET", uri: "" } }), "invalid_uri"],
    ];
    for (const [line, reason] of cases) {
      const r = parseCaddyLine(line);
      assert.deepEqual(r, { ok: false, reason }, line);
    }
  });

  it("ignores ambiguous multi-value User-Agent headers", () => {
    const line = JSON.stringify({
      ts: 1_760_000_000,
      status: 200,
      request: { host: "example.com", method: "GET", uri: "/", headers: { "User-Agent": ["ChatGPT-User/1.0", "x"] } },
    });
    const r = parseCaddyLine(line);
    assert.ok(r.ok);
    assert.equal(r.record.userAgent, "");
  });

  it("normalizes hosts", () => {
    assert.equal(normalizeHost("Example.COM:443"), "example.com");
    assert.equal(normalizeHost("example.com."), "example.com");
    assert.equal(normalizeHost("[::1]:8080"), "[::1]");
  });
});
