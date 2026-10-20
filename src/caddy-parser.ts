/** Minimal subset of a Caddy JSON access-log entry. Nothing else is ever extracted. */
export interface AccessRecord {
  /** Unix time in seconds (may be fractional). */
  ts: number;
  status: number;
  /** Response body bytes. */
  size: number;
  /** Request handling time in seconds, if present. */
  durationSec: number | null;
  /** Lowercased host without port. */
  host: string;
  method: string;
  /** Raw request-target as logged by Caddy (path + optional query). */
  uri: string;
  userAgent: string;
}

export type ParseResult = { ok: true; record: AccessRecord } | { ok: false; reason: string };

const MIN_TS = 946_684_800; // 2000-01-01
const MAX_UA_LENGTH = 1024;
const MAX_URI_LENGTH = 8192;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseTs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return ms / 1000;
  }
  return null;
}

function headerValue(headers: unknown, name: string): string | null {
  if (!isObject(headers)) return null;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== lower) continue;
    if (Array.isArray(v) && v.length === 1 && typeof v[0] === "string") return v[0];
    return null; // missing, empty or ambiguous (multiple values)
  }
  return null;
}

export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end >= 0 ? h.slice(0, end + 1) : h;
  }
  const colon = h.lastIndexOf(":");
  if (colon >= 0 && /^\d*$/.test(h.slice(colon + 1))) h = h.slice(0, colon);
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/**
 * Parses one Caddy JSON log line defensively. Only whitelisted fields are read;
 * IPs, cookies, referrers, auth headers and other fields are never copied.
 */
export function parseCaddyLine(line: string, nowSec: number = Date.now() / 1000): ParseResult {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (!isObject(obj)) return { ok: false, reason: "not_object" };
  const req = obj["request"];
  if (!isObject(req)) return { ok: false, reason: "missing_request" };

  const ts = parseTs(obj["ts"]);
  if (ts === null || ts < MIN_TS || ts > nowSec + 86_400) return { ok: false, reason: "invalid_ts" };

  const status = obj["status"];
  if (typeof status !== "number" || !Number.isInteger(status) || status < 0 || status > 999) {
    return { ok: false, reason: "invalid_status" };
  }
  const sizeRaw = obj["size"];
  const size = typeof sizeRaw === "number" && Number.isFinite(sizeRaw) && sizeRaw >= 0 ? Math.floor(sizeRaw) : 0;
  const durRaw = obj["duration"];
  const durationSec = typeof durRaw === "number" && Number.isFinite(durRaw) && durRaw >= 0 ? durRaw : null;

  const host = req["host"];
  const method = req["method"];
  const uri = req["uri"];
  if (typeof host !== "string" || host.length === 0 || host.length > 255) return { ok: false, reason: "invalid_host" };
  if (typeof method !== "string" || !/^[A-Za-z]{1,16}$/.test(method)) return { ok: false, reason: "invalid_method" };
  if (typeof uri !== "string" || uri.length === 0 || uri.length > MAX_URI_LENGTH) return { ok: false, reason: "invalid_uri" };

  const ua = headerValue(req["headers"], "User-Agent") ?? "";

  return {
    ok: true,
    record: {
      ts,
      status,
      size,
      durationSec,
      host: normalizeHost(host),
      method: method.toUpperCase(),
      uri,
      userAgent: ua.slice(0, MAX_UA_LENGTH),
    },
  };
}
