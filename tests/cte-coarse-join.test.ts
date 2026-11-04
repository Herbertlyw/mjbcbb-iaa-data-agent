import { isolatedDocker, loopbackPort, runOwnedContainer } from "./isolated-docker.js";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { loadKnowledge } from "../src/knowledge.js";
import { assertJoinKeys, guardSql, SqlRejected } from "../src/sql.js";
import { prepareJoinEvidence, verifyJoinEvidence, verifyJoinExecutionSchema } from "../src/join-evidence.js";
import { createClickHouseClient, clickHouseCommand, clickHouseInsert, clickHouseQueryBounded } from "../src/clickhouse-client.js";
import { createTableSql, smallWarehouse, WAREHOUSE_TABLES } from "../src/warehouse.js";

const kb = loadKnowledge("knowledge/harborlight");
const payment = kb.contract_by_table.get("fact_fox_daily_payment")!.contract!;
const install = kb.contract_by_table.get("fact_fox_daily_install")!.contract!;
const title = kb.contract_by_table.get("dim_fox_title")!.contract!;
const rules = [payment, install, title].map((c) => ({ table: c.table, allowed_columns: c.columns.map((x) => x.name).filter((x) => !c.sensitive_columns.includes(x)), sensitive_columns: c.sensitive_columns, must_filter: c.must_filter }));
const grains = new Map([[payment.table, payment.grain!], [install.table, install.grain!], [title.table, title.grain!]]);
const options = { leftJoinDimensions: new Set([title.table]) };
const paymentWhere = "f.event_date >= '2026-10-06' AND f.event_date <= '2026-10-08' AND f.title_id = 'paper_lantern' AND f.platform = 'ios' AND f.country_code = 'US' AND f.channel_id = 'mist_ads'";
const outer = "SELECT p.product_id AS product, d.title_name AS label, SUM(p.revenue) AS revenue_total, SUM(p.cost) AS cost_total FROM SOURCE LEFT JOIN dim_fox_title d ON p.product_id = d.title_id GROUP BY p.product_id, d.title_name ORDER BY p.product_id";
const inner = `SELECT f.title_id AS product_id, SUM(f.amount_usd) AS revenue, SUM(f.cost_usd) AS cost FROM fact_fox_daily_payment f WHERE ${paymentWhere} GROUP BY f.title_id`;
const cte = `WITH p AS (${inner}) ${outer.replace("SOURCE", "p")}`;
const derived = outer.replace("SOURCE", `(${inner}) p`);
const dateInner = `SELECT f.event_date AS biz_day, f.title_id AS product_id, SUM(f.amount_usd) AS revenue, SUM(f.cost_usd) AS cost FROM fact_fox_daily_payment f WHERE ${paymentWhere} GROUP BY f.event_date, f.title_id`;
const dated = `WITH p AS (${dateInner}) SELECT p.biz_day AS day, p.product_id AS product, d.title_name AS label, SUM(p.revenue) AS revenue_total, SUM(p.cost) AS cost_total FROM p INNER JOIN dim_fox_title d ON p.product_id = d.title_id GROUP BY p.biz_day, p.product_id, d.title_name ORDER BY p.biz_day`;
const installInner = "SELECT f.title_id AS product_id, SUM(f.new_users) AS subtotal FROM fact_fox_daily_install f WHERE f.event_date >= '2026-10-06' AND f.event_date <= '2026-10-12' AND f.platform = 'android' AND f.country_code = 'ZZ' GROUP BY f.title_id";
const folded = `WITH p AS (${installInner}) SELECT p.product_id AS product, d.title_name AS label, SUM(p.subtotal) AS total FROM p LEFT JOIN dim_fox_title d ON p.product_id = d.title_id GROUP BY p.product_id, d.title_name ORDER BY p.product_id`;

