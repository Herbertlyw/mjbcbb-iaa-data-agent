import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import mysql from "mysql2/promise";
import { openRuntime } from "./helpers.js";
import type { ProviderStepBegin } from "../src/state-store.js";

test("MySQL 事务里并发预留、重复结算、冲突、缺用量和旧围栏不会放宽额度", async () => {
  const port = await freePort();
  const password = randomBytes(12).toString("hex");
  const name = `lumenfox-budget-${randomUUID()}`;
  const dir = mkdtempSync(path.join(tmpdir(), "lumenfox-budget-"));
  await docker(["run", "--pull=never", "-d", "--name", name, "--tmpfs", "/var/lib/mysql:rw,size=1g", "-p", `127.0.0.1:${port}:3306`, "-e", `MYSQL_ROOT_PASSWORD=${password}`, "-e", "MYSQL_DATABASE=lumenfox_it", "-e", "MYSQL_USER=lumenfox_it", "-e", `MYSQL_PASSWORD=${password}`, "mysql:8.0.32"]);
  try {
    await waitMysql(port, password);
    const runtime = openRuntime(dir, {
      stateMode: "mysql",
      mysqlHost: "127.0.0.1",
      mysqlPort: port,
      mysqlUser: "lumenfox_it",
      mysqlPassword: password,
      mysqlDatabase: "lumenfox_it",
      redisHost: "127.0.0.1",
      redisPassword: password,
      startWorker: false,
    });
    const session = await runtime.sessions.createAsync("analyst");
    const state = await runtime.mysqlAsyncState();
    const job = await runtime.jobs.submitForSessionAsync(session.session_id, "预算争抢", "budget-key");
    const claim = (await state.call("claimJob", job.job_id, "worker-a", Date.now(), 60_000));
    assert.ok(claim);
    const connection = { host: "127.0.0.1", port, user: "lumenfox_it", password, database: "lumenfox_it" };
    const input = (stepId: string): ProviderStepBegin => ({
      stepId,
      sessionId: session.session_id,
      jobId: job.job_id,
      actorId: "demo-analyst",
      owner: "worker-a",
      fence: claim.fence,
      provider: "openai-compatible",
      model: "local-protocol",
      estimatedInput: 100,
      reservedOutput: 100,
      estimateSource: "char_estimate",
      contextWindow: 8000,
      maxTokens: 250,
      maxModelCalls: 4,
      maxToolCalls: 8,
      wallClockMs: 60_000,
      maxResourceBytes: 1000,
    });
    const raced = await Promise.all([
      race(connection, input("step_a")),
      race(connection, input("step_b")),
    ]);
    const wins = raced.filter((item) => item.ok);
    const losses = raced.filter((item) => !item.ok);
    assert.equal(wins.length, 1);
    assert.equal(losses.length, 1);
    assert.equal(losses[0]?.code, "budget_exhausted");
    const budget = (await state.call("getTurnBudget", job.job_id));
    assert.equal(budget?.reserved_tokens, 200);
    assert.equal(budget?.model_calls_reserved, 1);
    const winner = wins[0]?.code === "reserved" ? (raced[0]?.ok ? "step_a" : "step_b") : "step_a";
    const stepId = raced[0]?.ok ? "step_a" : "step_b";
    const duplicate = (await state.call("settleProviderStep", {
      stepId,
      jobId: job.job_id,
      owner: "worker-a",
      fence: claim.fence,
      status: "completed",
      inputTokens: 21,
      outputTokens: 9,
      usageSource: "simulated",
      durationMs: 5,
      errorCode: null,
    }));
    assert.equal(duplicate.ok, true);
    const again = (await state.call("settleProviderStep", {
      stepId,
      jobId: job.job_id,
      owner: "worker-a",
      fence: claim.fence,
      status: "completed",
      inputTokens: 21,
      outputTokens: 9,
      usageSource: "simulated",
      durationMs: 5,
      errorCode: null,
    }));
    assert.equal(again.code, "idempotent");
    const conflict = (await state.call("settleProviderStep", {
      stepId,
      jobId: job.job_id,
      owner: "worker-a",
      fence: claim.fence,
      status: "completed",
      inputTokens: 99,
      outputTokens: 9,
      usageSource: "simulated",
      durationMs: 5,
      errorCode: null,
    }));
    assert.equal(conflict.code, "settlement_conflict");
    const after = (await state.call("getTurnBudget", job.job_id));
    assert.equal(after?.settled_input, 21);
    assert.equal(after?.settled_output, 9);
    assert.equal(after?.reserved_tokens, 0);
    const heldBegin = (await state.call("beginProviderStep", input("step_hold")));
    assert.equal(heldBegin.ok, true, heldBegin.code);
    const missing = (await state.call("settleProviderStep", {
      stepId: "step_hold",
      jobId: job.job_id,
      owner: "worker-a",
      fence: claim.fence,
      status: "completed",
      inputTokens: null,
      outputTokens: null,
      usageSource: "unknown",
      durationMs: 5,
      errorCode: null,
    }));
    assert.equal(missing.code, "held");
    const blocked = (await state.call("beginProviderStep", input("step_after_hold")));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "token_budget_unknown");
    assert.equal((await state.call("getTurnBudget", job.job_id))?.reserved_tokens, 200);
    const oldFence = (await state.call("settleProviderStep", {
      stepId: "step_hold",
      jobId: job.job_id,
      owner: "worker-a",
      fence: claim.fence - 1,
      status: "completed",
      inputTokens: 1,
      outputTokens: 1,
      usageSource: "simulated",
      durationMs: 1,
      errorCode: null,
    }));
    assert.equal(oldFence.ok, false);
    assert.equal(oldFence.code, "provider_fence_rejected");
    const step = (await state.call("listProviderSteps", job.job_id)).find((item) => item.step_id === "step_hold");
    assert.equal(step?.settlement, "held_unknown");
    assert.equal(step?.input_tokens, null);
    assert.notEqual(winner, "");
    await runtime.close({ abandon: true });
  } finally {
    await docker(["rm", "-f", name]);
    rmSync(dir, { recursive: true, force: true });
  }
});

function race(connection: { host: string; port: number; user: string; password: string; database: string }, input: ProviderStepBegin) {
  return new Promise<{ ok: boolean; code: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "tests/budget-racer.ts", JSON.stringify(connection), JSON.stringify(input)], {
      cwd: path.join(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(stderr || stdout));
      else resolve(JSON.parse(stdout) as { ok: boolean; code: string });
    });
  });
}

function docker(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("docker", args, { stdio: "ignore" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`docker ${code}`))));
  });
}

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
    server.on("error", reject);
  });
}

async function waitMysql(port: number, password: string) {
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    try {
      const connection = await mysql.createConnection({ host: "127.0.0.1", port, user: "lumenfox_it", password, database: "lumenfox_it" });
      await connection.query("SELECT 1");
      await connection.end();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("mysql not ready");
}
