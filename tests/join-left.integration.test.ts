import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { clickHouseColumnTypes, clickHouseCommand, clickHouseInsert, clickHouseQuery, clickHouseQueryBounded, createClickHouseClient } from "../src/clickhouse-client.js";
import { dimensionSnapshotStatusValid, probeClickHouseAndPublish, probeClickHouseFreshness } from "../src/freshness.js";
import { joinDimensionObservations, joinMissingDimensionKeys, prepareJoinEvidence, verifyJoinEvidence, verifyJoinExecutionSchema, verifyJoinPhysicalSchema } from "../src/join-evidence.js";
import { loadKnowledge } from "../src/knowledge.js";
import { createTableSql, smallWarehouse, WAREHOUSE_TABLES } from "../src/warehouse.js";
import { analyst, bindTables, withRuntime } from "./helpers.js";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const knowledge = loadKnowledge(path.join(root, "knowledge", "harborlight"));
const fact = knowledge.contract_by_table.get("fact_fox_daily_install")!.contract!;
const title = knowledge.contract_by_table.get("dim_fox_title")!.contract!;
const channel = knowledge.contract_by_table.get("dim_fox_channel")!.contract!;
const dateRange = "f.event_date >= '2026-10-06' AND f.event_date <= '2026-10-12'";
const productSql = `SELECT f.title_id, d.title_name AS label, SUM(f.new_users) AS total FROM fact_fox_daily_install f LEFT JOIN dim_fox_title d ON f.title_id = d.title_id WHERE ${dateRange} AND f.platform = 'ios' AND f.country_code = 'JP' AND f.channel_id = 'mist_ads' GROUP BY f.title_id, d.title_name ORDER BY f.title_id`;
const channelSql = `SELECT f.channel_id, d.channel_name AS label, SUM(f.new_users) AS total FROM fact_fox_daily_install f LEFT JOIN dim_fox_channel d ON f.channel_id = d.channel_id WHERE ${dateRange} AND f.title_id = 'paper_lantern' AND f.platform = 'ios' AND f.country_code = 'JP' GROUP BY f.channel_id, d.channel_name ORDER BY f.channel_id`;

async function docker(args: string[]): Promise<string> {
  try { const result = await exec("docker", args); return result.stdout; }
  catch { throw new Error("isolated_container_operation_failed"); }
}

test("LEFT 证明仅允许登记键、完整事实粒度与无维表 WHERE 的受控形状", () => {
  const product = prepareJoinEvidence(productSql, fact, title, knowledge.joins);
  const channels = prepareJoinEvidence(channelSql, fact, channel, knowledge.joins);
  assert.equal(product?.joinType, "left"); assert.equal(channels?.joinType, "left");
  assert.equal(prepareJoinEvidence(productSql.replace("f.title_id = d.title_id", "f.platform = d.title_id"), fact, title, knowledge.joins), null);
  assert.equal(prepareJoinEvidence(productSql.replace(" GROUP BY", " AND d.title_name = '纸灯' GROUP BY"), fact, title, knowledge.joins), null);
  assert.equal(prepareJoinEvidence(`${productSql} LIMIT 1`, fact, title, knowledge.joins), null);
  assert.equal(prepareJoinEvidence(productSql, fact, { ...title, sensitive_columns: [...title.sensitive_columns, "title_name"] }, knowledge.joins), null);
});

