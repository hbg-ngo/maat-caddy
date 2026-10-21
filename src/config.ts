import { readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { parse as parseToml } from "smol-toml";

export interface Config {
  matomo: {
    endpoint: URL;
    siteId: number;
    tokenFile: string;
    requestTimeoutMs: number;
    stripQueryString: boolean;
    source: string;
    bypassQueuedTracking: boolean;
    allowInsecureLocalhostForTests: boolean;
  };
  log: {
    path: string;
    expectedHost: string;
    startPosition: "beginning" | "end";
    pollIntervalMs: number;
    maxLineBytes: number;
    batchLines: number;
    rotationGraceMs: number;
  };
  storage: {
    databasePath: string;
    maxQueueEvents: number;
    deliveredRetentionDays: number;
    deadLetterRetentionDays: number;
    /** 0 = keep deduplication fingerprints forever. */
    seenRetentionDays: number;
  };
  server: {
    healthHost: string;
    healthPort: number;
  };
  delivery: {
    workers: number;
    maxAttempts: number;
    initialBackoffMs: number;
    maxBackoffMs: number;
    leaseMs: number;
    idlePollMs: number;
    shutdownTimeoutMs: number;
    onAmbiguousFailure: AmbiguousFailurePolicy;
  };
  filtering: {
    statusMin: number;
    statusMax: number;
    allowedMethods: string[];
    excludePaths: string[];
    excludePrefixes: string[];
    excludeExtensions: string[];
    documentExtensions: string[];
  };
  assistants: string[];
  trainingCrawlers: string[];
  debug: {
    /** Log each event Matomo accepted (debug level, rate-limited, daemon only). */
    logTracked: boolean;
    /** Log each skipped training-crawler request (debug level, rate-limited, daemon only). */
    logExcludedCrawlers: boolean;
  };
}

/**
 * What to do when Matomo may already have recorded a failed delivery:
 * "retry" = at-least-once (possible duplicates), "dead_letter" = at-most-once (possible losses).
 */
export type AmbiguousFailurePolicy = "retry" | "dead_letter";

export class ConfigError extends Error {
  override name = "ConfigError";
}

type Table = Record<string, unknown>;

/**
 * Mirrors Matomo's BotTracking BotDetector::$aiAssistantPatterns
 * (matomo-org/matomo@71b5fbf2194b83ff363cd6bc9d94fe2ef8e62e25, plugins/BotTracking/BotDetector.php).
 */
export const MATOMO_AI_ASSISTANTS = [
  "ChatGPT-User",
  "MistralAI-User",
  "Gemini-Deep-Research",
  "Claude-User",
  "Perplexity-User",
  "Google-GeminiNotebook",
  "Google-NotebookLM",
];
const MIN_ASSISTANT_NAME_LENGTH = 6;
export const DEFAULT_CRAWLERS = ["GPTBot", "ClaudeBot", "Google-Extended", "CCBot", "Amazonbot"];
/** Product-token names: RFC 9110 token characters excluding "/". */
const PRODUCT_TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

class Reader {
  private readonly table: Table;
  private readonly section: string;
  private readonly seen = new Set<string>();

  constructor(table: Table, section: string) {
    this.table = table;
    this.section = section;
  }

  private path(key: string): string {
    return `${this.section}.${key}`;
  }

  private raw(key: string): unknown {
    this.seen.add(key);
    return this.table[key];
  }

  str(key: string, def?: string): string {
    const v = this.raw(key) ?? def;
    if (typeof v !== "string" || v.length === 0) throw new ConfigError(`${this.path(key)} must be a non-empty string`);
    return v;
  }

  int(key: string, min: number, max: number, def?: number): number {
    const v = this.raw(key) ?? def;
    const n = typeof v === "bigint" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
      throw new ConfigError(`${this.path(key)} must be an integer between ${min} and ${max}`);
    }
    return n;
  }

  num(key: string, min: number, max: number, def?: number): number {
    const v = this.raw(key) ?? def;
    const n = typeof v === "bigint" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) {
      throw new ConfigError(`${this.path(key)} must be a number between ${min} and ${max}`);
    }
    return n;
  }

  bool(key: string, def?: boolean): boolean {
    const v = this.raw(key) ?? def;
    if (typeof v !== "boolean") throw new ConfigError(`${this.path(key)} must be a boolean`);
    return v;
  }

  strList(key: string, def?: string[]): string[] {
    const v = this.raw(key) ?? def;
    if (!Array.isArray(v) || !v.every((x): x is string => typeof x === "string" && x.length > 0)) {
      throw new ConfigError(`${this.path(key)} must be an array of non-empty strings`);
    }
    return v;
  }

  done(): void {
    const unknown = Object.keys(this.table).filter((k) => !this.seen.has(k));
    if (unknown.length > 0) throw new ConfigError(`unknown key(s) in [${this.section}]: ${unknown.join(", ")}`);
  }
}

