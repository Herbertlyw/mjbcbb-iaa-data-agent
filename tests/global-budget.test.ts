import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { GlobalBudget, type GlobalBudgetOptions } from "../src/global-budget.js";

function fixture(maxRequests = 1, maxTokens = 1000) {
  const dir = mkdtempSync(path.join(tmpdir(), "dataagent-global-budget-"));
  const options: GlobalBudgetOptions = { path: path.join(dir, "budget.sqlite"), budgetId: "synthetic-test", maxRequests, maxTokens, timeoutMs: 10_000 };
  return { dir, options };
}
function racer(options: GlobalBudgetOptions, id: string) {
  return new Promise<{ ok: boolean; code: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "tests/global-budget-racer.ts", JSON.stringify(options), id], { cwd: path.resolve("."), stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errorOutput = ""; child.stdout.on("data", (chunk: Buffer) => { output += chunk; }); child.stderr.on("data", (chunk: Buffer) => { errorOutput += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(`racer failed ${code}: ${errorOutput}`)));
  });
}

test("跨进程并发、重启与重复派发不能绕过总请求预算", async () => {
  const { dir, options } = fixture();
  try {
    const init = await GlobalBudget.activate(options); await init.close();
    assert.equal(statSync(options.path).mode & 0o077, 0);
    const results = await Promise.all([racer(options, "step_a"), racer(options, "step_b")]);
    assert.equal(results.filter((item) => item.ok).length, 1);
    assert.equal(results.find((item) => !item.ok)?.code, "global_budget_exhausted");
    const winner = results[0]!.ok ? "step_a" : "step_b";
    const gate = await GlobalBudget.open(options);
    assert.equal((await gate.stats())?.requests_reserved, 1);
    assert.equal((await gate.stats())?.dispatched_count, 0);
    assert.deepEqual((await gate.pendingSteps()).map((row) => row.step_id), [winner]);
    assert.equal((await gate.reserve({ stepId: winner, jobId: `job_${winner}`, estimatedInput: 100, reservedOutput: 100 })).code, "global_budget_step_exists");
    assert.equal((await gate.markDispatched(winner)).code, "dispatched");
    assert.equal((await gate.stats())?.dispatched_count, 1);
    assert.equal((await gate.markDispatched(winner)).code, "global_budget_dispatch_rejected");
    assert.equal((await gate.closeScope()).code, "global_budget_pending");
    const usage = { stepId: winner, outcome: "completed" as const, inputTokens: 150, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: null, cacheHitTokens: 0, cacheMissTokens: 150 };
    assert.equal((await gate.settle(usage)).code, "settled");
    assert.deepEqual(await gate.pendingSteps(), []);
    assert.equal((await gate.settle(usage)).code, "idempotent");
    assert.equal((await gate.settle({ ...usage, inputTokens: 151 })).code, "global_budget_settlement_conflict");
    const saved = await gate.step(winner);
    assert.equal(saved?.input_tokens, 150); assert.equal(saved?.output_tokens, 20);
    assert.equal(saved?.cache_read_tokens, 0); assert.equal(saved?.cache_write_tokens, null);
    assert.equal(saved?.cache_hit_tokens, 0); assert.equal(saved?.cache_miss_tokens, 150);
    assert.equal((await gate.stats())?.accounted_tokens, 170);
    assert.equal((await gate.stats())?.cache_hit_tokens, 0); assert.equal((await gate.stats())?.cache_miss_tokens, 150);
    assert.equal((await gate.reserve({ stepId: "step_c", jobId: "job_c", estimatedInput: 1, reservedOutput: 1 })).code, "global_budget_exhausted");
    await assert.rejects(GlobalBudget.activate({ ...options, budgetId: "another-session" }), /global_budget_active_mismatch/);
    await assert.rejects(GlobalBudget.open({ ...options, maxRequests: 2 }), /global_budget_active_mismatch/);
    assert.equal((await gate.closeScope()).code, "closed"); await gate.close();
    const audit = await GlobalBudget.inspect(options);
    assert.equal((await audit.stats())?.status, "closed");
    assert.equal((await audit.step(winner))?.input_tokens, 150);
    await assert.rejects(audit.reserve({ stepId: "forbidden", jobId: "job_forbidden", estimatedInput: 1, reservedOutput: 1 }), /global_budget_operation_failed/);
    await assert.rejects(audit.closeScope(), /global_budget_operation_failed/);
    await audit.close();
    await assert.rejects(GlobalBudget.inspect({ ...options, maxRequests: 2 }), /global_budget_scope_mismatch/);
    await assert.rejects(GlobalBudget.activate(options), /global_budget_id_used/);
    const later = await GlobalBudget.activate({ ...options, budgetId: "explicit-later" });
    assert.equal((await later.stats())?.requests_reserved, 0); await later.close();
    chmodSync(options.path, 0o644);
    await assert.rejects(GlobalBudget.open({ ...options, budgetId: "explicit-later" }), /global_budget_outcome_unknown/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("进程崩溃、未知用量和取消保留预算，不能自动释放或重试", async () => {
  const { dir, options } = fixture(3, 600);
  try {
    const init = await GlobalBudget.activate(options); await init.close();
    const child = spawn(process.execPath, ["--import", "tsx", "tests/global-budget-racer.ts", JSON.stringify(options), "step_crash", "crash"], { cwd: path.resolve("."), stdio: ["ignore", "pipe", "ignore"] });
    const ready = await new Promise<string>((resolve, reject) => { let output = ""; child.stdout.on("data", (chunk: Buffer) => { output += chunk; if (output.includes("\n")) resolve(output); }); child.on("error", reject); child.on("exit", (code) => reject(new Error(`premature exit ${code}`))); });
    assert.equal(JSON.parse(ready).dispatched.ok, true);
    child.kill("SIGKILL"); await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const gate = await GlobalBudget.open(options);
    assert.equal((await gate.step("step_crash"))?.state, "dispatched");
    assert.equal((await gate.markDispatched("step_crash")).ok, false);
    assert.equal((await gate.reserve({ stepId: "step_crash", jobId: "job_step_crash", estimatedInput: 100, reservedOutput: 100 })).ok, false);
    assert.equal((await gate.settle({ stepId: "step_crash", outcome: "outcome_unknown" })).code, "held_unknown");
    assert.equal((await gate.step("step_crash"))?.input_tokens, null);
    assert.equal((await gate.settle({ stepId: "step_crash", outcome: "completed", inputTokens: 1, outputTokens: 1 })).code, "global_budget_settlement_conflict");
    assert.equal((await gate.reserve({ stepId: "step_cancel", jobId: "job_cancel", estimatedInput: 100, reservedOutput: 100 })).ok, true);
    assert.equal((await gate.markDispatched("step_cancel")).ok, true);
    assert.equal((await gate.settle({ stepId: "step_cancel", outcome: "cancelled" })).code, "held_unknown");
    assert.equal((await gate.stats())?.accounted_tokens, 400);
    assert.equal((await gate.reserve({ stepId: "too_large", jobId: "job_large", estimatedInput: 200, reservedOutput: 1 })).code, "global_budget_exhausted");
    assert.equal((await gate.reserve({ stepId: "before_dispatch", jobId: "job_before", estimatedInput: 100, reservedOutput: 100 })).ok, true);
    assert.equal((await gate.stats())?.dispatched_count, 2);
    assert.deepEqual((await gate.pendingSteps("", 1)).map((row) => row.step_id), ["before_dispatch"]);
    assert.deepEqual(await gate.pendingSteps("before_dispatch", 1), []);
    assert.equal((await gate.closeScope(true)).code, "global_budget_pending");
    await gate.close();
    const reopened = await GlobalBudget.open(options);
    assert.equal((await reopened.step("before_dispatch"))?.state, "reserved");
    assert.equal((await reopened.acknowledgeInterrupted("before_dispatch")).code, "held_unknown");
    assert.equal((await reopened.stats())?.accounted_tokens, 600);
    assert.equal((await reopened.closeScope()).code, "global_budget_unknown_unacknowledged");
    assert.equal((await reopened.closeScope(true)).code, "closed"); await reopened.close();
    const later = await GlobalBudget.activate({ ...options, budgetId: "manual-later" });
    assert.equal((await later.step("step_crash")), null); await later.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("缺失缓存统计保留为 null，不能把部分报告当成全量", async () => {
  const { dir, options } = fixture(2, 1000);
  try {
    const gate = await GlobalBudget.activate(options);
    assert.equal((await gate.stats())?.reported_input, null);
    for (const id of ["first", "second"]) {
      assert.equal((await gate.reserve({ stepId: id, jobId: `job_${id}`, estimatedInput: 100, reservedOutput: 100 })).ok, true);
      assert.equal((await gate.markDispatched(id)).ok, true);
      assert.equal((await gate.settle({ stepId: id, outcome: "completed", inputTokens: 10, outputTokens: 5, ...(id === "first" ? { cacheHitTokens: 0, cacheMissTokens: 10 } : {}) })).ok, true);
    }
    assert.equal((await gate.step("second"))?.cache_hit_tokens, null);
    assert.equal((await gate.stats())?.cache_hit_tokens, null);
    assert.equal((await gate.stats())?.cache_miss_tokens, null);
    assert.equal((await gate.stats())?.reported_input, 20);
    await gate.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("显式 0 用量、部分用量与未返回分别保存，未完成结算继续占额", async () => {
  const { dir, options } = fixture(3, 1000);
  try {
    const gate = await GlobalBudget.activate(options);
    for (const id of ["zero", "partial", "absent"]) {
      assert.equal((await gate.reserve({ stepId: id, jobId: `job_${id}`, estimatedInput: 100, reservedOutput: 100 })).ok, true);
      assert.equal((await gate.markDispatched(id)).ok, true);
    }
    assert.equal((await gate.settle({ stepId: "zero", outcome: "completed", inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 })).code, "held_unknown");
    assert.equal((await gate.step("zero"))?.input_tokens, 0);
    assert.equal((await gate.step("zero"))?.output_tokens, 0);
    assert.equal((await gate.step("zero"))?.cache_hit_tokens, 0);
    assert.equal((await gate.settle({ stepId: "partial", outcome: "outcome_unknown", inputTokens: 250, outputTokens: null })).code, "held_unknown");
    assert.equal((await gate.step("partial"))?.input_tokens, 250);
    assert.equal((await gate.step("partial"))?.output_tokens, null);
    assert.equal((await gate.settle({ stepId: "absent", outcome: "error" })).code, "held_unknown");
    assert.equal((await gate.step("absent"))?.input_tokens, null);
    const stats = await gate.stats();
    assert.equal(stats?.accounted_tokens, 650); // 200 + max(200,250) + 200
    assert.equal(stats?.reported_input, 250); assert.equal(stats?.reported_output, 0);
    assert.equal(stats?.usage_incomplete_count, 2);
    assert.equal(stats?.cache_hit_tokens, null);
    await gate.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("跨进程数据库锁等待不阻塞 Node 定时器，超时不推断回滚", async () => {
  const { dir, options } = fixture(5, 1000);
  try {
    const gate = await GlobalBudget.activate(options);
    const locker = new DatabaseSync(options.path); locker.exec("BEGIN IMMEDIATE");
    let ticks = 0; const timer = setInterval(() => { ticks++; }, 10);
    const pending = gate.reserve({ stepId: "step_lock", jobId: "job_lock", estimatedInput: 100, reservedOutput: 100 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(ticks >= 5, `timer ticks ${ticks}`);
    locker.exec("COMMIT"); locker.close(); clearInterval(timer);
    assert.equal((await pending).code, "reserved");
    assert.equal((await gate.stats())?.requests_reserved, 1);
    await gate.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("预算存储不可用和超时均失败关闭，重开时不假定旧事务是否提交", async () => {
  const { dir, options } = fixture(5, 1000);
  try {
    await assert.rejects(GlobalBudget.open({ ...options, path: path.join(dir, "missing", "budget.sqlite") }), /global_budget_outcome_unknown/);
    const init = await GlobalBudget.activate(options); await init.close();
    const gate = await GlobalBudget.open({ ...options, timeoutMs: 150 });
    const locker = new DatabaseSync(options.path); locker.exec("BEGIN IMMEDIATE");
    try {
      await assert.rejects(gate.reserve({ stepId: "uncertain", jobId: "job_uncertain", estimatedInput: 100, reservedOutput: 100 }), /global_budget_outcome_unknown/);
      await assert.rejects(gate.reserve({ stepId: "must_not_retry", jobId: "job_uncertain", estimatedInput: 100, reservedOutput: 100 }), /global_budget_closed/);
    } finally { locker.exec("COMMIT"); locker.close(); await gate.close(); }
    const reopened = await GlobalBudget.open(options);
    const step = await reopened.step("uncertain");
    assert.ok(step === null || step.state === "reserved");
    if (step) assert.equal((await reopened.reserve({ stepId: "uncertain", jobId: "job_uncertain", estimatedInput: 100, reservedOutput: 100 })).code, "global_budget_step_exists");
    await reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("普通打开不创建新库，预算初始化拒绝改写其他 SQLite 或链接", async () => {
  const { dir, options } = fixture();
  try {
    await assert.rejects(GlobalBudget.open(options), /global_budget_outcome_unknown/);
    assert.equal(existsSync(options.path), false);
    const other = path.join(dir, "other.sqlite");
    const db = new DatabaseSync(other);
    db.exec("CREATE TABLE keep_data (value TEXT); INSERT INTO keep_data VALUES ('synthetic-existing');"); db.close();
    await assert.rejects(GlobalBudget.activate({ ...options, path: other }), /global_budget_outcome_unknown/);
    const check = new DatabaseSync(other);
    assert.equal(check.prepare("SELECT value FROM keep_data").get()?.value, "synthetic-existing");
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='budget_scopes'").get()?.n, 0);
    check.close();
    const linked = path.join(dir, "linked.sqlite"); symlinkSync(other, linked);
    await assert.rejects(GlobalBudget.activate({ ...options, path: linked }), /global_budget_outcome_unknown/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