test("粗粒度多指标只沿契约来源、日期与登记键放行", () => {
  for (const [sql, fact] of [[cte, payment], [derived, payment], [dated, payment], [folded, install]] as const) {
    const actualRules = rules.filter((r) => [fact.table, title.table].includes(r.table));
    assert.deepEqual(guardSql(sql, actualRules).tables.sort(), [fact.table, title.table].sort());
    assert.doesNotThrow(() => assertJoinKeys(sql, kb.joins, grains, options));
    const plan = prepareJoinEvidence(sql, fact, title, kb.joins); assert.ok(plan); assert.equal(plan.coarse, true);
  }
  const denied = folded.replace("f.title_id AS product_id", "f.device_token AS product_id").replace("GROUP BY f.title_id", "GROUP BY f.device_token");
  assert.throws(() => guardSql(denied, rules), (e: unknown) => e instanceof SqlRejected && e.code === "sensitive_field");
  const wrong = folded.replace("p.product_id = d.title_id", "p.product_id = d.title_name");
  assert.throws(() => assertJoinKeys(wrong, kb.joins, grains, options), SqlRejected);
  assert.throws(() => guardSql(folded.replace("f.event_date >= '2026-10-06' AND f.event_date <= '2026-10-12' AND ", ""), rules), SqlRejected);
  const unused = cte.replace("SUM(f.cost_usd) AS cost", "SUM(f.cost_usd) AS cost, SUM(f.amount_usd) AS hidden");
  assert.throws(() => guardSql(unused, rules), SqlRejected);
  const unsafeGrain = cte.replace("f.title_id AS product_id, SUM", "f.title_id AS product_id, f.amount_usd, SUM").replace("GROUP BY f.title_id)", "GROUP BY f.title_id, f.amount_usd)");
  assert.throws(() => assertJoinKeys(unsafeGrain, kb.joins, grains, options), SqlRejected);
});

test("隔离 ClickHouse：粗粒度多 Decimal、日期分组、折叠多渠道和左侧缺维证明", async () => {
  const name = `dataagent-coarse-${randomUUID()}`; const password = randomBytes(20).toString("hex"); const ownedContainers: string[] = [];
  try {
    await runOwnedContainer(["run", "--pull=never", "-d", "--name", name, "--label", `dataagent.test.run=${name}`, "--tmpfs", "/var/lib/clickhouse:rw,size=512m", "--ulimit", "nofile=262144:262144", "-p", "127.0.0.1::8123", "-e", `CLICKHOUSE_PASSWORD=${password}`, "-e", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1", "clickhouse/clickhouse-server:24.8.14.39"], name, name, ownedContainers);
    const port = await loopbackPort(name, 8123); assert.ok(port > 0);
    const url = `http://127.0.0.1:${port}`; const deadline = Date.now() + 45_000;
    while (true) { try { if ((await fetch(`${url}/ping`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {} if (Date.now() > deadline) throw new Error("isolated_clickhouse_start_timeout"); await new Promise((resolve) => setTimeout(resolve, 250)); }
    const ch = createClickHouseClient({ url, username: "default", password, database: "default", maxRowsToRead: 1_000_000, timeoutSeconds: 10 }, false);
    try {
      for (const t of [payment.table, install.table, title.table]) { const spec = WAREHOUSE_TABLES.find((s) => s.table === t); assert.ok(spec); await clickHouseCommand(ch, createTableSql(spec)); }
      const data = smallWarehouse(); await clickHouseInsert(ch, payment.table, data.payments); await clickHouseInsert(ch, install.table, data.installs); await clickHouseInsert(ch, title.table, data.titles);
      for (const [sql, fact] of [[cte,payment], [derived,payment], [dated,payment], [folded,install]] as const) {
        const plan = prepareJoinEvidence(sql, fact, title, kb.joins); assert.ok(plan);
        const original = await clickHouseQueryBounded(ch, sql, 100, 500_000); const proof = await clickHouseQueryBounded(ch, plan.executionSql, 100, 500_000);
        assert.equal(proof.truncated, false); assert.equal(verifyJoinExecutionSchema(plan, fact, title, proof.column_types), true, JSON.stringify(proof.column_types));
        assert.deepEqual(proof.rows.map(({ __da_join_proof: _proof, ...row }) => row), original.rows);
        const values = verifyJoinEvidence(plan, proof.rows); assert.ok(values, JSON.stringify(proof.rows));
        if (sql === cte || sql === derived) assert.deepEqual(values.map((v) => [v.column, v.value]), [["amount_usd", "90071992547411.00"], ["cost_usd", "2.13"]]);
        if (sql === folded) { assert.deepEqual(values.map((v) => v.value).sort(), ["21", "91"]); assert.equal(values.find((v) => v.value === "21")?.unmatched_rows, 7); }
        if (sql === dated) {
          assert.equal(values.length, 6);
          assert.deepEqual([...new Set(values.map((v) => v.group[`${payment.table}.event_date`]))], ["2026-10-06", "2026-10-07", "2026-10-08"]);
          assert.equal(verifyJoinEvidence(plan, proof.rows.slice(1)), null, "某一日期的结果缺失不得证明完整周期");
          const tampered = structuredClone(proof.rows); const tuple = (tampered[0]!.__da_join_proof as unknown[][])[0]!; tuple[0] = "2026-10-07";
          assert.equal(verifyJoinEvidence(plan, tampered), null, "分组日期与真实元组日期必须一致");
        }
      }
    } finally { await ch.close(); }
  } finally { for (const owned of ownedContainers) await isolatedDocker(["rm", "-f", owned]).catch(() => undefined); }
});
