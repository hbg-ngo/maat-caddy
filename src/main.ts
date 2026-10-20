import { parseArgs } from "node:util";
import { App, createLineProcessor } from "./app.ts";
import { Importer, parseDateArg } from "./importer.ts";
import { ConfigError, loadConfig, loadToken, type Config } from "./config.ts";
import { describeError, log, setLogSink } from "./log.ts";
import { Store } from "./store.ts";

const USAGE = `Usage: maat-caddy [--config <path>] [command]

Commands:
  run                                   Follow the log and deliver events (default)
  check-config                          Validate config and token file, then exit
  queue stats                           Print aggregate queue counts
  deadletter stats                      Print dead-letter counts by reason
  deadletter replay [--reason <code>] [--limit <n>]
                                        Move dead-lettered events back to the queue
  import <file>... [--dry-run] [--since <date>] [--until <date>]
                                        Queue events from historic (plain or .gz) logs;
                                        already-queued requests are always skipped.
                                        The running daemon delivers them.

The config path defaults to $CONFIG_PATH. The Matomo token is read from
$MATOMO_TOKEN_FILE or matomo.token_file; it is never accepted as an argument.`;

function print(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function tokenPath(config: Config): string {
  return process.env["MATOMO_TOKEN_FILE"] ?? config.matomo.tokenFile;
}

async function run(config: Config): Promise<number> {
  if (process.env["NODE_TLS_REJECT_UNAUTHORIZED"] === "0") {
    throw new ConfigError("NODE_TLS_REJECT_UNAUTHORIZED=0 is not allowed; TLS validation must stay enabled");
  }
  if (process.getuid?.() === 0) log("warn", "running as root is not recommended");
  const token = loadToken(tokenPath(config));
  const app = new App(config, token);

  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((r) => (resolveExit = r));
  let signalled = false;
  const onSignal = (sig: NodeJS.Signals) => {
    if (signalled) {
      log("warn", "second signal received; exiting immediately", { signal: sig });
      process.exit(1);
    }
    signalled = true;
    log("info", "signal received", { signal: sig });
    app.stop().then(
      () => resolveExit(0),
      (err: unknown) => {
        log("error", "shutdown failed", { error: describeError(err) });
        resolveExit(1);
      },
    );
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  try {
    await app.start();
  } catch (err) {
    await app.stop().catch(() => undefined);
    throw err;
  }
  return exited;
}

function withStore<T>(config: Config, fn: (store: Store) => T): T {
  const store = new Store(config.storage.databasePath, { maxQueueEvents: config.storage.maxQueueEvents });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

async function runImport(
  config: Config,
  files: string[],
  values: { "dry-run"?: boolean; since?: string; until?: string },
): Promise<number> {
  if (files.length === 0) throw new ConfigError("import: no files given");
  const since = values.since === undefined ? null : parseDateArg(values.since, "--since");
  const until = values.until === undefined ? null : parseDateArg(values.until, "--until");
  if (since !== null && until !== null && since >= until) throw new ConfigError("--since must be before --until");
  // Keep stdout for the JSON report; diagnostics go to stderr.
  setLogSink((line) => process.stderr.write(line + "\n"));
  const store = new Store(config.storage.databasePath, { maxQueueEvents: config.storage.maxQueueEvents });
  try {
    const importer = new Importer({
      store,
      lineProcessor: (metrics) => createLineProcessor(config, metrics),
      maxLineBytes: config.log.maxLineBytes,
      batchSize: Math.min(config.log.batchLines, config.storage.maxQueueEvents),
      dryRun: values["dry-run"] ?? false,
      since,
      until,
      onProgress: (msg, fields) => log("info", msg, fields),
    });
    const result = await importer.importFiles(files);
    print({ dryRun: values["dry-run"] ?? false, ...result });
    return 0;
  } finally {
    store.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      reason: { type: "string" },
      limit: { type: "string" },
      "dry-run": { type: "boolean" },
      since: { type: "string" },
      until: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  const configPath = values.config ?? process.env["CONFIG_PATH"];
  if (!configPath) throw new ConfigError("no config path given (use --config or CONFIG_PATH)");
  const config = loadConfig(configPath);
  if (positionals[0] === "import") return runImport(config, positionals.slice(1), values);
  const command = positionals.join(" ") || "run";

  switch (command) {
    case "run":
      return run(config);
    case "check-config":
      loadToken(tokenPath(config));
      print({ ok: true });
      return 0;
    case "queue stats":
      print(withStore(config, (s) => s.stats()));
      return 0;
    case "deadletter stats":
      print(withStore(config, (s) => s.deadLetterStats()));
      return 0;
    case "deadletter replay": {
      const limit = values.limit === undefined ? 1_000_000 : Number(values.limit);
      if (!Number.isInteger(limit) || limit < 1) throw new ConfigError("--limit must be a positive integer");
      const replayed = withStore(config, (s) => s.replayDeadLetters(values.reason ?? null, limit));
      print({ replayed });
      return 0;
    }
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}\n`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    log("error", err instanceof ConfigError ? "invalid configuration" : "fatal error", { error: describeError(err) });
    process.exitCode = 1;
  },
);
