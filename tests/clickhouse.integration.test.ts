import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import mysql from "mysql2/promise";
import { clickHouseColumns, clickHouseCommand, clickHouseInsert, clickHouseQuery, createClickHouseClient } from "../src/clickhouse-client.js";
import { freshnessManifest, probeClickHouseAndPublish, probeClickHouseFreshness } from "../src/freshness.js";
import { MysqlFreshnessStore } from "../src/mysql-freshness.js";
import { loadKnowledge } from "../src/knowledge.js";
import { compareLiveColumns, diagnoseKnowledge } from "../src/knowledge-doctor.js";
import { createRuntime } from "../src/runtime.js";
import { resolveTurn } from "../src/turn.js";
import { bulkInstalls, chunks, createTableSql, smallWarehouse, WAREHOUSE_TABLES } from "../src/warehouse.js";
import { bindTables } from "./helpers.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const knowledgeDir = path.join(root, "knowledge", "harborlight");
const adminPassword = randomBytes(18).toString("hex");
const readerPassword = randomBytes(18).toString("hex");
const container = `lumenfox-ch-${randomUUID()}`;

test("Harborlight 表卡驱动槽位，不把 SQLite 表名写进这条链", () => {
  const turn = resolveTurn(null, "纸灯 在 2026-10-06 到 2026-10-12（美国、iOS、雾帆）的新增用户是多少？", knowledgeDir);
  assert.equal(turn.slots.game, "paper_lantern");
  assert.equal(turn.slots.channel, "mist_ads");
  assert.equal(turn.warehouse?.new_users?.table, "fact_fox_daily_install");
  assert.equal(diagnoseKnowledge(knowledgeDir).length, 0);
  assert.equal(WAREHOUSE_TABLES.length, 10);
  assert.equal(chunks(bulkInstalls(20_000), 5_000).length, 4);
});

