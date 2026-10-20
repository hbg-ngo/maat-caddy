import type { EventData } from "./filter.ts";

/**
 * `ambiguous` = Matomo may have recorded the request even though it failed
 * (e.g. timeout after sending). Retrying an ambiguous failure can create a
 * duplicate, because Matomo cannot deduplicate bot requests.
 */
export type SendResult =
  | { ok: true; status: number }
  | { ok: false; retryable: boolean; ambiguous: boolean; reason: string };

export interface MatomoClientOptions {
  endpoint: URL;
  siteId: number;
  token: string;
  source: string;
  timeoutMs: number;
  /** Send queuedtracking=0 (default true). */
  bypassQueuedTracking?: boolean;
  /** Max response bytes read before the body is discarded. */
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}

/** Fields Matomo bot tracking (recMode=1, Matomo >= 5.7) accepts. Nothing else is ever sent. */
export function buildPayload(
  ev: EventData,
  siteId: number,
  source: string,
  token: string,
  bypassQueuedTracking = true,
): URLSearchParams {
  const p = new URLSearchParams();
  p.set("idsite", String(siteId));
  p.set("rec", "1");
  p.set("recMode", "1");
  p.set("apiv", "1");
  p.set("send_image", "0");
  p.set("ua", ev.ua);
  p.set("url", ev.url);
  if (ev.isDownload) p.set("download", ev.url);
  p.set("cdt", String(Math.floor(ev.eventTs)));
  p.set("http_status", String(ev.httpStatus));
  p.set("bw_bytes", String(ev.bwBytes));
  if (ev.pfSrvMs !== null) p.set("pf_srv", String(ev.pfSrvMs));
  p.set("source", source);
  // Always authenticated: cdt older than 24h (backlog, retries, replays) requires token_auth.
  p.set("token_auth", token);
  // Process immediately instead of via the QueuedTracking plugin: its deferred
  // processing can lose token_auth and then silently drops events older than 24h.
  if (bypassQueuedTracking) p.set("queuedtracking", "0");
  return p;
}

/** Reads at most `max` bytes of a response body, then cancels the stream. Returns the byte count. */
export async function drainBounded(res: Response, max: number): Promise<number> {
  if (res.body === null) return 0;
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  let total = 0;
  try {
    while (total <= max) {
      const { done, value } = await reader.read();
      if (done) return total;
      total += value.byteLength;
    }
    return total;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Statuses that mean the request was not processed (safe to retry without duplicates). */
const NOT_PROCESSED_STATUSES = new Set([408, 425, 429, 503]);

export function classifyStatus(status: number): SendResult {
  if (status >= 200 && status < 300) return { ok: true, status };
  if (status >= 300 && status < 400) {
    return { ok: false, retryable: false, ambiguous: false, reason: `http_${status}_redirect` };
  }
  const retryable = isRetryableStatus(status);
  return {
    ok: false,
    retryable,
    // A 5xx other than 503 may come from a proxy after Matomo already stored the request.
    ambiguous: retryable && !NOT_PROCESSED_STATUSES.has(status),
    reason: `http_${status}`,
  };
}

export class MatomoClient {
  private readonly opts: MatomoClientOptions & { maxResponseBytes: number; fetchImpl: typeof fetch };

  constructor(opts: MatomoClientOptions) {
    this.opts = { ...opts, maxResponseBytes: opts.maxResponseBytes ?? 16 * 1024, fetchImpl: opts.fetchImpl ?? fetch };
  }

  async send(ev: EventData, signal?: AbortSignal): Promise<SendResult> {
    const body = buildPayload(ev, this.opts.siteId, this.opts.source, this.opts.token, this.opts.bypassQueuedTracking ?? true);
    const timeout = AbortSignal.timeout(this.opts.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.opts.fetchImpl(this.opts.endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
        body: body.toString(),
        // Never follow redirects: a redirect could replay the token to another URL.
        redirect: "manual",
        signal: combined,
      });
    } catch (err) {
      // Shutdown abort and timeouts can happen after the request was sent.
      if (signal?.aborted) return { ok: false, retryable: true, ambiguous: true, reason: "aborted" };
      if (timeout.aborted) return { ok: false, retryable: true, ambiguous: true, reason: "timeout" };
      const reason = networkReason(err);
      return { ok: false, retryable: true, ambiguous: !isConnectFailure(reason), reason };
    }
    try {
      await drainBounded(res, this.opts.maxResponseBytes);
    } catch {
      // Body errors after a status was received do not change the outcome.
    }
    return classifyStatus(res.status);
  }
}

const TLS_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** Errors raised before a connection was established: the request was never sent. */
const CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export function isConnectFailure(reason: string): boolean {
  if (reason.startsWith("tls_")) return true;
  return reason.startsWith("network_") && CONNECT_CODES.has(reason.slice("network_".length));
}

/** Short, payload-free failure code (e.g. "network_ECONNREFUSED", "tls_CERT_HAS_EXPIRED"). */
function networkReason(err: unknown): string {
  const cause = err instanceof Error ? (err.cause as NodeJS.ErrnoException | undefined) : undefined;
  const code = cause?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)) {
    return TLS_CODES.has(code) ? `tls_${code}` : `network_${code}`;
  }
  return "network_error";
}
