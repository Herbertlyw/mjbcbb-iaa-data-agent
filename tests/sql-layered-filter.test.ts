import { isolatedDocker, loopbackPort, runOwnedContainer } from "./isolated-docker.js";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { assertJoinKeys, guardSql, parseReadonlySql, rewritePreaggregatedDimensionJoin, SqlRejected, type TableRule } from "../src/sql.js";
import { loadKnowledge } from "../src/knowledge.js";
import { prepareJoinEvidence, verifyJoinEvidence, verifyJoinExecutionSchema } from "../src/join-evidence.js";
import { createClickHouseClient, clickHouseCommand, clickHouseInsert, clickHouseQueryBounded } from "../src/clickhouse-client.js";
import { createTableSql, smallWarehouse, WAREHOUSE_TABLES } from "../src/warehouse.js";

const kb = loadKnowledge("knowledge/harborlight");
const fact = kb.contract_by_table.get("fact_fox_daily_payment")!.contract!;
const dimension = kb.contract_by_table.get("dim_fox_title")!.contract!;
const rules: TableRule[] = [fact, dimension].map((c) => ({ table: c.table, allowed_columns: c.columns.filter((x) => !c.sensitive_columns.includes(x.name)).map((x) => x.name), sensitive_columns: c.sensitive_columns, must_filter: c.must_filter }));
const grains = new Map([[fact.table, fact.grain!], [dimension.table, dimension.grain!]]);
const options = { leftJoinDimensions: new Set([dimension.table]) };
const first = "SELECT f.title_id AS id, f.channel_id AS ch, SUM(f.amount_usd) AS amount, SUM(f.cost_usd) AS cost FROM fact_fox_daily_payment f WHERE f.event_date >= '2026-10-06' AND f.event_date <= '2026-10-08' AND f.platform = 'ios' AND f.country_code = 'US' GROUP BY f.title_id, f.channel_id";
const a = "SELECT id AS item, ch AS chn, amount AS price, cost AS c FROM a WHERE id = 'paper_lantern'";
const b = "SELECT item AS product, chn AS chan, price AS revenue, c AS cost2 FROM b WHERE chn = 'mist_ads'";
const outer = "SELECT p.product, p.chan, d.title_name AS label, SUM(p.revenue) AS total, SUM(p.cost2) AS expense FROM SOURCE LEFT JOIN dim_fox_title d ON p.product = d.title_id GROUP BY p.product, p.chan, d.title_name ORDER BY p.product";
const cte = `WITH a AS (${first}), b AS (${a}), c AS (${b}) ${outer.replace("SOURCE", "c p")}`;
const derived = outer.replace("SOURCE", `(SELECT item AS product, chn AS chan, price AS revenue, c AS cost2 FROM (SELECT id AS item, ch AS chn, amount AS price, cost AS c FROM (${first}) a WHERE id = 'paper_lantern') b WHERE chn = 'mist_ads') p`);
function checked(sql: string) {
  const guarded = guardSql(sql, rules);
  assert.deepEqual(guarded.tables.sort(), ["dim_fox_title", "fact_fox_daily_payment"]);
  assertJoinKeys(sql, kb.joins, grains, options);
  return rewritePreaggregatedDimensionJoin(parseReadonlySql(sql).ast);
}

test("多层分组键等值过滤随列血缘下推，聚合过滤和作用域绕过仍拒绝", () => {
  for (const sql of [cte, derived]) {
    const result = checked(sql); assert.ok(result);
    assert.match(result.sql, /p\.title_id = 'paper_lantern'/);
    assert.match(result.sql, /p\.channel_id = 'mist_ads'/);
    assert.ok(prepareJoinEvidence(sql, fact, dimension, kb.joins));
  }
  const reject = [
    cte.replace("WHERE id = 'paper_lantern'", "WHERE amount = '1'"),
    cte.replace("WHERE id = 'paper_lantern'", "WHERE id = 'paper_lantern' OR id = 'glass_minnow'"),
    cte.replace("WHERE id = 'paper_lantern'", "WHERE id = 'paper_lantern' AND id = 'glass_minnow'"),
    cte.replace("WHERE chn = 'mist_ads'", "WHERE item = 'glass_minnow'"),
    cte.replace("WHERE id = 'paper_lantern'", "WHERE alien.id = 'paper_lantern'"),
    // A projection alias that shadows a different physical column has
    // ClickHouse-specific name-resolution semantics; do not fold it.
    cte.replace("f.title_id AS id", "f.title_id AS channel_id").replace("SELECT id AS item", "SELECT channel_id AS item").replace("WHERE id = 'paper_lantern'", "WHERE channel_id = 'paper_lantern'"),
    cte.replace("WHERE id = 'paper_lantern'", "WHERE id IN ('paper_lantern', 'glass_minnow')"),
    cte.replace("GROUP BY f.title_id, f.channel_id", "GROUP BY f.title_id, f.channel_id, f.device_token"),
    cte.replace("p.product = d.title_id", "p.product = d.title_name"),
    cte.replace("GROUP BY p.product, p.chan, d.title_name", "WHERE d.title_name = '纸灯' GROUP BY p.product, p.chan, d.title_name"),
  ];
  for (const sql of reject) assert.throws(() => checked(sql), SqlRejected, sql);
});

