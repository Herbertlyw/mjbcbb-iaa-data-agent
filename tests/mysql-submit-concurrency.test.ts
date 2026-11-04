import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import mysql from "mysql2/promise";
import { openRuntime } from "./helpers.js";
import { AsyncMysqlStateStore } from "../src/async-mysql-state-store.js";

function docker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "ignore"] }); let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve(output) : reject(new Error("isolated_container_operation_failed")));
  });
}

test("隔离 MySQL 受控并发创建任务、同会话互斥及未知结果", async () => {
  const password = randomBytes(18).toString("hex"); const name = `dataagent-submit-${randomUUID()}`;
  const dir = mkdtempSync(path.join(tmpdir(), "dataagent-submit-"));
  let runtime: ReturnType<typeof openRuntime> | undefined;
  try {
    await docker(["run", "--pull=never", "-d", "--name", name, "--label", `dataagent.test.run=${name}`, "--tmpfs", "/var/lib/mysql:rw,size=1g", "-p", "127.0.0.1::3306", "-e", `MYSQL_ROOT_PASSWORD=${password}`, "-e", "MYSQL_DATABASE=synthetic_it", "-e", "MYSQL_USER=synthetic_it", "-e", `MYSQL_PASSWORD=${password}`, "mysql:8.0.32", "--skip-log-bin"]);
    const port = Number(/^127\.0\.0\.1:(\d+)\s*$/u.exec(await docker(["port", name, "3306/tcp"]))?.[1]); assert.ok(port > 0 && port < 65536);
    const config = { host: "127.0.0.1", port, user: "synthetic_it", password, database: "synthetic_it" };
    const deadline = Date.now() + 60_000;
    while (true) {
      try { const connection = await mysql.createConnection(config); await connection.end(); break; }
      catch { if (Date.now() > deadline) throw new Error("isolated_mysql_start_timeout"); await new Promise((resolve) => setTimeout(resolve, 200)); }
    }
    runtime = openRuntime(dir, { stateMode: "mysql", mysqlHost: "127.0.0.1", mysqlPort: port, mysqlUser: config.user, mysqlPassword: password, mysqlDatabase: config.database, startWorker: false });
    const worker = runtime;
    const sessions = await Promise.all(Array.from({ length: 48 }, () => worker.sessions.createAsync("analyst")));
    const jobs = [];
    for (let start = 0; start < sessions.length; start += 8) {
      jobs.push(...await Promise.all(sessions.slice(start, start + 8).map((session, index) => worker.jobs.submitForSessionAsync(session.session_id, "虚构并发问题", `batch-${start}-${index}`))));
    }
    assert.equal(new Set(jobs.map((job) => job.job_id)).size, 48);
    const same = await worker.sessions.createAsync("analyst");
    const duplicate = await Promise.all(Array.from({ length: 8 }, () => worker.jobs.submitForSessionAsync(same.session_id, "相同虚构问题", "same-key")));
    assert.equal(new Set(duplicate.map((job) => job.job_id)).size, 1);
    await assert.rejects(() => worker.jobs.submitForSessionAsync(same.session_id, "不同虚构问题", "same-key"), (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "idempotency_conflict");
    const contested = await worker.sessions.createAsync("analyst");
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => worker.jobs.submitForSessionAsync(contested.session_id, "虚构竞争问题", `key-${index}`)));
    assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
    for (const item of outcomes) if (item.status === "rejected") assert.equal((item.reason as { code?: string }).code, "session_busy");
    const connection = await mysql.createConnection(config);
    try {
      const [rows] = await connection.query("SELECT (SELECT COUNT(*) FROM jobs) AS jobs, (SELECT COUNT(*) FROM job_events) AS events, (SELECT COUNT(*) FROM messages) AS messages, (SELECT COUNT(*) FROM outbox) AS outbox");
      assert.deepEqual({ ...(rows as Array<Record<string, number>>)[0] }, { jobs: 50, events: 50, messages: 50, outbox: 50 });
      // Hold the session row while an active worker holds its job row and
      // waits to update the session; a concurrent submit waits on session.
      // Once released, submission must not try to lock the worker's job row
      // in reverse order, and the existing active job must still win.
      const lockedSession = await worker.sessions.createAsync("analyst");
      const active = await worker.jobs.submitForSessionAsync(lockedSession.session_id, "虚构活动任务", "active");
      const authority = await worker.mysqlAsyncState();
      const claim = await authority.call("claimJob", active.job_id, "synthetic-owner", Date.now(), 20_000); assert.ok(claim);
      await connection.beginTransaction();
      await connection.query("SELECT session_id FROM sessions WHERE session_id = ? FOR UPDATE", [lockedSession.session_id]);
      const save = authority.call("saveSession", { ...lockedSession, title: "虚构活动会话" }, { jobId: active.job_id, owner: "synthetic-owner", fence: claim.fence });
      const probe = await mysql.createConnection(config);
      try {
        let blocked = false; const deadline = Date.now() + 5000;
        while (Date.now() < deadline && !blocked) {
          try { await probe.query("SELECT job_id FROM jobs WHERE job_id = ? FOR UPDATE NOWAIT", [active.job_id]); }
          catch (error) { if ((error as { code?: string }).code === "ER_LOCK_NOWAIT") blocked = true; else throw error; }
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(blocked, true, "已确认 worker 持有 job 锁并等待 session");
        const competing = assert.rejects(() => worker.jobs.submitForSessionAsync(lockedSession.session_id, "虚构后续任务", "later"), (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "session_busy");
        await connection.commit();
        await Promise.all([save, competing]);
        await authority.call("requestCancel", active.job_id);
        assert.equal(await authority.call("finish", active.job_id, "synthetic-owner", claim.fence, "completed", null, null), true);
        const ended = await authority.call("getJob", active.job_id);
        assert.equal(ended?.status, "cancelled");
        assert.equal(ended?.events.filter((event) => ["job_finished", "job_cancelled", "job_failed", "job_timed_out"].includes(event.type)).length, 1);
      } finally { await connection.rollback().catch(() => undefined); await probe.end(); }
      const uncertainSession = await worker.sessions.createAsync("analyst");
      const shortBridge = await AsyncMysqlStateStore.open(config, 150, 5000);
      try {
        await connection.query("CREATE TABLE synthetic_insert_attempts (id INT AUTO_INCREMENT PRIMARY KEY, marker INT NOT NULL)");
        await connection.query("CREATE TRIGGER synthetic_count_insert AFTER INSERT ON jobs FOR EACH ROW INSERT INTO synthetic_insert_attempts (marker) VALUES (1)");
        await connection.query("CREATE TRIGGER synthetic_delay_outbox BEFORE INSERT ON outbox FOR EACH ROW DO SLEEP(0.8)");
        const createdAt = new Date().toISOString(); const jobId = `job_${randomUUID()}`; const text = "虚构未知提交";
        const job = { job_id: jobId, session_id: uncertainSession.session_id, status: "queued" as const, user_text: text, idempotency_key: "unknown-key", turn: { kind: "new_question" as const, intent: "performance" as const, raw_text: text, slots: { game: "starlane_drift" as const, metrics: [] }, inherited: [], replaced: [], missing_slots: [], search_query: "", read_asset_ids: [], contract_asset_ids: [], clarification_question: null }, events: [], next_seq: 2, version: 1, analysis: null, error: null, abort_reason: null, fence: 0, lease_owner: null, lease_until: null, cancel_requested: false, simulated: true as const, created_at: createdAt };
        const input = { job, session: uncertainSession, message: { message_id: `msg_${randomUUID()}`, session_id: uncertainSession.session_id, job_id: jobId, role: "user" as const, text, created_at: createdAt } };
        await assert.rejects(() => shortBridge.call("createJob", input), /mysql_state_outcome_unknown/);
        assert.equal(shortBridge.available, false);
        await assert.rejects(() => shortBridge.call("createJob", input), /mysql_state_closed/);
        let committed = 0; const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const [found] = await connection.query("SELECT COUNT(*) AS n FROM jobs WHERE job_id = ?", [jobId]);
          committed = Number((found as Array<{ n: number }>)[0]?.n);
          if (committed === 1) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(committed, 1, "客户端超时不证明数据库回滚");
        const recovered = await worker.jobs.submitForSessionAsync(uncertainSession.session_id, text, "unknown-key");
        assert.equal(recovered.job_id, jobId, "使用相同幂等键显式查询返回已提交任务");
        const [counts] = await connection.query("SELECT (SELECT COUNT(*) FROM synthetic_insert_attempts) AS attempts, (SELECT COUNT(*) FROM jobs WHERE job_id = ?) AS jobs, (SELECT COUNT(*) FROM job_events WHERE job_id = ?) AS events, (SELECT COUNT(*) FROM messages WHERE job_id = ?) AS messages, (SELECT COUNT(*) FROM outbox WHERE job_id = ?) AS outbox", [jobId, jobId, jobId, jobId]);
        assert.deepEqual({ ...(counts as Array<Record<string, number>>)[0] }, { attempts: 1, jobs: 1, events: 1, messages: 1, outbox: 1 });
      } finally { await shortBridge.close(); }
    } finally { await connection.end(); }
  } finally {
    await runtime?.close({ abandon: true });
    const label = await docker(["inspect", "--format", '{{index .Config.Labels "dataagent.test.run"}}', name]).catch(() => "");
    if (label.trim() === name) await docker(["rm", "-f", name]);
    rmSync(dir, { recursive: true, force: true });
  }
});