test("隔离 ClickHouse：真实查询、新鲜度、拒绝绕过，并走分进程", async () => {
  const port = await freePort();
  const dir = mkdtempSync(path.join(tmpdir(), "lumenfox-ch-"));
  const freshnessPath = path.join(dir, "freshness.json");
  const url = `http://127.0.0.1:${port}`;
  let containerCreated = false;
  try {
    await runQuiet("docker", [
      "run", "--pull=never", "-d", "--name", container,
      "--tmpfs", "/var/lib/clickhouse:rw,size=512m",
      "--ulimit", "nofile=262144:262144",
      "-p", `127.0.0.1:${port}:8123`,
      "-e", `CLICKHOUSE_PASSWORD=${adminPassword}`,
      "-e", "CLICKHOUSE_DB=harborlight",
      "-e", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1",
      "clickhouse/clickhouse-server:24.8.14.39",
    ], adminPassword);
    containerCreated = true;
    await waitForHttp(url);
    const bootstrap = createClickHouseClient({
      url, username: "default", password: adminPassword, database: "default", maxRowsToRead: 5_000_000, timeoutSeconds: 30,
    }, false);
    await clickHouseCommand(bootstrap, "CREATE DATABASE IF NOT EXISTS harborlight");
    await bootstrap.close();
    const admin = createClickHouseClient({
      url, username: "default", password: adminPassword, database: "harborlight", maxRowsToRead: 5_000_000, timeoutSeconds: 30,
    }, false);
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
    const bulk = bulkInstalls(100_000);
    assert.equal(chunks(bulk, 5_000).length, 20);
    for (const group of chunks(bulk, 5_000)) await clickHouseInsert(admin, "fact_fox_daily_install", group);
    const bulkCount = await clickHouseQuery(admin, "SELECT count() AS n FROM fact_fox_daily_install WHERE title_id = 'bulk_lantern'");
    assert.equal(Number(bulkCount[0]?.n), 100_000);
    await clickHouseCommand(admin, `CREATE USER IF NOT EXISTS fox_reader IDENTIFIED BY '${readerPassword}'`);
    await clickHouseCommand(admin, "GRANT SELECT ON harborlight.* TO fox_reader");
    const reader = createClickHouseClient({
      url, username: "fox_reader", password: readerPassword, database: "harborlight", maxRowsToRead: 5_000_000, timeoutSeconds: 10,
    }, true);
    const described: Record<string, string[]> = {};
    for (const table of WAREHOUSE_TABLES) {
      const live = new Set(await clickHouseColumns(reader, table.table));
      for (const column of table.columns) assert.equal(live.has(column.name), true, `${table.table}.${column.name}`);
      const rows = await clickHouseQuery(reader, `DESCRIBE TABLE ${table.table}`);
      described[table.table] = rows.map((row) => String(row.name));
    }
    assert.deepEqual(compareLiveColumns(knowledgeDir, described), []);
    const publication = await probeClickHouseAndPublish({
      targetsPath: path.join(knowledgeDir, "freshness-targets.json"),
      destinationPath: freshnessPath,
      query: (sql) => clickHouseQuery(reader, sql) as Promise<Array<{ event_date: string }>>,
    });
    assert.equal(publication.engine, "clickhouse-local");
    assert.equal(publication.tables.fact_fox_daily_install?.status, "fresh");
    assert.equal(publication.tables.fact_fox_retention_cohort?.status, "fresh");
    const runtime = createRuntime({
      knowledgeDir,
      businessEngine: "clickhouse",
      clickhouseUrl: url,
      clickhouseUser: "fox_reader",
      clickhousePassword: readerPassword,
      clickhouseDatabase: "harborlight",
      freshnessPath,
      publishFreshnessOnStart: false,
      databasePath: path.join(dir, "unused.sqlite"),
      stateDatabasePath: path.join(dir, "state.sqlite"),
      startWorker: false,
      ephemeralDir: undefined,
    });
    try {
      const session = runtime.sessions.create("analyst");
      await bindTables(runtime, session.session_id, ["contract.fact_fox_daily_install", "contract.fact_fox_ad_receipt", "contract.fact_fox_daily_spend", "contract.fact_fox_experiment_metric", "contract.dim_fox_title"]);
      const installs = await runtime.tools.query(session.session_id, {
        sql: "SELECT event_date, title_id, platform, country_code, channel_id, new_users FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-12' AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'US' AND channel_id = 'mist_ads' ORDER BY event_date",
      });
      assert.equal(installs.ok, true, JSON.stringify(installs));
      if (!installs.ok) return;
      assert.equal(installs.engine, "clickhouse-local");
      const coverage = installs.coverage as { null_dates: string[]; zero_dates: string[]; absent_dates: string[] };
      assert.deepEqual(coverage.null_dates, ["2026-10-09"]);
      assert.deepEqual(coverage.zero_dates, ["2026-10-07"]);
      assert.equal(coverage.absent_dates.length, 0);
      const summed = await runtime.tools.calculateSessionCells(session.session_id, {
        resource_id: String(installs.resource_id),
        operations: [{ op: "sum", column: "new_users", as: "new_users_sum" }, { op: "count_null", column: "new_users", as: "new_users_missing" }, { op: "count_zero", column: "new_users", as: "new_users_zero" }],
      });
      assert.equal(summed.ok, true);
      if (!summed.ok) return;
      assert.equal((summed.cells as { new_users_sum: number }).new_users_sum, 670);
      const reread = await runtime.tools.readSessionResource(session.session_id, { resource_id: String(installs.resource_id) });
      assert.equal(reread.ok, true);
      const revenue = await runtime.tools.query(session.session_id, {
        sql: "SELECT event_date, revenue_usd, is_predicted FROM fact_fox_ad_receipt WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-12' AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'US' ORDER BY event_date",
      });
      assert.equal(revenue.ok, true);
      if (!revenue.ok) return;
      const revenueCoverage = revenue.coverage as { predicted_dates: string[]; null_dates: string[]; zero_dates: string[] };
      assert.deepEqual(revenueCoverage.predicted_dates, ["2026-10-10", "2026-10-11"]);
      assert.deepEqual(revenueCoverage.null_dates, ["2026-10-08"]);
      assert.deepEqual(revenueCoverage.zero_dates, ["2026-10-07"]);
      const pebble = await runtime.tools.query(session.session_id, {
        sql: "SELECT event_date, channel_id, new_users FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-12' AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'US' AND channel_id = 'pebble_net'",
      });
      assert.equal(pebble.ok, true);
      if (!pebble.ok) return;
      assert.equal((pebble.coverage as { absent_dates: string[] }).absent_dates.length, 6);
      const denied = [
        ["SELECT event_date, device_token FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-12'", "sensitive_field"],
        ["SELECT * FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-12'", "wildcard_projection"],
        ["SELECT event_date, new_users FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-12'; DROP TABLE fact_fox_daily_install", "multiple_statements"],
        ["INSERT INTO fact_fox_daily_install (event_date, title_id, platform, country_code, channel_id, new_users) VALUES ('2026-10-06', 'paper_lantern', 'ios', 'US', 'mist_ads', 1)", "write_statement"],
        ["SELECT event_date, new_users FROM file('secret.csv')", "dangerous_table"],
        ["SELECT event_date, new_users FROM system.numbers WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-12'", "dangerous_table"],
        ["SELECT a.event_date, b.metric_value FROM fact_fox_daily_install AS a JOIN fact_fox_experiment_metric AS b ON a.event_date = b.event_date WHERE a.event_date >= '2026-10-06' AND a.event_date <= '2026-10-12' AND b.event_date >= '2026-10-06' AND b.event_date <= '2026-10-12'", "missing_join_constraint"],
      ] as const;
      for (const [sql, code] of denied) {
        const result = await runtime.tools.query(session.session_id, { sql });
        assert.equal(result.ok, false, sql);
        if (!result.ok) assert.equal(result.code, code, sql);
      }
      const resourcesBeforeNested = runtime.sessions.resourceCount();
      const nestedJoin = await runtime.tools.query(session.session_id, {
        sql: "WITH x AS (SELECT a.event_date FROM fact_fox_daily_install a JOIN fact_fox_experiment_metric b ON a.event_date = b.event_date WHERE a.event_date >= '2026-10-06' AND a.event_date <= '2026-10-12' AND b.event_date >= '2026-10-06' AND b.event_date <= '2026-10-12') SELECT event_date FROM x",
      });
      assert.equal(nestedJoin.ok, false);
      if (!nestedJoin.ok) assert.equal(nestedJoin.code, "missing_join_constraint");
      assert.equal(runtime.sessions.resourceCount(), resourcesBeforeNested);
      const nested = await runtime.tools.query(session.session_id, {
        sql: "SELECT event_date, new_users FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-12' AND title_id IN (SELECT title_id FROM fact_fox_daily_install)",
      });
      assert.equal(nested.ok, false);
      if (!nested.ok) assert.equal(nested.code, "unbounded_query");
      await assert.rejects(() => clickHouseCommand(reader, "INSERT INTO fact_fox_daily_install (event_date) VALUES ('2026-10-01')"));
      const narrow = createClickHouseClient({
        url, username: "fox_reader", password: readerPassword, database: "harborlight", maxRowsToRead: 1, timeoutSeconds: 5,
      }, true);
      await assert.rejects(() => clickHouseQuery(narrow, "SELECT event_date, new_users FROM fact_fox_daily_install WHERE event_date >= '2026-09-29' AND event_date <= '2026-10-12'"));
      await narrow.close();
      const controller = new AbortController();
      controller.abort();
      const cancelled = await runtime.tools.query(session.session_id, {
        sql: "SELECT event_date, new_users FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-12'",
      }, controller.signal);
      assert.equal(cancelled.ok, false);
      if (!cancelled.ok) assert.equal(cancelled.code, "tool_cancelled");
      const lookup = await runtime.tools.query(session.session_id, {
        sql: `SELECT i.event_date, i.title_id, i.platform, i.country_code, i.channel_id, i.new_users, t.title_name
          FROM fact_fox_daily_install AS i
          JOIN dim_fox_title AS t ON i.title_id = t.title_id
          WHERE i.event_date >= '2026-10-06' AND i.event_date <= '2026-10-12'
            AND i.title_id = 'paper_lantern' AND i.platform = 'ios' AND i.country_code = 'US' AND i.channel_id = 'mist_ads'`,
      });
      assert.equal(lookup.ok, true, JSON.stringify(lookup));
      if (!lookup.ok) return;
      const lookupSum = await runtime.tools.calculateSessionCells(session.session_id, {
        resource_id: String(lookup.resource_id),
        operations: [{ op: "sum", column: "new_users", as: "joined_new_users" }],
      });
      assert.equal(lookupSum.ok, true);
      if (!lookupSum.ok) return;
      assert.equal((lookupSum.cells as { joined_new_users: number }).joined_new_users, 670);
      const resourcesBefore = runtime.sessions.resourceCount();
      const unsafe = await runtime.tools.query(session.session_id, {
        sql: `SELECT i.event_date, i.new_users, r.revenue_usd, r.is_predicted
          FROM fact_fox_daily_install AS i
          JOIN fact_fox_ad_receipt AS r
            ON i.event_date = r.event_date AND i.title_id = r.title_id AND i.platform = r.platform AND i.country_code = r.country_code
          WHERE i.event_date >= '2026-10-06' AND i.event_date <= '2026-10-12'
            AND r.event_date >= '2026-10-06' AND r.event_date <= '2026-10-12'
            AND i.title_id = 'paper_lantern' AND i.platform = 'ios' AND i.country_code = 'US'`,
      });
      assert.equal(unsafe.ok, false);
      if (!unsafe.ok) assert.equal(unsafe.code, "join_grain_mismatch");
      assert.equal(runtime.sessions.resourceCount(), resourcesBefore);
      const duplicated = await clickHouseQuery(admin, `SELECT sum(r.revenue_usd) AS n
        FROM fact_fox_daily_install AS i
        INNER JOIN fact_fox_ad_receipt AS r
          ON i.event_date = r.event_date AND i.title_id = r.title_id AND i.platform = r.platform AND i.country_code = r.country_code
        WHERE i.event_date >= '2026-10-06' AND i.event_date <= '2026-10-12'
          AND i.title_id = 'paper_lantern' AND i.platform = 'ios' AND i.country_code = 'US' AND r.is_predicted = 0`);
      assert.notEqual(Number(duplicated[0]?.n), 43.5);
      await verifyEvidenceLineage(runtime, reader, freshnessPath);
    } finally {
      await runtime.close();
      await reader.close();
      await admin.close();
    }
    await runSplitProcess(url, freshnessPath, dir, port);
  } finally {
    if (containerCreated) await runQuiet("docker", ["rm", "-f", container], adminPassword).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

async function verifyEvidenceLineage(runtime: ReturnType<typeof createRuntime>, reader: ReturnType<typeof createClickHouseClient>, freshnessPath: string) {
  const session = runtime.sessions.create("analyst");
  await bindTables(runtime, session.session_id, ["contract.fact_fox_daily_install", "contract.fact_fox_daily_active", "contract.fact_fox_ad_receipt", "contract.fact_fox_daily_spend"]);
  runtime.sessions.setActiveJob(session.session_id, "job_evidence_lineage");
  const time = "event_date >= '2026-10-06' AND event_date <= '2026-10-12'";
  const common = "title_id = 'paper_lantern' AND platform = 'ios'";
  async function calculate(sql: string, column: string, predicted: "any" | "actual_only" | "predicted_only" = "any") {
    const query = await runtime.tools.query(session.session_id, { sql });
    assert.equal(query.ok, true, JSON.stringify(query));
    if (!query.ok) throw new Error("query rejected");
    const calculation = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: String(query.resource_id), operations: [{ op: "sum", column, predicted, as: "MODEL_CHOSEN_ALIAS" }] });
    assert.equal(calculation.ok, true, JSON.stringify(calculation));
    if (!calculation.ok) throw new Error("calculation rejected");
    return { query, calculation };
  }
  const installs = await calculate(`SELECT event_date, title_id, platform, country_code, channel_id, new_users FROM fact_fox_daily_install WHERE ${time} AND ${common} AND country_code = 'JP' AND channel_id = 'mist_ads'`, "new_users");
  const active = await calculate(`SELECT event_date, title_id, platform, country_code, channel_id, active_users FROM fact_fox_daily_active WHERE ${time} AND ${common} AND country_code = 'JP' AND channel_id = 'mist_ads'`, "active_users");
  const revenue = await calculate(`SELECT event_date, title_id, platform, country_code, placement, revenue_usd, is_predicted FROM fact_fox_ad_receipt WHERE ${time} AND ${common} AND country_code = 'US'`, "revenue_usd", "actual_only");
  const values = [installs, active, revenue];
  const resources = values.flatMap((item) => [String(item.query.resource_id), String(item.calculation.resource_id)]);
  const wrongLabels = ["WRONG_COUNTRY_US", "WRONG_DATE_1999", "WRONG_METRIC_ROI", "WRONG_UNIT_USD", "WRONG_GROUP_ANDROID"];
  const analysis = await runtime.tools.updateAnalysis(session.session_id, {
    suggested_status: "completed", draft_answer: "", resource_ids: resources,
    findings: wrongLabels.map((label, index) => ({ label, metric: "spend_usd", unit: "USD", value: 70, kind: "predicted" as const, resource_id: String(installs.calculation.resource_id), cell: "MODEL_CHOSEN_ALIAS", group: (index % 2 ? { platform: "android" } : { country_code: "US" }) as Record<string, string>, time_range: { start: "1999-01-01", end: "1999-01-02" } })),
  });
  assert.equal(analysis.ok, true);
  if (!analysis.ok) return;
  const answer = String(analysis.answer);
  for (const wrong of wrongLabels) assert.equal(answer.includes(wrong), false);
  assert.match(answer, /fact_fox_daily_install\.new_users/);
  const installLine = answer.split("\n").find((line) => line.includes("fact_fox_daily_install.new_users")) ?? "";
  assert.match(installLine, /合计 70；单位 人/);
  assert.match(installLine, /country_code=JP/);
  assert.doesNotMatch(installLine, /USD|country_code=US|platform=android|1999/);
  assert.match(answer, /合计 70；单位 人/);
  assert.match(answer, /country_code=JP/);
  assert.match(answer, /2026-10-06 到 2026-10-12/);
  assert.match(answer, /fact_fox_daily_active\.active_users[^\n]*5090/);
  assert.match(answer, /fact_fox_ad_receipt\.revenue_usd[^\n]*43\.5；单位 USD；实际/);
  assert.equal(answer.includes("MODEL_CHOSEN_ALIAS"), false);
  const flags = await calculate(`SELECT event_date, title_id, platform, country_code, placement, revenue_usd, is_predicted FROM fact_fox_ad_receipt WHERE ${time} AND ${common} AND country_code = 'US'`, "revenue_usd", "predicted_only");
  const predicted = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(flags.query.resource_id), String(flags.calculation.resource_id)], findings: [{ label: "WRONG_ACTUAL", value: 27.5, kind: "actual", resource_id: String(flags.calculation.resource_id), cell: "MODEL_CHOSEN_ALIAS" }] });
  assert.equal(predicted.ok, true);
  if (predicted.ok) { assert.match(String(predicted.answer), /27\.5；单位 USD；预测/); assert.doesNotMatch(String(predicted.answer), /WRONG_ACTUAL/); }
  const grouped = await calculate(`SELECT event_date, title_id, platform, country_code, channel_id, spend_usd, is_predicted FROM fact_fox_daily_spend WHERE ${time} AND ${common} AND country_code = 'US'`, "spend_usd", "actual_only");
  const groupedAnalysis = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(grouped.query.resource_id), String(grouped.calculation.resource_id)] });
  assert.equal(groupedAnalysis.ok, true);
  if (groupedAnalysis.ok) assert.match(String(groupedAnalysis.answer), /mist_ads=40.*pebble_net=5|pebble_net=5.*mist_ads=40/);
  for (const expression of ["new_users AS revenue_usd", "SUM(new_users) AS revenue_usd"]) {
    const unsupported = await runtime.tools.query(session.session_id, { sql: `SELECT ${expression} FROM fact_fox_daily_install WHERE ${time} AND ${common} AND country_code = 'JP' AND channel_id = 'mist_ads'` });
    if (!unsupported.ok) continue; // SQL admission may conservatively reject it earlier.
    const calc = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: String(unsupported.resource_id), operations: [{ op: "sum", column: "revenue_usd", as: "fake" }] });
    assert.equal(calc.ok, true);
    if (!calc.ok) continue;
    const result = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(unsupported.resource_id), String(calc.resource_id)] });
    assert.equal(result.ok, true);
    if (result.ok) { assert.notEqual(result.status, "completed"); assert.doesNotMatch(String(result.answer), /合计 70/); }
  }
  const zeroNullQuery = await runtime.tools.query(session.session_id, { sql: `SELECT event_date, title_id, platform, country_code, channel_id, new_users FROM fact_fox_daily_install WHERE ${time} AND ${common} AND country_code = 'US' AND channel_id = 'mist_ads'` });
  assert.equal(zeroNullQuery.ok, true);
  if (zeroNullQuery.ok) {
    const counts = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: String(zeroNullQuery.resource_id), operations: [{ op: "count_null", column: "new_users", as: "pretend_zero" }, { op: "count_zero", column: "new_users", as: "pretend_missing" }] });
    assert.equal(counts.ok, true);
    if (counts.ok) {
      const result = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(zeroNullQuery.resource_id), String(counts.resource_id)] });
      assert.equal(result.ok, true);
      if (result.ok) { assert.match(String(result.answer), /值为 NULL 的行数 1/); assert.match(String(result.answer), /数值为零的行数 1/); assert.doesNotMatch(String(result.answer), /pretend_zero|pretend_missing/); }
    }
  }
  const nullOnly = await calculate(`SELECT event_date, title_id, platform, country_code, channel_id, new_users FROM fact_fox_daily_install WHERE event_date >= '2026-10-09' AND event_date <= '2026-10-09' AND ${common} AND country_code = 'US' AND channel_id = 'mist_ads'`, "new_users");
  const nullResult = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(nullOnly.query.resource_id), String(nullOnly.calculation.resource_id)] });
  assert.equal(nullResult.ok, true);
  if (nullResult.ok) assert.doesNotMatch(String(nullResult.answer), /合计 0/);
  const mixed = await calculate(`SELECT event_date, title_id, platform, country_code, placement, revenue_usd, is_predicted FROM fact_fox_ad_receipt WHERE ${time} AND ${common} AND country_code = 'US'`, "revenue_usd", "any");
  const mixedResult = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(mixed.query.resource_id), String(mixed.calculation.resource_id)] });
  assert.equal(mixedResult.ok, true);
  if (mixedResult.ok) assert.doesNotMatch(String(mixedResult.answer), /合计 71/);
  const oldLimit = runtime.config.maxResultRows;
  runtime.config.maxResultRows = 2;
  try {
    const cut = await calculate(`SELECT event_date, title_id, platform, country_code, channel_id, new_users FROM fact_fox_daily_install WHERE ${time} AND ${common} AND country_code = 'JP' AND channel_id = 'mist_ads'`, "new_users");
    const result = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(cut.query.resource_id), String(cut.calculation.resource_id)] });
    assert.equal(result.ok, true);
    if (result.ok) { assert.notEqual(result.status, "completed"); assert.doesNotMatch(String(result.answer), /合计 20/); assert.deepEqual((result.sources as Array<{ rows: unknown[] }>)[0]?.rows, []); }
  } finally { runtime.config.maxResultRows = oldLimit; }
  runtime.sessions.setActiveJob(session.session_id, "job_next");
  const crossed = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: String(installs.query.resource_id), operations: [{ op: "sum", column: "new_users", as: "fake" }] });
  assert.equal(crossed.ok, false);
  if (!crossed.ok) assert.equal(crossed.code, "resource_from_other_execution");
  runtime.sessions.setActiveJob(session.session_id, "job_evidence_lineage");
  await probeClickHouseAndPublish({ targetsPath: path.join(knowledgeDir, "freshness-targets.json"), destinationPath: freshnessPath, query: (sql) => clickHouseQuery(reader, sql) as Promise<Array<{ event_date: string }>> });
  const stale = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(installs.query.resource_id), String(installs.calculation.resource_id)] });
  assert.equal(stale.ok, true);
  if (stale.ok) { assert.notEqual(stale.status, "completed"); assert.doesNotMatch(String(stale.answer), /合计 70/); assert.deepEqual((stale.sources as Array<{ rows: unknown[] }>)[0]?.rows, []); }
}

