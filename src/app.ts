import { parseCaddyLine } from "./caddy-parser.ts";
import { Classifier } from "./classifier.ts";
import type { Config } from "./config.ts";
import { normalizeUrl, RequestFilter, type TrackEvent } from "./filter.ts";
import { Follower } from "./follower.ts";
import { HealthServer, type HealthReport } from "./health.ts";
import { describeError, log, RateLimitedLogger, registerSecret, setLogLevel } from "./log.ts";
import { MatomoClient } from "./matomo.ts";
import { Metrics } from "./metrics.ts";
import { Store, type QueuedEvent, type StoreOptions } from "./store.ts";
import { WorkerPool, type Sender } from "./worker.ts";

const DAY_MS = 86_400_000;
const RETENTION_INTERVAL_MS = 3_600_000;

export function storeOptions(config: Config): StoreOptions {
  return {
    maxQueueEvents: config.storage.maxQueueEvents,
    seenRetentionMs: config.storage.seenRetentionDays * DAY_MS,
  };
}

export interface AppOptions {
  /** Override the Matomo sender (tests). */
  sender?: Sender;
}

const DEBUG_LOG_MAX = 20;
const DEBUG_LOG_WINDOW_MS = 60_000;

export interface LineProcessorOptions {
  /** Debug-log skipped training-crawler requests (rate-limited). */
  logExcludedCrawlers?: boolean;
}

/** Builds the line -> event pipeline: strict parse, filters and counters. */
export function createLineProcessor(
  config: Config,
  metrics: Metrics,
  opts: LineProcessorOptions = {},
): (line: string) => TrackEvent | null {
  const filter = new RequestFilter(config, new Classifier(config.assistants, config.trainingCrawlers));
  const malformed = new RateLimitedLogger(5, 60_000);
  const crawlerLog = opts.logExcludedCrawlers ? new RateLimitedLogger(DEBUG_LOG_MAX, DEBUG_LOG_WINDOW_MS) : null;
  return (line) => {
    const parsed = parseCaddyLine(line);
    if (!parsed.ok) {
      metrics.inc("lines_malformed");
      // Never log line content: only the reason and length.
      malformed.log("warn", "skipping malformed log line", { reason: parsed.reason, length: line.length });
      return null;
    }
    const decision = filter.decide(parsed.record);
    if (!decision.qualifies) {
      metrics.inc(`skipped_${decision.reason}`);
      if (crawlerLog !== null && decision.reason === "excluded_crawler") {
        // URL without query string, no IP or raw line.
        crawlerLog.log("debug", "training crawler excluded", {
          crawler: decision.crawler,
          url: normalizeUrl(config.log.expectedHost, parsed.record.uri, true)?.url ?? null,
          httpStatus: parsed.record.status,
          eventTs: parsed.record.ts,
        });
      }
      return null;
    }
    return decision.event;
  };
}

/** Debug-logs events Matomo accepted (rate-limited). The assistant name is re-derived from the UA. */
export function trackedLogger(config: Config): (ev: QueuedEvent) => void {
  const classifier = new Classifier(config.assistants, config.trainingCrawlers);
  const limiter = new RateLimitedLogger(DEBUG_LOG_MAX, DEBUG_LOG_WINDOW_MS);
  return (ev) => {
    const cls = classifier.classify(ev.ua);
    limiter.log("debug", "event tracked", {
      assistant: cls.kind === "assistant" ? cls.name : null,
      url: ev.url,
      httpStatus: ev.httpStatus,
      eventTs: ev.eventTs,
      attempts: ev.attempts,
    });
  };
}

export class App {
  readonly config: Config;
  readonly metrics = new Metrics();
  readonly store: Store;
  readonly follower: Follower;
  readonly workers: WorkerPool;
  private readonly health: HealthServer;
  private retentionTimer: NodeJS.Timeout | undefined;
  private readonly startedAt = Date.now();
  private stopping: Promise<void> | null = null;

