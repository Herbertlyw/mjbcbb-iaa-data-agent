import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import mysql from "mysql2/promise";
import { openRuntime } from "./helpers.js";
import type { ProviderStepBegin } from "../src/state-store.js";

test("MySQL 事务里并发预留、重复结算、冲突、缺用量和旧围栏不会放宽额度", async () => {
  const password = randomBytes(12).toString("hex");
  const name = `lumenfox-budget-${randomUUID()}`;
  const dir = mkdtempSync(path.join(tmpdir(), "lumenfox-budget-"));
  try {
    // Ask Docker to allocate a loopback port atomically: closing a temporary
    // Node listener before docker run races with parallel integration tests.
    await docker(["run", "--pull=never", "-d", "--name", name, "--label", `dataagent.test.run=${name}`, "--tmpfs", "/var/lib/mysql:rw,size=1g", "-p", "127.0.0.1::3306", "-e", `MYSQL_ROOT_PASSWORD=${password}`, "-e", "MYSQL_DATABASE=lumenfox_it", "-e", "MYSQL_USER=lumenfox_it", "-e", `MYSQL_PASSWORD=${password}`, "mysql:8.0.32"]);
    const binding = await dockerOutput(["port", name, "3306/tcp"]);
    const port = Number(/^127\.0\.0\.1:(\d+)\s*$/u.exec(binding)?.[1]);
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, "MySQL must bind a random loopback port");
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
    assert.equal(await state.call("saveProviderPayload", { payloadId: `res_${stepId}`, stepId, sessionId: session.session_id, actorId: "demo-analyst", jobId: job.job_id, owner: "worker-a", fence: claim.fence, kind: "response", body: JSON.stringify({ format: "metadata-only", failed: false, usage_source: "simulated", input_tokens: 21, output_tokens: 9, cache_hit_tokens: 5, cache_miss_tokens: 16 }) }), true);
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
    const cached = (await state.call("listProviderSteps", job.job_id)).find((item) => item.step_id === stepId);
    assert.equal(cached?.cache_hit_tokens, 5); assert.equal(cached?.cache_miss_tokens, 16);
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
    assert.equal((await state.call("beginProviderStep", input("step_reported"))).ok, true);
    const reported = { stepId: "step_reported", jobId: job.job_id, owner: "worker-a", fence: claim.fence, status: "completed" as const, inputTokens: 10, outputTokens: 5, usageSource: "reported" as const, durationMs: 5, errorCode: null };
    assert.equal((await state.call("settleProviderStep", reported)).code, "settled");
    assert.equal((await state.call("settleProviderStep", reported)).code, "idempotent");
    assert.equal((await state.call("settleProviderStep", { ...reported, usageSource: "simulated" })).code, "settlement_conflict");
    assert.equal((await state.call("listProviderSteps", job.job_id)).find((item) => item.step_id === "step_reported")?.usage_source, "reported");
    assert.equal((await state.call("beginProviderStep", input("step_blocked"))).ok, true);
    const notSent = { stepId: "step_blocked", jobId: job.job_id, owner: "worker-a", fence: claim.fence, status: "not_dispatched" as const, inputTokens: null, outputTokens: null, usageSource: "unknown" as const, durationMs: 5, errorCode: "global_budget_exhausted" };
    assert.equal((await state.call("settleProviderStep", { ...notSent, fence: claim.fence - 1 })).code, "provider_fence_rejected");
    assert.equal((await state.call("settleProviderStep", notSent)).code, "not_dispatched");
    assert.equal((await state.call("settleProviderStep", notSent)).code, "idempotent");
    assert.equal((await state.call("settleProviderStep", { ...notSent, errorCode: "global_budget_active_mismatch" })).code, "settlement_conflict");
    assert.equal((await state.call("getTurnBudget", job.job_id))?.reserved_tokens, 0);
    assert.equal((await state.call("listProviderSteps", job.job_id)).find((item) => item.step_id === "step_blocked")?.status, "not_dispatched");
    assert.equal((await state.call("beginProviderStep", input("step_cancel_before_dispatch"))).ok, true);
    const cancelledBeforeDispatch = { ...notSent, stepId: "step_cancel_before_dispatch", errorCode: "provider_cancelled" };
    assert.equal((await state.call("settleProviderStep", { ...cancelledBeforeDispatch, errorCode: "provider_timeout" })).code, "settlement_conflict");
    assert.equal((await state.call("settleProviderStep", cancelledBeforeDispatch)).code, "not_dispatched");
    assert.equal((await state.call("settleProviderStep", cancelledBeforeDispatch)).code, "idempotent");
    assert.equal((await state.call("getTurnBudget", job.job_id))?.reserved_tokens, 0);
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
    const label = await dockerOutput(["inspect", "--format", '{{index .Config.Labels "dataagent.test.run"}}', name]).catch(() => "");
    if (label.trim() === name) await docker(["rm", "-f", name]);
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

function dockerOutput(args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(output) : reject(new Error(`docker ${code}`)));
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