function section(root: Table, name: string, required: boolean): Reader {
  const v = root[name];
  if (v === undefined) {
    if (required) throw new ConfigError(`missing section [${name}]`);
    return new Reader({}, name);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ConfigError(`[${name}] must be a table`);
  return new Reader(v as Table, name);
}

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

function parseEndpoint(raw: string, allowInsecure: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("matomo.endpoint is not a valid URL");
  }
  if (url.username || url.password) throw new ConfigError("matomo.endpoint must not contain credentials");
  if (url.search || url.hash) throw new ConfigError("matomo.endpoint must not contain a query string or fragment");
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && allowInsecure && isLoopbackHost(url.hostname)) return url;
  throw new ConfigError(
    "matomo.endpoint must use https (plain http is only allowed for loopback test mocks with allow_insecure_localhost_for_tests = true)",
  );
}

function parseListen(raw: string): { host: string; port: number } {
  const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(raw);
  if (!m) throw new ConfigError("server.health_listen must be host:port");
  const host = m[1]!.replace(/^\[|\]$/g, "");
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError("server.health_listen port is invalid");
  if (isIP(host) === 0 || !isLoopbackHost(host)) {
    throw new ConfigError("server.health_listen must bind to a loopback IP address (e.g. 127.0.0.1)");
  }
  return { host, port };
}

function parseAmbiguousPolicy(v: string): AmbiguousFailurePolicy {
  if (v === "retry" || v === "dead_letter") return v;
  throw new ConfigError('delivery.on_ambiguous_failure must be "retry" or "dead_letter"');
}

function normalizeExtensions(list: string[], key: string): string[] {
  return list.map((e) => {
    const ext = e.toLowerCase();
    if (!/^\.[a-z0-9]+$/.test(ext)) throw new ConfigError(`${key}: invalid extension "${e}"`);
    return ext;
  });
}

function validateUaList(list: string[], key: string): string[] {
  for (const ua of list) {
    if (!PRODUCT_TOKEN.test(ua)) throw new ConfigError(`${key}: "${ua}" is not a valid product token`);
  }
  return list;
}

