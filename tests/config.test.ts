import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ConfigError, loadConfig, loadToken, MATOMO_AI_ASSISTANTS, parseConfig } from "../src/config.ts";
import { tempDir, testConfigToml, TEST_TOKEN } from "../test-support/helpers.ts";

const tmp = tempDir();
after(tmp.cleanup);
const base = (extra: Record<string, Record<string, unknown>> = {}, endpoint?: string) =>
  testConfigToml({ dir: tmp.dir, extra, ...(endpoint ? { endpoint } : {}) });

describe("config", () => {
  it("parses the shipped example config with safe defaults", () => {
    const cfg = loadConfig(new URL("../config/config.example.toml", import.meta.url).pathname);
    assert.equal(cfg.matomo.endpoint.href, "https://matomo.example.com/matomo.php");
    assert.equal(cfg.matomo.stripQueryString, true);
    assert.equal(cfg.matomo.source, "Caddy");
    assert.equal(cfg.matomo.bypassQueuedTracking, true);
    assert.equal(cfg.filtering.statusMax, 299);
    assert.equal(parseConfig(base()).filtering.statusMax, 299, "default when not configured");
    assert.equal(cfg.log.expectedHost, "example.com");
    assert.equal(cfg.server.healthHost, "127.0.0.1");
    assert.equal(cfg.server.healthPort, 9788);
    assert.deepEqual(cfg.assistants, MATOMO_AI_ASSISTANTS);
    assert.deepEqual(parseConfig(base()).assistants, MATOMO_AI_ASSISTANTS, "default when not configured");
    assert.deepEqual(cfg.trainingCrawlers, ["GPTBot", "ClaudeBot", "Google-Extended", "CCBot", "Amazonbot"]);
    assert.deepEqual(cfg.filtering.documentExtensions, [".pdf"]);
    assert.ok(!cfg.filtering.excludeExtensions.includes(".pdf"));
  });

  it("example config contains no token", () => {
    const text = readFileSync(new URL("../config/config.example.toml", import.meta.url), "utf8");
    assert.doesNotMatch(text, /^\s*token(_auth)?\s*=/m);
    assert.doesNotMatch(text, /\b[a-f0-9]{32}\b/i);
  });

  it("requires https for non-loopback endpoints even with the test flag", () => {
    assert.throws(() => parseConfig(base({}, "http://matomo.example.org/matomo.php")), ConfigError);
    assert.throws(
      () => parseConfig(base({ matomo: { allow_insecure_localhost_for_tests: false } }, "http://127.0.0.1:1/matomo.php")),
      /must use https/,
    );
    assert.equal(parseConfig(base({}, "http://127.0.0.1:1/matomo.php")).matomo.endpoint.protocol, "http:");
    assert.equal(parseConfig(base({}, "https://matomo.example.org/matomo.php")).matomo.endpoint.protocol, "https:");
  });

  it("rejects endpoints with credentials or query strings", () => {
    assert.throws(() => parseConfig(base({}, "https://u:p@matomo.example.org/matomo.php")), /credentials/);
    assert.throws(() => parseConfig(base({}, "https://matomo.example.org/matomo.php?token_auth=x")), /query/);
  });

  it("fails closed on unknown keys, sections and bad values", () => {
    assert.throws(() => parseConfig(base({ matomo: { tokn_file: "x" } })), /unknown key/);
    assert.throws(() => parseConfig(base() + "\n[extra]\na = 1\n"), /unknown section/);
    assert.throws(() => parseConfig(base({ delivery: { workers: 0 } })), /workers/);
    assert.throws(() => parseConfig(base({ filtering: { allowed_status_min: 400, allowed_status_max: 200 } })), /status/);
    assert.throws(() => parseConfig("this is = = not toml"), /invalid TOML/);
    assert.throws(() => parseConfig(base({ log: { format: "common" } })), /format/);
    assert.throws(() => parseConfig(base({ ai_assistants: { user_agents: ["Chat GPT"] } })), /product token/);
    assert.throws(() => parseConfig(base({ ai_assistants: { user_agents: ["GPTBot"] } })), /both allowed and excluded/);
    assert.throws(() => parseConfig(base({ ai_assistants: { user_agents: ["GPT"] } })), /too short/);
    assert.throws(
      () => parseConfig(base({ filtering: { exclude_extensions: [".pdf"], document_extensions: [".pdf"] } })),
      /both excluded and documents/,
    );
    assert.throws(() => parseConfig(base({ delivery: { lease_seconds: 1 } })), /lease_seconds/);
    assert.throws(() => parseConfig(base({ delivery: { on_ambiguous_failure: "drop" } })), /on_ambiguous_failure/);
    assert.equal(parseConfig(base()).delivery.onAmbiguousFailure, "retry");
    assert.equal(parseConfig(base({ delivery: { on_ambiguous_failure: "dead_letter" } })).delivery.onAmbiguousFailure, "dead_letter");
  });

  it("debug logging is off by default and configurable per flag", () => {
    assert.deepEqual(parseConfig(base()).debug, { logTracked: false, logExcludedCrawlers: false });
    const example = loadConfig(new URL("../config/config.example.toml", import.meta.url).pathname);
    assert.deepEqual(example.debug, { logTracked: false, logExcludedCrawlers: false });
    assert.deepEqual(parseConfig(base({ debug: { log_tracked: true } })).debug, { logTracked: true, logExcludedCrawlers: false });
    assert.deepEqual(parseConfig(base({ debug: { log_excluded_crawlers: true } })).debug, {
      logTracked: false,
      logExcludedCrawlers: true,
    });
    assert.throws(() => parseConfig(base({ debug: { log_tracked: "yes" } })), /debug.log_tracked must be a boolean/);
    assert.throws(() => parseConfig(base({ debug: { log_level: "debug" } })), /unknown key/);
  });

  it("keeps fingerprints forever unless seen_retention_days is set", () => {
    assert.equal(parseConfig(base()).storage.seenRetentionDays, 0);
    const example = loadConfig(new URL("../config/config.example.toml", import.meta.url).pathname);
    assert.equal(example.storage.seenRetentionDays, 0);
    assert.equal(parseConfig(base({ storage: { seen_retention_days: 400 } })).storage.seenRetentionDays, 400);
    assert.throws(() => parseConfig(base({ storage: { seen_retention_days: 0.5 } })), /seen_retention_days must be an integer/);
    assert.throws(() => parseConfig(base({ storage: { seen_retention_days: -1 } })), /seen_retention_days/);
  });

  it("only allows the health endpoint on loopback IPs", () => {
    assert.throws(() => parseConfig(base({ server: { health_listen: "0.0.0.0:9788" } })), /loopback/);
    assert.throws(() => parseConfig(base({ server: { health_listen: "localhost:9788" } })), /loopback/);
    assert.throws(() => parseConfig(base({ server: { health_listen: "10.0.0.1:9788" } })), /loopback/);
    assert.equal(parseConfig(base({ server: { health_listen: "[::1]:9788" } })).server.healthHost, "::1");
  });

  it("loads the token from a file and validates it", () => {
    const p = join(tmp.dir, "tok");
    writeFileSync(p, `  ${TEST_TOKEN}\n`);
    assert.equal(loadToken(p), TEST_TOKEN);
    writeFileSync(p, "");
    assert.throws(() => loadToken(p), /valid token/);
    writeFileSync(p, "not a token; rm -rf /");
    assert.throws(() => loadToken(p), (err: Error) => !err.message.includes("rm -rf"));
    assert.throws(() => loadToken(join(tmp.dir, "missing")), /ENOENT/);
    assert.throws(() => loadToken(tmp.dir), /not a regular file/);
  });
});
