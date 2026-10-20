import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface HealthReport {
  healthy: boolean;
  body: Record<string, unknown>;
}

export interface HealthSource {
  health(): HealthReport;
  metrics(): Record<string, unknown>;
}

/** Loopback-only health and aggregate-metrics endpoint. GET /health, GET /metrics. */
export class HealthServer {
  private readonly server: Server;
  private readonly source: HealthSource;

  constructor(source: HealthSource) {
    this.source = source;
    this.server = createServer((req, res) => {
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(body));
      };
      if (req.method !== "GET") return reply(405, { error: "method not allowed" });
      try {
        if (req.url === "/health") {
          const h = this.source.health();
          return reply(h.healthy ? 200 : 503, h.body);
        }
        if (req.url === "/metrics") return reply(200, this.source.metrics());
      } catch {
        return reply(500, { error: "internal error" });
      }
      return reply(404, { error: "not found" });
    });
    this.server.requestTimeout = 5000;
    this.server.headersTimeout = 5000;
    this.server.maxHeadersCount = 50;
  }

  async listen(host: string, port: number): Promise<AddressInfo> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    return this.server.address() as AddressInfo;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