export function parseConfig(text: string): Config {
  let root: Table;
  try {
    root = parseToml(text);
  } catch (err) {
    throw new ConfigError(`invalid TOML: ${err instanceof Error ? err.message.split("\n")[0] : "parse error"}`);
  }
  const known = ["matomo", "log", "storage", "server", "delivery", "filtering", "ai_assistants", "training_crawlers", "debug"];
  const unknownSections = Object.keys(root).filter((k) => !known.includes(k));
  if (unknownSections.length > 0) throw new ConfigError(`unknown section(s): ${unknownSections.join(", ")}`);

  const m = section(root, "matomo", true);
  const allowInsecure = m.bool("allow_insecure_localhost_for_tests", false);
  const matomo: Config["matomo"] = {
    endpoint: parseEndpoint(m.str("endpoint"), allowInsecure),
    siteId: m.int("site_id", 1, 2_147_483_647),
    tokenFile: m.str("token_file", "/run/secrets/matomo-token"),
    requestTimeoutMs: Math.round(m.num("request_timeout_seconds", 1, 120, 10) * 1000),
    stripQueryString: m.bool("strip_query_string", true),
    source: m.str("source", "Caddy"),
    bypassQueuedTracking: m.bool("bypass_queued_tracking", true),
    allowInsecureLocalhostForTests: allowInsecure,
  };
  if (!/^[A-Za-z0-9 ._-]{1,64}$/.test(matomo.source)) throw new ConfigError("matomo.source contains invalid characters");
  m.done();

  const l = section(root, "log", true);
  const format = l.str("format", "json");
  if (format !== "json") throw new ConfigError('log.format must be "json"');
  const startPosition = l.str("start_position", "end");
  if (startPosition !== "beginning" && startPosition !== "end") {
    throw new ConfigError('log.start_position must be "beginning" or "end"');
  }
  const log: Config["log"] = {
    path: l.str("path"),
    expectedHost: l.str("expected_host").toLowerCase(),
    startPosition,
    pollIntervalMs: l.int("poll_interval_ms", 50, 60_000, 500),
    maxLineBytes: l.int("max_line_bytes", 1024, 16 * 1024 * 1024, 1024 * 1024),
    batchLines: l.int("batch_lines", 1, 100_000, 1000),
    rotationGraceMs: l.int("rotation_grace_ms", 0, 60_000, 1000),
  };
  if (!log.path.startsWith("/")) throw new ConfigError("log.path must be absolute");
  if (!/^[a-z0-9.-]+$/.test(log.expectedHost)) throw new ConfigError("log.expected_host is not a valid hostname");
  l.done();

  const s = section(root, "storage", true);
  const storage: Config["storage"] = {
    databasePath: s.str("database_path"),
    maxQueueEvents: s.int("max_queue_events", 1, 10_000_000, 100_000),
    deliveredRetentionDays: s.num("delivered_retention_days", 0, 3650, 7),
    deadLetterRetentionDays: s.num("dead_letter_retention_days", 0, 3650, 30),
    seenRetentionDays: s.int("seen_retention_days", 0, 36_500, 0),
  };
  s.done();

  const sv = section(root, "server", false);
  const listen = parseListen(sv.str("health_listen", "127.0.0.1:9788"));
  const server: Config["server"] = { healthHost: listen.host, healthPort: listen.port };
  sv.done();

  const d = section(root, "delivery", false);
  const delivery: Config["delivery"] = {
    workers: d.int("workers", 1, 64, 4),
    maxAttempts: d.int("max_attempts", 1, 1000, 12),
    initialBackoffMs: Math.round(d.num("initial_backoff_seconds", 0.001, 3600, 2) * 1000),
    maxBackoffMs: Math.round(d.num("max_backoff_seconds", 0.001, 86_400, 900) * 1000),
    leaseMs: Math.round(d.num("lease_seconds", 1, 3600, 60) * 1000),
    idlePollMs: d.int("idle_poll_ms", 10, 60_000, 1000),
    shutdownTimeoutMs: Math.round(d.num("shutdown_timeout_seconds", 0, 300, 20) * 1000),
    onAmbiguousFailure: parseAmbiguousPolicy(d.str("on_ambiguous_failure", "retry")),
  };
  if (delivery.maxBackoffMs < delivery.initialBackoffMs) {
    throw new ConfigError("delivery.max_backoff_seconds must be >= initial_backoff_seconds");
  }
  if (delivery.leaseMs <= matomo.requestTimeoutMs) {
    throw new ConfigError("delivery.lease_seconds must be greater than matomo.request_timeout_seconds");
  }
  d.done();

  const f = section(root, "filtering", false);
  const filtering: Config["filtering"] = {
    statusMin: f.int("allowed_status_min", 100, 599, 200),
    statusMax: f.int("allowed_status_max", 100, 599, 299),
    allowedMethods: f.strList("allowed_methods", ["GET"]).map((x) => x.toUpperCase()),
    excludePaths: f.strList("exclude_paths", ["/robots.txt", "/health", "/healthz"]),
    excludePrefixes: f.strList("exclude_prefixes", ["/_next/", "/api/"]),
    excludeExtensions: normalizeExtensions(f.strList("exclude_extensions", []), "filtering.exclude_extensions"),
    documentExtensions: normalizeExtensions(f.strList("document_extensions", [".pdf"]), "filtering.document_extensions"),
  };
  if (filtering.statusMin > filtering.statusMax) throw new ConfigError("filtering.allowed_status_min must be <= allowed_status_max");
  for (const p of [...filtering.excludePaths, ...filtering.excludePrefixes]) {
    if (!p.startsWith("/")) throw new ConfigError(`filtering: path "${p}" must start with "/"`);
  }
  const overlap = filtering.documentExtensions.filter((e) => filtering.excludeExtensions.includes(e));
  if (overlap.length > 0) {
    throw new ConfigError(`filtering: extension(s) both excluded and documents: ${overlap.join(", ")}`);
  }
  f.done();

  const a = section(root, "ai_assistants", false);
  const assistants = validateUaList(a.strList("user_agents", MATOMO_AI_ASSISTANTS), "ai_assistants.user_agents");
  // Assistants are matched as substrings (like Matomo), so short generic names are refused.
  for (const ua of assistants) {
    if (ua.length < MIN_ASSISTANT_NAME_LENGTH) {
      throw new ConfigError(`ai_assistants.user_agents: "${ua}" is too short (min ${MIN_ASSISTANT_NAME_LENGTH} characters)`);
    }
  }
  a.done();
  const t = section(root, "training_crawlers", false);
  const trainingCrawlers = validateUaList(t.strList("user_agents", DEFAULT_CRAWLERS), "training_crawlers.user_agents");
  t.done();
  const lowerCrawlers = new Set(trainingCrawlers.map((x) => x.toLowerCase()));
  const conflict = assistants.filter((x) => lowerCrawlers.has(x.toLowerCase()));
  if (conflict.length > 0) throw new ConfigError(`user agent(s) both allowed and excluded: ${conflict.join(", ")}`);

  const dbg = section(root, "debug", false);
  const debug: Config["debug"] = {
    logTracked: dbg.bool("log_tracked", false),
    logExcludedCrawlers: dbg.bool("log_excluded_crawlers", false),
  };
  dbg.done();

  return { matomo, log, storage, server, delivery, filtering, assistants, trainingCrawlers, debug };
}

export function loadConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read config file ${path}: ${(err as NodeJS.ErrnoException).code ?? "error"}`);
  }
  return parseConfig(text);
}

const MAX_TOKEN_FILE_BYTES = 4096;

/** Reads the Matomo token from a secret file. Errors never include file content. */
export function loadToken(path: string): string {
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new ConfigError(`token file ${path} is not a regular file`);
    size = st.size;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`cannot read token file ${path}: ${(err as NodeJS.ErrnoException).code ?? "error"}`);
  }
  if (size > MAX_TOKEN_FILE_BYTES) throw new ConfigError(`token file ${path} is too large`);
  let token: string;
  try {
    token = readFileSync(path, "utf8").trim();
  } catch (err) {
    throw new ConfigError(`cannot read token file ${path}: ${(err as NodeJS.ErrnoException).code ?? "error"}`);
  }
  if (!/^[A-Za-z0-9]{16,128}$/.test(token)) {
    throw new ConfigError(`token file ${path} does not contain a valid token (expected 16-128 alphanumeric characters)`);
  }
  return token;
}
