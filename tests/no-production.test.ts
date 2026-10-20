import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";

describe("test isolation from real Matomo instances", () => {
  it("the network guard blocks non-loopback fetches in test processes", async () => {
    const example = loadConfig(new URL("../config/config.example.toml", import.meta.url).pathname);
    await assert.rejects(fetch(example.matomo.endpoint, { method: "POST" }), /network-guard/);
    await assert.rejects(fetch("https://example.org/"), /network-guard/);
  });

  it("the network guard allows loopback fetches", async () => {
    await assert.rejects(fetch("http://127.0.0.1:1/"), (e: Error) => !/network-guard/.test(String(e.message)));
  });
});
