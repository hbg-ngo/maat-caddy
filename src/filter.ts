import { createHash } from "node:crypto";
import type { AccessRecord } from "./caddy-parser.ts";
import type { Classifier } from "./classifier.ts";
import type { Config } from "./config.ts";

/** The only data ever persisted or sent for a request. */
export interface EventData {
  /** Original request time, Unix seconds. */
  eventTs: number;
  /** Full normalized URL (query stripped by default). */
  url: string;
  /** True for configured document extensions; sent as Matomo `download`. */
  isDownload: boolean;
  ua: string;
  httpStatus: number;
  bwBytes: number;
  pfSrvMs: number | null;
}

export interface TrackEvent extends EventData {
  /** SHA-256 (hex) identifying the original request; used to never enqueue it twice. */
  fingerprint: string;
}

/**
 * Identifies one logged request using only data the tracker already keeps
 * (no IP, no query string unless configured): precise timestamp and duration
 * as logged, method, normalized URL, User-Agent, status and size.
 */
export function eventFingerprint(rec: AccessRecord, url: string): string {
  return createHash("sha256")
    .update(JSON.stringify([rec.ts, rec.durationSec, rec.method, url, rec.userAgent, rec.status, rec.size]))
    .digest("hex");
}

export type SkipReason =
  | "host"
  | "method"
  | "status"
  | "not_assistant"
  | "excluded_crawler"
  | "invalid_url"
  | "excluded_path"
  | "excluded_prefix"
  | "excluded_extension";

export type Decision =
  | { qualifies: true; event: TrackEvent }
  | { qualifies: false; reason: "excluded_crawler"; crawler: string }
  | { qualifies: false; reason: Exclude<SkipReason, "excluded_crawler"> };

export interface NormalizedUrl {
  pathname: string;
  url: string;
}

/** Resolves dot segments and percent-encoding so filters cannot be bypassed with "/a/../_next/". */
export function normalizeUrl(host: string, uri: string, stripQuery: boolean): NormalizedUrl | null {
  if (!uri.startsWith("/") || uri.startsWith("//")) return null;
  let parsed: URL;
  try {
    parsed = new URL(uri, `https://${host}`);
  } catch {
    return null;
  }
  if (parsed.host !== host) return null;
  parsed.hash = "";
  if (stripQuery) parsed.search = "";
  return { pathname: parsed.pathname, url: parsed.href };
}

function extensionOf(pathname: string): string {
  const segment = pathname.slice(pathname.lastIndexOf("/") + 1);
  const dot = segment.lastIndexOf(".");
  return dot > 0 ? segment.slice(dot).toLowerCase() : "";
}

export class RequestFilter {
  private readonly cfg: Config["filtering"];
  private readonly host: string;
  private readonly stripQuery: boolean;
  private readonly classifier: Classifier;
  private readonly excludePaths: Set<string>;

  constructor(config: Config, classifier: Classifier) {
    this.cfg = config.filtering;
    this.host = config.log.expectedHost;
    this.stripQuery = config.matomo.stripQueryString;
    this.classifier = classifier;
    this.excludePaths = new Set(config.filtering.excludePaths.map((p) => p.toLowerCase()));
  }

  private pathExcluded(pathname: string): "excluded_path" | "excluded_prefix" | "excluded_extension" | null {
    const p = pathname.toLowerCase();
    const trimmed = p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
    if (this.excludePaths.has(p) || this.excludePaths.has(trimmed)) return "excluded_path";
    for (const prefix of this.cfg.excludePrefixes) {
      const pre = prefix.toLowerCase();
      if (p.startsWith(pre) || (pre.endsWith("/") && p === pre.slice(0, -1))) return "excluded_prefix";
    }
    if (this.cfg.excludeExtensions.includes(extensionOf(p))) return "excluded_extension";
    return null;
  }

  decide(rec: AccessRecord): Decision {
    if (rec.host !== this.host) return { qualifies: false, reason: "host" };
    const cls = this.classifier.classify(rec.userAgent);
    if (cls.kind === "excluded_crawler") return { qualifies: false, reason: "excluded_crawler", crawler: cls.name };
    if (cls.kind !== "assistant") return { qualifies: false, reason: "not_assistant" };
    if (!this.cfg.allowedMethods.includes(rec.method)) return { qualifies: false, reason: "method" };
    if (rec.status < this.cfg.statusMin || rec.status > this.cfg.statusMax) return { qualifies: false, reason: "status" };

    const norm = normalizeUrl(this.host, rec.uri, this.stripQuery);
    if (norm === null) return { qualifies: false, reason: "invalid_url" };
    const excluded = this.pathExcluded(norm.pathname);
    if (excluded !== null) return { qualifies: false, reason: excluded };

    return {
      qualifies: true,
      event: {
        eventTs: rec.ts,
        url: norm.url,
        isDownload: this.cfg.documentExtensions.includes(extensionOf(norm.pathname.toLowerCase())),
        ua: rec.userAgent,
        httpStatus: rec.status,
        bwBytes: rec.size,
        pfSrvMs: rec.durationSec === null ? null : Math.round(rec.durationSec * 1000),
        fingerprint: eventFingerprint(rec, norm.url),
      },
    };
  }
}
