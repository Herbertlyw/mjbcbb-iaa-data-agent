import { isolatedDocker, loopbackPort, runOwnedContainer } from "./isolated-docker.js";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { loadKnowledge } from "../src/knowledge.js";
import { prepareJoinEvidence, prepareJoinAggregateEvidence, verifyJoinEvidence, verifyJoinExecutionSchema, joinDimensionObservations } from "../src/join-evidence.js";
import { createClickHouseClient, clickHouseCommand, clickHouseQueryBounded } from "../src/clickhouse-client.js";
import { createTableSql, WAREHOUSE_TABLES } from "../src/warehouse.js";

const kb = loadKnowledge("knowledge/harborlight");
const fact = kb.contract_by_table.get("fact_fox_daily_install")!.contract!;
const dimension = kb.contract_by_table.get("dim_fox_title")!.contract!;
const sql = `WITH p AS (SELECT f.title_id AS product_id, SUM(f.new_users) AS subtotal FROM fact_fox_daily_install f WHERE f.event_date >= '2026-10-06' AND f.event_date <= '2026-10-09' AND f.platform = 'ios' AND f.channel_id = 'mist_ads' GROUP BY f.title_id) SELECT p.product_id AS product, d.title_name AS label, SUM(p.subtotal) AS total FROM p INNER JOIN dim_fox_title d ON p.product_id = d.title_id GROUP BY p.product_id, d.title_name ORDER BY p.product_id`;

test("隔离 ClickHouse：十万事实行的全量聚合级关联检查及反例", { timeout: 120_000 }, async () => {
  const name = `dataagent-large-${randomUUID()}`; const password = randomBytes(20).toString("hex"); const ownedContainers: string[] = [];
  try {
    await runOwnedContainer(["run", "--pull=never", "-d", "--name", name, "--label", `dataagent.test.run=${name}`, "--tmpfs", "/var/lib/clickhouse:rw,size=768m", "--ulimit", "nofile=262144:262144", "-p", "127.0.0.1::8123", "-e", `CLICKHOUSE_PASSWORD=${password}`, "-e", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1", "clickhouse/clickhouse-server:24.8.14.39"], name, name, ownedContainers);
    const port = await loopbackPort(name, 8123); assert.ok(port > 0);
    const url = `http://127.0.0.1:${port}`; const deadline = Date.now() + 45_000;
    while (true) { try { if ((await fetch(`${url}/ping`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {} if (Date.now() > deadline) throw new Error("isolated_clickhouse_start_timeout"); await new Promise((resolve) => setTimeout(resolve, 250)); }
    const ch = createClickHouseClient({ url, username: "default", password, database: "default", maxRowsToRead: 1_000_000, timeoutSeconds: 30 }, false);
    try {
      for (const table of [fact.table, dimension.table]) { const spec = WAREHOUSE_TABLES.find((entry) => entry.table === table); assert.ok(spec); await clickHouseCommand(ch, createTableSql(spec)); }
      await clickHouseCommand(ch, `INSERT INTO dim_fox_title VALUES ('paper_lantern', '纸灯', 'fiction', '2026-01-01')`);
      // Four days for 25,000 distinct fictitious regions, each value 1..25,000.
      // Independent arithmetic: 4 × 25,000 × 25,001 / 2 = 1,250,050,000.
      await clickHouseCommand(ch, `INSERT INTO fact_fox_daily_install SELECT toDate('2026-10-06') + toUInt16(number % 4), 'paper_lantern', 'ios', concat('S', toString(intDiv(number, 4))), 'mist_ads', toInt32(intDiv(number, 4) + 1), NULL FROM numbers(100000)`);
      const plan = prepareJoinAggregateEvidence(sql, fact, dimension, kb.joins); assert.ok(plan);
      const normal = await clickHouseQueryBounded(ch, sql, 100, 2_000_000);
      const result = await clickHouseQueryBounded(ch, plan.executionSql, 100, 2_000_000);
      assert.equal(result.truncated, false); assert.ok(Buffer.byteLength(JSON.stringify(result.rows)) < 20_000);
      assert.equal(verifyJoinExecutionSchema(plan, fact, dimension, result.column_types), true, JSON.stringify(result.column_types));
      assert.deepEqual(result.rows.map(({ __da_join_proof: _proof, ...row }) => row), normal.rows);
      assert.equal(String(normal.rows[0]?.total), "1250050000");
      assert.equal(verifyJoinEvidence(plan, result.rows)?.[0]?.value, "1250050000");
      assert.equal(joinDimensionObservations(plan, result.rows)?.find((item) => item.column === "title_name")?.value, "纸灯");
      const restricted = createClickHouseClient({ url, username: "default", password, database: "default", maxRowsToRead: 1000, timeoutSeconds: 30 }, false);
      try { await assert.rejects(() => clickHouseQueryBounded(restricted, plan.executionSql, 100, 2_000_000)); } finally { await restricted.close(); }
      const oldPlan = prepareJoinEvidence(sql, fact, dimension, kb.joins); assert.ok(oldPlan);
      const old = await clickHouseQueryBounded(ch, oldPlan.executionSql, 100, 2_000_000);
      assert.equal(old.truncated || verifyJoinEvidence(oldPlan, old.rows) === null, true);
      await clickHouseCommand(ch, `INSERT INTO dim_fox_title VALUES ('paper_lantern', '重复标签', 'fiction', '2026-01-01')`);
      const duplicated = await clickHouseQueryBounded(ch, plan.executionSql, 100, 2_000_000);
      assert.equal(verifyJoinEvidence(plan, duplicated.rows), null, "重复维表键必须拒绝");
      await clickHouseCommand(ch, `TRUNCATE TABLE dim_fox_title`);
      await clickHouseCommand(ch, `INSERT INTO dim_fox_title VALUES ('paper_lantern', '纸灯', 'fiction', '2026-01-01')`);
      await clickHouseCommand(ch, `INSERT INTO fact_fox_daily_install VALUES ('2026-10-06', 'paper_lantern', 'ios', 'S0', 'mist_ads', 1, NULL)`);
      const duplicateFact = await clickHouseQueryBounded(ch, plan.executionSql, 100, 2_000_000);
      assert.equal(verifyJoinEvidence(plan, duplicateFact.rows), null, "事实粒度重复必须拒绝");
      await clickHouseCommand(ch, `TRUNCATE TABLE fact_fox_daily_install`);
      await clickHouseCommand(ch, `INSERT INTO fact_fox_daily_install VALUES ('2026-10-06', 'paper_lantern', 'ios', 'ZZ', 'mist_ads', NULL, NULL)`);
      const nullMetric = await clickHouseQueryBounded(ch, plan.executionSql, 100, 2_000_000);
      assert.equal(verifyJoinEvidence(plan, nullMetric.rows), null, "NULL 不能因 SUM 返回零而成为已验证值");
      await clickHouseCommand(ch, `TRUNCATE TABLE fact_fox_daily_install`);
      await clickHouseCommand(ch, `INSERT INTO fact_fox_daily_install VALUES ('2026-10-06', 'paper_lantern', 'ios', 'ZZ', 'mist_ads', 0, NULL)`);
      const zero = await clickHouseQueryBounded(ch, plan.executionSql, 100, 2_000_000);
      assert.equal(verifyJoinEvidence(plan, zero.rows)?.[0]?.value, "0", "真实零是有效观测，但不能推断缺日期已完整覆盖");
    } finally { await ch.close(); }
  } finally { for (const owned of ownedContainers) await isolatedDocker(["rm", "-f", owned]).catch(() => undefined); }
});
