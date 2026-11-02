import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { promisify } from "node:util";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { clickHouseColumnTypes, clickHouseCommand, clickHouseInsert, clickHouseQuery, clickHouseQueryBounded, createClickHouseClient } from "../src/clickhouse-client.js";
import { prepareJoinEvidence, verifyJoinEvidence, verifyJoinExecutionSchema, verifyJoinPhysicalSchema } from "../src/join-evidence.js";
import { probeClickHouseAndPublish } from "../src/freshness.js";
import { loadKnowledge } from "../src/knowledge.js";
import { createTableSql, smallWarehouse, WAREHOUSE_TABLES } from "../src/warehouse.js";
import { analyst, bindTables, withRuntime } from "./helpers.js";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const knowledge = loadKnowledge(path.join(root, "knowledge", "harborlight"));
const fact = knowledge.contract_by_table.get("fact_fox_daily_install")!.contract!;
const title = knowledge.contract_by_table.get("dim_fox_title")!.contract!;
const channel = knowledge.contract_by_table.get("dim_fox_channel")!.contract!;
const filters = "f.event_date >= '2026-10-06' AND f.event_date <= '2026-10-12' AND f.title_id = 'paper_lantern' AND f.platform = 'ios' AND f.country_code = 'JP' AND f.channel_id = 'mist_ads'";
const titleSql = `SELECT d.title_name AS label, SUM(f.new_users) AS total FROM fact_fox_daily_install f JOIN dim_fox_title d ON f.title_id = d.title_id WHERE ${filters} GROUP BY d.title_name ORDER BY d.title_name`;
const channelSql = `SELECT d.channel_name AS label, COUNT(f.new_users) AS total FROM fact_fox_daily_install f JOIN dim_fox_channel d ON f.channel_id = d.channel_id WHERE ${filters} GROUP BY d.channel_name`;

test("JOIN 证明规划只接受可核对完整粒度和登记键的 SQL", () => {
  assert.ok(prepareJoinEvidence(titleSql, fact, title, knowledge.joins));
  assert.ok(prepareJoinEvidence(channelSql, fact, channel, knowledge.joins));
  assert.equal(prepareJoinEvidence(titleSql.replace("f.title_id = d.title_id", "f.platform = d.title_id"), fact, title, knowledge.joins), null);
  assert.equal(prepareJoinEvidence(titleSql.replace(" AND f.channel_id = 'mist_ads'", ""), fact, title, knowledge.joins), null);
  assert.equal(prepareJoinEvidence(titleSql.replace("SUM(f.new_users)", "SUM(f.device_token)"), fact, title, knowledge.joins), null);
  assert.equal(prepareJoinEvidence(`${titleSql} LIMIT 1`, fact, title, knowledge.joins), null);
  assert.equal(prepareJoinEvidence(titleSql.replace("f.country_code = 'JP'", "(f.country_code = 'JP' OR f.country_code = 'US')"), fact, title, knowledge.joins), null);
  assert.equal(prepareJoinEvidence(titleSql.replace(" GROUP BY", " AND d.title_name = '纸灯' GROUP BY"), fact, title, knowledge.joins), null);
  assert.equal(prepareJoinEvidence(titleSql.replace("d.title_name AS label, SUM", "d.title_name AS label, d.title_name AS other_label, SUM").replace("GROUP BY d.title_name", "GROUP BY d.title_name, f.country_code"), fact, title, knowledge.joins), null);
  // None of these auto-captured proof fields is projected by the SQL. A
  // sensitive flag still prohibits the read, including dimension JOIN keys.
  assert.equal(prepareJoinEvidence(titleSql, { ...fact, sensitive_columns: [...fact.sensitive_columns, "channel_id"] }, title, knowledge.joins), null);
  assert.equal(prepareJoinEvidence(titleSql, { ...fact, sensitive_columns: [...fact.sensitive_columns, "event_date"] }, title, knowledge.joins), null);
  assert.equal(prepareJoinEvidence(titleSql, fact, { ...title, sensitive_columns: [...title.sensitive_columns, "title_id"] }, knowledge.joins), null);
  assert.equal(prepareJoinEvidence(titleSql, fact, { ...title, columns: title.columns.filter((column) => column.name !== "title_id") }, knowledge.joins), null);
});