test("隔离 ClickHouse：多层过滤在事实聚合前后等价，LEFT 未匹配保留 NULL", { timeout: 120_000 }, async () => {
  const name = `dataagent-filter-${randomUUID()}`; const password = randomBytes(20).toString("hex"); const ownedContainers: string[] = [];
  try {
    await runOwnedContainer(["run", "--pull=never", "-d", "--name", name, "--label", `dataagent.test.run=${name}`, "--tmpfs", "/var/lib/clickhouse:rw,size=512m", "--ulimit", "nofile=262144:262144", "-p", "127.0.0.1::8123", "-e", `CLICKHOUSE_PASSWORD=${password}`, "-e", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1", "clickhouse/clickhouse-server:24.8.14.39"], name, name, ownedContainers);
    const port = await loopbackPort(name, 8123); assert.ok(port > 0);
    const url = `http://127.0.0.1:${port}`; const deadline = Date.now() + 45_000;
    while (true) { try { if ((await fetch(`${url}/ping`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {} if (Date.now() > deadline) throw new Error("isolated_clickhouse_start_timeout"); await new Promise((resolve) => setTimeout(resolve, 250)); }
    const ch = createClickHouseClient({ url, username: "default", password, database: "default", maxRowsToRead: 1_000_000, timeoutSeconds: 10 }, false);
    try {
      for (const table of [fact.table, dimension.table]) { const spec = WAREHOUSE_TABLES.find((item) => item.table === table); assert.ok(spec); await clickHouseCommand(ch, createTableSql(spec)); }
      const data = smallWarehouse(); await clickHouseInsert(ch, fact.table, data.payments); await clickHouseInsert(ch, dimension.table, data.titles);
      await clickHouseInsert(ch, fact.table, ["06", "07", "08"].map((date) => ({ event_date: `2026-10-${date}`, title_id: "unknown_title", platform: "ios", country_code: "US", channel_id: "mist_ads", amount_usd: "1.10", cost_usd: "0.20" })));
      for (const sql of [cte, derived, cte.replace("LEFT JOIN", "INNER JOIN"), cte.replace("paper_lantern", "unknown_title")]) {
        assert.ok(checked(sql)); const plan = prepareJoinEvidence(sql, fact, dimension, kb.joins); assert.ok(plan);
        const actual = await clickHouseQueryBounded(ch, sql, 100, 500_000);
        const proof = await clickHouseQueryBounded(ch, plan.executionSql, 100, 500_000);
        assert.equal(proof.truncated, false); assert.equal(verifyJoinExecutionSchema(plan, fact, dimension, proof.column_types), true);
        assert.deepEqual(proof.rows.map(({ __da_join_proof: _proof, ...row }) => row), actual.rows);
        const values = verifyJoinEvidence(plan, proof.rows); assert.ok(values);
        const unmatched = sql.includes("unknown_title");
        assert.deepEqual(values.map((value) => [value.column, value.value]), unmatched ? [["amount_usd", "3.30"], ["cost_usd", "0.60"]] : [["amount_usd", "90071992547411.00"], ["cost_usd", "2.13"]]);
        assert.equal(actual.rows[0]?.label, unmatched ? null : "纸灯");
      }
    } finally { await ch.close(); }
  } finally { for (const owned of ownedContainers) await isolatedDocker(["rm", "-f", owned]).catch(() => undefined); }
});
