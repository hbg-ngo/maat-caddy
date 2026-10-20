import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { caddyLine, tempDir, testConfigToml, TEST_TOKEN, waitFor } from "../test-support/helpers.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const IMAGE = process.env["CONTAINER_TEST_IMAGE"] || "maat-caddy:test";
const NAME = `maat-test-${process.pid}`;

function dockerAvailable(): boolean {
  if (process.env["SKIP_CONTAINER_TESTS"] === "1") return false;
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

function docker(...args: string[]): { status: number | null; out: string } {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

const execIn = (...cmd: string[]) => docker("exec", NAME, ...cmd);

const skip = dockerAvailable() ? false : "docker not available (set SKIP_CONTAINER_TESTS=1 to skip explicitly)";

describe("container", { skip, timeout: 600_000 }, () => {
  const tmp = tempDir("maat-ctr-");
  const logs = join(tmp.dir, "logs");

  before(() => {
    if (!process.env["CONTAINER_TEST_IMAGE"]) {
      execFileSync("docker", ["build", "-q", "-t", IMAGE, "."], { cwd: root, stdio: "ignore" });
    }
    mkdirSync(logs);
    mkdirSync(join(tmp.dir, "data"));
    chmodSync(join(tmp.dir, "data"), 0o777);
    writeFileSync(join(logs, "example.com.log"), caddyLine({ uri: "/c1" }) + "\n");
    chmodSync(logs, 0o755);
    writeFileSync(join(tmp.dir, "token"), TEST_TOKEN + "\n", { mode: 0o444 });
    writeFileSync(
      join(tmp.dir, "config.toml"),
      testConfigToml({
        dir: tmp.dir,
        extra: {
          matomo: { token_file: "/run/secrets/matomo_token" },
          log: { path: "/var/log/caddy/example.com.log" },
          storage: { database_path: "/var/lib/maat-caddy/queue.sqlite3" },
          server: { health_listen: "127.0.0.1:9788" },
          delivery: { max_attempts: 1000, shutdown_timeout_seconds: 5 },
        },
      }),
    );
    const run = docker(
      "run", "-d", "--name", NAME,
      "--init", "--read-only", "--user", "10001:10001",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--pids-limit", "100", "--memory", "256m",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
      "-v", `${logs}:/var/log/caddy:ro`,
      "-v", `${join(tmp.dir, "config.toml")}:/etc/maat-caddy/config.toml:ro`,
      "-v", `${join(tmp.dir, "token")}:/run/secrets/matomo_token:ro`,
      "-v", `${join(tmp.dir, "data")}:/var/lib/maat-caddy`,
      "-e", "CONFIG_PATH=/etc/maat-caddy/config.toml",
      "-e", "MATOMO_TOKEN_FILE=/run/secrets/matomo_token",
      IMAGE,
    );
    assert.equal(run.status, 0, run.out);
  });

  after(() => {
    docker("rm", "-f", NAME);
    tmp.cleanup();
  });

  it("starts with the secret file and runs as non-root", async () => {
    await waitFor(() => docker("logs", NAME).out.includes("tracker started"), 30_000, 200);
    assert.equal(execIn("node", "-p", "process.getuid()").out.trim(), "10001");
    assert.ok(!docker("logs", NAME).out.includes(TEST_TOKEN), "token must not be logged");
  });

  it("serves health on container loopback only and publishes no ports", () => {
    const ok = execIn("node", "-e", "fetch('http://127.0.0.1:9788/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(2))");
    assert.equal(ok.status, 0, ok.out);
    const external = execIn(
      "node",
      "-e",
      "const ip=Object.values(require('os').networkInterfaces()).flat().find(i=>i.family==='IPv4'&&!i.internal).address;" +
        "fetch('http://'+ip+':9788/health').then(()=>process.exit(1),()=>process.exit(0))",
    );
    assert.equal(external.status, 0, "health must not be reachable on the container network interface");
    assert.equal(docker("port", NAME).out.trim(), "");
  });

  it("has a read-only root filesystem and read-only log mount", () => {
    const write = (path: string, flag: string) =>
      execIn("node", "-e", `require('fs').writeFileSync(${JSON.stringify(path)}, 'x', { flag: '${flag}' })`);
    assert.notEqual(write("/app/x", "w").status, 0);
    assert.notEqual(write("/var/log/caddy/example.com.log", "a").status, 0);
    assert.equal(write("/var/lib/maat-caddy/probe", "w").status, 0);
  });

  it("ships no shell", () => {
    assert.notEqual(execIn("sh", "-c", "true").status, 0);
  });

  it("follows the mounted log and enqueues events", async () => {
    appendFileSync(join(logs, "example.com.log"), caddyLine({ uri: "/c2" }) + "\n");
    await waitFor(
      () => {
        const m = execIn("node", "-e", "fetch('http://127.0.0.1:9788/metrics').then(r=>r.text()).then(t=>console.log(t))");
        return /"events_enqueued":2/.test(m.out);
      },
      15_000,
      300,
    );
  });

  it("sees rename/create rotation through the read-only directory mount", async () => {
    const live = join(logs, "example.com.log");
    appendFileSync(live, caddyLine({ uri: "/c3" }) + "\n");
    renameSync(live, join(logs, "example.com-2026-10-19T12-00-00.000.log"));
    writeFileSync(live, caddyLine({ uri: "/c4" }) + "\n");
    await waitFor(
      () => {
        const m = execIn("node", "-e", "fetch('http://127.0.0.1:9788/metrics').then(r=>r.text()).then(t=>console.log(t))");
        return /"events_enqueued":4/.test(m.out) && /"rotations":1/.test(m.out);
      },
      15_000,
      300,
    );
  });

  it("shuts down gracefully on SIGTERM", () => {
    const started = Date.now();
    assert.equal(docker("stop", "-t", "30", NAME).status, 0);
    assert.ok(Date.now() - started < 15_000);
    assert.equal(docker("inspect", "-f", "{{.State.ExitCode}}", NAME).out.trim(), "0");
    assert.match(docker("logs", NAME).out, /shutdown complete/);
  });
});
