import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { DEMO_QUESTIONS } from "../src/demo.js";
import { MysqlStateStore } from "../src/mysql-state-store.js";
import { RedisJobQueue } from "../src/redis-queue.js";
import { createRuntime } from "../src/runtime.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const password = randomBytes(18).toString("hex");
const database = `lumenfox_it_${process.pid}`;
const user = "lumenfox_it";
const queueKey = `lumenfox:it:${process.pid}:jobs`;
const suffix = randomUUID();
const mysqlName = `lumenfox-it-${suffix}-mysql`;
const redisName = `lumenfox-it-${suffix}-redis`;

test("隔离的 MySQL 与 Redis 分进程：权威状态、outbox、围栏和恢复", async () => {
  await assertLocalImages();
  const mysqlPort = await freePort();
  const redisPort = await freePort();
  const apiPort = await freePort();
  const dir = mkdtempSync(path.join(tmpdir(), "lumenfox-it-"));
  const databasePath = path.join(dir, "business.sqlite");
  const freshnessPath = path.join(dir, "freshness.json");
  const seeded = createRuntime({
    databasePath,
    stateDatabasePath: path.join(dir, "unused-state.sqlite"),
    freshnessPath,
    startWorker: false,
    ephemeralDir: undefined,
    stateMode: "sqlite",
  });
  await seeded.close();
  const children: ChildProcess[] = [];
  const store = () => new MysqlStateStore({ host: "127.0.0.1", port: mysqlPort, user, password, database });
  let mysqlCreated = false;
  let redisCreated = false;
  try {
    await runQuiet("docker", ["run", "--pull=never", "-d", "--name", mysqlName, "-p", `127.0.0.1:${mysqlPort}:3306`, "-e", `MYSQL_ROOT_PASSWORD=${password}`, "-e", `MYSQL_DATABASE=${database}`, "-e", `MYSQL_USER=${user}`, "-e", `MYSQL_PASSWORD=${password}`, "mysql:8.0.32", "--bind-address=0.0.0.0"], password);
    mysqlCreated = true;
    await runQuiet("docker", ["run", "--pull=never", "-d", "--name", redisName, "-p", `127.0.0.1:${redisPort}:6379`, "redis:6.2", "redis-server", "--bind", "0.0.0.0", "--protected-mode", "yes", "--requirepass", password], password);
    redisCreated = true;
    await waitForMysql(mysqlPort);
    await waitForRedis(redisPort);
    const authority = store();
    const baseEnv = isolatedEnv({ mysqlPort, redisPort, apiPort, databasePath, freshnessPath, recoveryMs: "60000" });
    const api = startRole("src/api.ts", baseEnv);
    children.push(api);
    await waitForHealth(apiPort);
    const worker = startRole("src/worker.ts", baseEnv);
    const dispatcher = startRole("src/dispatcher.ts", baseEnv);
    children.push(worker, dispatcher);
    const japan = DEMO_QUESTIONS.find((item) => item.id === "japan")?.text ?? "";
    const created = await postSession(apiPort);
    const first = await postJob(apiPort, created.session_id, japan, "same-key");
    const replay = await postJob(apiPort, created.session_id, japan, "same-key");
    assert.equal(replay.job_id, first.job_id);
    const conflict = await postJob(apiPort, created.session_id, "完全不同的问题", "same-key", true);
    assert.equal(conflict.status, 409);
    const done = await waitJob(authority, first.job_id);
    assert.equal(done.status, "partial", JSON.stringify(done.error));
    assert.equal(done.events.filter((event) => event.type === "job_finished").length, 1);
    assert.deepEqual(done.events.map((event) => event.seq), done.events.map((_, index) => index + 1));
    const httpJob = await getJob(apiPort, first.job_id);
    assert.equal(httpJob.status, done.status);
    assert.equal(httpJob.events.length, done.events.length);
    const pending = authority.listPendingOutbox(10).filter((item) => item.job_id === first.job_id);
    assert.equal(pending.length, 0);
    assert.equal(authority.listJobs(created.session_id).length, 1);

    await stopProcess(api);
    const apiAgain = startRole("src/api.ts", baseEnv);
    children.push(apiAgain);
    await waitForHealth(apiPort);
    const afterRestart = await getJob(apiPort, first.job_id);
    assert.equal(afterRestart.job_id, first.job_id);
    assert.equal(afterRestart.events[0]?.type, "job_queued");
    const hidden = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/${created.session_id}`, { headers: { "x-demo-actor": "demo-viewer" } });
    assert.equal(hidden.status, 404);
    const resumed = await fetch(`http://127.0.0.1:${apiPort}/api/jobs/${first.job_id}/events?after=1`);
    const text = await readSome(resumed);
    assert.match(text, /job_finished/);
    assert.doesNotMatch(text, /"seq":1[,}]/);

    const slowSession = await postSession(apiPort);
    await stopProcess(dispatcher);
    const queuedOnly = await postJob(apiPort, slowSession.session_id, japan, "before-dispatch");
    await delay(700);
    assert.equal(authority.getJob(queuedOnly.job_id)?.status, "queued");
    assert.equal(authority.listPendingOutbox(20).some((item) => item.job_id === queuedOnly.job_id), true);
    const dispatcherAgain = startRole("src/dispatcher.ts", baseEnv);
    children.push(dispatcherAgain);
    const recoveredDispatch = await waitJob(authority, queuedOnly.job_id);
    assert.equal(recoveredDispatch.status, "partial");
    assert.equal(recoveredDispatch.events.filter((event) => ["job_finished", "job_failed", "job_cancelled"].includes(event.type)).length, 1);

    await stopProcess(worker);
    await stopProcess(dispatcherAgain);
    const duplicateSession = await postSession(apiPort);
    const duplicate = await postJob(apiPort, duplicateSession.session_id, japan, "duplicate-dispatch");
    const pendingDuplicate = authority.listPendingOutbox(20).find((item) => item.job_id === duplicate.job_id);
    assert.ok(pendingDuplicate);
    const queue = new RedisJobQueue({ host: "127.0.0.1", port: redisPort, password, queueKey });
    await queue.publish({ job_id: duplicate.job_id, outbox_id: pendingDuplicate?.outbox_id ?? 0 });
    await queue.publish({ job_id: duplicate.job_id, outbox_id: pendingDuplicate?.outbox_id ?? 0 });
    const duplicateWorker = startRole("src/worker.ts", baseEnv);
    children.push(duplicateWorker);
    const duplicated = await waitJob(authority, duplicate.job_id);
    assert.equal(duplicated.status, "partial");
    assert.equal(duplicated.events.filter((event) => event.type === "job_finished").length, 1);
    await queue.close();
    await stopProcess(duplicateWorker);

    const lostSession = await postSession(apiPort);
    const lost = await postJob(apiPort, lostSession.session_id, japan, "lost-redis");
    await delay(400);
    assert.equal(authority.getJob(lost.job_id)?.status, "queued");
    assert.equal(authority.listPendingOutbox(20).some((item) => item.job_id === lost.job_id), true);
    const recoveryEnv = isolatedEnv({ mysqlPort, redisPort, apiPort, databasePath, freshnessPath, recoveryMs: "400" });
    const recoveryWorker = startRole("src/worker.ts", recoveryEnv);
    children.push(recoveryWorker);
    const recoveredWithoutRedis = await waitJob(authority, lost.job_id);
    assert.equal(recoveredWithoutRedis.status, "partial");
    assert.equal(recoveredWithoutRedis.events.filter((event) => event.type === "job_finished").length, 1);
    assert.equal(authority.listPendingOutbox(20).some((item) => item.job_id === lost.job_id), true);
    await stopProcess(recoveryWorker);

    const fenceSession = authority.createSession({
      session_id: `ses_${randomUUID()}`,
      title: "围栏",
      role: "analyst",
      actor_id: "demo-analyst",
      created_at: new Date().toISOString(),
      slots: null,
      bindings: [],
    });
    const fenceJob = authority.createJob({
      job: fakeJob(fenceSession.session_id, "围栏任务", "fence-key"),
      session: fenceSession,
      message: { message_id: `msg_${randomUUID()}`, session_id: fenceSession.session_id, job_id: "pending", role: "user", text: "围栏任务", created_at: new Date().toISOString() },
    });
    const other = store();
    const claims = await Promise.all([
      Promise.resolve().then(() => authority.claimNext("owner-a", Date.now(), 5_000)),
      Promise.resolve().then(() => other.claimNext("owner-b", Date.now(), 5_000)),
    ]);
    const winner = claims.find((claim) => claim && claim.job.job_id === fenceJob.job_id);
    assert.equal(claims.filter((claim) => claim !== null).length, 1);
    assert.ok(winner);
    if (!winner) return;
    authority.expireLease(fenceJob.job_id);
    const second = other.claimJob(fenceJob.job_id, "owner-b", Date.now(), 5_000);
    assert.ok(second);
    if (!second) return;
    assert.notEqual(second.fence, winner.fence);
    assert.equal(authority.appendEvent(fenceJob.job_id, winner.owner, winner.fence, "tool_finished", { late: true }), null);
    assert.equal(authority.finish(fenceJob.job_id, winner.owner, winner.fence, "completed", null, null), false);
    assert.equal(other.finish(fenceJob.job_id, second.owner, second.fence, "failed", null, { code: "recovered", message: "新执行者收口" }), true);
    const fenced = authority.getJob(fenceJob.job_id);
    assert.equal(fenced?.status, "failed");
    assert.equal(fenced?.events.filter((event) => event.type === "job_failed" || event.type === "job_finished").length, 1);

    const cancelSession = authority.createSession({
      session_id: `ses_${randomUUID()}`,
      title: "取消",
      role: "analyst",
      actor_id: "demo-analyst",
      created_at: new Date().toISOString(),
      slots: null,
      bindings: [],
    });
    const cancelJob = authority.createJob({
      job: fakeJob(cancelSession.session_id, "取消竞争", "cancel-key"),
      session: cancelSession,
      message: { message_id: `msg_${randomUUID()}`, session_id: cancelSession.session_id, job_id: "pending", role: "user", text: "取消竞争", created_at: new Date().toISOString() },
    });
    const claimed = authority.claimJob(cancelJob.job_id, "owner-cancel", Date.now(), 5_000);
    assert.ok(claimed);
    if (!claimed) return;
    authority.requestCancel(cancelJob.job_id);
    assert.equal(authority.finish(cancelJob.job_id, claimed.owner, claimed.fence, "completed", null, null), true);
    const cancelled = authority.getJob(cancelJob.job_id);
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(cancelled?.events.filter((event) => event.type === "job_finished" || event.type === "job_cancelled").length, 1);
    authority.close();
    other.close();
  } finally {
    for (const child of children) await stopProcess(child);
    if (mysqlCreated) await runQuiet("docker", ["rm", "-f", mysqlName], password).catch(() => undefined);
    if (redisCreated) await runQuiet("docker", ["rm", "-f", redisName], password).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeJob(sessionId: string, text: string, key: string) {
  return {
    job_id: `job_${randomUUID()}`,
    session_id: sessionId,
    status: "queued" as const,
    user_text: text,
    idempotency_key: key,
    turn: {
      kind: "new_question" as const,
      intent: "performance" as const,
      raw_text: text,
      slots: { game: "starlane_drift" as const, metrics: [] },
      inherited: [],
      replaced: [],
      missing_slots: [],
      search_query: "",
      read_asset_ids: [],
      contract_asset_ids: [],
      clarification_question: null,
    },
    events: [],
    next_seq: 2,
    version: 1,
    analysis: null,
    error: null,
    abort_reason: null,
    fence: 0,
    lease_owner: null,
    lease_until: null,
    cancel_requested: false,
    simulated: true as const,
    created_at: new Date().toISOString(),
  };
}

function isolatedEnv(input: { mysqlPort: number; redisPort: number; apiPort: number; databasePath: string; freshnessPath: string; recoveryMs: string }) {
  return {
    PATH: process.env.PATH ?? "",
    HOST: "127.0.0.1",
    PORT: String(input.apiPort),
    STATE_MODE: "mysql",
    RESEED_DATABASE: "false",
    PUBLISH_FRESHNESS_ON_START: "false",
    DATABASE_PATH: input.databasePath,
    FRESHNESS_PATH: input.freshnessPath,
    MYSQL_HOST: "127.0.0.1",
    MYSQL_PORT: String(input.mysqlPort),
    MYSQL_USER: user,
    MYSQL_PASSWORD: password,
    MYSQL_DATABASE: database,
    REDIS_HOST: "127.0.0.1",
    REDIS_PORT: String(input.redisPort),
    REDIS_PASSWORD: password,
    REDIS_QUEUE_KEY: queueKey,
    RECOVERY_MS: input.recoveryMs,
    DISPATCHER_POLL_MS: "100",
    LEASE_MS: "5000",
    HEARTBEAT_MS: "200",
    MODEL_MODE: "deterministic",
  };
}

function startRole(script: string, env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", () => undefined);
  return child;
}

async function waitJob(store: MysqlStateStore, jobId: string) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    const job = store.getJob(jobId);
    if (job && !["queued", "running"].includes(job.status)) return job;
    await delay(50);
  }
  throw new Error(`任务没有在 MySQL 中结束：${store.getJob(jobId)?.status ?? "missing"}`);
}

