import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { clickHouseCommand, clickHouseInsert, clickHouseQuery, createClickHouseClient } from "../src/clickhouse-client.js";
import { freshnessManifest, probeClickHouseFreshness } from "../src/freshness.js";
import { MysqlFreshnessStore } from "../src/mysql-freshness.js";
import { loadKnowledge } from "../src/knowledge.js";
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
  const suffix = randomUUID();
  const names = [`lumenfox-oai-ch-${suffix}`, `lumenfox-oai-mysql-${suffix}`, `lumenfox-oai-redis-${suffix}`];
  const createdContainers: string[] = [];
  const dir = mkdtempSync(path.join(tmpdir(), "lumenfox-oai-"));
  const children: ChildProcess[] = [];
  try {
    await docker(["run", "--pull=never", "-d", "--name", names[0], "--tmpfs", "/var/lib/clickhouse:rw,size=512m", "--ulimit", "nofile=262144:262144", "-p", `127.0.0.1:${clickhousePort}:8123`, "-e", `CLICKHOUSE_PASSWORD=${adminPassword}`, "-e", "CLICKHOUSE_DB=harborlight", "-e", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1", "clickhouse/clickhouse-server:24.8.14.39"]);
    createdContainers.push(names[0]!);
    await docker(["run", "--pull=never", "-d", "--name", names[1], "--tmpfs", "/var/lib/mysql:rw,size=1g", "-p", `127.0.0.1:${mysqlPort}:3306`, "-e", `MYSQL_ROOT_PASSWORD=${statePassword}`, "-e", "MYSQL_DATABASE=lumenfox_it", "-e", "MYSQL_USER=lumenfox_it", "-e", `MYSQL_PASSWORD=${statePassword}`, "mysql:8.0.32"]);
    createdContainers.push(names[1]!);
    await docker(["run", "--pull=never", "-d", "--name", names[2], "--tmpfs", "/data:rw,size=64m", "-p", `127.0.0.1:${redisPort}:6379`, "redis:6.2", "redis-server", "--bind", "0.0.0.0", "--protected-mode", "yes", "--requirepass", statePassword]);
    createdContainers.push(names[2]!);
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
    await waitMysql(mysqlPort, statePassword);
    const freshness = await MysqlFreshnessStore.open({ host: "127.0.0.1", port: mysqlPort, user: "lumenfox_it", password: statePassword, database: "lumenfox_it" });
    try {
      const targetsPath = path.join(knowledgeDir, "freshness-targets.json");
      const batch = await freshness.begin(freshnessManifest(loadKnowledge(knowledgeDir), targetsPath));
      const observed = await probeClickHouseFreshness({ targetsPath, query: (sql) => clickHouseQuery(reader, sql) as Promise<Array<{ event_date: string }>> });
      assert.equal(await freshness.publish(batch.version, observed), "published");
    } finally { await freshness.close(); await reader.close(); }
    const baseEnv = {
      PATH: process.env.PATH ?? "",
      SIMULATED_TODAY: "2026-10-29",
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
      PI_CONTEXT_WINDOW: "64000",
      PI_MAX_OUTPUT_TOKENS: "512",
      PI_REASONING: "off",
      PI_PROTOCOL_SCRIPT: "happy",
      RECOVERY_MS: "600",
      LEASE_MS: "4000",
      MAX_MODEL_CALLS: "24",
    };
    let api = spawn(process.execPath, ["--import", "tsx", "src/api.ts"], { cwd: root, env: baseEnv, stdio: "ignore" });
    const dispatcher = spawn(process.execPath, ["--import", "tsx", "src/dispatcher.ts"], { cwd: root, env: baseEnv, stdio: "ignore" });
    children.push(api, dispatcher);
    await waitHttp(`http://127.0.0.1:${apiPort}/api/health`);
    let happyWorker = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], { cwd: root, env: baseEnv, stdio: "ignore" });
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
    const followup = await postQuestion(apiPort, session.session_id, "那日本呢？");
    const followupTools = followup.events.filter((event) => event.type === "tool_started").map((event) => event.payload.tool_name);
    assert.equal(followup.status, "completed", `followup=${followup.status} tools=${followupTools.join("> ")} answer=${followup.analysis?.answer ?? ""} error=${JSON.stringify(followup.error)} events=${JSON.stringify(followup.events.filter((e) => ["model_context", "tool_finished"].includes(e.type)))} obs=${JSON.stringify(fake.observations.slice(-4))}`);
    assert.match(followup.analysis?.answer ?? "", /70/);
    assert.equal(followup.analysis?.sources?.[0]?.engine, "clickhouse-local");
    assert.deepEqual(followupTools, ["read_data_contract_view", "query", "calculate_session_cells", "update_analysis"]);
    assert.ok(fake.observations.some((item) => item.userMessages.length === 2 && item.userMessages[0] === question && item.userMessages[1] === "那日本呢？" && item.currentTurnRoles.includes("tool")));
    const source1 = job.analysis?.sources?.[0]?.resource_id;
    const source2 = followup.analysis?.sources?.[0]?.resource_id;
    assert.ok(source1 && source2 && source1 !== source2);
    const db = await mysql.createConnection({ host: "127.0.0.1", port: mysqlPort, user: "lumenfox_it", password: statePassword, database: "lumenfox_it" });
    const [storedMessages] = await db.query("SELECT job_id, text FROM messages WHERE session_id = ? ORDER BY created_at", [session.session_id]);
    assert.deepEqual((storedMessages as Array<{ job_id: string; text: string }>).map((row) => row.text), [question, "那日本呢？"]);
    const [snapshots] = await db.query("SELECT body_json FROM agent_snapshots WHERE session_id = ? AND job_id = ? AND kind = 'settled' ORDER BY snapshot_id DESC LIMIT 1", [session.session_id, queued.job_id]);
    const firstSnapshot = JSON.parse(String((snapshots as Array<{ body_json: string }>)[0]?.body_json)) as { jsonl: string; branch_entry_ids: string[] };
    const branch = firstSnapshot.jsonl.trim().split("\n").map((line) => JSON.parse(line) as { id?: string; type?: string; message?: { role?: string; content?: unknown } }).filter((entry) => entry.id && firstSnapshot.branch_entry_ids.includes(entry.id));
    assert.ok(branch.some((entry) => entry.message?.role === "user" && JSON.stringify(entry.message.content).includes(question)));
    assert.ok(branch.some((entry) => entry.message?.role === "toolResult"));
    const [owned] = await db.query("SELECT resource_id, body_json FROM resources WHERE resource_id IN (?, ?)", [source1, source2]);
    for (const row of owned as Array<{ resource_id: string; body_json: string }>) {
      const resource = JSON.parse(String(row.body_json)) as { session_id: string; job_id: string; engine: string; freshness_receipts: unknown[] };
      assert.equal(resource.session_id, session.session_id);
      assert.equal(resource.job_id, row.resource_id === source1 ? queued.job_id : followup.job_id);
      assert.equal(resource.engine, "clickhouse-local");
      assert.ok(resource.freshness_receipts.length > 0);
    }
    assert.equal((owned as unknown[]).length, 2);
    await db.end();
    await stopChild(api);
    await stopChild(happyWorker);
    api = spawn(process.execPath, ["--import", "tsx", "src/api.ts"], { cwd: root, env: baseEnv, stdio: "ignore" });
    happyWorker = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], { cwd: root, env: baseEnv, stdio: "ignore" });
    children.push(api, happyWorker);
    await waitHttp(`http://127.0.0.1:${apiPort}/api/health`);
    const reopened = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/${session.session_id}`);
    const history = await reopened.json() as { jobs: Array<{ job_id: string; user_text: string }> };
    assert.deepEqual(history.jobs.map((item) => item.user_text), [question, "那日本呢？"]);
    const third = await postQuestion(apiPort, session.session_id, "日期改成 2026-10-06 到 2026-10-08。");
    assert.equal(third.status, "completed", JSON.stringify(third.error));
    assert.match(third.analysis?.answer ?? "", /30/);
    assert.equal(third.analysis?.sources?.[0]?.engine, "clickhouse-local");
    const source3 = third.analysis?.sources?.[0]?.resource_id;
    assert.ok(source3 && source3 !== source1 && source3 !== source2);
    assert.deepEqual(third.events.filter((event) => event.type === "tool_started").map((event) => event.payload.tool_name), ["read_data_contract_view", "query", "calculate_session_cells", "update_analysis"]);
    const thirdDb = await mysql.createConnection({ host: "127.0.0.1", port: mysqlPort, user: "lumenfox_it", password: statePassword, database: "lumenfox_it" });
    const [thirdResources] = await thirdDb.query("SELECT body_json FROM resources WHERE resource_id = ?", [source3]);
    const thirdResource = JSON.parse(String((thirdResources as Array<{ body_json: string }>)[0]?.body_json)) as { session_id: string; job_id: string; freshness_receipts: unknown[] };
    assert.equal(thirdResource.session_id, session.session_id);
    assert.equal(thirdResource.job_id, third.job_id);
    assert.ok(thirdResource.freshness_receipts.length > 0);
    await thirdDb.end();
    assert.ok(fake.observations.some((item) => item.userMessages.length === 3 && item.userMessages[2] === "日期改成 2026-10-06 到 2026-10-08。"));
    // Optional manual browser regression: a loopback proxy really drops the first
    // SSE socket and records the browser's subsequent cursor and event IDs.
    if (process.env.BROWSER_TRACE_DIR) {
      await browserDisconnectProbe(apiPort, process.env.BROWSER_TRACE_DIR);
    }
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
    const clarify = await postQuestion(apiPort, await another(), "那日本呢？");
    assert.equal(clarify.analysis?.status, "needs_clarification");
    assert.equal(clarify.events.filter((event) => event.type === "tool_started" && event.payload.tool_name === "query").length, 0);
    await stopChild(happyWorker);

    const lowWorker = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], { cwd: root, env: { ...baseEnv, PI_CONTEXT_WINDOW: "8000" }, stdio: "ignore" });
    children.push(lowWorker);
    const lowSession = await another();
    const lowFirst = await postQuestion(apiPort, lowSession, question);
    if (lowFirst.status === "failed") {
      assert.equal(lowFirst.error?.code, "context_window_exceeded");
      assert.equal(lowFirst.events.some((event) => event.type === "tool_started" && event.payload.tool_name === "query"), false);
    } else {
      assert.match(lowFirst.analysis?.answer ?? "", /670/, JSON.stringify(lowFirst.error));
      const lowFollowup = await postQuestion(apiPort, lowSession, "那日本呢？");
      // The scripted compaction cannot prove natural-language scope inheritance.
      if (lowFollowup.status === "needs_clarification") {
        assert.equal(lowFollowup.events.some((event) => event.type === "tool_started" && event.payload.tool_name === "query"), false);
      } else {
        assert.equal(lowFollowup.status, "failed", JSON.stringify(lowFollowup.error));
        assert.equal(lowFollowup.error?.code, "context_window_exceeded");
      }
    }
    const oversized = await postQuestion(apiPort, await another(), question + "合成范围填充".repeat(6000));
    assert.equal(oversized.status, "failed", JSON.stringify(oversized.error));
    assert.equal(oversized.error?.code, "context_window_exceeded");
    assert.equal(oversized.analysis, null);
    assert.equal(oversized.events.filter((event) => event.type === "job_failed").length, 1);
    await stopChild(lowWorker);

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
    if (createdContainers.length) await docker(["rm", "-f", ...createdContainers]).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

async function browserDisconnectProbe(apiPort: number, dir: string): Promise<void> {
  const trace: { after: number; seqs: number[] }[] = [];
  let dropped = false;
  const proxy = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const isEvents = /^\/api\/jobs\/[^/]+\/events$/u.test(url.pathname);
    const item = isEvents ? { after: Number(url.searchParams.get("after") ?? 0), seqs: [] as number[] } : null;
    if (item) trace.push(item);
    const upstream = httpRequest({ hostname: "127.0.0.1", port: apiPort, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${apiPort}` } }, (incoming) => {
      res.writeHead(incoming.statusCode ?? 502, incoming.headers);
      let pending = "";
      incoming.on("data", (chunk: Buffer) => {
        if (res.destroyed) return;
        res.write(chunk);
        if (!item) return;
        pending += chunk.toString("utf8");
        const frames = pending.split("\n\n"); pending = frames.pop() ?? "";
        for (const frame of frames) {
          const match = frame.match(/^id: (\d+)$/mu);
          if (match) item.seqs.push(Number(match[1]));
        }
        writeFileSync(path.join(dir, "trace.json"), JSON.stringify(trace));
        if (!dropped && item.seqs.length) {
          dropped = true;
          setTimeout(() => { res.destroy(); incoming.destroy(); }, 250);
        }
      });
      incoming.on("end", () => { if (!res.destroyed) res.end(); });
      incoming.on("error", () => { if (!res.destroyed) res.destroy(); });
    });
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  writeFileSync(path.join(dir, "ready.json"), JSON.stringify({ port: typeof address === "object" && address ? address.port : 0 }));
  try {
    const deadline = Date.now() + 240_000;
    while (!existsSync(path.join(dir, "done")) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(existsSync(path.join(dir, "done")), "browser probe timed out");
    assert.ok(dropped && trace.length >= 2 && trace[1]!.after > 0, JSON.stringify(trace));
    const sequences = trace.flatMap((item) => item.seqs);
    assert.ok(sequences.length > 1 && sequences.every((value, index) => value === index + 1), JSON.stringify(trace));
    writeFileSync(path.join(dir, "verified.json"), JSON.stringify({ trace, sequences }));
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
}

function stopChild(child: ChildProcess) {
  return new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
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
      job_id: string;
      error?: { code?: string; message?: string };
      usage?: { input_tokens: number | null; usage_source?: string };
      analysis?: { status?: string; answer?: string; sources?: Array<{ engine?: string; resource_id?: string }> };
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
