import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const guard = fileURLToPath(new URL("./network-guard.ts", import.meta.url));

/** Runs the tracker (src/main.ts) as a real child process with the network guard preloaded. */
export class Daemon {
  readonly output: string[] = [];
  private child: ChildProcess | null = null;
  private exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  healthPort = 0;
  private readonly configPath: string;
  exitCode: number | null = null;

  constructor(configPath: string) {
    this.configPath = configPath;
  }

  async start(): Promise<void> {
    const child = spawn(process.execPath, ["--import", guard, "src/main.ts", "--config", this.configPath], {
      cwd: root,
      env: { PATH: process.env["PATH"] ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        this.output.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    this.exit = new Promise((resolve) =>
      child.on("exit", (code, signal) => {
        this.exitCode = code;
        resolve({ code, signal });
      }),
    );
    const line = await this.waitForLine(/"msg":"tracker started"/, 10_000);
    const m = /"health":"127\.0\.0\.1:(\d+)"/.exec(line);
    this.healthPort = m ? Number(m[1]) : 0;
  }

  async waitForLine(re: RegExp, timeoutMs = 5000): Promise<string> {
    const start = Date.now();
    for (;;) {
      const found = this.output.find((l) => re.test(l));
      if (found) return found;
      if (this.exitCode !== null) throw new Error(`process exited with ${this.exitCode}; output:\n${this.output.join("\n")}`);
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${re}; output:\n${this.output.join("\n")}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async metrics(): Promise<{ counters: Record<string, number>; queue: Record<string, number> }> {
    const r = await fetch(`http://127.0.0.1:${this.healthPort}/metrics`);
    return (await r.json()) as { counters: Record<string, number>; queue: Record<string, number> };
  }

  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.exit === null) return { code: null, signal: null };
    this.child?.kill(signal);
    const result = await this.exit;
    this.child = null;
    return result;
  }
}