async function postSession(port: number) {
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-demo-actor": "demo-analyst" },
    body: JSON.stringify({ userId: "root", role: "viewer", title: "隔离会话" }),
  });
  assert.equal(response.status, 201);
  const body = (await response.json()) as { session_id: string; role: string; actor_id: string };
  assert.equal(body.role, "analyst");
  assert.equal(body.actor_id, "demo-analyst");
  return body;
}

async function postJob(port: number, sessionId: string, text: string, key: string, allowError = false) {
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-demo-actor": "demo-analyst" },
    body: JSON.stringify({ text, idempotency_key: key, userId: "root" }),
  });
  if (allowError) return { status: response.status, job_id: "" };
  assert.equal(response.status, 202);
  return (await response.json()) as { job_id: string; status: number };
}

async function getJob(port: number, jobId: string) {
  const response = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}`, { headers: { "x-demo-actor": "demo-analyst" } });
  assert.equal(response.status, 200);
  return (await response.json()) as { job_id: string; status: string; events: Array<{ seq: number; type: string }> };
}

async function readSome(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  let text = "";
  const started = Date.now();
  while (Date.now() - started < 3000 && !text.includes("job_finished")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
  }
  await reader.cancel();
  return text;
}

async function waitForHealth(port: number) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        const body = (await response.json()) as { state_mode: string; queue: string };
        assert.equal(body.state_mode, "mysql");
        assert.equal(body.queue, "redis-wake-only");
        return;
      }
    } catch {
      // 进程还在监听前。
    }
    await delay(100);
  }
  throw new Error("API 没有在隔离端口就绪");
}

async function waitForMysql(port: number) {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    try {
      const connection = await mysql.createConnection({ host: "127.0.0.1", port, user, password, database });
      await connection.query("SELECT 1");
      await connection.end();
      return;
    } catch {
      await delay(500);
    }
  }
  throw new Error("隔离 MySQL 未就绪");
}

async function waitForRedis(port: number) {
  const queue = new RedisJobQueue({ host: "127.0.0.1", port, password, queueKey: `${queueKey}:ping` });
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    try {
      await queue.depth();
      await queue.close();
      return;
    } catch {
      await delay(200);
    }
  }
  await queue.close();
  throw new Error("隔离 Redis 未就绪");
}

async function assertLocalImages() {
  await runQuiet("docker", ["image", "inspect", "mysql:8.0.32"], password);
  await runQuiet("docker", ["image", "inspect", "redis:6.2"], password);
}

function runQuiet(command: string, args: string[], secret: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error((err || `${command} exit ${code}`).replaceAll(secret, "[secret]").slice(0, 400)));
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}
