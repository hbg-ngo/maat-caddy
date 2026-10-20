import { describeError, log, RateLimitedLogger } from "./log.ts";
import type { SendResult } from "./matomo.ts";
import type { AmbiguousFailurePolicy } from "./config.ts";
import type { Metrics } from "./metrics.ts";
import type { QueuedEvent, Store } from "./store.ts";
import type { EventData } from "./filter.ts";

export interface Sender {
  send(ev: EventData, signal?: AbortSignal): Promise<SendResult>;
}

export interface WorkerPoolOptions {
  store: Store;
  sender: Sender;
  metrics: Metrics;
  workers: number;
  maxAttempts: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  leaseMs: number;
  idlePollMs: number;
  /** Default "retry" (at-least-once). */
  onAmbiguousFailure?: AmbiguousFailurePolicy;
  /** Called after Matomo accepted an event and it was acked. */
  onDelivered?: (ev: QueuedEvent) => void;
  now?: () => number;
  random?: () => number;
}

/**
 * Capped exponential backoff with "equal jitter": half the capped delay is
 * fixed, the other half random, so retries spread out but never fire instantly.
 */
export function backoffMs(attempt: number, initialMs: number, maxMs: number, random: () => number = Math.random): number {
  const exp = Math.min(maxMs, initialMs * 2 ** Math.max(0, Math.min(attempt - 1, 52)));
  const half = exp / 2;
  return Math.round(half + random() * half);
}

export class WorkerPool {
  private readonly opts: WorkerPoolOptions;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly errors = new RateLimitedLogger(5, 60_000);
  private stopping = false;
  private readonly abort = new AbortController();
  private loops: Promise<void>[] = [];
  private readonly wakers = new Set<() => void>();
  inFlight = 0;

  constructor(opts: WorkerPoolOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
  }

  start(): void {
    for (let i = 0; i < this.opts.workers; i++) this.loops.push(this.loop());
  }

  /** Wake idle workers (e.g. after new events were enqueued). */
  notify(): void {
    for (const w of this.wakers) w();
  }

  /**
   * Stops claiming new work and waits for in-flight deliveries until the
   * deadline. Deliveries still running at the deadline are aborted and their
   * events released back to the queue.
   */
  async stop(deadlineMs: number): Promise<void> {
    this.stopping = true;
    this.notify();
    const all = Promise.all(this.loops);
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      all.then(() => false),
      new Promise<boolean>((r) => (timer = setTimeout(() => r(true), deadlineMs))),
    ]);
    clearTimeout(timer);
    if (timedOut) {
      log("warn", "shutdown deadline reached; aborting in-flight deliveries", { inFlight: this.inFlight });
      this.abort.abort();
      await all;
    }
    this.loops = [];
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.wakers.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.wakers.add(done);
    });
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      let worked = false;
      try {
        worked = await this.runOnce();
      } catch (err) {
        this.opts.metrics.inc("worker_errors");
        this.errors.log("error", "delivery worker error", { error: describeError(err) });
      }
      if (!worked && !this.stopping) await this.sleep(this.opts.idlePollMs);
    }
  }

  /** Claims and processes one event. Returns false if nothing was due. Exposed for tests. */
  async runOnce(): Promise<boolean> {
    const { store, metrics } = this.opts;
    const ev = store.claim(this.opts.leaseMs);
    if (ev === null) return false;
    if (ev.unsettledSend) {
      // A previous holder crashed or lost its lease mid-request: Matomo may have it already.
      metrics.inc("deliveries_ambiguous");
      if (this.policy === "dead_letter") {
        this.deadLetter(ev, "ambiguous_lease_expired");
        return true;
      }
    }
    if (ev.attempts > this.opts.maxAttempts) {
      // Lease expired repeatedly (e.g. crashes mid-delivery) until attempts were exhausted.
      this.deadLetter(ev, "lease_expired_exhausted");
      return true;
    }
    if (!store.markSending(ev.id, ev.leaseToken)) {
      metrics.inc("lease_lost");
      return true;
    }
    this.inFlight++;
    let result: SendResult;
    try {
      result = await this.opts.sender.send(ev, this.abort.signal);
    } finally {
      this.inFlight--;
    }
    this.settle(ev, result);
    return true;
  }

  private get policy(): AmbiguousFailurePolicy {
    return this.opts.onAmbiguousFailure ?? "retry";
  }

  private settle(ev: QueuedEvent, result: SendResult): void {
    const { store, metrics } = this.opts;
    if (result.ok) {
      if (store.ack(ev.id, ev.leaseToken)) {
        metrics.inc("deliveries_ok");
        metrics.set("last_delivery_at", this.now());
        this.opts.onDelivered?.(ev);
      } else {
        metrics.inc("lease_lost");
      }
      return;
    }
    if (!result.retryable) {
      this.deadLetter(ev, result.reason);
      return;
    }
    if (result.ambiguous) {
      metrics.inc("deliveries_ambiguous");
      if (this.policy === "dead_letter") {
        this.deadLetter(ev, `ambiguous_${result.reason}`);
        return;
      }
    }
    if (result.reason === "aborted") {
      // Shutdown deadline: back to the queue without consuming an attempt.
      store.release(ev.id, ev.leaseToken);
      return;
    }
    if (ev.attempts >= this.opts.maxAttempts) {
      this.deadLetter(ev, `exhausted_${result.reason}`);
      return;
    }
    const delay = backoffMs(ev.attempts, this.opts.initialBackoffMs, this.opts.maxBackoffMs, this.random);
    if (store.retry(ev.id, ev.leaseToken, this.now() + delay, result.reason)) metrics.inc("deliveries_retried");
    this.errors.log("warn", "delivery failed; will retry", {
      reason: result.reason,
      ambiguous: result.ambiguous,
      attempt: ev.attempts,
      delayMs: delay,
    });
  }

  private deadLetter(ev: QueuedEvent, reason: string): void {
    if (this.opts.store.deadLetter(ev.id, ev.leaseToken, reason)) this.opts.metrics.inc("deliveries_dead");
    this.errors.log("warn", "event dead-lettered", { reason, attempts: ev.attempts });
  }
}
