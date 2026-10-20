import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type Config } from "../src/config.ts";
import type { TrackEvent } from "../src/filter.ts";

export const TEST_TOKEN = "testtoken0123456789abcdef01234567";
export const CHATGPT_UA =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
export const PERPLEXITY_UA =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)";
export const GPTBOT_UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot";
export const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";

export function tempDir(prefix = "maat-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface TestConfigOptions {
  dir: string;
  endpoint?: string;
  extra?: Record<string, Record<string, unknown>>;
}

function tomlValue(v: unknown): string {
  return JSON.stringify(v);
}

/** Builds a TOML config pointing at temp paths and a loopback (never production) endpoint. */
export function testConfigToml(opts: TestConfigOptions): string {
  const sections: Record<string, Record<string, unknown>> = {
    matomo: {
      endpoint: opts.endpoint ?? "http://127.0.0.1:9/matomo.php",
      site_id: 7,
      token_file: join(opts.dir, "token"),
      request_timeout_seconds: 2,
      allow_insecure_localhost_for_tests: true,
    },
    log: {
      path: join(opts.dir, "logs", "example.com.log"),
      expected_host: "example.com",
      start_position: "beginning",
      poll_interval_ms: 50,
      rotation_grace_ms: 100,
    },
    storage: { database_path: join(opts.dir, "data", "queue.sqlite3"), max_queue_events: 1000 },
    server: { health_listen: "127.0.0.1:0" },
    delivery: {
      workers: 2,
      max_attempts: 3,
      initial_backoff_seconds: 0.01,
      max_backoff_seconds: 0.05,
      lease_seconds: 5,
      idle_poll_ms: 20,
      shutdown_timeout_seconds: 2,
    },
    filtering: {
      exclude_extensions: [".css", ".js", ".map", ".png", ".jpg", ".svg", ".ico", ".woff2"],
    },
  };
  for (const [name, values] of Object.entries(opts.extra ?? {})) {
    sections[name] = { ...sections[name], ...values };
  }
  return Object.entries(sections)
    .map(([name, values]) => `[${name}]\n${Object.entries(values).map(([k, v]) => `${k} = ${tomlValue(v)}`).join("\n")}`)
    .join("\n\n");
}

export function testConfig(opts: TestConfigOptions): Config {
  return parseConfig(testConfigToml(opts));
}

export function writeToken(dir: string, token = TEST_TOKEN): void {
  writeFileSync(join(dir, "token"), token + "\n", { mode: 0o600 });
}

export interface LineOptions {
  ua?: string;
  host?: string;
  uri?: string;
  method?: string;
  status?: number;
  ts?: number;
  size?: number;
  duration?: number;
}

/** A realistic Caddy v2 JSON access-log line, including fields that must never be forwarded. */
export function caddyLine(o: LineOptions = {}): string {
  return JSON.stringify({
    level: "info",
    ts: o.ts ?? 1_760_000_000.123456,
    logger: "http.log.access.log0",
    msg: "handled request",
    request: {
      remote_ip: "203.0.113.9",
      remote_port: "51234",
      client_ip: "203.0.113.9",
      proto: "HTTP/2.0",
      method: o.method ?? "GET",
      host: o.host ?? "example.com",
      uri: o.uri ?? "/de/arbeit?utm_source=chatgpt.com",
      headers: {
        "User-Agent": [o.ua ?? CHATGPT_UA],
        Cookie: ["session=secret-cookie"],
        Referer: ["https://referrer.example/private"],
        Authorization: ["Bearer secret-auth"],
        "X-Forwarded-For": ["198.51.100.7"],
      },
      tls: { resumed: false, version: 772, server_name: "example.com" },
    },
    bytes_read: 0,
    user_id: "",
    duration: o.duration ?? 0.0421,
    size: o.size ?? 5120,
    status: o.status ?? 200,
    resp_headers: { "Set-Cookie": ["a=b"], "Content-Type": ["text/html"] },
  });
}

let sampleCounter = 0;

/** Each call yields a distinct fingerprint unless one is given. */
export function sampleEvent(over: Partial<TrackEvent> = {}): TrackEvent {
  sampleCounter++;
  return {
    fingerprint: sampleCounter.toString(16).padStart(64, "0"),
    eventTs: 1_760_000_000.5,
    url: "https://example.com/de/arbeit",
    isDownload: false,
    ua: CHATGPT_UA,
    httpStatus: 200,
    bwBytes: 100,
    pfSrvMs: 12,
    ...over,
  };
}

export interface MockRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
  params: URLSearchParams;
}

/** Local Matomo stand-in. `respond` decides the status for each request (default 204). */
export class MockMatomo {
  readonly requests: MockRequest[] = [];
  respond: (req: MockRequest, index: number) => number | Promise<number> = () => 204;
  responseBody = "";
  private server: Server | null = null;
  url = "";

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const r: MockRequest = {
          method: req.method ?? "",
          url: req.url ?? "",
          headers: req.headers,
          body,
          params: new URLSearchParams(body),
        };
        const index = this.requests.length;
        this.requests.push(r);
        Promise.resolve(this.respond(r, index)).then(
          (status) => {
            if (res.destroyed) return;
            res.writeHead(status, { "content-type": "text/plain" });
            res.end(status === 204 ? undefined : this.responseBody);
          },
          () => res.destroy(),
        );
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    const port = (this.server.address() as AddressInfo).port;
    this.url = `http://127.0.0.1:${port}/matomo.php`;
    return this.url;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = null;
  }
}

export async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 20): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
