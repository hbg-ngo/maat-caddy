import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { parseCaddyLine } from "../src/caddy-parser.ts";
import { Classifier } from "../src/classifier.ts";
import { normalizeUrl, RequestFilter, type Decision } from "../src/filter.ts";
import { caddyLine, CHATGPT_UA, PERPLEXITY_UA, GPTBOT_UA, BROWSER_UA, tempDir, testConfig, type LineOptions } from "../test-support/helpers.ts";

const tmp = tempDir();
after(tmp.cleanup);

function decide(o: LineOptions, extra: Parameters<typeof testConfig>[0]["extra"] = {}): Decision {
  const cfg = testConfig({ dir: tmp.dir, extra });
  const filter = new RequestFilter(cfg, new Classifier(cfg.assistants, cfg.trainingCrawlers));
  const parsed = parseCaddyLine(caddyLine(o));
  assert.ok(parsed.ok);
  return filter.decide(parsed.record);
}

function reason(o: LineOptions, extra?: Parameters<typeof testConfig>[0]["extra"]): string {
  const d = decide(o, extra);
  return d.qualifies ? "qualifies" : d.reason;
}

describe("filter", () => {
  it("produces a minimal event for a qualifying request", () => {
    const d = decide({ uri: "/de/arbeit?utm_source=chatgpt.com#frag", duration: 0.0421, size: 5120, ts: 1_760_000_000.9 });
    assert.ok(d.qualifies);
    assert.match(d.event.fingerprint, /^[0-9a-f]{64}$/);
    assert.deepEqual(d.event, {
      fingerprint: d.event.fingerprint,
      eventTs: 1_760_000_000.9,
      url: "https://example.com/de/arbeit",
      isDownload: false,
      ua: CHATGPT_UA,
      httpStatus: 200,
      bwBytes: 5120,
      pfSrvMs: 42,
    });
  });

  it("never carries IPs, cookies, referrer, auth or other headers", () => {
    const d = decide({});
    assert.ok(d.qualifies);
    assert.deepEqual(Object.keys(d.event).sort(), ["bwBytes", "eventTs", "fingerprint", "httpStatus", "isDownload", "pfSrvMs", "ua", "url"]);
    const s = JSON.stringify(d.event);
    for (const forbidden of ["203.0.113.9", "198.51.100.7", "secret-cookie", "referrer.example", "secret-auth", "utm_source"]) {
      assert.ok(!s.includes(forbidden), forbidden);
    }
  });

  it("fingerprints identify the logged request", () => {
    const fp = (o: LineOptions) => {
      const d = decide(o);
      assert.ok(d.qualifies);
      return d.event.fingerprint;
    };
    const base = { ts: 1_760_000_000.123456, uri: "/a", duration: 0.0421 };
    assert.equal(fp(base), fp(base), "stable across reads");
    assert.equal(fp(base), fp({ ...base, uri: "/a?other=query" }), "stripped query does not matter");
    assert.notEqual(fp(base), fp({ ...base, ts: 1_760_000_000.123457 }));
    assert.notEqual(fp(base), fp({ ...base, duration: 0.0422 }));
    assert.notEqual(fp(base), fp({ ...base, uri: "/b" }));
    assert.notEqual(fp(base), fp({ ...base, ua: PERPLEXITY_UA }));
    assert.notEqual(fp(base), fp({ ...base, status: 206 }));
    assert.notEqual(fp(base), fp({ ...base, size: 1 }));
  });

  it("strips query strings by default and keeps them only when explicitly disabled", () => {
    assert.equal(normalizeUrl("example.com", "/a?b=1", true)?.url, "https://example.com/a");
    assert.equal(normalizeUrl("example.com", "/a?b=1#x", false)?.url, "https://example.com/a?b=1");
    const d = decide({ uri: "/a?b=1" }, { matomo: { strip_query_string: false } });
    assert.ok(d.qualifies);
    assert.equal(d.event.url, "https://example.com/a?b=1");
  });

  it("only accepts the configured host", () => {
    assert.equal(reason({ host: "example.com:443" }), "qualifies");
    assert.equal(reason({ host: "EXAMPLE.COM" }), "qualifies");
    assert.equal(reason({ host: "www.example.com" }), "host");
    assert.equal(reason({ host: "evil-example.com" }), "host");
    assert.equal(reason({ host: "example.com.evil.com" }), "host");
    assert.equal(reason({ host: "matomo.example.com" }), "host");
  });

  it("classifies user agents with exclusions first", () => {
    assert.equal(reason({ ua: GPTBOT_UA }), "excluded_crawler");
    assert.deepEqual(decide({ ua: GPTBOT_UA }), { qualifies: false, reason: "excluded_crawler", crawler: "GPTBot" });
    assert.equal(reason({ ua: BROWSER_UA }), "not_assistant");
    assert.equal(reason({ ua: "" }), "not_assistant");
  });

  it("filters methods and statuses outside 2xx by default", () => {
    assert.equal(reason({ method: "POST" }), "method");
    assert.equal(reason({ method: "HEAD" }), "method");
    for (const s of [200, 204, 206, 299]) assert.equal(reason({ status: s }), "qualifies", String(s));
    for (const s of [101, 199, 301, 304, 307, 400, 404, 429, 500, 503]) assert.equal(reason({ status: s }), "status", String(s));
    assert.equal(reason({ status: 307 }, { filtering: { allowed_status_max: 399 } }), "qualifies", "3xx when configured");
  });

  it("filters static assets, Next.js internals, API, health and robots", () => {
    const cases: [string, string][] = [
      ["/_next/static/chunks/main.js", "excluded_prefix"],
      ["/_next/image?url=x", "excluded_prefix"],
      ["/api/search?q=x", "excluded_prefix"],
      ["/api", "excluded_prefix"],
      ["/robots.txt", "excluded_path"],
      ["/health", "excluded_path"],
      ["/healthz/", "excluded_path"],
      ["/styles/site.CSS", "excluded_extension"],
      ["/img/logo.png?v=2", "excluded_extension"],
      ["/fonts/a.woff2", "excluded_extension"],
      ["/de/../_next/static/x.js", "excluded_prefix"],
      ["/%5Fnext/x", "qualifies"],
      ["/apiary", "qualifies"],
      ["/de/robots.txt.html", "qualifies"],
      ["/", "qualifies"],
    ];
    for (const [uri, expected] of cases) assert.equal(reason({ uri }), expected, uri);
  });

  it("honours configured excluded paths", () => {
    assert.equal(reason({ uri: "/private/x" }, { filtering: { exclude_prefixes: ["/private/"] } }), "excluded_prefix");
    assert.equal(reason({ uri: "/status" }, { filtering: { exclude_paths: ["/status"] } }), "excluded_path");
  });

  it("marks configured document extensions as downloads", () => {
    const d = decide({ uri: "/files/Guide.PDF?download=1" });
    assert.ok(d.qualifies);
    assert.equal(d.event.isDownload, true);
    assert.equal(d.event.url, "https://example.com/files/Guide.PDF");
  });

  it("rejects request targets that are not origin-form paths", () => {
    assert.equal(reason({ uri: "http://other.example/x" }), "invalid_url");
    assert.equal(reason({ uri: "//other.example/x" }), "invalid_url");
    assert.equal(reason({ uri: "*" }), "invalid_url");
  });

  it("omits pf_srv when duration is missing", () => {
    const cfg = testConfig({ dir: tmp.dir });
    const filter = new RequestFilter(cfg, new Classifier(cfg.assistants, cfg.trainingCrawlers));
    const d = filter.decide({
      ts: 1_760_000_000,
      status: 200,
      size: 1,
      durationSec: null,
      host: "example.com",
      method: "GET",
      uri: "/",
      userAgent: CHATGPT_UA,
    });
    assert.ok(d.qualifies);
    assert.equal(d.event.pfSrvMs, null);
  });
});