test("隔离 ClickHouse LEFT 产品/渠道：真实 NULL、完整左侧、重复键和伪造回执", async () => {
  const name = `dataagent-left-${randomUUID()}`; const password = randomBytes(20).toString("hex");
  try {
    await docker(["run", "--pull=never", "-d", "--name", name, "--label", `dataagent.test.run=${name}`, "--tmpfs", "/var/lib/clickhouse:rw,size=512m", "--ulimit", "nofile=262144:262144", "-p", "127.0.0.1::8123", "-e", `CLICKHOUSE_PASSWORD=${password}`, "-e", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1", "clickhouse/clickhouse-server:24.8.14.39"]);
    const port = Number(/^127\.0\.0\.1:(\d+)\s*$/u.exec(await docker(["port", name, "8123/tcp"]))?.[1]);
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
    const url = `http://127.0.0.1:${port}`; const deadline = Date.now() + 45_000;
    while (true) {
      try { if ((await fetch(`${url}/ping`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* starting */ }
      if (Date.now() > deadline) throw new Error("isolated_clickhouse_start_timeout");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const client = createClickHouseClient({ url, username: "default", password, database: "default", maxRowsToRead: 1_000_000, timeoutSeconds: 10 }, false);
    try {
      for (const tableName of [fact.table, title.table, channel.table]) {
        const table = WAREHOUSE_TABLES.find((item) => item.table === tableName); assert.ok(table);
        await clickHouseCommand(client, createTableSql(table));
      }
      const data = smallWarehouse();
      await clickHouseInsert(client, fact.table, data.installs);
      await clickHouseInsert(client, title.table, data.titles);
      await clickHouseInsert(client, channel.table, data.channels);
      const original = data.installs.filter((row) => row.country_code === "JP" && row.title_id === "paper_lantern" && row.channel_id === "mist_ads");
      assert.equal(original.length, 7);
      await clickHouseInsert(client, fact.table, original.map((row) => ({ ...row, title_id: "orphan_title", new_users: 3 })));
      await clickHouseInsert(client, fact.table, original.map((row) => ({ ...row, channel_id: "orphan_channel", new_users: 3 })));
      const readerPassword = randomBytes(20).toString("hex");
      try { await clickHouseCommand(client, `CREATE USER synthetic_left_reader IDENTIFIED BY '${readerPassword}'`); } catch { throw new Error("isolated_reader_create_failed"); }
      await clickHouseCommand(client, "GRANT SELECT ON default.* TO synthetic_left_reader");
      const reader = createClickHouseClient({ url, username: "synthetic_left_reader", password: readerPassword, database: "default", maxRowsToRead: 1_000_000, timeoutSeconds: 10 }, true);
      try {
        for (const [sql, dimension, key] of [[productSql, title, "title_id"], [channelSql, channel, "channel_id"]] as const) {
          const plan = prepareJoinEvidence(sql, fact, dimension, knowledge.joins); assert.ok(plan);
          assert.equal(verifyJoinPhysicalSchema(plan, fact, dimension, await clickHouseColumnTypes(reader, fact.table), await clickHouseColumnTypes(reader, dimension.table)), true);
          const originalRows = await clickHouseQueryBounded(reader, sql, 100, 200_000);
          const result = await clickHouseQueryBounded(reader, plan.executionSql, 100, 200_000);
          assert.equal(result.truncated, false); assert.equal(verifyJoinExecutionSchema(plan, fact, dimension, result.column_types), true, JSON.stringify(result.column_types));
          assert.equal(verifyJoinExecutionSchema(plan, fact, dimension, { ...result.column_types, __da_join_proof: result.column_types.__da_join_proof!.replace("Nullable(String)", "String") }), false, "不能把缺失维值当默认空字符串");
          assert.deepEqual(result.rows.map(({ __da_join_proof: _proof, ...row }) => row), originalRows.rows, "证明查询必须保留原 LEFT JOIN 行值");
          const values = verifyJoinEvidence(plan, result.rows); assert.ok(values, JSON.stringify(result.rows));
          assert.equal(values.length, 2);
          assert.deepEqual(values.map((item) => item.value).sort(), ["21", "70"]);
          const absent = values.find((item) => item.value === "21"); assert.ok(absent);
          assert.equal(absent.unmatched_rows, 7);
          assert.equal(values.find((item) => item.value === "70")?.unmatched_rows, 0);
          assert.equal(absent.group[`${dimension.table}.${dimension === title ? "title_name" : "channel_name"}`], null);
          const orphanKey = dimension === title ? "orphan_title" : "orphan_channel";
          assert.deepEqual(joinMissingDimensionKeys(plan, result.rows), [{ [key]: orphanKey }]);
          const observations = joinDimensionObservations(plan, result.rows); assert.ok(observations);
          assert.ok(observations.every((item) => item.keys[key] !== orphanKey), "未匹配行不能伪造维表值");
          const changed = structuredClone(result.rows);
          const missingRow = changed.find((row) => row.label === null); assert.ok(missingRow);
          missingRow.label = "伪造名称";
          assert.equal(verifyJoinEvidence(plan, changed), null);
          const changedProof = structuredClone(result.rows);
          const changedTuple = (changedProof.find((row) => row.label === null)!.__da_join_proof as unknown[][])[0]!;
          const keyOffset = 1 + new Set(plan.metrics.map((metric) => metric.column)).size + plan.proofFields.findIndex((field) => field.table === "dimension" && field.column === key);
          changedTuple[keyOffset] = orphanKey;
          assert.equal(verifyJoinEvidence(plan, changedProof), null);
        }
        await withRuntime({ knowledgeDir: path.join(root, "knowledge", "harborlight"), businessEngine: "clickhouse", clickhouseUrl: url, clickhouseUser: "synthetic_left_reader", clickhousePassword: readerPassword, clickhouseDatabase: "default", publishFreshnessOnStart: false, startWorker: false }, async (runtime) => {
          const publish = () => probeClickHouseAndPublish({ targetsPath: runtime.config.freshnessTargetsPath, destinationPath: runtime.config.freshnessPath, query: (sql) => clickHouseQuery(reader, sql) as Promise<Array<{ event_date: string }>> });
          await publish();
          const session = analyst(runtime);
          await bindTables(runtime, session.session_id, ["contract.fact_fox_daily_install", "contract.dim_fox_title", "contract.dim_fox_channel"]);
          runtime.sessions.setActiveJob(session.session_id, "left_authority_test");
          const inner = "SELECT event_date, title_id, platform, country_code, channel_id, new_users FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-12' AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'JP' AND channel_id = 'mist_ads'";
          for (const sql of [`WITH scoped AS (${inner}) SELECT event_date, new_users FROM scoped`, `SELECT scoped.event_date, scoped.new_users FROM (${inner}) scoped`]) {
            const query = await runtime.tools.query(session.session_id, { sql });
            assert.equal(query.ok, true, JSON.stringify(query)); if (!query.ok) throw new Error("projection_query_rejected");
            assert.equal(query.executed_sql, sql, "实际执行与展示必须使用用户 SQL");
            const calculation = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: String(query.resource_id), operations: [{ op: "sum", column: "new_users", as: "total" }] });
            assert.equal(calculation.ok, true, JSON.stringify(calculation)); if (!calculation.ok) throw new Error("projection_calculation_rejected");
            const result = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(query.resource_id), String(calculation.resource_id)] });
            assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error("projection_delivery_rejected");
            assert.equal(result.status, "completed", JSON.stringify(result));
            assert.match(String(result.answer), /70/);
          }
          for (const sql of [productSql, channelSql]) {
            const query = await runtime.tools.query(session.session_id, { sql });
            assert.equal(query.ok, true, JSON.stringify(query)); if (!query.ok) throw new Error("left_query_rejected");
            const answer = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(query.resource_id)] });
            assert.equal(answer.ok, true, JSON.stringify(answer)); if (!answer.ok) throw new Error("left_delivery_rejected");
            assert.equal(answer.status, "completed", JSON.stringify(answer));
            assert.match(String(answer.answer), /JOIN 求和 21；单位 人/);
            assert.match(String(answer.answer), /NULL（维表未匹配）/);
          }
          const ungroupedSql = `SELECT SUM(f.new_users) AS total FROM fact_fox_daily_install f LEFT JOIN dim_fox_title d ON f.title_id = d.title_id WHERE ${dateRange} AND f.title_id = 'orphan_title' AND f.platform = 'ios' AND f.country_code = 'JP' AND f.channel_id = 'mist_ads'`;
          const ungrouped = await runtime.tools.query(session.session_id, { sql: ungroupedSql });
          assert.equal(ungrouped.ok, true, JSON.stringify(ungrouped)); if (!ungrouped.ok) throw new Error("ungrouped_left_rejected");
          const ungroupedAnswer = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(ungrouped.resource_id)] });
          assert.equal(ungroupedAnswer.ok, true, JSON.stringify(ungroupedAnswer));
          if (ungroupedAnswer.ok) { assert.equal(ungroupedAnswer.status, "completed"); assert.match(String(ungroupedAnswer.answer), /未匹配维表 7 行/); }
          // A self-consistent snapshot keyed by a different column is not a
          // proof that an unmatched title_id is absent from the dimension.
          const wrongPath = path.join(runtime.config.ephemeralDir!, "wrong-dimension-target.json");
          writeFileSync(wrongPath, JSON.stringify({ source: "synthetic-test", engine: "clickhouse-local", valid_until: "2027-04-01", targets: [{ table: title.table, engine: "clickhouse-local", kind: "dimension_snapshot", key_columns: ["genre"], snapshot_columns: ["genre", "title_id", "title_name"] }] }));
          const wrongSnapshot = (await probeClickHouseFreshness({ targetsPath: wrongPath, query: (sql) => clickHouseQuery(reader, sql) as Promise<Array<{ event_date: string }>> })).tables[title.table];
          assert.equal(dimensionSnapshotStatusValid(wrongSnapshot, title.table), true);
          const savedPublication = readFileSync(runtime.config.freshnessPath, "utf8");
          try {
            const wrongPublication = JSON.parse(savedPublication) as { tables: Record<string, unknown> };
            wrongPublication.tables[title.table] = wrongSnapshot;
            writeFileSync(runtime.config.freshnessPath, JSON.stringify(wrongPublication));
            const orphanOnlySql = `SELECT d.title_name AS label, SUM(f.new_users) AS total FROM fact_fox_daily_install f LEFT JOIN dim_fox_title d ON f.title_id = d.title_id WHERE ${dateRange} AND f.title_id = 'orphan_title' AND f.platform = 'ios' AND f.country_code = 'JP' AND f.channel_id = 'mist_ads' GROUP BY d.title_name`;
            const wrongKey = await runtime.tools.query(session.session_id, { sql: orphanOnlySql });
            assert.equal(wrongKey.ok, false); if (!wrongKey.ok) assert.equal(wrongKey.code, "dimension_snapshot_mismatch");
          } finally { writeFileSync(runtime.config.freshnessPath, savedPublication); }
          // Snapshot says absent, but the live dimension now contains the key.
          await clickHouseInsert(client, title.table, [{ title_id: "orphan_title", title_name: "合成孤儿", genre: "test", launched_on: "2026-01-01" }]);
          const added = await runtime.tools.query(session.session_id, { sql: productSql });
          assert.equal(added.ok, false); if (!added.ok) assert.equal(added.code, "dimension_snapshot_mismatch");
          // Publish the added key, then remove it: a NULL match must not claim
          // absence while the current authority still contains that key.
          await publish();
          await clickHouseCommand(client, "ALTER TABLE dim_fox_title DELETE WHERE title_id = 'orphan_title' SETTINGS mutations_sync = 2");
          const deleted = await runtime.tools.query(session.session_id, { sql: productSql });
          assert.equal(deleted.ok, false); if (!deleted.ok) assert.equal(deleted.code, "dimension_snapshot_mismatch");
        });
        const plan = prepareJoinEvidence(productSql, fact, title, knowledge.joins); assert.ok(plan);
        await clickHouseInsert(client, fact.table, [original[0]!]);
        const repeatedFact = await clickHouseQueryBounded(reader, plan.executionSql, 100, 200_000);
        assert.equal(verifyJoinEvidence(plan, repeatedFact.rows), null, "重复事实粒度不能放大总量");
        await clickHouseCommand(client, "ALTER TABLE fact_fox_daily_install DELETE WHERE event_date = '2026-10-06' AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'JP' AND channel_id = 'mist_ads' SETTINGS mutations_sync = 2");
        await clickHouseInsert(client, fact.table, [original[0]!]);
        await clickHouseInsert(client, title.table, [{ ...data.titles[0]!, title_name: "同键另一个标签" }]);
        const duplicated = await clickHouseQueryBounded(reader, plan.executionSql, 100, 200_000);
        assert.equal(verifyJoinEvidence(plan, duplicated.rows), null, "维表重复键不能放大事实");
      } finally { await reader.close(); }
    } finally { await client.close(); }
  } finally {
    const label = await docker(["inspect", "--format", '{{index .Config.Labels "dataagent.test.run"}}', name]).catch(() => "");
    if (label.trim() === name) await docker(["rm", "-f", name]);
  }
});
