import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { isolatedDocker, loopbackPort, runOwnedContainer } from "./isolated-docker.js";
import { GlobalBudget } from "../src/global-budget.js";
import { clickHouseScopedProjection } from "../src/clickhouse-scoped-projection.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const sourceKnowledgeDir = path.join(root, "knowledge", "harborlight");
const token = "fictional-loopback-token";
const question = "纸灯 在 2026-10-06 到 2026-10-12（美国、iOS、雾帆）的新增用户是多少？";

test("本地 OpenAI 兼容假服务驱动 AgentSession 查询 ClickHouse，未知派发不会被重试", async () => {
  const fake = await startFakeOpenAI(token);
  const adminPassword = randomBytes(12).toString("hex");
  const readerPassword = randomBytes(12).toString("hex");
  const statePassword = randomBytes(12).toString("hex");
  const suffix = randomUUID();
  const names = [`lumenfox-oai-ch-${suffix}`, `lumenfox-oai-mysql-${suffix}`, `lumenfox-oai-redis-${suffix}`];
  const createdContainers: string[] = [];
  const dir = mkdtempSync(path.join(tmpdir(), "lumenfox-oai-"));
  const budgetOptions = { path: path.join(dir, "budget.sqlite"), budgetId: "protocol-integration", maxRequests: 1000, maxTokens: 10000000 };
  const globalBudget = await GlobalBudget.activate(budgetOptions);
  const knowledgeDir = path.join(dir, "knowledge");
  const children: ChildProcess[] = [];
  try {
    cpSync(sourceKnowledgeDir, knowledgeDir, { recursive: true });
    // These schema variants belong only to this integration run. They model an
    // explicitly nullable business dimension; the shipped contracts stay intact.
    for (const name of ["fact_fox_daily_install", "fact_fox_daily_payment"]) {
      const file = path.join(knowledgeDir, "contracts", `${name}.json`);
      const contract = JSON.parse(readFileSync(file, "utf8"));
      const dimension = contract.columns.find((column: { name: string }) => column.name === "country_code");
      assert.ok(dimension); dimension.type = "Nullable(String)"; dimension.nullable = true;
      writeFileSync(file, JSON.stringify(contract));
    }
    await runOwnedContainer(["run", "--pull=never", "-d", "--name", names[0]!, "--label", `dataagent.test.run=${suffix}`, "--tmpfs", "/var/lib/clickhouse:rw,size=512m", "--ulimit", "nofile=262144:262144", "-p", "127.0.0.1::8123", "-e", `CLICKHOUSE_PASSWORD=${adminPassword}`, "-e", "CLICKHOUSE_DB=harborlight", "-e", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1", "clickhouse/clickhouse-server:24.8.14.39"], names[0]!, suffix, createdContainers);
    await runOwnedContainer(["run", "--pull=never", "-d", "--name", names[1]!, "--label", `dataagent.test.run=${suffix}`, "--tmpfs", "/var/lib/mysql:rw,size=1g", "-p", "127.0.0.1::3306", "-e", `MYSQL_ROOT_PASSWORD=${statePassword}`, "-e", "MYSQL_DATABASE=lumenfox_it", "-e", "MYSQL_USER=lumenfox_it", "-e", `MYSQL_PASSWORD=${statePassword}`, "mysql:8.0.32"], names[1]!, suffix, createdContainers);
    await runOwnedContainer(["run", "--pull=never", "-d", "--name", names[2]!, "--label", `dataagent.test.run=${suffix}`, "--tmpfs", "/data:rw,size=64m", "-p", "127.0.0.1::6379", "redis:6.2", "redis-server", "--bind", "0.0.0.0", "--protected-mode", "yes", "--requirepass", statePassword], names[2]!, suffix, createdContainers);
    const clickhousePort = await loopbackPort(names[0]!, 8123);
    const mysqlPort = await loopbackPort(names[1]!, 3306);
    const redisPort = await loopbackPort(names[2]!, 6379);
    const apiPort = await freePort();
    const clickhouseUrl = `http://127.0.0.1:${clickhousePort}`;
    await waitHttp(clickhouseUrl);
    const bootstrap = createClickHouseClient({ url: clickhouseUrl, username: "default", password: adminPassword, database: "default", maxRowsToRead: 5_000_000, timeoutSeconds: 30 }, false);
    await clickHouseCommand(bootstrap, "CREATE DATABASE IF NOT EXISTS harborlight");
    await bootstrap.close();
    const admin = createClickHouseClient({ url: clickhouseUrl, username: "default", password: adminPassword, database: "harborlight", maxRowsToRead: 5_000_000, timeoutSeconds: 30 }, false);
    for (const table of WAREHOUSE_TABLES) {
      const nullable = ["fact_fox_daily_install", "fact_fox_daily_payment"].includes(table.table);
      const sql = createTableSql(table);
      await clickHouseCommand(admin, nullable ? sql.replace("country_code LowCardinality(String)", "country_code Nullable(String)") + " SETTINGS allow_nullable_key = 1" : sql);
    }
    const data = smallWarehouse();
    await clickHouseInsert(admin, "dim_fox_title", data.titles);
    await clickHouseInsert(admin, "dim_fox_channel", data.channels);
    await clickHouseInsert(admin, "fact_fox_daily_install", data.installs);
    await clickHouseInsert(admin, "fact_fox_daily_active", data.active);
    await clickHouseInsert(admin, "fact_fox_daily_payment", data.payments);
    // Independent synthetic goldens: 6/3=2, 10/2=5, 0/0 is unknown,
    // 9/3=3, 4.5/3=1.5 and 12/4=3, by day and channel.
    const dayFixture = [
      ["2026-10-06", "mist_ads", "6.00", 3], ["2026-10-06", "pebble_net", "10.00", 2],
      ["2026-10-07", "mist_ads", "0.00", 0], ["2026-10-07", "pebble_net", "9.00", 3],
      ["2026-10-08", "mist_ads", "4.50", 3], ["2026-10-08", "pebble_net", "12.00", 4],
    ] as const;
    await clickHouseInsert(admin, "fact_fox_daily_install", dayFixture.map(([event_date, channel_id, , new_users]) => ({ event_date, channel_id, title_id: "date_demo", platform: "android", country_code: "DATEZZ", new_users, device_token: null })));
    await clickHouseInsert(admin, "fact_fox_daily_payment", dayFixture.map(([event_date, channel_id, amount_usd]) => ({ event_date, channel_id, title_id: "date_demo", platform: "android", country_code: "DATEZZ", amount_usd, cost_usd: "1.00" })));
    const nullBase = { event_date: "2026-10-08", title_id: "null_demo", platform: "android", channel_id: "mist_ads" };
    await clickHouseInsert(admin, "fact_fox_daily_install", [
      { ...nullBase, country_code: null, new_users: 5, device_token: null },
      { ...nullBase, country_code: "NULL", new_users: 10, device_token: null },
      { ...nullBase, country_code: "ZERO", new_users: 0, device_token: null },
      { ...nullBase, country_code: "RIGHT_ONLY", new_users: 3, device_token: null },
    ]);
    await clickHouseInsert(admin, "fact_fox_daily_payment", [
      { ...nullBase, country_code: null, amount_usd: "10.00", cost_usd: "1.00" },
      { ...nullBase, country_code: "NULL", amount_usd: "40.00", cost_usd: "2.00" },
      { ...nullBase, country_code: "ZERO", amount_usd: "1.00", cost_usd: "1.00" },
      { ...nullBase, country_code: "LEFT_ONLY", amount_usd: "8.00", cost_usd: "1.00" },
    ]);
    await clickHouseInsert(admin, "fact_fox_ad_receipt", data.revenue);
    await clickHouseInsert(admin, "fact_fox_daily_spend", data.spend);
    await clickHouseInsert(admin, "fact_fox_retention_cohort", data.retention);
    await clickHouseInsert(admin, "fact_fox_cohort_payback", data.cohortPayback);
    await clickHouseInsert(admin, "fact_fox_experiment_arm", data.arms);
    await clickHouseInsert(admin, "fact_fox_experiment_metric", data.experimentMetrics);
    const dateEndpoints = await clickHouseQuery(admin, "SELECT toString(toDate('1970-01-01')) AS first_day, toString(toDate('2149-06-06')) AS last_day");
    assert.deepEqual(dateEndpoints, [{ first_day: "1970-01-01", last_day: "2149-06-06" }]);
    await clickHouseCommand(admin, `CREATE USER IF NOT EXISTS fox_reader IDENTIFIED BY '${readerPassword}'`);
    await clickHouseCommand(admin, "GRANT SELECT ON harborlight.* TO fox_reader");
    await admin.close();
    // Exercise the actual seed command against this test's isolated ClickHouse.
    const seedEnv = { PATH: process.env.PATH ?? "", CLICKHOUSE_URL: clickhouseUrl, SYNTHETIC_DATABASE: "synthetic_rolling_it", SYNTHETIC_ADMIN_USER: "default", SYNTHETIC_ADMIN_PASSWORD: adminPassword, SYNTHETIC_READER_USER: "synthetic_rolling_reader", SYNTHETIC_READER_PASSWORD: readerPassword, SIMULATED_TODAY: "2027-02-15" };
    const seed = spawn(process.execPath, ["--import", "tsx", "src/seed-clickhouse.ts"], { cwd: root, env: seedEnv, stdio: "ignore" });
    assert.equal(await new Promise((resolve) => seed.once("exit", resolve)), 0);
    const duplicateSeed = spawn(process.execPath, ["--import", "tsx", "src/seed-clickhouse.ts"], { cwd: root, env: seedEnv, stdio: "ignore" });
    assert.notEqual(await new Promise((resolve) => duplicateSeed.once("exit", resolve)), 0, "不能覆盖已存在的数据库");
    const rollingReader = createClickHouseClient({ url: clickhouseUrl, username: "synthetic_rolling_reader", password: readerPassword, database: "synthetic_rolling_it", maxRowsToRead: 5_000_000, timeoutSeconds: 10 }, true);
    try {
      const observed = await probeClickHouseFreshness({ targetsPath: path.join(knowledgeDir, "freshness-targets-rolling.example.json"), simulatedToday: "2027-02-15", query: (sql) => clickHouseQuery(rollingReader, sql) as Promise<Array<{ event_date: string }>> });
      assert.equal(observed.tables.fact_fox_daily_install?.status, "fresh");
      assert.equal(observed.tables.fact_fox_retention_cohort?.status, "fresh");
      const values = await clickHouseQuery(rollingReader, "SELECT event_date, new_users FROM fact_fox_daily_install WHERE title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'US' AND channel_id = 'mist_ads' AND event_date >= '2027-01-23' AND event_date <= '2027-01-29' ORDER BY event_date");
      assert.deepEqual(values.map((row) => row.new_users), [100, 0, 120, null, 140, 150, 160]);
    } finally { await rollingReader.close(); }
    const reader = createClickHouseClient({ url: clickhouseUrl, username: "fox_reader", password: readerPassword, database: "harborlight", maxRowsToRead: 5_000_000, timeoutSeconds: 10 }, true);
    const freshnessPath = path.join(dir, "freshness.json");
    await waitMysql(mysqlPort, statePassword);
    const freshness = await MysqlFreshnessStore.open({ host: "127.0.0.1", port: mysqlPort, user: "lumenfox_it", password: statePassword, database: "lumenfox_it" });
    try {
      const rollingPath = path.join(knowledgeDir, "freshness-targets-rolling.example.json");
      const rollingKnowledge = loadKnowledge(knowledgeDir);
      const firstDay = { simulatedToday: "2026-10-29" };
      const nextDay = { simulatedToday: "2026-10-30" };
      const rollingManifest = freshnessManifest(rollingKnowledge, rollingPath, firstDay);
      const rollingBatch = await freshness.begin(rollingManifest);
      const rollingObserved = await probeClickHouseFreshness({ targetsPath: rollingPath, ...firstDay, query: (sql) => clickHouseQuery(reader, sql) as Promise<Array<{ event_date: string }>> });
      assert.equal(rollingObserved.tables.fact_fox_daily_install?.status, "fresh");
      assert.equal(rollingObserved.valid_until, "2026-10-29");
      assert.equal(await freshness.publish(rollingBatch.version, rollingObserved), "published");
      assert.equal((await freshness.current())?.version, rollingBatch.version);
      assert.notEqual(rollingManifest.target_hash, freshnessManifest(rollingKnowledge, rollingPath, nextDay).target_hash);
      const nextObserved = await probeClickHouseFreshness({ targetsPath: rollingPath, ...nextDay, query: (sql) => clickHouseQuery(reader, sql) as Promise<Array<{ event_date: string }>> });
      assert.equal(nextObserved.tables.fact_fox_daily_install?.status, "stale");
      assert.equal((await freshness.get(rollingBatch.version))?.tables.fact_fox_daily_install?.status, "fresh", "旧版本仅供审计");
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
      DATAAGENT_TEST_GLOBAL_BUDGET_PATH: budgetOptions.path,
      DEEPSEEK_BUDGET_ID: budgetOptions.budgetId,
      DEEPSEEK_BUDGET_MAX_REQUESTS: String(budgetOptions.maxRequests),
      DEEPSEEK_BUDGET_MAX_TOKENS: String(budgetOptions.maxTokens),
      PI_PROVIDER: process.env.TEST_DEEPSEEK_DIALECT === "1" ? "deepseek" : "openai-compatible",
      PI_MODEL: process.env.TEST_DEEPSEEK_DIALECT === "1" ? "deepseek-flash" : "local-protocol",
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
    const noteSessionResponse = await fetch(`http://127.0.0.1:${apiPort}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const noteSession = ((await noteSessionResponse.json()) as { session_id: string }).session_id;
    const noted = await postQuestion(apiPort, noteSession, "合成工作记录后继续：纸灯美国 iOS 雾帆本周新增多少？");
    // The seven-day synthetic fixture has one NULL: 670 is the sum of the
    // observed values, not a complete seven-day population.
    assert.equal(noted.status, "partial", JSON.stringify({ error: noted.error, answer: noted.analysis?.answer, reasons: noted.analysis?.server_reasons, events: noted.events.filter((event) => event.type === "tool_finished") }));
    assert.match(noted.analysis?.answer ?? "", /670/);
    assert.ok(noted.analysis?.server_reasons?.includes("completeness_gap"));
    assert.match(noted.analysis?.answer ?? "", /排除了 1 行 NULL/);
    assert.equal(noted.analysis?.analysis_declaration?.provenance, "model_declared");
    const notedTools = noted.events.filter((event) => event.type === "tool_started").map((event) => event.payload.tool_name);
    assert.equal(notedTools[0], "update_analysis");
    assert.ok(notedTools.indexOf("query") > notedTools.indexOf("update_analysis"));
    assert.ok(notedTools.indexOf("calculate_session_cells") > notedTools.indexOf("query"));
    assert.equal(noted.events.filter((event) => event.type === "candidate_reviewed").length, 1);
    assert.equal(noted.events.filter((event) => ["job_finished", "job_failed", "job_cancelled", "job_timed_out"].includes(event.type)).length, 1);
    if (process.env.TEST_DEEPSEEK_DIALECT === "1") assert.ok(fake.observations.every((item) => item.thinkingType === "disabled"));
    const followup = await postQuestion(apiPort, session.session_id, "那日本呢？");
    const followupTools = followup.events.filter((event) => event.type === "tool_started").map((event) => event.payload.tool_name);
    assert.equal(followup.status, "completed", `followup=${followup.status} tools=${followupTools.join("> ")} answer=${followup.analysis?.answer ?? ""} error=${JSON.stringify(followup.error)} events=${JSON.stringify(followup.events.filter((e) => ["model_context", "tool_finished"].includes(e.type)))} obs=${JSON.stringify(fake.observations.slice(-4))}`);
    assert.match(followup.analysis?.answer ?? "", /不是同一原子快照/);
    assert.match(followup.analysis?.answer ?? "", /70/);
    assert.equal(followup.analysis?.sources?.[0]?.engine, "clickhouse-local");
    assert.deepEqual(followupTools, ["read_data_contract_view", "query", "calculate_session_cells"]);
    assert.ok(fake.observations.some((item) => item.userMessages.length === 2 && item.userMessages[0] === question && item.userMessages[1] === "那日本呢？" && item.currentTurnRoles.includes("tool")));
    assert.ok(fake.observations.some((item) => item.userMessages.length === 2 && item.historySummaryCount >= 1), "后续模型请求应携带精简的旧回合服务端结论");
    const source1 = job.analysis?.sources?.[0]?.resource_id;
    const source2 = followup.analysis?.sources?.[0]?.resource_id;
    assert.ok(source1 && source2 && source1 !== source2);
    const db = await mysql.createConnection({ host: "127.0.0.1", port: mysqlPort, user: "lumenfox_it", password: statePassword, database: "lumenfox_it" });
    const [storedMessages] = await db.query("SELECT job_id, text FROM messages WHERE session_id = ? ORDER BY created_at", [session.session_id]);
    assert.deepEqual((storedMessages as Array<{ job_id: string; text: string }>).map((row) => row.text), [question, "那日本呢？"]);
    const [snapshots] = await db.query("SELECT body_json FROM agent_snapshots WHERE session_id = ? AND job_id = ? AND kind = 'settled' ORDER BY snapshot_id DESC LIMIT 1", [session.session_id, queued.job_id]);
    const firstSnapshot = JSON.parse(String((snapshots as Array<{ body_json: string }>)[0]?.body_json)) as { jsonl: string; branch_entry_ids: string[] };
    const branch = firstSnapshot.jsonl.trim().split("\n").map((line) => JSON.parse(line) as { id?: string; type?: string; message?: { role?: string; toolName?: string; content?: unknown } }).filter((entry) => entry.id && firstSnapshot.branch_entry_ids.includes(entry.id));
    assert.ok(branch.some((entry) => entry.message?.role === "user" && JSON.stringify(entry.message.content).includes(question)));
    assert.ok(branch.some((entry) => entry.message?.role === "toolResult"));
    const previousReceipt = branch.find((entry) => entry.message?.role === "toolResult" && entry.message.toolName === "calculate_session_cells");
    const previousQuery = branch.find((entry) => entry.message?.role === "toolResult" && entry.message.toolName === "query");
    const followObservation = fake.observations.find((item) => item.userMessages.length === 2 && item.historySummaryCount === 2);
    assert.ok(previousReceipt && previousQuery && followObservation);
    const fullBytes = Buffer.byteLength(JSON.stringify(previousReceipt.message?.content)) + Buffer.byteLength(JSON.stringify(previousQuery.message?.content));
    assert.ok(followObservation.historySummaryBytes < fullBytes, "模型请求应减小旧查询和分析回执，原生 JSONL 保留完整内容");
    if (process.env.DIAG_CONTEXT_SIZES === "1") console.log(`合成旧分析回执 ${fullBytes} 字节，发送摘要 ${followObservation.historySummaryBytes} 字节；追问请求体 ${followObservation.requestBytes} 字节。`);
    const [owned] = await db.query("SELECT resource_id, body_json FROM resources WHERE resource_id IN (?, ?)", [source1, source2]);
    for (const row of owned as Array<{ resource_id: string; body_json: string }>) {
      const resource = JSON.parse(String(row.body_json)) as { session_id: string; job_id: string; engine: string; sql_review_engine?: string; freshness_receipts: unknown[] };
      assert.equal(resource.session_id, session.session_id);
      assert.equal(resource.job_id, row.resource_id === source1 ? queued.job_id : followup.job_id);
      assert.equal(resource.engine, "clickhouse-local");
      assert.equal(resource.sql_review_engine, "clickhouse_ast_direct");
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
    assert.match(third.analysis?.answer ?? "", /不是同一原子快照/);
    assert.match(third.analysis?.answer ?? "", /30/);
    assert.equal(third.analysis?.sources?.[0]?.engine, "clickhouse-local");
    const source3 = third.analysis?.sources?.[0]?.resource_id;
    assert.ok(source3 && source3 !== source1 && source3 !== source2);
    assert.deepEqual(third.events.filter((event) => event.type === "tool_started").map((event) => event.payload.tool_name), ["read_data_contract_view", "query", "calculate_session_cells"]);
    const thirdDb = await mysql.createConnection({ host: "127.0.0.1", port: mysqlPort, user: "lumenfox_it", password: statePassword, database: "lumenfox_it" });
    const [thirdResources] = await thirdDb.query("SELECT body_json FROM resources WHERE resource_id = ?", [source3]);
    const thirdResource = JSON.parse(String((thirdResources as Array<{ body_json: string }>)[0]?.body_json)) as { session_id: string; job_id: string; freshness_receipts: unknown[] };
    assert.equal(thirdResource.session_id, session.session_id);
    assert.equal(thirdResource.job_id, third.job_id);
    assert.ok(thirdResource.freshness_receipts.length > 0);
    await thirdDb.end();
    assert.ok(fake.observations.some((item) => item.userMessages.length === 3 && item.userMessages[2] === "日期改成 2026-10-06 到 2026-10-08。"));
    const decimalSession = await fetch(`http://127.0.0.1:${apiPort}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const decimalSessionId = ((await decimalSession.json()) as { session_id: string }).session_id;
    const clarification = await postQuestion(apiPort, decimalSessionId, "只说看看收入");
    assert.equal(clarification.status, "needs_clarification", JSON.stringify(clarification.error));
    assert.equal(clarification.events.some((event) => event.type === "tool_started" && event.payload.tool_name === "query"), false);
    assert.equal(clarification.analysis?.sources?.length, 0);
    const supplement = "合成精确金额：纸灯美国 iOS 雾帆，比较 2026-10-06 和 2026-10-08。";
    const decimal = await postQuestion(apiPort, decimalSessionId, supplement);
    assert.equal(decimal.status, "completed", JSON.stringify({ error: decimal.error, tools: decimal.events.filter((event) => event.type === "tool_finished").map((event) => ({ tool: event.payload.tool_name, code: event.payload.code, is_error: event.payload.is_error })) }));
    assert.ok(fake.observations.some((item) => item.userMessages.length === 2 && item.userMessages[0] === "只说看看收入" && item.userMessages[1] === supplement && item.historySummaryCount > 0));
    assert.match(decimal.analysis?.answer ?? "", /不是同一原子快照/);
    assert.match(decimal.analysis?.answer ?? "", /90071992547409\.91/);
    assert.match(decimal.analysis?.answer ?? "", /90071992547408\.91/);
    assert.match(decimal.analysis?.answer ?? "", /90071992547409\.9100/);
    assert.match(decimal.analysis?.answer ?? "", /90071992547408\.910000000000000000/);
    assert.equal(decimal.events.filter((event) => event.type === "tool_started" && event.payload.tool_name === "calculate_session_cells").length, 2);
    assert.equal(decimal.analysis?.sources?.length, 2);
    assert.equal(decimal.analysis?.sources?.every((source) => source.engine === "clickhouse-local" && source.freshness_receipts?.length), true);
    const decimalIds = decimal.analysis?.sources?.map((source) => source.resource_id) ?? [];
    assert.equal(new Set(decimalIds).size, 2);
    const decimalDb = await mysql.createConnection({ host: "127.0.0.1", port: mysqlPort, user: "lumenfox_it", password: statePassword, database: "lumenfox_it" });
    try {
      for (const id of decimalIds) {
        const [rows] = await decimalDb.query("SELECT body_json FROM resources WHERE resource_id = ?", [id]);
        const resource = JSON.parse(String((rows as Array<{ body_json: string }>)[0]?.body_json)) as { session_id: string; job_id: string; sql_review_engine?: string; rows: Array<{ total: unknown }>; freshness_receipts: unknown[] };
        assert.equal(resource.session_id, decimalSessionId);
        assert.equal(resource.job_id, decimal.job_id);
        assert.equal(resource.sql_review_engine, "clickhouse_ast_direct");
        assert.equal(typeof resource.rows[0]?.total, "string");
        assert.ok(resource.freshness_receipts.length > 0);
      }
    } finally { await decimalDb.end(); }
    const ratioSession = await fetch(`http://127.0.0.1:${apiPort}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const ratioSessionId = ((await ratioSession.json()) as { session_id: string }).session_id;
    const ratio = await postQuestion(apiPort, ratioSessionId, "合成收入成本比：2026-10-08 美国 iOS 雾帆的收入除以成本。");
    assert.equal(ratio.status, "completed", `${JSON.stringify(ratio.error)} ${ratio.analysis?.answer ?? ""}`);
    assert.match(ratio.analysis?.answer ?? "", /不是同一原子快照/);
    assert.match(ratio.analysis?.answer ?? "", /amount_usd divide fact_fox_daily_payment\.cost_usd/);
    assert.match(ratio.analysis?.answer ?? "", /0\.500000000000000000 比值/);
    assert.equal(ratio.analysis?.sources?.length, 2);
    assert.equal(ratio.analysis?.sources?.every((source) => source.engine === "clickhouse-local" && source.freshness_receipts?.length), true);
    assert.deepEqual(ratio.events.filter((event) => event.type === "tool_started").map((event) => event.payload.tool_name), ["read_data_contract_view", "query", "query", "calculate_session_cells"]);
    const ratioDb = await mysql.createConnection({ host: "127.0.0.1", port: mysqlPort, user: "lumenfox_it", password: statePassword, database: "lumenfox_it" });
    try {
      for (const source of ratio.analysis?.sources ?? []) {
        const [rows] = await ratioDb.query("SELECT body_json FROM resources WHERE resource_id = ?", [source.resource_id]);
        const resource = JSON.parse(String((rows as Array<{ body_json: string }>)[0]?.body_json)) as { session_id: string; job_id: string };
        assert.equal(resource.session_id, ratioSessionId);
        assert.equal(resource.job_id, ratio.job_id);
      }
    } finally { await ratioDb.end(); }
    const groupedSession = await fetch(`http://127.0.0.1:${apiPort}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const groupedSessionId = ((await groupedSession.json()) as { session_id: string }).session_id;
    const groupedRatio = await postQuestion(apiPort, groupedSessionId, "合成多渠道收入成本比：按国家和渠道对齐 2026-10-08 收入与成本。");
    assert.equal(groupedRatio.status, "completed", `${JSON.stringify(groupedRatio.error)} ${groupedRatio.analysis?.answer ?? ""}`);
    assert.match(groupedRatio.analysis?.answer ?? "", /不是同一原子快照/);
    assert.match(groupedRatio.analysis?.answer ?? "", /channel_id=mist_ads，country_code=JP.*结果 1\.500000000000000000 比值/);
    assert.match(groupedRatio.analysis?.answer ?? "", /channel_id=mist_ads，country_code=US.*结果 0\.500000000000000000 比值/);
    assert.match(groupedRatio.analysis?.answer ?? "", /channel_id=pebble_net，country_code=US.*结果 2\.000000000000000000 比值/);
    assert.equal(groupedRatio.analysis?.sources?.length, 2);
    const joinSession = await fetch(`http://127.0.0.1:${apiPort}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const joinSessionId = ((await joinSession.json()) as { session_id: string }).session_id;
    const join = await postQuestion(apiPort, joinSessionId, "合成产品维表关联：统计纸灯日本 iOS 雾帆 2026-10-06 到 2026-10-12 新增。");
    assert.equal(join.status, "completed", `${JSON.stringify(join.error)} ${join.analysis?.answer ?? ""}`);
    assert.match(join.analysis?.answer ?? "", /已核验 JOIN 求和 70；单位 人/);
    assert.match(join.analysis?.answer ?? "", /dim_fox_title\.title_name=纸灯/);
    assert.equal(join.analysis?.sources?.[0]?.engine, "clickhouse-local");
    assert.equal(join.analysis?.sources?.[0]?.freshness_receipts?.length, 2);
    assert.deepEqual(join.events.filter((event) => event.type === "tool_started").map((event) => event.payload.tool_name), ["read_data_contract_view", "read_data_contract_view", "query"]);
    assert.ok(join.events.some((event) => event.type === "tool_finished" && event.payload.tool_name === "query" && event.payload.is_error === false));
    const joinTransformSession = await fetch(`http://127.0.0.1:${apiPort}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const joinTransformSessionId = ((await joinTransformSession.json()) as { session_id: string }).session_id;
    const joinTransform = await postQuestion(apiPort, joinTransformSessionId, "合成维表关联后再汇总：纸灯日本 iOS 雾帆 2026-10-06 到 2026-10-12 新增，合计后再加自身。");
    assert.equal(joinTransform.status, "completed", JSON.stringify({ error: joinTransform.error, answer: joinTransform.analysis?.answer, reasons: joinTransform.analysis?.server_reasons, tools: joinTransform.events.filter((event) => event.type === "tool_finished") }));
    assert.match(joinTransform.analysis?.answer ?? "", /140/);
    assert.equal(joinTransform.events.find((event) => event.type === "candidate_reviewed")?.payload.selected_count, 1);
    assert.equal(joinTransform.events.filter((event) => event.type === "tool_finished" && event.payload.tool_name === "calculate_session_cells" && event.payload.is_error === false).length, 2);
    assert.equal(joinTransform.analysis?.sources?.[0]?.engine, "clickhouse-local");
    await stopChild(happyWorker);
    const candidateWorker = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], { cwd: root, env: { ...baseEnv, PI_HOLD_AFTER_CANDIDATE_MS: "8000" }, stdio: "ignore" });
    children.push(candidateWorker);
    const recoverySessionResponse = await fetch(`http://127.0.0.1:${apiPort}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const recoverySession = ((await recoverySessionResponse.json()) as { session_id: string }).session_id;
    const recoveryPost = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/${recoverySession}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "合成维表关联后再汇总：纸灯日本 iOS 雾帆 2026-10-06 到 2026-10-12 新增，合计后再加自身。", idempotency_key: randomUUID() }) });
    assert.equal(recoveryPost.status, 202);
    const recoveryId = ((await recoveryPost.json()) as { job_id: string }).job_id;
    const savedCandidate = await waitCandidateSnapshot(apiPort, recoveryId);
    await stopChild(candidateWorker);
    await new Promise((resolve) => setTimeout(resolve, 4500));
    happyWorker = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], { cwd: root, env: baseEnv, stdio: "ignore" });
    children.push(happyWorker);
    const resumedJoin = await waitJob(apiPort, recoveryId);
    assert.equal(resumedJoin.status, "completed", JSON.stringify({ error: resumedJoin.error, reasons: resumedJoin.analysis?.server_reasons }));
    assert.match(resumedJoin.analysis?.answer ?? "", /140/);
    assert.equal(resumedJoin.events.filter((event) => event.type === "tool_started" && event.payload.tool_name === "query").length, 1);
    assert.equal(resumedJoin.events.filter((event) => event.type === "tool_started" && event.payload.tool_name === "calculate_session_cells").length, 2);
    assert.equal(resumedJoin.events.find((event) => event.type === "model_context" && event.payload.decision === "reread_candidate")?.payload.leaf_id, savedCandidate);
    assert.equal(resumedJoin.events.filter((event) => event.type === "candidate_reviewed").length, 1);
    assert.equal(resumedJoin.events.filter((event) => ["job_finished", "job_failed", "job_cancelled", "job_timed_out"].includes(event.type)).length, 1);
    const channelJoinSession = await fetch(`http://127.0.0.1:${apiPort}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const channelJoinSessionId = ((await channelJoinSession.json()) as { session_id: string }).session_id;
    const channelJoin = await postQuestion(apiPort, channelJoinSessionId, "合成渠道维表关联：统计纸灯日本 iOS 雾帆 2026-10-06 到 2026-10-12 新增。");
    assert.equal(channelJoin.status, "completed", `${JSON.stringify(channelJoin.error)} ${channelJoin.analysis?.answer ?? ""} events=${JSON.stringify(channelJoin.events)}`);
    assert.match(channelJoin.analysis?.answer ?? "", /已核验 JOIN 求和 70；单位 人/);
    assert.match(channelJoin.analysis?.answer ?? "", /dim_fox_channel\.channel_name=雾帆/);
    assert.equal(channelJoin.analysis?.sources?.[0]?.engine, "clickhouse-local");
    assert.equal(channelJoin.analysis?.sources?.[0]?.freshness_receipts?.length, 2);
    assert.equal(channelJoin.events.filter((event) => event.type === "job_finished").length, 1);
    const joinDb = await mysql.createConnection({ host: "127.0.0.1", port: mysqlPort, user: "lumenfox_it", password: statePassword, database: "lumenfox_it" });
    try {
      for (const [result, sessionId, dimension] of [[join, joinSessionId, "dim_fox_title"], [channelJoin, channelJoinSessionId, "dim_fox_channel"]] as const) {
        const source = result.analysis?.sources?.[0];
        assert.ok(source?.resource_id && source.execution_id && source.observed_at);
        const [rows] = await joinDb.query("SELECT body_json FROM resources WHERE resource_id = ?", [source.resource_id]);
        const resource = JSON.parse(String((rows as Array<{ body_json: string }>)[0]?.body_json)) as { session_id: string; job_id: string; execution_id: string; created_at: string; freshness_receipts: Array<{ table: string; status: string; version: number; publication_id: string }> };
        assert.equal(resource.session_id, sessionId);
        assert.equal(resource.job_id, result.job_id);
        assert.equal(resource.execution_id, source.execution_id);
        assert.equal(resource.created_at, source.observed_at);
        assert.deepEqual(resource.freshness_receipts.map((receipt) => receipt.table).sort(), [dimension, "fact_fox_daily_install"].sort());
        assert.ok(resource.freshness_receipts.every((receipt) => receipt.status === "fresh" && receipt.version === resource.freshness_receipts[0]?.version && receipt.publication_id === resource.freshness_receipts[0]?.publication_id));
        const [sessions] = await joinDb.query("SELECT actor_id FROM sessions WHERE session_id = ?", [sessionId]);
        assert.equal((sessions as Array<{ actor_id: string }>)[0]?.actor_id, "demo-analyst");
      }
    } finally { await joinDb.end(); }
    const largeSession = await fetch(`http://127.0.0.1:${apiPort}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const largeSessionId = ((await largeSession.json()) as { session_id: string }).session_id;
    const largeExpected = (JSON.parse(readFileSync(path.join(root, "eval", "harborlight-query-golden.json"), "utf8")) as { pagination_case: { count: number; sum: string } }).pagination_case;
    const large = await postQuestion(apiPort, largeSessionId, "合成完整分页：统计 2026-10-06 纸灯 Android 雾帆各虚构地区的新增总数。");
    assert.equal(large.status, "completed", `${JSON.stringify(large.error)} ${large.analysis?.answer ?? ""}`);
    assert.match(large.analysis?.answer ?? "", new RegExp(`的合计=${largeExpected.sum}（人）`));
    assert.match(large.analysis?.answer ?? "", new RegExp(`输入结果行数=${largeExpected.count}`));
    assert.equal(large.analysis?.analysis_declaration?.provenance, "model_declared");
    assert.doesNotMatch(large.analysis?.answer ?? "", /这些地区代码仅为合成示例/);
    const largeSource = large.analysis?.sources?.[0];
    assert.equal(largeSource?.engine, "clickhouse-local");
    assert.equal(largeSource?.total_rows, largeExpected.count);
    assert.equal(largeSource?.rows?.length, 100);
    assert.equal(largeSource?.preview_has_more, true);
    const largeHash = large.analysis?.resource_hashes?.[String(largeSource?.resource_id)];
    assert.ok(largeHash);
    const pageUrl = `http://127.0.0.1:${apiPort}/api/sessions/${largeSessionId}/resources/${largeSource?.resource_id}?offset=100&limit=100&resource_hash=${largeHash}`;
    const pageResponse = await fetch(pageUrl);
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.json() as { resource: { rows: unknown[] }; has_more: boolean; next_row_offset: number };
    assert.equal(page.resource.rows.length, 100); assert.equal(page.has_more, true); assert.equal(page.next_row_offset, 200);
    assert.equal((await fetch(pageUrl, { headers: { "x-demo-actor": "demo-viewer" } })).status, 404);
    const stalePage = await fetch(pageUrl.replace(String(largeHash), "wrong"));
    assert.equal(stalePage.status, 400);
    assert.deepEqual(large.events.filter((event) => event.type === "tool_started").map((event) => event.payload.tool_name), ["read_data_contract_view", "query", "calculate_session_cells", "update_analysis"]);
    const largeDb = await mysql.createConnection({ host: "127.0.0.1", port: mysqlPort, user: "lumenfox_it", password: statePassword, database: "lumenfox_it" });
    try {
      const [rows] = await largeDb.query("SELECT body_json FROM resources WHERE resource_id = ?", [largeSource?.resource_id]);
      const saved = JSON.parse(String((rows as Array<{ body_json: string }>)[0]?.body_json)) as { session_id: string; job_id: string; rows: unknown[]; truncated: boolean };
      assert.equal(saved.session_id, largeSessionId); assert.equal(saved.job_id, large.job_id);
      assert.equal(saved.rows.length, largeExpected.count); assert.equal(saved.truncated, false);
    } finally { await largeDb.end(); }
    const thousandSession = await fetch(`http://127.0.0.1:${apiPort}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const thousandSessionId = ((await thousandSession.json()) as { session_id: string }).session_id;
    const thousandExpected = (JSON.parse(readFileSync(path.join(root, "eval", "harborlight-query-golden.json"), "utf8")) as { large_pagination_case: { count: number; sum: string } }).large_pagination_case;
    const thousand = await postQuestion(apiPort, thousandSessionId, "合成千行完整计算：统计 2026-10-08 玻璃鲦 Android 卵石各虚构地区的新增总数。");
    assert.equal(thousand.status, "completed", `${JSON.stringify(thousand.error)} ${thousand.analysis?.answer ?? ""}`);
    assert.match(thousand.analysis?.answer ?? "", new RegExp(`的合计=${thousandExpected.sum}（人）`));
    assert.match(thousand.analysis?.answer ?? "", new RegExp(`输入结果行数=${thousandExpected.count}`));
    const thousandSource = thousand.analysis?.sources?.[0];
    assert.equal(thousandSource?.total_rows, thousandExpected.count);
    assert.equal(thousandSource?.engine, "clickhouse-local");
    const thousandHash = thousand.analysis?.resource_hashes?.[String(thousandSource?.resource_id)];
    assert.ok(thousandHash);
    const lastResponse = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/${thousandSessionId}/resources/${thousandSource?.resource_id}?offset=1100&limit=100&resource_hash=${thousandHash}`);
    assert.equal(lastResponse.status, 200);
    const lastPage = await lastResponse.json() as { resource: { rows: Array<{ country_code: string; new_users: number }> }; has_more: boolean };
    assert.equal(lastPage.resource.rows.length, 100); assert.equal(lastPage.has_more, false);
    assert.equal(lastPage.resource.rows.at(-1)?.country_code, "Q1200"); assert.equal(lastPage.resource.rows.at(-1)?.new_users, 1200);
    assert.equal(thousand.events.filter((event) => event.type === "job_finished").length, 1);
    const largerSession = await fetch(`http://127.0.0.1:${apiPort}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const largerSessionId = ((await largerSession.json()) as { session_id: string }).session_id;
    const largerExpected = (JSON.parse(readFileSync(path.join(root, "eval", "harborlight-query-golden.json"), "utf8")) as { three_day_pagination_case: { count: number; sum: string } }).three_day_pagination_case;
    const larger = await postQuestion(apiPort, largerSessionId, "合成三千六百行：统计 2026-10-06 到 2026-10-08 的新增。");
    assert.equal(larger.status, "completed", `${JSON.stringify(larger.error)} ${larger.analysis?.answer ?? ""}`);
    assert.match(larger.analysis?.answer ?? "", new RegExp(`的合计=${largerExpected.sum}（人）`));
    assert.match(larger.analysis?.answer ?? "", new RegExp(`输入结果行数=${largerExpected.count}`));
    const largerSource = larger.analysis?.sources?.[0];
    assert.equal(largerSource?.engine, "clickhouse-local"); assert.equal(largerSource?.total_rows, largerExpected.count);
    const largerHash = larger.analysis?.resource_hashes?.[String(largerSource?.resource_id)]; assert.ok(largerHash);
    const largerLast = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/${largerSessionId}/resources/${largerSource?.resource_id}?offset=3500&limit=100&resource_hash=${largerHash}`);
    assert.equal(largerLast.status, 200);
    const largerPage = await largerLast.json() as { resource: { rows: unknown[] }; has_more: boolean };
    assert.equal(largerPage.resource.rows.length, 100); assert.equal(largerPage.has_more, false);
    const largerDb = await mysql.createConnection({ host: "127.0.0.1", port: mysqlPort, user: "lumenfox_it", password: statePassword, database: "lumenfox_it" });
    try {
      const [rows] = await largerDb.query("SELECT body_json FROM resources WHERE resource_id = ?", [largerSource?.resource_id]);
      const body = String((rows as Array<{ body_json: string }>)[0]?.body_json);
      const saved = JSON.parse(body) as { rows: unknown[]; job_id: string; session_id: string; truncated: boolean };
      assert.equal(saved.rows.length, 3600); assert.equal(saved.job_id, larger.job_id); assert.equal(saved.session_id, largerSessionId); assert.equal(saved.truncated, false);
      assert.ok(Buffer.byteLength(body) < 2_000_000, `saved_resource_bytes=${Buffer.byteLength(body)}`);
      console.log(`合成 3600 行完整查询资源字节数：${Buffer.byteLength(body)}；本任务分页计算合计：${largerExpected.sum}`);
    } finally { await largerDb.end(); }
    const crossSession = await fetch(`http://127.0.0.1:${apiPort}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const crossSessionId = ((await crossSession.json()) as { session_id: string }).session_id;
    const crossExpected = (JSON.parse(readFileSync(path.join(root, "eval", "harborlight-query-golden.json"), "utf8")) as { cross_fact_case: { japan_mist: string; us_mist: string; us_pebble: string } }).cross_fact_case;
    const cross = await postQuestion(apiPort, crossSessionId, "合成跨事实比率：按国家和渠道比较 2026-10-08 纸灯 iOS 的收入和新增人数。");
    assert.equal(cross.status, "partial", `${JSON.stringify(cross.error)} ${cross.analysis?.answer ?? ""}`);
    assert.ok((cross.analysis?.answer ?? "").includes(crossExpected.japan_mist));
    assert.ok((cross.analysis?.answer ?? "").includes(crossExpected.us_mist));
    assert.match(cross.analysis?.answer ?? "", /\(USD\)\/\(人\)/);
    assert.match(cross.analysis?.answer ?? "", /缺少一侧分组/);
    assert.equal(cross.analysis?.sources?.length, 2);
    assert.equal(cross.analysis?.sources?.every((source) => source.engine === "clickhouse-local"), true);
    const createSyntheticSession = async () => {
      const response = await fetch(`http://127.0.0.1:${apiPort}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      return ((await response.json()) as { session_id: string }).session_id;
    };
    const dailySession = await createSyntheticSession();
    const derivedAligned = await postQuestion(apiPort, await createSyntheticSession(), "合成变换结果对齐：比较纸灯 iOS 雾帆 2026-10-06 各国家新增分组的两个排序结果。");
    assert.equal(derivedAligned.status, "completed", JSON.stringify({ error: derivedAligned.error, answer: derivedAligned.analysis?.answer, reasons: derivedAligned.analysis?.server_reasons, tools: derivedAligned.events.filter((event) => event.type === "tool_finished") }));
    const derivedRows = derivedAligned.analysis?.alignment_results?.[0]?.rows ?? [];
    assert.ok(derivedRows.length >= 2); assert.ok(derivedRows.every((row) => row.status === "matched" && row.result?.value === "1.000000000000000000"));
    assert.match(derivedAligned.analysis?.answer ?? "", /数学对齐/);
    assert.equal(derivedAligned.events.find((event) => event.type === "candidate_reviewed")?.payload.selected_count, 1);
    const dailyCross = await postQuestion(apiPort, dailySession, "合成多日双渠道跨事实：按日期和渠道比较收入与新增。");
    assert.equal(dailyCross.status, "partial", `${JSON.stringify(dailyCross.error)} tools=${dailyCross.events.filter((event) => event.type === "tool_started").map((event) => event.payload.tool_name).join(">")}`);
    assert.equal(dailyCross.events.find((event) => event.type === "candidate_reviewed")?.payload.selected_count, 1, "只选择最终变换，依赖由宿主展开");
    const dailyRows = dailyCross.analysis?.alignment_results?.[0]?.rows ?? [];
    const expectedDaily = [
      ["2026-10-06", "mist_ads", "2.000000000000000000", "matched"], ["2026-10-06", "pebble_net", "5.000000000000000000", "matched"],
      ["2026-10-07", "mist_ads", null, "zero_divisor"], ["2026-10-07", "pebble_net", "3.000000000000000000", "matched"],
    ];
    assert.deepEqual(dailyRows.map((row) => [row.group.event_date, row.group.channel_id, row.result?.value ?? null, row.status]).sort(), expectedDaily.sort(), JSON.stringify({ answer: dailyCross.analysis?.answer, reasons: dailyCross.analysis?.server_reasons, events: dailyCross.events.filter((event) => ["tool_finished", "candidate_reviewed", "candidate_feedback"].includes(event.type)) }));
    assert.equal(dailyCross.analysis?.sources?.length, 2);
    assert.equal(dailyCross.analysis?.sources?.every((source) => source.engine === "clickhouse-local"), true);
    for (const source of dailyCross.analysis?.sources ?? []) {
      assert.ok(source.resource_id && source.execution_id);
      const hash: string | undefined = dailyCross.analysis?.resource_hashes?.[source.resource_id]; assert.ok(hash);
      const response: Response = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/${dailySession}/resources/${source.resource_id}?offset=0&limit=100&resource_hash=${hash}`);
      assert.equal(response.status, 200);
      const page = await response.json() as { resource: { session_id: string; job_id: string; execution_id: string; rows: unknown[] } };
      assert.equal(page.resource.session_id, dailySession); assert.equal(page.resource.job_id, dailyCross.job_id);
      assert.equal(page.resource.execution_id, source.execution_id); assert.equal(page.resource.rows.length, 4);
    }
    const dailyTransform = dailyCross.analysis?.transform_results?.[0]; assert.ok(dailyTransform);
    assert.deepEqual(dailyTransform.result.rows.map((row) => row.result_value), ["5.000000000000000000", "3.000000000000000000", "2.000000000000000000"]);
    assert.match(dailyCross.analysis?.answer ?? "", /零分母|除数为零/);
    assert.equal(dailyCross.events.filter((event) => event.type === "tool_started" && event.payload.tool_name === "calculate_session_cells").length, 2);
    assert.equal(dailyCross.events.filter((event) => ["job_finished", "job_failed", "job_cancelled", "job_timed_out"].includes(event.type)).length, 1);
    const rawCross = await postQuestion(apiPort, await createSyntheticSession(), "合成明细跨事实：按国家和渠道对齐收入及新增明细。");
    assert.equal(rawCross.status, "partial", `${JSON.stringify(rawCross.error)} ${rawCross.analysis?.answer ?? ""}`);
    assert.ok((rawCross.analysis?.answer ?? "").includes(crossExpected.japan_mist));
    assert.ok((rawCross.analysis?.answer ?? "").includes(crossExpected.us_mist));
    assert.match(rawCross.analysis?.answer ?? "", /缺少一侧分组/);
    assert.equal(rawCross.analysis?.sources?.length, 2);
    const nullCross = await postQuestion(apiPort, await createSyntheticSession(), "合成空值跨事实：比较 2026-10-09 收入和新增的缺失。");
    assert.equal(nullCross.status, "partial", `${JSON.stringify(nullCross.error)} ${nullCross.analysis?.answer ?? ""}`);
    assert.match(nullCross.analysis?.answer ?? "", /至少一侧全 NULL，结果未知/);
    assert.match(nullCross.analysis?.answer ?? "", /缺少一侧分组/);
    assert.match(nullCross.analysis?.answer ?? "", /1 行 NULL/);
    const nullGroups = nullCross.analysis?.alignment_results?.[0]?.rows ?? [];
    assert.equal(nullGroups.find((row) => row.group.country_code === "US" && row.group.channel_id === "mist_ads")?.status, "null_input");
    assert.equal(nullGroups.find((row) => row.group.country_code === "JP" && row.group.channel_id === "mist_ads")?.status, "missing_left");
    assert.equal(nullCross.analysis?.sources?.length, 2);
    const partialCross = await postQuestion(apiPort, await createSyntheticSession(), "合成部分空值跨事实：比较 2026-10-08 到 2026-10-09 收入和新增。");
    assert.equal(partialCross.status, "partial", `${JSON.stringify(partialCross.error)} ${partialCross.analysis?.answer ?? ""}`);
    const partialUs = partialCross.analysis?.alignment_results?.[0]?.rows.find((row) => row.group.country_code === "US" && row.group.channel_id === "mist_ads");
    assert.equal(partialUs?.status, "partial_nulls");
    assert.match(partialCross.analysis?.answer ?? "", /仅非 NULL 部分，不能代表完整分组/);
    assert.match(partialCross.analysis?.answer ?? "", /0\.008333333333333333/);
    const nullableSession = await createSyntheticSession();
    const nullable = await postQuestion(apiPort, nullableSession, "合成可空地区对齐：比较虚构产品的收入和新增。");
    assert.equal(nullable.status, "partial", `${JSON.stringify(nullable.error)} ${nullable.analysis?.answer ?? ""} ${JSON.stringify(nullable.events)}`);
    const nullableRows = nullable.analysis?.alignment_results?.[0]?.rows ?? [];
    const nullKey = nullableRows.find((row) => row.group.country_code === null);
    const literalKey = nullableRows.find((row) => row.group.country_code === "NULL");
    assert.equal(nullableRows.length, 5);
    assert.equal(nullKey?.status, "matched"); assert.equal(nullKey?.result?.value, "2.000000000000000000");
    assert.equal(literalKey?.status, "matched"); assert.equal(literalKey?.result?.value, "4.000000000000000000");
    assert.equal(nullableRows.find((row) => row.group.country_code === "ZERO")?.status, "zero_divisor");
    assert.equal(nullableRows.find((row) => row.group.country_code === "LEFT_ONLY")?.status, "missing_right");
    assert.equal(nullableRows.find((row) => row.group.country_code === "RIGHT_ONLY")?.status, "missing_left");
    assert.match(nullable.analysis?.answer ?? "", /NULL 键作为独立分组/);
    assert.equal(nullable.analysis?.sources?.length, 2);
    for (const source of nullable.analysis?.sources ?? []) {
      assert.equal(source.engine, "clickhouse-local"); assert.equal(source.freshness_receipts?.length, 1); assert.ok(source.execution_id);
      const hash: string | undefined = nullable.analysis?.resource_hashes?.[String(source.resource_id)]; assert.ok(hash);
      const response: Response = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/${nullableSession}/resources/${source.resource_id}?offset=0&limit=100&resource_hash=${hash}`);
      assert.equal(response.status, 200);
      const foreign: Response = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/${nullableSession}/resources/${source.resource_id}?offset=0&limit=100&resource_hash=${hash}`, { headers: { "x-demo-actor": "demo-viewer" } });
      assert.equal(foreign.status, 404, "其他模拟主体不能读取资源");
      const page = await response.json() as { resource: { session_id: string; job_id: string; rows: Array<{ country_code: string | null }> } };
      assert.equal(page.resource.session_id, nullableSession); assert.equal(page.resource.job_id, nullable.job_id);
      assert.ok(page.resource.rows.some((row) => row.country_code === null));
      assert.ok(page.resource.rows.some((row) => row.country_code === "NULL"));
    }
    const nullableId = nullable.analysis?.alignment_results?.[0]?.resource_id; assert.ok(nullableId);
    const nullableDb = await mysql.createConnection({ host: "127.0.0.1", port: mysqlPort, user: "lumenfox_it", password: statePassword, database: "lumenfox_it" });
    try {
      const [rows] = await nullableDb.query("SELECT body_json FROM resources WHERE resource_id = ?", [nullableId]);
      const saved = JSON.parse(String((rows as Array<{ body_json: string }>)[0]?.body_json)) as { session_id: string; job_id: string; rows: typeof nullableRows };
      assert.equal(saved.session_id, nullableSession); assert.equal(saved.job_id, nullable.job_id);
      assert.ok(saved.rows.some((row) => row.group.country_code === null));
      assert.ok(saved.rows.some((row) => row.group.country_code === "NULL"));
    } finally { await nullableDb.end(); }
    const mixed = await postQuestion(apiPort, await createSyntheticSession(), "合成混合聚合明细：比较收入分组与新增明细。");
    assert.equal(mixed.status, "partial", `${JSON.stringify(mixed.error)} ${mixed.analysis?.answer ?? ""} ${JSON.stringify(mixed.events)}`);
    const mixedRows = mixed.analysis?.alignment_results?.[0]?.rows ?? [];
    assert.equal(mixedRows.find((row) => row.group.country_code === "JP" && row.group.channel_id === "mist_ads")?.result?.value, "0.300000000000000000");
    assert.equal(mixedRows.find((row) => row.group.country_code === "US" && row.group.channel_id === "mist_ads")?.result?.value, "0.008333333333333333");
    assert.equal(mixedRows.find((row) => row.group.country_code === "US" && row.group.channel_id === "pebble_net")?.status, "missing_right");
    assert.equal(mixed.analysis?.sources?.length, 2);
    const cteSessionId = await createSyntheticSession();
    const cte = await postQuestion(apiPort, cteSessionId, "合成 CTE 查询：纸灯日本七日新增。");
    assert.equal(cte.status, "completed", `${JSON.stringify(cte.error)} ${cte.analysis?.answer ?? ""}`);
    assert.match(cte.analysis?.answer ?? "", /70/);
    assert.equal(cte.analysis?.sources?.[0]?.engine, "clickhouse-local");
    const cteResource = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/${cteSessionId}/resources/${cte.analysis?.sources?.[0]?.resource_id}?offset=0&limit=1`);
    assert.equal(cteResource.status, 200);
    assert.equal(((await cteResource.json()) as { resource: { sql_review_engine?: string } }).resource.sql_review_engine, "clickhouse_ast_scoped");
    const nestedCteSessionId = await createSyntheticSession();
    const nestedCte = await postQuestion(apiPort, nestedCteSessionId, "合成多层恒等投影：纸灯日本七日新增。");
    assert.equal(nestedCte.status, "completed", JSON.stringify({ error: nestedCte.error, answer: nestedCte.analysis?.answer, reasons: nestedCte.analysis?.server_reasons }));
    assert.match(nestedCte.analysis?.answer ?? "", /70/);
    const nestedCteResource = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/${nestedCteSessionId}/resources/${nestedCte.analysis?.sources?.[0]?.resource_id}?offset=0&limit=1`);
    assert.equal(nestedCteResource.status, 200);
    const nativeScoped = ((await nestedCteResource.json()) as { resource: { sql_review_engine?: string; sql?: string; executed_sql?: string } }).resource;
    assert.equal(nativeScoped.sql_review_engine, "clickhouse_ast_scoped");
    assert.equal(nativeScoped.sql, nativeScoped.executed_sql, "实际执行用户原 SQL，内部证明不替代查询");
    const proofSql = clickHouseScopedProjection(nativeScoped.sql!, "fact_fox_daily_install"); assert.ok(proofSql);
    const proofReader = createClickHouseClient({ url: clickhouseUrl, username: "fox_reader", password: readerPassword, database: "harborlight", maxRowsToRead: 5_000_000, timeoutSeconds: 10 }, true);
    try {
      const originalRows = await clickHouseQuery(proofReader, nativeScoped.sql!);
      const proofRows = await clickHouseQuery(proofReader, proofSql);
      assert.deepEqual(originalRows.map((row) => JSON.stringify(row)).sort(), proofRows.map((row) => JSON.stringify(row)).sort(), "固定合成数据上原查询与内部证明应返回相同可见行；两次读取没有共同原子快照");
    } finally { await proofReader.close(); }
    const renamedSession = await createSyntheticSession();
    const renamed = await postQuestion(apiPort, renamedSession, "合成多层重命名投影：纸灯日本七日新增。");
    assert.equal(renamed.status, "completed", JSON.stringify({ error: renamed.error, answer: renamed.analysis?.answer, reasons: renamed.analysis?.server_reasons }));
    assert.match(renamed.analysis?.answer ?? "", /70/);
    const renamedResource = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/${renamedSession}/resources/${renamed.analysis?.sources?.[0]?.resource_id}?offset=0&limit=1`);
    const renamedSource = ((await renamedResource.json()) as { resource: { sql_review_engine?: string; sql: string } }).resource;
    assert.equal(renamedSource.sql_review_engine, "clickhouse_ast_scoped");
    const renamedProof = clickHouseScopedProjection(renamedSource.sql, "fact_fox_daily_install"); assert.ok(renamedProof);
    const renamedReader = createClickHouseClient({ url: clickhouseUrl, username: "fox_reader", password: readerPassword, database: "harborlight", maxRowsToRead: 5_000_000, timeoutSeconds: 10 }, true);
    try {
      const originalRows = await clickHouseQuery(renamedReader, renamedSource.sql);
      const proofRows = await clickHouseQuery(renamedReader, renamedProof);
      assert.deepEqual(originalRows.map((row) => JSON.stringify(row)).sort(), proofRows.map((row) => JSON.stringify(row)).sort());
    } finally { await renamedReader.close(); }
    const left = await postQuestion(apiPort, await createSyntheticSession(), "合成左关联产品：保留未匹配产品。");
    assert.equal(left.status, "completed", `${JSON.stringify(left.error)} ${left.analysis?.answer ?? ""}`);
    assert.match(left.analysis?.answer ?? "", /JOIN 求和 70/);
    assert.match(left.analysis?.answer ?? "", /JOIN 求和 21/);
    assert.match(left.analysis?.answer ?? "", /NULL（维表未匹配）/);
    assert.equal(left.analysis?.sources?.[0]?.engine, "clickhouse-local");
    const preaggregatedExpected = (JSON.parse(readFileSync(path.join(root, "eval", "harborlight-query-golden.json"), "utf8")) as { preaggregated_title_case: { japan_known: string; zz_known: string; zz_unknown: string } }).preaggregated_title_case;
    const preaggregated = await postQuestion(apiPort, await createSyntheticSession(), "合成 CTE 预聚合关联：日本产品七日新增。");
    assert.equal(preaggregated.status, "completed", `${JSON.stringify(preaggregated.error)} ${preaggregated.analysis?.answer ?? ""}`);
    assert.match(preaggregated.analysis?.answer ?? "", new RegExp(`JOIN 求和 ${preaggregatedExpected.japan_known}`));
    assert.equal(preaggregated.analysis?.sources?.[0]?.engine, "clickhouse-local");
    assert.match(preaggregated.analysis?.sources?.[0]?.sql ?? "", /^WITH p AS /);
    assert.ok(preaggregated.analysis?.sources?.[0]?.execution_id);
    assert.ok(preaggregated.analysis?.sources?.[0]?.executed_sql);
    assert.equal(preaggregated.analysis?.sources?.[0]?.execution_settings?.join_use_nulls, true);
    assert.equal(preaggregated.analysis?.sources?.[0]?.freshness_receipts?.length, 2);
    const coarseSession = await createSyntheticSession();
    const coarse = await postQuestion(apiPort, coarseSession, "合成粗粒度金额关联：按产品统计三日收入和成本。");
    assert.equal(coarse.status, "completed", `${JSON.stringify(coarse.error)} ${coarse.analysis?.answer ?? ""} events=${JSON.stringify(coarse.events)}`);
    // Independent sums from the synthetic input rows: 90071992547409.91 +
    // 0.09 + 1.00 = 90071992547411.00; 0.10 + 0.03 + 2.00 = 2.13.
    assert.match(coarse.analysis?.answer ?? "", /JOIN 求和 90071992547411\.00；单位 USD/);
    assert.match(coarse.analysis?.answer ?? "", /JOIN 求和 2\.13；单位 USD/);
    assert.match(coarse.analysis?.answer ?? "", /dim_fox_title\.title_name=纸灯/);
    assert.match(coarse.analysis?.answer ?? "", /的合计=90071992547411\.00（USD）/);
    assert.match(coarse.analysis?.answer ?? "", /的合计=2\.13（USD）/);
    assert.equal(coarse.events.filter((event) => event.type === "tool_started" && event.payload.tool_name === "calculate_session_cells").length, 1);
    const coarseSource = coarse.analysis?.sources?.[0]; assert.ok(coarseSource);
    assert.equal(coarseSource.engine, "clickhouse-local");
    assert.match(coarseSource.sql ?? "", /^WITH p AS /); assert.match(coarseSource.executed_sql ?? "", /groupArray/);
    assert.notEqual(coarseSource.executed_sql, coarseSource.sql); assert.equal(coarseSource.execution_settings?.join_use_nulls, true);
    assert.ok(coarseSource.execution_id); assert.equal(coarseSource.freshness_receipts?.length, 2);
    assert.equal(coarseSource.contract_revisions?.fact_fox_daily_payment, "contract.fact_fox_daily_payment-r5");
    assert.equal(coarseSource.contract_revisions?.dim_fox_title, "contract.dim_fox_title-r2");
    const coarseHash = coarse.analysis?.resource_hashes?.[String(coarseSource.resource_id)]; assert.ok(coarseHash);
    const coarsePage = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/${coarseSession}/resources/${coarseSource.resource_id}?offset=0&limit=100&resource_hash=${coarseHash}`);
    assert.equal(coarsePage.status, 200);
    const coarseResource = await coarsePage.json() as { resource: { session_id: string; job_id: string; execution_id: string } };
    assert.equal(coarseResource.resource.session_id, coarseSession); assert.equal(coarseResource.resource.job_id, coarse.job_id);
    assert.equal(coarseResource.resource.execution_id, coarseSource.execution_id);
    const layeredSession = await createSyntheticSession();
    const layered = await postQuestion(apiPort, layeredSession, "合成多层过滤产品：按产品与渠道统计收入和成本。");
    assert.equal(layered.status, "completed", `${JSON.stringify(layered.error)} ${layered.analysis?.answer ?? ""}`);
    // Independent fixed-point sums over the original synthetic rows:
    // 90071992547409.91 + .09 + 1.00, and .10 + .03 + 2.00.
    assert.match(layered.analysis?.answer ?? "", /JOIN 求和 90071992547411\.00；单位 USD/);
    assert.match(layered.analysis?.answer ?? "", /JOIN 求和 2\.13；单位 USD/);
    assert.match(layered.analysis?.answer ?? "", /的合计=90071992547411\.00（USD）/);
    const layeredSource = layered.analysis?.sources?.[0]; assert.ok(layeredSource);
    assert.equal(layeredSource.engine, "clickhouse-local");
    assert.match(layeredSource.sql ?? "", /FROM a WHERE id = 'paper_lantern'/);
    assert.match(layeredSource.sql ?? "", /FROM b WHERE chn = 'mist_ads'/);
    assert.match(layeredSource.executed_sql ?? "", /title_id = 'paper_lantern'/);
    assert.match(layeredSource.executed_sql ?? "", /channel_id = 'mist_ads'/);
    assert.notEqual(layeredSource.sql, layeredSource.executed_sql);
    assert.equal(layeredSource.freshness_receipts?.length, 2);
    assert.equal(layered.events.filter((event) => event.type === "job_finished").length, 1);
    const layeredHash = layered.analysis?.resource_hashes?.[String(layeredSource.resource_id)]; assert.ok(layeredHash);
    const layeredPage = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/${layeredSession}/resources/${layeredSource.resource_id}?offset=0&limit=100&resource_hash=${layeredHash}`);
    assert.equal(layeredPage.status, 200);
    const layeredResource = await layeredPage.json() as { resource: { session_id: string; job_id: string; execution_id: string } };
    assert.equal(layeredResource.resource.session_id, layeredSession);
    assert.equal(layeredResource.resource.job_id, layered.job_id);
    assert.equal(layeredResource.resource.execution_id, layeredSource.execution_id);
    const dateSession = await createSyntheticSession();
    const dateFunction = await postQuestion(apiPort, dateSession, "合成日期函数查询：纸灯日本 iOS 雾帆的三日新增。");
    assert.equal(dateFunction.status, "completed", `${JSON.stringify(dateFunction.error)} ${dateFunction.analysis?.answer ?? ""}`);
    // Three independently seeded Japanese daily observations of 10 each.
    assert.match(dateFunction.analysis?.answer ?? "", /合计 30；单位 人/);
    assert.match(dateFunction.analysis?.answer ?? "", /数据库求和 30；单位 人/);
    assert.equal(dateFunction.analysis?.sources?.length, 2);
    for (const source of dateFunction.analysis?.sources ?? []) {
      assert.equal(source.engine, "clickhouse-local");
      assert.match(source.sql ?? "", /toDate\('2026-10-06'\)/);
      assert.equal(source.sql, source.executed_sql);
      assert.equal(source.freshness_receipts?.length, 1);
      assert.ok(source.execution_id);
      const hash: string | undefined = dateFunction.analysis?.resource_hashes?.[String(source.resource_id)]; assert.ok(hash);
      const page: Response = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/${dateSession}/resources/${source.resource_id}?offset=0&limit=100&resource_hash=${hash}`);
      assert.equal(page.status, 200);
      const saved = await page.json() as { resource: { session_id: string; job_id: string; execution_id: string } };
      assert.equal(saved.resource.session_id, dateSession);
      assert.equal(saved.resource.job_id, dateFunction.job_id);
      assert.equal(saved.resource.execution_id, source.execution_id);
    }
    assert.equal(dateFunction.events.filter((event) => event.type === "job_finished").length, 1);
    const inSession = await createSyntheticSession();
    const inResult = await postQuestion(apiPort, inSession, "合成两地区 IN：查询纸灯美国和日本单日新增。");
    assert.equal(inResult.status, "completed", `${JSON.stringify(inResult.error)} ${inResult.analysis?.answer ?? ""}`);
    // Independent fixed fixture: US 120 and JP 10 on the selected day.
    assert.match(inResult.analysis?.answer ?? "", /数据库求和 120；单位 人.*分组 country_code=US/u);
    assert.match(inResult.analysis?.answer ?? "", /数据库求和 10；单位 人.*分组 country_code=JP/u);
    const inSource = inResult.analysis?.sources?.[0]; assert.ok(inSource);
    assert.equal(inSource.engine, "clickhouse-local"); assert.match(inSource.sql ?? "", /country_code IN \('US', 'JP'\)/u);
    assert.equal(inSource.freshness_receipts?.length, 1);
    assert.equal(inResult.events.filter((event) => event.type === "job_finished").length, 1);
    const inHash: string | undefined = inResult.analysis?.resource_hashes?.[String(inSource.resource_id)]; assert.ok(inHash);
    const inPage = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/${inSession}/resources/${inSource.resource_id}?offset=0&limit=100&resource_hash=${inHash}`);
    assert.equal(inPage.status, 200);
    const inSaved = await inPage.json() as { resource: { session_id: string; job_id: string; execution_id: string } };
    assert.equal(inSaved.resource.session_id, inSession); assert.equal(inSaved.resource.job_id, inResult.job_id); assert.equal(inSaved.resource.execution_id, inSource.execution_id);
    const channelCoarse = await postQuestion(apiPort, await createSyntheticSession(), "合成粗粒度渠道关联：按渠道统计美国收入和成本。");
    assert.equal(channelCoarse.status, "completed", `${JSON.stringify(channelCoarse.error)} ${channelCoarse.analysis?.answer ?? ""} events=${JSON.stringify(channelCoarse.events)}`);
    // Independent rows: mist_ads has (1.00, 2.00), pebble_net has
    // (6.00, 3.00), so their totals are 7.00 revenue and 5.00 cost.
    assert.match(channelCoarse.analysis?.answer ?? "", /dim_fox_channel\.channel_name=雾帆/);
    assert.match(channelCoarse.analysis?.answer ?? "", /dim_fox_channel\.channel_name=卵石/);
    assert.match(channelCoarse.analysis?.answer ?? "", /的合计=7\.00（USD）/);
    assert.match(channelCoarse.analysis?.answer ?? "", /的合计=5\.00（USD）/);
    assert.equal(channelCoarse.analysis?.sources?.[0]?.engine, "clickhouse-local");
    assert.equal(channelCoarse.analysis?.sources?.[0]?.freshness_receipts?.length, 2);
    const channelRatio = await postQuestion(apiPort, await createSyntheticSession(), "合成渠道关联比率：按渠道比较收入和成本。");
    assert.equal(channelRatio.status, "completed", `${JSON.stringify(channelRatio.error)} ${channelRatio.analysis?.answer ?? ""} events=${JSON.stringify(channelRatio.events)}`);
    // Independent arithmetic for the above synthetic inputs: 1/2 = 0.5; 6/3 = 2.
    assert.match(channelRatio.analysis?.answer ?? "", /=0\.500000000000000000（比值）/);
    assert.match(channelRatio.analysis?.answer ?? "", /=2\.000000000000000000（比值）/);
    assert.match(channelRatio.analysis?.answer ?? "", /半数远离零/);
    assert.equal(channelRatio.analysis?.sources?.[0]?.engine, "clickhouse-local");
    const inverseRatio = await postQuestion(apiPort, await createSyntheticSession(), "合成未声明反向比率：按渠道比较成本和收入。");
    assert.ok(inverseRatio.events.some((event) => event.type === "tool_finished" && event.payload.tool_name === "calculate_session_cells" && event.payload.is_error === true));
    assert.doesNotMatch(inverseRatio.analysis?.answer ?? "", /=2\.000000000000000000（比值）/);
    const difference = await postQuestion(apiPort, await createSyntheticSession(), "合成跨资源收入减成本：分别查询后按国家和渠道对齐。");
    assert.equal(difference.status, "completed", `${JSON.stringify(difference.error)} ${difference.analysis?.answer ?? ""}`);
    // Independent fixture arithmetic: JP 3−2=1; US mist 1−2=−1;
    // US pebble 6−3=3. Both resources are separate persisted queries.
    assert.match(difference.analysis?.answer ?? "", /channel_id=mist_ads，country_code=JP[^\n]*结果 1\.00 USD/);
    assert.match(difference.analysis?.answer ?? "", /channel_id=mist_ads，country_code=US[^\n]*结果 -1\.00 USD/);
    assert.match(difference.analysis?.answer ?? "", /channel_id=pebble_net，country_code=US[^\n]*结果 3\.00 USD/);
    assert.equal(difference.analysis?.sources?.length, 2);
    assert.notEqual(difference.analysis?.sources?.[0]?.resource_id, difference.analysis?.sources?.[1]?.resource_id);
    const preaggregatedLeft = await postQuestion(apiPort, await createSyntheticSession(), "合成 CTE 左关联未匹配：保留虚构产品。");
    assert.equal(preaggregatedLeft.status, "completed", `${JSON.stringify(preaggregatedLeft.error)} ${preaggregatedLeft.analysis?.answer ?? ""}`);
    assert.match(preaggregatedLeft.analysis?.answer ?? "", new RegExp(`JOIN 求和 ${preaggregatedExpected.zz_known}`));
    assert.match(preaggregatedLeft.analysis?.answer ?? "", new RegExp(`JOIN 求和 ${preaggregatedExpected.zz_unknown}`));
    assert.match(preaggregatedLeft.analysis?.answer ?? "", /NULL（维表未匹配）/);
    assert.match(preaggregatedLeft.analysis?.answer ?? "", /的合计=21（人）/);
    assert.equal(preaggregatedLeft.events.filter((event) => event.type === "tool_started" && event.payload.tool_name === "calculate_session_cells").length, 1);
    const alignSession = await fetch(`http://127.0.0.1:${apiPort}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const alignSessionId = ((await alignSession.json()) as { session_id: string }).session_id;
    const align = await postQuestion(apiPort, alignSessionId, "合成分组对齐：按国家对照 10 月 6 日与 8 日的新增，并筛选、排序及求和下降组。");
    assert.equal(align.status, "completed", `${JSON.stringify(align.error)} ${align.analysis?.answer ?? ""}`);
    assert.match(align.analysis?.answer ?? "", /不是同一原子快照/);
    assert.match(align.analysis?.answer ?? "", /country_code=US.*结果 -20 人/);
    assert.match(align.analysis?.answer ?? "", /的合计=-20（人）/);
    assert.equal(align.events.filter((event) => event.type === "tool_started" && event.payload.tool_name === "calculate_session_cells").length, 2);
    assert.equal(align.analysis?.sources?.length, 2);
    const withoutRecordSession = await fetch(`http://127.0.0.1:${apiPort}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const withoutRecordId = ((await withoutRecordSession.json()) as { session_id: string }).session_id;
    const withoutRecord = await postQuestion(apiPort, withoutRecordId, "合成问题：不调用记录工具，查询日本新增。");
    assert.equal(withoutRecord.status, "completed", JSON.stringify(withoutRecord.error));
    assert.match(withoutRecord.analysis?.answer ?? "", /数据库求和 70；单位 人/);
    assert.equal(withoutRecord.events.some((event) => event.type === "tool_started" && event.payload.tool_name === "update_analysis"), false);
    assert.equal(withoutRecord.events.filter((event) => event.type === "candidate_reviewed").length, 1);
    // Optional manual browser regression: a loopback proxy really drops the first
    // SSE socket and records the browser's subsequent cursor and event IDs.
    if (process.env.BROWSER_TRACE_DIR) {
      await browserDisconnectProbe(apiPort, process.env.BROWSER_TRACE_DIR, async () => {
        // This control is available only to the opt-in test harness. Restart
        // exactly the two children created by this test, keeping the databases,
        // dispatcher and loopback proxy alive for the browser's current session.
        await stopChild(happyWorker);
        await stopChild(api);
        api = spawn(process.execPath, ["--import", "tsx", "src/api.ts"], { cwd: root, env: baseEnv, stdio: "ignore" });
        happyWorker = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], { cwd: root, env: baseEnv, stdio: "ignore" });
        children.push(api, happyWorker);
        await waitHttp(`http://127.0.0.1:${apiPort}/api/health`);
      });
    }
    const another = async () => {
      const created = await fetch(`http://127.0.0.1:${apiPort}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      return ((await created.json()) as { session_id: string }).session_id;
    };
    const batchSession = await another();
    const batch = await postQuestion(apiPort, batchSession, "合成并发契约：查询已授权的新增用户。");
    assert.equal(batch.status, "partial", `${JSON.stringify(batch.error)} ${batch.analysis?.answer ?? ""}`);
    assert.match(batch.analysis?.answer ?? "", /670/u);
    assert.match(batch.analysis?.answer ?? "", /NULL/u);
    assert.deepEqual(batch.events.filter((event) => event.type === "tool_started").slice(0, 4).map((event) => event.payload.tool_name), ["read_data_contract_view", "read_data_contract_view", "read_data_contract_view", "query"]);
    assert.equal(batch.events.some((event) => event.type === "tool_finished" && event.payload.is_error === true), false);
    const batchDb = await mysql.createConnection({ host: "127.0.0.1", port: mysqlPort, user: "lumenfox_it", password: statePassword, database: "lumenfox_it" });
    try {
      const [rows] = await batchDb.query("SELECT bindings_json FROM sessions WHERE session_id = ?", [batchSession]);
      const bindings = JSON.parse(String((rows as Array<{ bindings_json: string }>)[0]!.bindings_json)) as Array<{ table: string }>;
      assert.deepEqual(bindings.map((item) => item.table).sort(), ["dim_fox_channel", "fact_fox_daily_install", "fact_fox_daily_payment"]);
    } finally { await batchDb.end(); }
    const glass = await postQuestion(apiPort, await another(), "玻璃鲦在德国 iOS、雾帆，2026-10-06 到 2026-10-12 的新增用户是多少？");
    assert.equal(glass.status, "completed", JSON.stringify(glass.error));
    assert.equal(glass.analysis?.sources?.[0]?.engine, "clickhouse-local", `${glass.status} ${glass.analysis?.answer ?? ""}`);
    assert.match(glass.analysis?.answer ?? "", /48/);
    assert.equal((glass.analysis?.answer ?? "").includes("99999"), false);
    assert.ok(glass.analysis?.server_reasons?.includes("model_draft_not_verified"));
    assert.ok(glass.analysis?.server_reasons?.includes("clickhouse_observation_nonatomic"));
    const marker = await postQuestion(apiPort, await another(), "合成空值标记投影：三天每日新增和合计。");
    assert.equal(marker.status, "completed", JSON.stringify(marker.error));
    assert.match(marker.analysis?.answer ?? "", /合计 220；单位 人/);
    assert.doesNotMatch(marker.analysis?.answer ?? "", /99999/);
    assert.ok(marker.analysis?.server_reasons?.includes("null_marker_preview_sanitized"));
    const markerRows = marker.analysis?.sources?.[0]?.rows as Array<Record<string, unknown>>;
    assert.deepEqual(markerRows.map((row) => row.new_users), [100, 0, 120]);
    assert.ok(markerRows.every((row) => !Object.hasOwn(row, "is_null")));
    // Independent fixture: [100, 0, 120] has two values > 50, two <= 100,
    // and two != 0. Equal numeric results retain three distinct predicates.
    const threshold = await postQuestion(apiPort, await another(), "合成条件阈值：统计三天不同条件的观测日数。");
    assert.equal(threshold.status, "completed", `${JSON.stringify(threshold.error)} ${threshold.analysis?.answer ?? ""}`);
    const thresholdAnswer = threshold.analysis?.answer ?? "";
    assert.match(thresholdAnswer, /> 50（NULL 不满足条件））2；单位 行/u);
    assert.match(thresholdAnswer, /<= 100（NULL 不满足条件））2；单位 行/u);
    assert.match(thresholdAnswer, /!= 0（NULL 不满足条件））2；单位 行/u);
    assert.equal(threshold.analysis?.sources?.[0]?.engine, "clickhouse-local");
    assert.ok(threshold.analysis?.sources?.[0]?.freshness_receipts?.length);
    const sameResource = await postQuestion(apiPort, await another(), "合成单资源比较：支付流水减成本。");
    assert.equal(sameResource.status, "completed", `${JSON.stringify(sameResource.error)} ${sameResource.analysis?.answer ?? ""} ${JSON.stringify(sameResource.events.filter((event) => event.type === "tool_finished").map((event) => ({ tool: event.payload.tool_name, code: event.payload.code })))}`);
    assert.match(sameResource.analysis?.answer ?? "", /四则运算 subtract：-1\.00 USD/u);
    assert.equal(sameResource.analysis?.sources?.[0]?.engine, "clickhouse-local");
    assert.deepEqual(sameResource.events.filter((event) => event.type === "tool_started").map((event) => event.payload.tool_name), ["read_data_contract_view", "query", "calculate_session_cells"]);
    assert.equal(sameResource.events.some((event) => event.type === "tool_finished" && event.payload.is_error === true), false);
    const rawSingle = await postQuestion(apiPort, await another(), "合成单明细比较：支付流水减成本。");
    assert.equal(rawSingle.status, "completed", `${JSON.stringify(rawSingle.error)} ${rawSingle.analysis?.answer ?? ""} ${JSON.stringify(rawSingle.events.filter((event) => event.type === "tool_finished").map((event) => ({ tool: event.payload.tool_name, code: event.payload.code })))}`);
    assert.match(rawSingle.analysis?.answer ?? "", /四则运算 subtract：-1\.00 USD/u);
    assert.equal(rawSingle.analysis?.sources?.[0]?.engine, "clickhouse-local");
    assert.equal(rawSingle.events.some((event) => event.type === "tool_finished" && event.payload.is_error === true), false);
    const rawSeparate = await postQuestion(apiPort, await another(), "合成不同明细来源：尝试跨查询逐行计算。");
    assert.equal(rawSeparate.status, "failed");
    assert.ok(rawSeparate.events.some((event) => event.type === "tool_finished" && event.payload.tool_name === "calculate_session_cells" && event.payload.code === "arithmetic_scope_incompatible"));
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
    await stopChild(recovered);
    const cappedOptions = { path: path.join(dir, "capped-budget.sqlite"), budgetId: "capped-integration", maxRequests: 1, maxTokens: 100000 };
    const capped = await GlobalBudget.activate(cappedOptions);
    try {
      const cappedWorker = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], { cwd: root, env: { ...baseEnv, DATAAGENT_TEST_GLOBAL_BUDGET_PATH: cappedOptions.path, DEEPSEEK_BUDGET_ID: cappedOptions.budgetId, DEEPSEEK_BUDGET_MAX_REQUESTS: "1", DEEPSEEK_BUDGET_MAX_TOKENS: "100000" }, stdio: "ignore" });
      children.push(cappedWorker);
      const before = fake.observations.length;
      const blocked = await postQuestion(apiPort, await another(), question);
      assert.equal(blocked.status, "failed");
      assert.equal(blocked.error?.code, "global_budget_exhausted");
      assert.equal(fake.observations.length - before, 1);
      assert.equal(blocked.usage?.model_attempts, 2);
      assert.equal(blocked.usage?.model_calls, 1);
      assert.equal(blocked.usage?.provider_not_dispatched, 1);
      assert.equal(blocked.usage?.usage_source, "simulated");
      assert.ok((blocked.usage?.input_tokens ?? 0) > 0);
      assert.equal((await capped.stats())?.dispatched_count, 1);
      await stopChild(cappedWorker);
    } finally { await capped.close(); }
  } finally {
    await globalBudget.close();
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await fake.close();
    if (createdContainers.length) await isolatedDocker(["rm", "-f", ...createdContainers]).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

async function browserDisconnectProbe(apiPort: number, dir: string, restart: () => Promise<void>): Promise<void> {
  const trace: { after: number; seqs: number[] }[] = [];
  let dropped = false;
  let trackedPath: string | undefined;
  const types: string[] = [];
  const proxy = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const eventPath = /^\/api\/jobs\/[^/]+\/events$/u.test(url.pathname);
    if (eventPath && !trackedPath) trackedPath = url.pathname;
    const isEvents = eventPath && url.pathname === trackedPath;
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
          const data = frame.match(/^data: (.+)$/mu);
          if (data) types.push((JSON.parse(data[1]!) as { type: string }).type);
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
    let restarted = false;
    while (!existsSync(path.join(dir, "done")) && Date.now() < deadline) {
      if (!restarted && existsSync(path.join(dir, "restart"))) {
        await restart();
        restarted = true;
        writeFileSync(path.join(dir, "restarted"), "ok");
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(existsSync(path.join(dir, "done")), "browser probe timed out");
    assert.ok(dropped && trace.length >= 2 && trace[1]!.after > 0, JSON.stringify(trace));
    const sequences = trace.flatMap((item) => item.seqs);
    assert.ok(sequences.length > 1 && sequences.every((value, index) => value === index + 1), JSON.stringify(trace));
    assert.equal(types.filter((type) => ["job_finished", "job_failed", "job_cancelled", "job_timed_out"].includes(type)).length, 1);
    writeFileSync(path.join(dir, "verified.json"), JSON.stringify({ trace, sequences, terminal: types.filter((type) => ["job_finished", "job_failed", "job_cancelled", "job_timed_out"].includes(type)) }));
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
      usage?: { input_tokens: number | null; usage_source?: string; model_attempts?: number; model_calls?: number; provider_not_dispatched?: number };
      analysis?: { status?: string; answer?: string; server_reasons?: string[]; resource_hashes?: Record<string, string>; analysis_declaration?: { provenance?: string }; alignment_results?: Array<{ resource_id?: string; rows: Array<{ group: Record<string,string|null>; status: string; result?: { value: string | null } | null }> }>; transform_results?: Array<{ result: { rows: Array<Record<string, unknown>> } }>; sources?: Array<{ engine?: string; resource_id?: string; execution_id?: string; sql?: string; executed_sql?: string; execution_settings?: { join_use_nulls?: boolean }; contract_revisions?: Record<string, string>; observed_at?: string; freshness_receipts?: unknown[]; total_rows?: number; rows?: unknown[]; preview_has_more?: boolean }> };
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("任务没有结束");
}

async function waitCandidateSnapshot(port: number, jobId: string): Promise<unknown> {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const response = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}`);
    const job = await response.json() as { status: string; events: Array<{ type: string; payload: Record<string, unknown> }> };
    const event = job.events.find((item) => item.type === "snapshot_saved" && item.payload.role === "assistant" && item.payload.stop_reason === "stop");
    if (event) return event.payload.leaf_id;
    if (!["queued", "running"].includes(job.status)) throw new Error("候选快照出现前任务已终止");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("候选快照等待超时");
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