async function runSplitProcess(clickhouseUrl: string, freshnessPath: string, dir: string, clickhousePort: number) {
  const mysqlPort = await freePort();
  const redisPort = await freePort();
  const apiPort = await freePort();
  const suffix = randomUUID();
  const mysqlName = `lumenfox-ch-mysql-${suffix}`;
  const redisName = `lumenfox-ch-redis-${suffix}`;
  let mysqlCreated = false;
  let redisCreated = false;
  const statePassword = randomBytes(12).toString("hex");
  const children: ChildProcess[] = [];
  try {
    await runQuiet("docker", ["run", "--pull=never", "-d", "--name", mysqlName, "--tmpfs", "/var/lib/mysql:rw,size=1g", "-p", `127.0.0.1:${mysqlPort}:3306`, "-e", `MYSQL_ROOT_PASSWORD=${statePassword}`, "-e", "MYSQL_DATABASE=lumenfox_it", "-e", "MYSQL_USER=lumenfox_it", "-e", `MYSQL_PASSWORD=${statePassword}`, "mysql:8.0.32"], statePassword);
    mysqlCreated = true;
    await runQuiet("docker", ["run", "--pull=never", "-d", "--name", redisName, "--tmpfs", "/data:rw,size=64m", "-p", `127.0.0.1:${redisPort}:6379`, "redis:6.2", "redis-server", "--bind", "0.0.0.0", "--protected-mode", "yes", "--requirepass", statePassword], statePassword);
    redisCreated = true;
    const env = {
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
      REDIS_QUEUE_KEY: `lumenfox:ch:${process.pid}:jobs`,
      RECOVERY_MS: "800",
      LEASE_MS: "4000",
      HEARTBEAT_MS: "300",
      TOOL_DELAY_MS: "1200",
      MODEL_MODE: "pi",
      PI_PROVIDER: "faux",
      MAX_MODEL_CALLS: "24",
    };
    void clickhousePort;
    await waitForMysql(mysqlPort, statePassword);
    const freshness = await MysqlFreshnessStore.open({ host: "127.0.0.1", port: mysqlPort, user: "lumenfox_it", password: statePassword, database: "lumenfox_it" });
    const freshnessReader = createClickHouseClient({ url: clickhouseUrl, username: "fox_reader", password: readerPassword, database: "harborlight", maxRowsToRead: 5_000_000, timeoutSeconds: 10 }, true);
    try {
      const targetsPath = path.join(knowledgeDir, "freshness-targets.json");
      const batch = await freshness.begin(freshnessManifest(loadKnowledge(knowledgeDir), targetsPath));
      const observed = await probeClickHouseFreshness({ targetsPath, query: (sql) => clickHouseQuery(freshnessReader, sql) as Promise<Array<{ event_date: string }>> });
      assert.equal(await freshness.publish(batch.version, observed), "published");
    } finally { await freshness.close(); await freshnessReader.close(); }
    const logs: string[] = [];
    const api = spawn(process.execPath, ["--import", "tsx", "src/api.ts"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(api);
    api.stderr?.on("data", (chunk: Buffer) => { logs.push(chunk.toString().replaceAll(statePassword, "[secret]").replaceAll(readerPassword, "[secret]")); });
    api.stdout?.on("data", () => undefined);
    try {
      await waitForHttp(`http://127.0.0.1:${apiPort}/api/health`);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : "api"} ${logs.join("").slice(-800)}`);
    }
    for (const script of ["src/worker.ts", "src/dispatcher.ts"]) {
      const child = spawn(process.execPath, ["--import", "tsx", script], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout?.on("data", () => undefined);
      child.stderr?.on("data", (chunk: Buffer) => { logs.push(chunk.toString().replaceAll(statePassword, "[secret]").replaceAll(readerPassword, "[secret]")); });
      children.push(child);
    }
    const created = await fetch(`http://127.0.0.1:${apiPort}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const session = (await created.json()) as { session_id: string; role: string };
    assert.equal(session.role, "analyst");
    const posted = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/${session.session_id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "纸灯 在 2026-10-06 到 2026-10-12（美国、iOS、雾帆）的新增用户是多少？", idempotency_key: randomUUID() }),
    });
    assert.equal(posted.status, 202);
    const queued = (await posted.json()) as { job_id: string };
    let job;
    try {
      job = await waitHttpJob(apiPort, queued.job_id);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : error}\n${logs.join("").slice(-1800)}`);
    }
    assert.equal(job.status, "partial", JSON.stringify(job.error ?? job.analysis?.answer));
    assert.match(job.analysis?.answer ?? "", /670/);
    assert.equal(job.analysis?.sources?.[0]?.engine, "clickhouse-local");
    assert.ok(job.analysis?.sources?.[0]?.freshness_receipts?.length);
    const hidden = await fetch(`http://127.0.0.1:${apiPort}/api/jobs/${queued.job_id}`, { headers: { "x-demo-actor": "demo-viewer" } });
    assert.equal(hidden.status, 404);
    const worker = children.find((child) => child.spawnargs.includes("src/worker.ts"));
    const interrupted = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/${session.session_id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "纸灯 在 2026-10-06 到 2026-10-12（美国、iOS、雾帆）的新增用户是多少？", idempotency_key: randomUUID() }),
    });
    const interruptedJob = (await interrupted.json()) as { job_id: string };
    const sawTool = await waitForEvent(apiPort, interruptedJob.job_id, "transcript_saved");
    assert.equal(sawTool, true);
    // Wait for the next tool to start and remain unfinished; killing immediately
    // after the saved receipt races with the agent starting its next tool.
    const unfinishedStart = Date.now();
    let sawUnfinished = false;
    while (Date.now() - unfinishedStart < 10_000) {
      const progress = await jobBody(apiPort, interruptedJob.job_id);
      const saved = progress.events.filter((event) => event.type === "transcript_saved").at(-1);
      const started = progress.events.filter((event) => event.type === "tool_started").at(-1);
      if (saved && started && started.seq > saved.seq && !progress.events.some((event) => event.type === "tool_finished" && event.payload.tool_call_id === started.payload.tool_call_id)) {
        sawUnfinished = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(sawUnfinished, true);
    worker?.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const recoveredWorker = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    recoveredWorker.stdout?.on("data", () => undefined);
    recoveredWorker.stderr?.on("data", () => undefined);
    children.push(recoveredWorker);
    const resumed = await waitHttpJob(apiPort, interruptedJob.job_id);
    assert.equal(resumed.status, "partial", JSON.stringify(resumed.error ?? resumed.analysis?.answer));
    assert.match(resumed.analysis?.answer ?? "", /670/);
    const contexts = (resumed.events ?? []).filter((event) => event.type === "model_context");
    const restored = contexts.filter((event) => event.payload.restored === true).at(-1);
    assert.ok(restored, JSON.stringify(resumed.events?.map((event) => event.type)));
    assert.equal(restored?.payload.format, "pi-coding-agent-session-jsonl-v3");
    assert.equal(restored?.payload.decision, "redo_unfinished_tool_call");
    assert.equal(restored?.payload.query_may_rerun, true);
    const resumedEvents = resumed.events ?? [];
    const recoveryAt = resumedEvents.findIndex((event, index) => event.type === "job_started" && resumedEvents.slice(0, index).some((item) => item.type === "job_started"));
    assert.ok(recoveryAt > 0);
    const beforeRecovery = resumedEvents.slice(0, recoveryAt);
    const savedReceipt = beforeRecovery.filter((event) => event.type === "transcript_saved").at(-1);
    const savedCall = String(savedReceipt?.payload.tool_call_id);
    const unfinishedCall = String(restored?.payload.leaf_tool_call_id);
    assert.notEqual(savedCall, unfinishedCall);
    assert.equal(resumedEvents.filter((event) => event.type === "tool_started" && event.payload.tool_call_id === savedCall).length, 1);
    assert.equal(resumedEvents.filter((event) => event.type === "tool_finished" && event.payload.tool_call_id === unfinishedCall).length, 0);
    const redone = resumedEvents.slice(recoveryAt).filter((event) => event.type === "tool_started" && event.payload.tool_name === restored?.payload.leaf_tool_name);
    assert.equal(redone.length, 1);
    assert.notEqual(redone[0]?.payload.tool_call_id, unfinishedCall);
    assert.equal(resumedEvents.filter((event) => event.type === "job_finished").length, 1);
    const question = "纸灯 在 2026-10-06 到 2026-10-12（美国、iOS、雾帆）的新增用户是多少？";
    const killWorkers = () => {
      for (const child of children) {
        if (child.spawnargs.includes("src/worker.ts") && child.exitCode === null) child.kill("SIGKILL");
      }
    };
    const spawnWorker = (extra: Record<string, string>) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], {
        cwd: root,
        env: { ...env, LEASE_MS: "20000", TOOL_DELAY_MS: "0", PI_HOLD_AFTER_TOOL_RESULT_MS: "0", PI_HOLD_BEFORE_MODEL_RESPONSE_MS: "0", PI_HOLD_AFTER_TOOL_NAMES: "", ...extra },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", () => undefined);
      child.stderr?.on("data", () => undefined);
      children.push(child);
      return child;
    };
    const askNew = async (text: string) => {
      const created = await fetch(`http://127.0.0.1:${apiPort}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const createdSession = (await created.json()) as { session_id: string };
      const posted = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/${createdSession.session_id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, idempotency_key: randomUUID() }),
      });
      assert.equal(posted.status, 202);
      return (await posted.json()) as { job_id: string };
    };
    killWorkers();
    await new Promise((resolve) => setTimeout(resolve, 300));
    spawnWorker({ PI_HOLD_AFTER_TOOL_RESULT_MS: "8000" });
    const held = await askNew(question);
    const heldReceipt = await waitForPayload(apiPort, held.job_id, "transcript_saved");
    const heldCall = String(heldReceipt.tool_call_id);
    killWorkers();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    spawnWorker({});
    const heldDone = await waitHttpJob(apiPort, held.job_id);
    const heldEvents = heldDone.events ?? [];
    assert.equal(heldEvents.filter((event) => event.type === "tool_started" && event.payload.tool_call_id === heldCall).length, 1, "已保存回执不能再次执行");
    const heldResume = heldEvents.filter((event) => event.type === "model_context" && event.payload.decision === "tool_result_reread").at(-1);
    assert.equal(heldResume?.payload.leaf_id, heldReceipt.leaf_id);
    assert.equal(heldResume?.payload.leaf_tool_call_id, heldCall);
    assert.equal(heldResume?.payload.query_may_rerun, false);
    assert.equal(heldEvents.filter((event) => event.type === "tool_started" && event.payload.tool_name === "query").length, 1);
    assert.equal(heldEvents.filter((event) => event.type === "job_finished").length, 1);

    killWorkers();
    await new Promise((resolve) => setTimeout(resolve, 300));
    spawnWorker({ PI_HOLD_BEFORE_MODEL_RESPONSE_MS: "8000" });
    const streaming = await askNew(question);
    const userSnapshot = await waitForPayload(apiPort, streaming.job_id, "snapshot_saved", (payload) => payload.role === "user");
    const midStream = await jobBody(apiPort, streaming.job_id);
    assert.equal(midStream.events.some((event) => event.type === "tool_started"), false);
    killWorkers();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    spawnWorker({});
    const streamed = await waitHttpJob(apiPort, streaming.job_id);
    const streamEvents = streamed.events ?? [];
    const streamRecovery = streamEvents.findIndex((event, index) => event.type === "job_started" && streamEvents.slice(0, index).some((item) => item.type === "job_started"));
    assert.equal(streamEvents.slice(0, streamRecovery).some((event) => event.type === "tool_started"), false);
    assert.equal(streamEvents.filter((event) => event.type === "model_context" && event.payload.decision === "model_turn_redone").length, 1);
    assert.equal(streamEvents.filter((event) => event.type === "model_context" && event.payload.leaf_role === "user" && event.payload.decision === "model_turn_redone").at(-1)?.payload.leaf_id, userSnapshot.leaf_id);
    assert.equal(streamEvents.filter((event) => event.type === "tool_started" && event.payload.tool_name === "query").length, 1);
    assert.equal(streamEvents.filter((event) => event.type === "job_finished").length, 1);

    killWorkers();
    await new Promise((resolve) => setTimeout(resolve, 300));
    spawnWorker({ PI_HOLD_AFTER_TOOL_RESULT_MS: "8000", PI_HOLD_AFTER_TOOL_NAMES: "update_analysis" });
    const candidate = await askNew(question);
    const candidateReceipt = await waitForPayload(apiPort, candidate.job_id, "transcript_saved", (payload) => payload.tool_name === "update_analysis");
    killWorkers();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    spawnWorker({});
    const submitted = await waitHttpJob(apiPort, candidate.job_id);
    const candidateEvents = submitted.events ?? [];
    assert.equal(candidateEvents.filter((event) => event.type === "tool_started" && event.payload.tool_name === "update_analysis").length, 1);
    assert.equal(candidateEvents.filter((event) => event.type === "tool_started" && event.payload.tool_call_id === candidateReceipt.tool_call_id).length, 1);
    assert.equal(candidateEvents.filter((event) => event.type === "model_context" && event.payload.decision === "reread_candidate").length, 1);
    assert.match(submitted.analysis?.answer ?? "", /670/);
    assert.equal(candidateEvents.filter((event) => event.type === "job_finished").length, 1);

    const redis = new Redis({ host: "127.0.0.1", port: redisPort, password: statePassword, maxRetriesPerRequest: 1 });
    await redis.lpush(`lumenfox:ch:${process.pid}:jobs`, JSON.stringify({ job_id: candidate.job_id, outbox_id: 0 }));
    await redis.quit();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const redelivered = await jobBody(apiPort, candidate.job_id);
    assert.equal(redelivered.events.filter((event) => event.type === "job_finished").length, 1);
    assert.equal(redelivered.status, submitted.status);
    const connection = await mysql.createConnection({ host: "127.0.0.1", port: mysqlPort, user: "lumenfox_it", password: statePassword, database: "lumenfox_it" });
    const [updated] = await connection.query("UPDATE jobs SET status = 'failed' WHERE job_id = ? AND fence = 1", [candidate.job_id]);
    await connection.end();
    assert.equal((updated as { affectedRows?: number }).affectedRows ?? 0, 0);
    const events = await fetch(`http://127.0.0.1:${apiPort}/api/jobs/${queued.job_id}/events?after=2`);
    const text = await events.text();
    assert.match(text, /job_finished|job_failed/);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    if (mysqlCreated) await runQuiet("docker", ["rm", "-f", mysqlName], statePassword).catch(() => undefined);
    if (redisCreated) await runQuiet("docker", ["rm", "-f", redisName], statePassword).catch(() => undefined);
  }
}

async function waitHttpJob(port: number, jobId: string) {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < 60_000) {
    const response = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}`);
    last = await response.text();
    const job = JSON.parse(last) as {
      status: string;
      error?: { message: string };
      events?: Array<{ type: string; payload: Record<string, unknown> }>;
      analysis?: { answer?: string; sources?: Array<{ engine?: string; freshness_receipts?: unknown[] }> };
    };
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`分进程任务没有结束 ${last.slice(0, 1500)}`);
}

function runQuiet(command: string, args: string[], secret: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error((err || `${command} exit ${code}`).replaceAll(secret, "[secret]").slice(0, 500)));
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

async function jobBody(port: number, jobId: string) {
  const response = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}`);
  return (await response.json()) as {
    status: string;
    analysis?: { answer?: string };
    events: Array<{ type: string; seq: number; payload: Record<string, unknown> }>;
  };
}

async function waitForPayload(port: number, jobId: string, type: string, predicate?: (payload: Record<string, unknown>) => boolean) {
  const started = Date.now();
  while (Date.now() - started < 70_000) {
    const job = await jobBody(port, jobId);
    const found = job.events.find((event) => event.type === type && (!predicate || predicate(event.payload)));
    if (found) return found.payload;
    if (!["queued", "running"].includes(job.status)) {
      throw new Error(`${type} 没有出现：${job.status} ${job.events.map((event) => event.type).join(",")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`${type} 等待超时`);
}

async function waitForEvent(port: number, jobId: string, type: string): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    const response = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}`);
    const job = (await response.json()) as { status?: string; events?: Array<{ type: string }> };
    if (job.events?.some((event) => event.type === type)) return true;
    if (job.status && !["queued", "running"].includes(job.status)) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function waitForMysql(port: number, password: string) {
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
  throw new Error("分进程用的隔离 MySQL 未就绪");
}

async function waitForHttp(url: string) {
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    try {
      const response = await fetch(url.endsWith("/api/health") ? url : `${url}/ping`);
      if (response.ok || response.status === 200) return;
    } catch {
      // 容器还在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`服务没有就绪：${url.replace(/:[^@/]+@/u, "://")}`);
}