  constructor(config: Config, token: string, opts: AppOptions = {}) {
    this.config = config;
    registerSecret(token);
    if (config.debug.logTracked || config.debug.logExcludedCrawlers) setLogLevel("debug");
    this.store = new Store(config.storage.databasePath, storeOptions(config));
    const sender =
      opts.sender ??
      new MatomoClient({
        endpoint: config.matomo.endpoint,
        siteId: config.matomo.siteId,
        token,
        source: config.matomo.source,
        bypassQueuedTracking: config.matomo.bypassQueuedTracking,
        timeoutMs: config.matomo.requestTimeoutMs,
      });
    this.workers = new WorkerPool({
      store: this.store,
      sender,
      metrics: this.metrics,
      workers: config.delivery.workers,
      maxAttempts: config.delivery.maxAttempts,
      initialBackoffMs: config.delivery.initialBackoffMs,
      maxBackoffMs: config.delivery.maxBackoffMs,
      leaseMs: config.delivery.leaseMs,
      idlePollMs: config.delivery.idlePollMs,
      onAmbiguousFailure: config.delivery.onAmbiguousFailure,
      ...(config.debug.logTracked ? { onDelivered: trackedLogger(config) } : {}),
    });
    this.follower = new Follower({
      path: config.log.path,
      store: this.store,
      processLine: createLineProcessor(config, this.metrics, { logExcludedCrawlers: config.debug.logExcludedCrawlers }),
      metrics: this.metrics,
      maxLineBytes: config.log.maxLineBytes,
      batchLines: config.log.batchLines,
      pollIntervalMs: config.log.pollIntervalMs,
      rotationGraceMs: config.log.rotationGraceMs,
      startPosition: config.log.startPosition,
      onEnqueued: () => this.workers.notify(),
    });
    this.health = new HealthServer({ health: () => this.healthReport(), metrics: () => this.metricsReport() });
  }

  async start(): Promise<{ healthPort: number }> {
    const addr = await this.health.listen(this.config.server.healthHost, this.config.server.healthPort);
    this.runRetention();
    this.retentionTimer = setInterval(() => this.runRetention(), RETENTION_INTERVAL_MS);
    this.retentionTimer.unref();
    this.workers.start();
    this.follower.start();
    log("info", "tracker started", {
      path: this.config.log.path,
      endpoint: this.config.matomo.endpoint.origin,
      health: `${addr.address}:${addr.port}`,
      workers: this.config.delivery.workers,
    });
    return { healthPort: addr.port };
  }

  /** Graceful shutdown: follower first (checkpoint stays consistent), then workers, then DB. */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      log("info", "shutting down");
      clearInterval(this.retentionTimer);
      await this.follower.stop();
      await this.workers.stop(this.config.delivery.shutdownTimeoutMs);
      await this.health.close();
      this.store.close();
      log("info", "shutdown complete");
    })();
    return this.stopping;
  }

  private runRetention(): void {
    try {
      const removed = this.store.cleanup(
        this.config.storage.deliveredRetentionDays * DAY_MS,
        this.config.storage.deadLetterRetentionDays * DAY_MS,
      );
      if (removed.delivered + removed.dead + removed.seen > 0) log("info", "retention cleanup", removed);
    } catch (err) {
      log("error", "retention cleanup failed", { error: describeError(err) });
    }
  }

  private healthReport(): HealthReport {
    const pollAge = Date.now() - this.follower.lastPollAt;
    const followerOk = pollAge < Math.max(10_000, this.config.log.pollIntervalMs * 10);
    let dbOk = true;
    try {
      this.store.db.prepare("SELECT 1").get();
    } catch {
      dbOk = false;
    }
    const healthy = followerOk && dbOk && this.stopping === null;
    return { healthy, body: { status: healthy ? "ok" : "unhealthy", followerOk, dbOk } };
  }

  private metricsReport(): Record<string, unknown> {
    const snap = this.metrics.snapshot();
    return {
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      queue: this.store.stats(),
      inFlight: this.workers.inFlight,
      followerLastPollAt: this.follower.lastPollAt,
      ...snap,
    };
  }
}
