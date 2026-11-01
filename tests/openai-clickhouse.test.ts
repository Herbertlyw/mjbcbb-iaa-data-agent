import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { clickHouseCommand, clickHouseInsert, clickHouseQuery, createClickHouseClient } from "../src/clickhouse-client.js";
import { probeClickHouseAndPublish } from "../src/freshness.js";
import { createTableSql, smallWarehouse, WAREHOUSE_TABLES } from "../src/warehouse.js";
import { startFakeOpenAI } from "./openai-fake-server.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const knowledgeDir = path.join(root, "knowledge", "harborlight");
const token = "fictional-loopback-token";
const question = "纸灯 在 2026-10-06 到 2026-10-12（美国、iOS、雾帆）的新增用户是多少？";

test("本地 OpenAI 兼容假服务驱动 AgentSession 查询 ClickHouse，未知派发不会被重试", async () => {
  const fake = await startFakeOpenAI(token);
  const clickhousePort = await freePort();
  const mysqlPort = await freePort();
  const redisPort = await freePort();
  const apiPort = await freePort();
  const adminPassword = randomBytes(12).toString("hex");
  const readerPassword = randomBytes(12).toString("hex");
  const statePassword = randomBytes(12).toString("hex");
  const names = [`lumenfox-oai-ch-${process.pid}`, `lumenfox-oai-mysql-${process.pid}`, `lumenfox-oai-redis-${process.pid}`];
  const dir = mkdtempSync(path.join(tmpdir(), "lumenfox-oai-"));
  const children: ChildProcess[] = [];
  try {
    await docker(["run", "-d", "--name", names[0], "--ulimit", "nofile=262144:262144", "-p", `127.0.0.1:${clickhousePort}:8123`, "-e", `CLICKHOUSE_PASSWORD=${adminPassword}`, "-e", "CLICKHOUSE_DB=harborlight", "-e", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1", "clickhouse/clickhouse-server:24.8.14.39"]);
    await docker(["run", "-d", "--name", names[1], "-p", `127.0.0.1:${mysqlPort}:3306`, "-e", `MYSQL_ROOT_PASSWORD=${statePassword}`, "-e", "MYSQL_DATABASE=lumenfox_it", "-e", "MYSQL_USER=lumenfox_it", "-e", `MYSQL_PASSWORD=${statePassword}`, "mysql:8.0.32"]);
    await docker(["run", "-d", "--name", names[2], "-p", `127.0.0.1:${redisPort}:6379`, "redis:6.2", "redis-server", "--bind", "0.0.0.0", "--protected-mode", "yes", "--requirepass", statePassword]);
    const clickhouseUrl = `http://127.0.0.1:${clickhousePort}`;
    await waitHttp(clickhouseUrl);
    const bootstrap = createClickHouseClient({ url: clickhouseUrl, username: "default", password: adminPassword, database: "default", maxRowsToRead: 5_000_000, timeoutSeconds: 30 }, false);
    await clickHouseCommand(bootstrap, "CREATE DATABASE IF NOT EXISTS harborlight");
    await bootstrap.close();
    const admin = createClickHouseClient({ url: clickhouseUrl, username: "default", password: adminPassword, database: "harborlight", maxRowsToRead: 5_000_000, timeoutSeconds: 30 }, false);
    for (const table of WAREHOUSE_TABLES) await clickHouseCommand(admin, createTableSql(table));
    const data = smallWarehouse();
    await clickHouseInsert(admin, "dim_fox_title", data.titles);
    await clickHouseInsert(admin, "dim_fox_channel", data.channels);
    await clickHouseInsert(admin, "fact_fox_daily_install", data.installs);
    await clickHouseInsert(admin, "fact_fox_daily_active", data.active);
    await clickHouseInsert(admin, "fact_fox_ad_receipt", data.revenue);
    await clickHouseInsert(admin, "fact_fox_daily_spend", data.spend);
    await clickHouseInsert(admin, "fact_fox_retention_cohort", data.retention);
    await clickHouseInsert(admin, "fact_fox_cohort_payback", data.cohortPayback);
    await clickHouseInsert(admin, "fact_fox_experiment_arm", data.arms);
    await clickHouseInsert(admin, "fact_fox_experiment_metric", data.experimentMetrics);
    await clickHouseCommand(admin, `CREATE USER IF NOT EXISTS fox_reader IDENTIFIED BY '${readerPassword}'`);
    await clickHouseCommand(admin, "GRANT SELECT ON harborlight.* TO fox_reader");
    await admin.close();
    const reader = createClickHouseClient({ url: clickhouseUrl, username: "fox_reader", password: readerPassword, database: "harborlight", maxRowsToRead: 5_000_000, timeoutSeconds: 10 }, true);
    const freshnessPath = path.join(dir, "freshness.json");
    await probeClickHouseAndPublish({
      targetsPath: path.join(knowledgeDir, "freshness-targets.json"),
      destinationPath: freshnessPath,
      query: (sql) => clickHouseQuery(reader, sql) as Promise<Array<{ event_date: string }>>,
    });
    await reader.close();
    await waitMysql(mysqlPort, statePassword);
    const baseEnv = {
      PATH: process.env.PATH ?? "",
      HOST: "127.0.0.1",
      PORT: String(apiPort),
      STATE_MODE: "mysql",
      BUSINESS_ENGINE: "clickhouse",
      KNOWLEDGE_DIR: knowledgeDir,
      CLICKHOUSE_URL: clickhouseUrl,
      CLICKHOUSE_USER: "fox_reader",
      CLICKHOUSE_PASSWORD: readerPassword,
      CLICKHOUSE_DATABASE: "harborlight",
      FRESHNESS_PATH: freshnessPath,
      DATABASE_PATH: path.join(dir, "unused.sqlite"),
      RESEED_DATABASE: "false",
      PUBLISH_FRESHNESS_ON_START: "false",
      MYSQL_HOST: "127.0.0.1",
      MYSQL_PORT: String(mysqlPort),
      MYSQL_USER: "lumenfox_it",
      MYSQL_PASSWORD: statePassword,
      MYSQL_DATABASE: "lumenfox_it",
      REDIS_HOST: "127.0.0.1",
      REDIS_PORT: String(redisPort),
      REDIS_PASSWORD: statePassword,
      REDIS_QUEUE_KEY: `lumenfox:oai:${process.pid}`,
      MODEL_MODE: "pi",
      PI_PROVIDER: "openai-compatible",
      PI_MODEL: "local-protocol",
      PI_API_KEY: token,
      PI_BASE_URL: fake.url,
      PI_CONTEXT_WINDOW: "8000",
      PI_MAX_OUTPUT_TOKENS: "512",
      PI_REASONING: "off",
      PI_PROTOCOL_SCRIPT: "happy",
      RECOVERY_MS: "600",
      LEASE_MS: "4000",
      MAX_MODEL_CALLS: "24",
    };
    const api = spawn(process.execPath, ["--import", "tsx", "src/api.ts"], { cwd: root, env: baseEnv, stdio: "ignore" });
    const dispatcher = spawn(process.execPath, ["--import", "tsx", "src/dispatcher.ts"], { cwd: root, env: baseEnv, stdio: "ignore" });
    children.push(api, dispatcher);
    await waitHttp(`http://127.0.0.1:${apiPort}/api/health`);
    const happyWorker = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], { cwd: root, env: baseEnv, stdio: "ignore" });
    children.push(happyWorker);
    const created = await fetch(`http://127.0.0.1:${apiPort}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const session = (await created.json()) as { session_id: string };
    const posted = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/${session.session_id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: question, idempotency_key: randomUUID() }),
    });
    assert.equal(posted.status, 202, await posted.clone().text());
    const queued = (await posted.json()) as { job_id: string };
    const job = await waitJob(apiPort, queued.job_id);
    const toolTrace = (job.events ?? []).filter((event) => event.type === "tool_started").map((event) => event.payload.tool_name).join(">");
    assert.ok(job.analysis, `${job.status} ${JSON.stringify(job.error)} tools=${toolTrace}`);
    assert.match(job.analysis?.answer ?? "", /670/);
    assert.equal(job.analysis?.sources?.[0]?.engine, "clickhouse-local");
    assert.equal(job.analysis?.sources?.[0]?.engine, "clickhouse-local");
    assert.equal(job.usage?.usage_source, "simulated");
    assert.ok((job.usage?.input_tokens ?? 0) > 0);
    assert.equal(job.events.filter((event) => event.type === "job_finished").length, 1);
    for (const name of ["search_assets", "read_assets", "read_data_contract_view", "query"]) {
      assert.equal(job.events.filter((event) => event.type === "tool_started" && event.payload.tool_name === name).length, 1, name);
    }
    assert.equal(fake.observations.some((item) => item.sawUserText && item.sawKnowledgeBody && item.authorizationMatched), true);
    const another = async () => {
      const created = await fetch(`http://127.0.0.1:${apiPort}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      return ((await created.json()) as { session_id: string }).session_id;
    };
    const glass = await postQuestion(apiPort, await another(), "玻璃鲦在德国 iOS、雾帆，2026-10-06 到 2026-10-12 的新增用户是多少？");
    assert.equal(glass.analysis?.sources?.[0]?.engine, "clickhouse-local", `${glass.status} ${glass.analysis?.answer ?? ""}`);
    assert.match(glass.analysis?.answer ?? "", /48/);
    assert.equal((glass.analysis?.answer ?? "").includes("99999"), false);
    const japan = await postQuestion(apiPort, await another(), "纸灯在日本、iOS、雾帆，2026-10-06 到 2026-10-12 的新增用户是多少？");
    assert.match(japan.analysis?.answer ?? "", /70/);
    const joined = await postQuestion(apiPort, await another(), "把纸灯美国 iOS 的新增和变现连表后告诉我新增合计。");
    assert.notEqual(joined.status, "completed");
    assert.equal((joined.analysis?.answer ?? "").includes("99999"), false);
    const clarify = await postQuestion(apiPort, await another(), "只说看看收入");
    assert.equal(clarify.analysis?.status, "needs_clarification");
    assert.equal(clarify.events.filter((event) => event.type === "tool_started" && event.payload.tool_name === "query").length, 0);
    happyWorker.kill("SIGKILL");

    const holdEnv = { ...baseEnv, PI_PROTOCOL_SCRIPT: "hold" };
    const holdWorker = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], { cwd: root, env: holdEnv, stdio: "ignore" });
    children.push(holdWorker);
    const interrupted = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/${session.session_id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: question, idempotency_key: randomUUID() }),
    });
    const interruptedJob = (await interrupted.json()) as { job_id: string };
    assert.equal(await waitDispatched(mysqlPort, statePassword, interruptedJob.job_id), "dispatched");
    holdWorker.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const recovered = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], { cwd: root, env: { ...baseEnv, PI_PROTOCOL_SCRIPT: "happy" }, stdio: "ignore" });
    children.push(recovered);
    const unknown = await waitJob(apiPort, interruptedJob.job_id);
    assert.equal(unknown.status, "failed", JSON.stringify(unknown.error));
    assert.equal(unknown.error?.code, "provider_outcome_unknown");
    assert.equal(unknown.usage?.input_tokens, null);
    assert.equal(unknown.usage?.usage_source, "unknown");
    assert.equal(unknown.events.filter((event) => event.type === "tool_started").length, 0);
    assert.equal(unknown.events.filter((event) => event.type === "job_failed" || event.type === "job_finished").length, 1);
    const connection = await mysql.createConnection({ host: "127.0.0.1", port: mysqlPort, user: "lumenfox_it", password: statePassword, database: "lumenfox_it" });
    const [updated] = await connection.query("UPDATE jobs SET status = 'completed' WHERE job_id = ? AND fence = 1", [interruptedJob.job_id]);
    const [steps] = await connection.query("SELECT status, input_tokens, usage_source FROM provider_steps WHERE job_id = ?", [interruptedJob.job_id]);
    await connection.end();
    assert.equal((updated as { affectedRows?: number }).affectedRows ?? 0, 0);
    assert.equal((steps as Array<{ status: string; input_tokens: number | null; usage_source: string }>)[0]?.status, "outcome_unknown");
    assert.equal((steps as Array<{ input_tokens: number | null }>)[0]?.input_tokens, null);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await fake.close();
    await docker(["rm", "-f", ...names]).catch(() => undefined);
  }
});

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

async function waitHttp(url: string) {
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status < 500) return;
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`not ready ${url}`);
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

async function postQuestion(port: number, sessionId: string, text: string) {
  const posted = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, idempotency_key: randomUUID() }),
  });
  assert.equal(posted.status, 202, await posted.clone().text());
  const queued = (await posted.json()) as { job_id: string };
  return waitJob(port, queued.job_id);
}

async function waitJob(port: number, jobId: string) {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const response = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}`);
    const job = (await response.json()) as {
      status: string;
      error?: { code?: string; message?: string };
      usage?: { input_tokens: number | null; usage_source?: string };
      analysis?: { status?: string; answer?: string; sources?: Array<{ engine?: string }> };
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("任务没有结束");
}

async function waitDispatched(port: number, password: string, jobId: string) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    const connection = await mysql.createConnection({ host: "127.0.0.1", port, user: "lumenfox_it", password, database: "lumenfox_it" });
    const [rows] = await connection.query("SELECT status FROM provider_steps WHERE job_id = ?", [jobId]);
    await connection.end();
    const status = (rows as Array<{ status: string }>)[0]?.status;
    if (status) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("没有派发记录");
}