test("隔离 ClickHouse 在同次 JOIN 读取中证明产品和渠道分组，并拒绝重复键及篡改", async () => {
  const portServer = createServer();
  await new Promise<void>((resolve) => portServer.listen(0, "127.0.0.1", resolve));
  const address = portServer.address(); assert.ok(address && typeof address === "object"); const port = address.port;
  await new Promise<void>((resolve, reject) => portServer.close((error) => error ? reject(error) : resolve()));
  const name = `dataagent-join-${randomUUID()}`; const password = randomBytes(20).toString("hex");
  const url = `http://127.0.0.1:${port}`;
  let created = false;
  try {
    await exec("docker", ["run", "--pull=never", "-d", "--name", name, "--tmpfs", "/var/lib/clickhouse:rw,size=512m", "--ulimit", "nofile=262144:262144", "-p", `127.0.0.1:${port}:8123`, "-e", `CLICKHOUSE_PASSWORD=${password}`, "-e", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1", "clickhouse/clickhouse-server:24.8.14.39"]);
    created = true;
    const deadline = Date.now() + 45_000;
    while (true) {
      try { const response = await fetch(`${url}/ping`); if (response.ok) break; } catch { /* container still starting */ }
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
      const extra = data.installs.filter((row) => row.country_code === "JP" && row.title_id === "paper_lantern").map((row) => ({ ...row, channel_id: "pebble_net", new_users: 2 }));
      assert.equal(extra.length, 7);
      await clickHouseInsert(client, fact.table, extra);
      const readerPassword = randomBytes(20).toString("hex");
      await clickHouseCommand(client, `CREATE USER synthetic_join_reader IDENTIFIED BY '${readerPassword}'`);
      await clickHouseCommand(client, "GRANT SELECT ON default.* TO synthetic_join_reader");
      const reader = createClickHouseClient({ url, username: "synthetic_join_reader", password: readerPassword, database: "default", maxRowsToRead: 1_000_000, timeoutSeconds: 10 }, true);
      try {
      const titlePlan = prepareJoinEvidence(titleSql, fact, title, knowledge.joins); assert.ok(titlePlan);
      const channelPlan = prepareJoinEvidence(channelSql, fact, channel, knowledge.joins); assert.ok(channelPlan);
      const factTypes = await clickHouseColumnTypes(reader, fact.table);
      const titleTypes = await clickHouseColumnTypes(reader, title.table);
      const channelTypes = await clickHouseColumnTypes(reader, channel.table);
      assert.equal(verifyJoinPhysicalSchema(titlePlan, fact, title, factTypes, titleTypes), true);
      assert.equal(verifyJoinPhysicalSchema(channelPlan, fact, channel, factTypes, channelTypes), true);
      assert.equal(verifyJoinPhysicalSchema(titlePlan, fact, title, { ...factTypes, new_users: "Nullable(Float64)" }, titleTypes), false);
      const titleResult = await clickHouseQueryBounded(reader, titlePlan.executionSql, 100, 200_000);
      const channelResult = await clickHouseQueryBounded(reader, channelPlan.executionSql, 100, 200_000);
      assert.equal(titleResult.truncated, false); assert.equal(channelResult.truncated, false);
      assert.equal(verifyJoinExecutionSchema(titlePlan, fact, title, titleResult.column_types), true);
      assert.equal(verifyJoinExecutionSchema(channelPlan, fact, channel, channelResult.column_types), true);
      assert.equal(verifyJoinExecutionSchema(titlePlan, fact, title, { ...titleResult.column_types, __da_join_proof: titleResult.column_types.__da_join_proof!.replace("Nullable(Int32)", "Nullable(Float64)") }), false);
      const product = verifyJoinEvidence(titlePlan, titleResult.rows);
      const channels = verifyJoinEvidence(channelPlan, channelResult.rows);
      assert.ok(product); assert.ok(channels);
      assert.equal(product[0]?.value, "70");
      assert.deepEqual(product[0]?.group, { "dim_fox_title.title_name": "纸灯" });
      assert.equal(channels[0]?.value, "7");
      assert.deepEqual(channels[0]?.group, { "dim_fox_channel.channel_name": "雾帆" });
      const groupedSql = `SELECT f.channel_id, d.channel_name AS label, SUM(f.new_users) AS total FROM fact_fox_daily_install f JOIN dim_fox_channel d ON f.channel_id = d.channel_id WHERE ${filters.replace(" AND f.channel_id = 'mist_ads'", "")} GROUP BY f.channel_id, d.channel_name ORDER BY f.channel_id`;
      const groupedPlan = prepareJoinEvidence(groupedSql, fact, channel, knowledge.joins); assert.ok(groupedPlan);
      const grouped = await clickHouseQueryBounded(reader, groupedPlan.executionSql, 100, 200_000);
      const groupedEvidence = verifyJoinEvidence(groupedPlan, grouped.rows); assert.ok(groupedEvidence);
      assert.deepEqual(groupedEvidence.map((item) => [item.group["fact_fox_daily_install.channel_id"], item.group["dim_fox_channel.channel_name"], item.value]), [["mist_ads", "雾帆", "70"], ["pebble_net", "卵石", "14"]]);
      await withRuntime({ knowledgeDir: path.join(root, "knowledge", "harborlight"), businessEngine: "clickhouse", clickhouseUrl: url, clickhouseUser: "synthetic_join_reader", clickhousePassword: readerPassword, clickhouseDatabase: "default", publishFreshnessOnStart: false, startWorker: false }, async (runtime) => {
        await probeClickHouseAndPublish({ targetsPath: runtime.config.freshnessTargetsPath, destinationPath: runtime.config.freshnessPath, query: (sql) => clickHouseQuery(reader, sql) as Promise<Array<{ event_date: string }>> });
        const session = analyst(runtime);
        await bindTables(runtime, session.session_id, ["contract.fact_fox_daily_install", "contract.dim_fox_title", "contract.dim_fox_channel"]);
        runtime.sessions.setActiveJob(session.session_id, "job_join_test");
        const queried = await runtime.tools.query(session.session_id, { sql: titleSql });
        assert.equal(queried.ok, true, JSON.stringify(queried)); if (!queried.ok) return;
        assert.deepEqual(queried.rows, [{ label: "纸灯", total: "70" }]);
        const page = await runtime.tools.readSessionResource(session.session_id, { resource_id: String(queried.resource_id) });
        assert.equal(page.ok, true); if (page.ok) assert.equal(Object.hasOwn(page.resource as object, "join_proof"), false);
        const answer = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(queried.resource_id)] });
        assert.equal(answer.ok, true, JSON.stringify(answer));
        if (answer.ok) {
          assert.equal(answer.status, "completed"); assert.match(String(answer.answer), /已核验 JOIN 求和 70；单位 人/); assert.match(String(answer.answer), /dim_fox_title\.title_name=纸灯/);
          const sources = answer.sources as Array<{ execution_id?: string; data_capture_hash?: string }>;
          assert.ok(sources[0]?.execution_id); assert.match(sources[0]?.data_capture_hash ?? "", /^[a-f0-9]{64}$/u);
        }
        const groupedQuery = await runtime.tools.query(session.session_id, { sql: groupedSql });
        assert.equal(groupedQuery.ok, true, JSON.stringify(groupedQuery)); if (!groupedQuery.ok) return;
        const groupedAnswer = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(groupedQuery.resource_id)] });
        assert.equal(groupedAnswer.ok, true, JSON.stringify(groupedAnswer));
        if (groupedAnswer.ok) { assert.equal(groupedAnswer.status, "completed"); assert.match(String(groupedAnswer.answer), /求和 70/); assert.match(String(groupedAnswer.answer), /求和 14/); }
        runtime.sessions.setActiveJob(session.session_id, "job_other");
        const foreign = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(queried.resource_id)] });
        assert.ok(!foreign.ok || foreign.status !== "completed");
        runtime.sessions.setActiveJob(session.session_id, "job_join_test");
        const saved = runtime.sessions.lookupResource(session.session_id, String(queried.resource_id)); assert.ok(saved.ok && saved.resource.kind === "query_result");
        if (saved.ok && saved.resource.kind === "query_result") {
          runtime.state.saveResource({ ...saved.resource, rows: [{ label: "纸灯", total: "999" }] });
          const altered = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(queried.resource_id)] });
          assert.equal(altered.ok, true); if (altered.ok) { assert.notEqual(altered.status, "completed"); assert.doesNotMatch(String(altered.answer), /999/); }
          runtime.state.saveResource(saved.resource);
          await probeClickHouseAndPublish({ targetsPath: runtime.config.freshnessTargetsPath, destinationPath: runtime.config.freshnessPath, query: (sql) => clickHouseQuery(reader, sql) as Promise<Array<{ event_date: string }>> });
          const changed = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(queried.resource_id)] });
          assert.equal(changed.ok, true); if (changed.ok) { assert.notEqual(changed.status, "completed"); assert.doesNotMatch(String(changed.answer), /JOIN 求和 70/); }
        }
      });
      const zeroSql = titleSql.replace("'2026-10-06'", "'2026-10-07'").replace("'2026-10-12'", "'2026-10-07'").replace("'JP'", "'US'");
      const zeroPlan = prepareJoinEvidence(zeroSql, fact, title, knowledge.joins); assert.ok(zeroPlan);
      const zero = await clickHouseQueryBounded(reader, zeroPlan.executionSql, 100, 200_000);
      assert.equal(verifyJoinEvidence(zeroPlan, zero.rows)?.[0]?.value, "0");
      const nullSql = titleSql.replace("'2026-10-06'", "'2026-10-09'").replace("'2026-10-12'", "'2026-10-09'").replace("'JP'", "'US'");
      const nullPlan = prepareJoinEvidence(nullSql, fact, title, knowledge.joins); assert.ok(nullPlan);
      const missing = await clickHouseQueryBounded(reader, nullPlan.executionSql, 100, 200_000);
      assert.equal(verifyJoinEvidence(nullPlan, missing.rows), null);
      const incompleteSql = titleSql.replace("'2026-10-06'", "'2026-10-05'");
      const incompletePlan = prepareJoinEvidence(incompleteSql, fact, title, knowledge.joins); assert.ok(incompletePlan);
      const incomplete = await clickHouseQueryBounded(reader, incompletePlan.executionSql, 100, 200_000);
      assert.equal(verifyJoinEvidence(incompletePlan, incomplete.rows), null);
      const wrongValue = structuredClone(titleResult.rows); wrongValue[0]!.total = "71";
      assert.equal(verifyJoinEvidence(titlePlan, wrongValue), null);
      const wrongLabel = structuredClone(titleResult.rows); wrongLabel[0]!.label = "其他产品";
      assert.equal(verifyJoinEvidence(titlePlan, wrongLabel), null);
      const nullCell = structuredClone(titleResult.rows); (nullCell[0]!.__da_join_proof as unknown[][])[0]![1] = null;
      assert.equal(verifyJoinEvidence(titlePlan, nullCell), null);
      // A duplicated key with a different label creates two apparently
      // complete output groups. Their fact grains must still collide globally.
      await clickHouseInsert(client, title.table, [{ ...data.titles[0]!, title_name: "纸灯重复标签" }]);
      const differentLabel = await clickHouseQueryBounded(reader, titlePlan.executionSql, 100, 200_000);
      assert.equal(differentLabel.rows.length, 2);
      assert.ok(differentLabel.rows.every((row) => (row.__da_join_proof as unknown[][]).length === 7));
      assert.equal(verifyJoinEvidence(titlePlan, differentLabel.rows), null);
      await clickHouseInsert(client, title.table, [data.titles[0]!]);
      const duplicate = await clickHouseQueryBounded(reader, titlePlan.executionSql, 100, 200_000);
      assert.equal(verifyJoinEvidence(titlePlan, duplicate.rows), null);
      await clickHouseInsert(client, channel.table, [data.channels[0]!]);
      const duplicateChannel = await clickHouseQueryBounded(reader, channelPlan.executionSql, 100, 200_000);
      assert.equal(verifyJoinEvidence(channelPlan, duplicateChannel.rows), null);
      const pebbleSql = channelSql.replace("'mist_ads'", "'pebble_net'");
      const pebblePlan = prepareJoinEvidence(pebbleSql, fact, channel, knowledge.joins); assert.ok(pebblePlan);
      const beforeFactDuplicate = await clickHouseQueryBounded(reader, pebblePlan.executionSql, 100, 200_000);
      assert.equal(verifyJoinEvidence(pebblePlan, beforeFactDuplicate.rows)?.[0]?.value, "7");
      await clickHouseInsert(client, fact.table, [extra[0]!]);
      const afterFactDuplicate = await clickHouseQueryBounded(reader, pebblePlan.executionSql, 100, 200_000);
      assert.equal(verifyJoinEvidence(pebblePlan, afterFactDuplicate.rows), null);
      } finally { await reader.close(); }
    } finally { await client.close(); }
  } finally {
    if (created) await exec("docker", ["rm", "-f", name]);
  }
});
