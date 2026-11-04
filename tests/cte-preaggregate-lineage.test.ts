import { isolatedDocker, loopbackPort, runOwnedContainer } from "./isolated-docker.js";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { loadKnowledge } from "../src/knowledge.js";
import { assertJoinKeys, guardSql, parseReadonlySql, rewritePreaggregatedDimensionJoin, SqlRejected } from "../src/sql.js";
import { prepareJoinEvidence } from "../src/join-evidence.js";

const knowledge = loadKnowledge("knowledge/harborlight");
const fact = knowledge.contract_by_table.get("fact_fox_daily_install")!.contract!;
const dim = knowledge.contract_by_table.get("dim_fox_title")!.contract!;
const rules = [fact, dim].map((contract) => ({ table: contract.table, allowed_columns: contract.columns.map((c) => c.name).filter((c) => !contract.sensitive_columns.includes(c)), sensitive_columns: contract.sensitive_columns, must_filter: contract.must_filter }));
const grains = new Map([[fact.table, fact.grain!], [dim.table, dim.grain!]]);
const inner = "SELECT f.event_date, f.title_id, f.platform, f.country_code, f.channel_id, SUM(f.new_users) AS subtotal FROM fact_fox_daily_install f WHERE f.event_date >= '2026-10-06' AND f.event_date <= '2026-10-12' AND f.platform = 'ios' AND f.country_code = 'JP' AND f.channel_id = 'mist_ads' GROUP BY f.event_date, f.title_id, f.platform, f.country_code, f.channel_id";
const outer = "SELECT p.title_id, d.title_name AS label, SUM(p.subtotal) AS total FROM SOURCE LEFT JOIN dim_fox_title d ON p.title_id = d.title_id GROUP BY p.title_id, d.title_name ORDER BY p.title_id";
const cte = `WITH p AS (${inner}) ${outer.replace("SOURCE", "p")}`;
const derived = outer.replace("SOURCE", `(${inner}) p`);
const joinOptions = { leftJoinDimensions: new Set([dim.table]) };

test("完整粒度 CTE 和派生表的预聚合可证明等价，JOIN 保留未匹配值", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE fact_fox_daily_install(event_date TEXT,title_id TEXT,platform TEXT,country_code TEXT,channel_id TEXT,new_users INTEGER); CREATE TABLE dim_fox_title(title_id TEXT,title_name TEXT); INSERT INTO dim_fox_title VALUES ('known','合成产品'); INSERT INTO fact_fox_daily_install VALUES ('2026-10-06','known','ios','JP','mist_ads',10),('2026-10-07','known','ios','JP','mist_ads',10),('2026-10-06','unknown','ios','JP','mist_ads',3)");
    for (const sql of [cte, derived]) {
      const rewrite = rewritePreaggregatedDimensionJoin(parseReadonlySql(sql).ast); assert.ok(rewrite);
      assert.deepEqual(guardSql(sql, rules).tables.sort(), [fact.table, dim.table].sort());
      assert.doesNotThrow(() => assertJoinKeys(sql, knowledge.joins, grains, joinOptions));
      const plan = prepareJoinEvidence(sql, fact, dim, knowledge.joins); assert.ok(plan);
      assert.equal(plan.originalSql, sql); assert.match(plan.executionSql, /groupArray/);
      const rows = (query: string) => db.prepare(query).all().map((row) => ({ ...row }));
      assert.deepEqual(rows(sql), rows(rewrite.sql));
      assert.deepEqual(rows(sql).map((r) => [r.label, r.total]), [["合成产品", 20], [null, 3]]);
    }
  } finally { db.close(); }
});

