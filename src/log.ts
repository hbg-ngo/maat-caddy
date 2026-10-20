export type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const secrets = new Set<string>();
let minLevel: Level = "info";
let sink: (line: string) => void = (line) => process.stdout.write(line + "\n");

/** Register a value that must never appear in log output. */
export function registerSecret(value: string): void {
  if (value.length > 0) secrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("[REDACTED]");
  return out;
}

export function setLogLevel(level: Level): void {
  minLevel = level;
}

/** Test hook: capture log lines instead of writing to stdout. */
export function setLogSink(fn: (line: string) => void): void {
  sink = fn;
}

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const entry = { time: new Date().toISOString(), level, msg, ...fields };
  sink(redact(JSON.stringify(entry)));
}

/** Error description safe for logging: name/code/message only, redacted, length-capped. */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    const text = `${err.name}${code ? `(${code})` : ""}: ${err.message}`;
    return redact(text).slice(0, 300);
  }
  return redact(String(err)).slice(0, 300);
}

/** Limits a log message to `max` emissions per `windowMs`; counts suppressed ones. */
export class RateLimitedLogger {
  private windowStart = 0;
  private count = 0;
  private suppressed = 0;
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(max: number, windowMs: number, now: () => number = Date.now) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
  }

  log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
    const t = this.now();
    if (t - this.windowStart >= this.windowMs) {
      if (this.suppressed > 0) log(level, `${msg} (suppressed)`, { suppressed: this.suppressed });
      this.windowStart = t;
      this.count = 0;
      this.suppressed = 0;
    }
    if (this.count < this.max) {
      this.count++;
      log(level, msg, fields);
    } else {
      this.suppressed++;
    }
  }
}
