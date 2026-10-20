import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Classifier, productNames } from "../src/classifier.ts";
import { DEFAULT_CRAWLERS, MATOMO_AI_ASSISTANTS } from "../src/config.ts";
import { BROWSER_UA, CHATGPT_UA, GPTBOT_UA, PERPLEXITY_UA } from "../test-support/helpers.ts";

const c = new Classifier(MATOMO_AI_ASSISTANTS, DEFAULT_CRAWLERS);

/** Realistic vendor User-Agent strings for every assistant Matomo detects. */
const VENDOR_UAS: [string, string][] = [
  [CHATGPT_UA, "ChatGPT-User"],
  [PERPLEXITY_UA, "Perplexity-User"],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)", "Claude-User"],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; MistralAI-User/1.0; +https://docs.mistral.ai/robots)", "MistralAI-User"],
  ["Mozilla/5.0 (compatible; Gemini-Deep-Research; +https://gemini.google/overview/deep-research/) Chrome/135.0.0.0 Safari/537.36", "Gemini-Deep-Research"],
  ["Mozilla/5.0 (compatible; Google-NotebookLM; +https://notebooklm.google)", "Google-NotebookLM"],
  ["Google-GeminiNotebook", "Google-GeminiNotebook"],
];

describe("classifier", () => {
  it("default assistant list equals Matomo's BotDetector list (matomo@71b5fbf)", () => {
    // From plugins/BotTracking/BotDetector.php $aiAssistantPatterns at
    // matomo-org/matomo@71b5fbf2194b83ff363cd6bc9d94fe2ef8e62e25. Update both together.
    assert.deepEqual(
      [...MATOMO_AI_ASSISTANTS].sort(),
      [
        "ChatGPT-User",
        "Claude-User",
        "Gemini-Deep-Research",
        "Google-GeminiNotebook",
        "Google-NotebookLM",
        "MistralAI-User",
        "Perplexity-User",
      ].sort(),
    );
  });

  it("extracts product names including those inside comments", () => {
    assert.deepEqual(productNames("Foo/1.0 (compatible; Bar/2; +https://x.y/z)"), ["foo", "compatible", "bar", "+https:"]);
  });

  it("recognises every Matomo-detected assistant in real-world UA strings", () => {
    for (const [ua, name] of VENDOR_UAS) assert.deepEqual(c.classify(ua), { kind: "assistant", name }, ua);
  });

  it("matches assistants like Matomo: case-insensitive substring of the full name", () => {
    assert.equal(c.classify("mozilla/5.0 (compatible; chatgpt-user/1.0)").kind, "assistant");
    assert.equal(c.classify("PERPLEXITY-USER/1.0").kind, "assistant");
    // Matomo's stripos also counts these, so they must not be skipped.
    for (const ua of ["NotChatGPT-User/1.0", "ChatGPT-User-Proxy/1.0", "Mozilla/5.0 ChatGPT-User1.0", "xclaude-userx"]) {
      assert.equal(c.classify(ua).kind, "assistant", ua);
    }
  });

  it("does not match partial names", () => {
    for (const ua of [
      "Mozilla/5.0 (compatible; ChatGPT/1.0)",
      "Mozilla/5.0 (compatible; GPT/1.0; Claude/2)",
      "Perplexity/1.0",
      "Mistral-User/1.0",
      "Gemini/1.0",
      "Google-Notebook/1.0",
    ]) {
      assert.equal(c.classify(ua).kind, "other", ua);
    }
  });

  it("training-crawler exclusions take precedence and match whole product names only", () => {
    assert.deepEqual(c.classify(GPTBOT_UA), { kind: "excluded_crawler", name: "GPTBot" });
    assert.equal(c.classify("ChatGPT-User/1.0 GPTBot/1.0").kind, "excluded_crawler");
    assert.equal(c.classify("GPTBot/1.0 (compatible; Claude-User/1.0)").kind, "excluded_crawler");
    for (const bot of ["ClaudeBot/1.0", "Google-Extended", "CCBot/2.0", "Amazonbot/0.1", "Perplexity-User/1.0 CCBot/2.0"]) {
      assert.equal(c.classify(bot).kind, "excluded_crawler", bot);
    }
    // Not whole crawler tokens -> no exclusion.
    assert.equal(c.classify("MyGPTBot/1.0").kind, "other");
    assert.equal(c.classify("ClaudeBotX/1.0").kind, "other");
    assert.equal(c.classify("MyGPTBot/1.0 ChatGPT-User/1.0").kind, "assistant");
  });

  it("treats browsers, empty and garbage UAs as other", () => {
    assert.equal(c.classify(BROWSER_UA).kind, "other");
    assert.equal(c.classify("").kind, "other");
    assert.equal(c.classify(";;;()///").kind, "other");
  });
});