test("预聚合可以使用受约束的粗粒度，但不能隐藏敏感字段或使用非契约粒度", () => {
  const incomplete = cte.replace(", f.platform, f.country_code, f.channel_id, SUM", ", f.platform, f.country_code, SUM").replace(", f.platform, f.country_code, f.channel_id) SELECT", ", f.platform, f.country_code) SELECT");
  assert.doesNotThrow(() => assertJoinKeys(incomplete, knowledge.joins, grains, joinOptions));
  assert.ok(prepareJoinEvidence(incomplete, fact, dim, knowledge.joins));
  const invalidGrain = cte.replace("f.channel_id, SUM", "f.channel_id, f.new_users, SUM").replace("f.country_code, f.channel_id) SELECT", "f.country_code, f.channel_id, f.new_users) SELECT");
  assert.throws(() => assertJoinKeys(invalidGrain, knowledge.joins, grains, joinOptions), (e: unknown) => e instanceof SqlRejected && e.code === "join_grain_mismatch");
  assert.equal(prepareJoinEvidence(invalidGrain, fact, dim, knowledge.joins), null);
  const sensitive = cte.replace("f.channel_id, SUM", "f.channel_id, f.device_token, SUM").replace("f.country_code, f.channel_id) SELECT", "f.country_code, f.channel_id, f.device_token) SELECT");
  assert.throws(() => guardSql(sensitive, rules), (e: unknown) => e instanceof SqlRejected && e.code === "sensitive_field");
  assert.throws(() => guardSql(cte.replace("SUM(f.new_users) AS subtotal", "SUM(f.device_token) AS subtotal"), rules), (e: unknown) => e instanceof SqlRejected && e.code === "sensitive_field");
  assert.throws(() => guardSql(cte.replace("AND f.channel_id = 'mist_ads'", "AND f.channel_id = 'mist_ads' AND f.device_token = 'fictional'"), rules), (e: unknown) => e instanceof SqlRejected && e.code === "sensitive_field");
  assert.throws(() => guardSql(cte.replace("p.title_id, d.title_name", "p.device_token, d.title_name"), rules), SqlRejected);
  assert.throws(() => guardSql(cte.replace("ORDER BY p.title_id", "ORDER BY p.device_token"), rules), SqlRejected);
  assert.throws(() => guardSql(cte.replace("p.title_id = d.title_id", "p.device_token = d.title_id"), rules), SqlRejected);
  assert.throws(() => assertJoinKeys(cte.replace("p.title_id = d.title_id", "p.platform = d.title_id"), knowledge.joins, grains, joinOptions), SqlRejected);
  assert.equal(prepareJoinEvidence(cte.replace("SUM(p.subtotal)", "COUNT(p.subtotal)"), fact, dim, knowledge.joins), null);
  assert.equal(prepareJoinEvidence(cte.replace("GROUP BY p.title_id", "WHERE d.title_name = '合成产品' GROUP BY p.title_id"), fact, dim, knowledge.joins), null);
});

test("隔离 ClickHouse 实际执行 CTE 与证明查询的可见结果一致", async () => {
  const { randomBytes, randomUUID } = await import("node:crypto");
  const { createClickHouseClient, clickHouseCommand, clickHouseInsert, clickHouseQueryBounded } = await import("../src/clickhouse-client.js");
  const { createTableSql, smallWarehouse, WAREHOUSE_TABLES } = await import("../src/warehouse.js");
  const { verifyJoinEvidence, verifyJoinExecutionSchema } = await import("../src/join-evidence.js");
  const name = `dataagent-cte-${randomUUID()}`; const password = randomBytes(20).toString("hex");
  const ownedContainers: string[] = [];
  try {
    await runOwnedContainer(["run", "--pull=never", "-d", "--name", name, "--label", `dataagent.test.run=${name}`, "--tmpfs", "/var/lib/clickhouse:rw,size=512m", "--ulimit", "nofile=262144:262144", "-p", "127.0.0.1::8123", "-e", `CLICKHOUSE_PASSWORD=${password}`, "-e", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1", "clickhouse/clickhouse-server:24.8.14.39"], name, name, ownedContainers);
    const port = await loopbackPort(name, 8123); assert.ok(port > 0);
    const url = `http://127.0.0.1:${port}`; const deadline = Date.now() + 45_000;
    while (true) {
      try { if ((await fetch(`${url}/ping`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* starting */ }
      if (Date.now() > deadline) throw new Error("isolated_clickhouse_start_timeout");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const client = createClickHouseClient({ url, username: "default", password, database: "default", maxRowsToRead: 1_000_000, timeoutSeconds: 10 }, false);
    try {
      for (const tableName of [fact.table, dim.table]) {
        const table = WAREHOUSE_TABLES.find((item) => item.table === tableName); assert.ok(table);
        await clickHouseCommand(client, createTableSql(table));
      }
      const data = smallWarehouse(); await clickHouseInsert(client, fact.table, data.installs); await clickHouseInsert(client, dim.table, data.titles);
      const cases = [cte, derived, cte.replace("f.platform = 'ios'", "f.platform = 'android'").replace("f.country_code = 'JP'", "f.country_code = 'ZZ'")];
      for (const sql of cases) {
        const plan = prepareJoinEvidence(sql, fact, dim, knowledge.joins); assert.ok(plan);
        const original = await clickHouseQueryBounded(client, sql, 100, 200_000);
        const proof = await clickHouseQueryBounded(client, plan.executionSql, 100, 200_000);
        assert.equal(proof.truncated, false);
        assert.deepEqual(proof.rows.map(({ __da_join_proof: _proof, ...row }) => row), original.rows);
        assert.equal(verifyJoinExecutionSchema(plan, fact, dim, proof.column_types), true);
        const values = verifyJoinEvidence(plan, proof.rows); assert.ok(values, JSON.stringify(proof.rows));
        assert.deepEqual(values.map((v) => v.value).sort(), sql.includes("'ZZ'") ? ["21", "70"] : ["70"]);
        if (sql.includes("'ZZ'")) assert.equal(values.find((v) => v.value === "21")?.unmatched_rows, 7);
      }
    } finally { await client.close(); }
  } finally { for (const owned of ownedContainers) await isolatedDocker(["rm", "-f", owned]).catch(() => undefined); }
});
