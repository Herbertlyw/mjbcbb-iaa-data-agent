import { isolatedDocker, loopbackPort, runOwnedContainer } from "./isolated-docker.js";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { assertJoinKeys, guardSql, parseReadonlySql, rewritePreaggregatedDimensionJoin, SqlRejected, type TableRule } from "../src/sql.js";
import { loadKnowledge } from "../src/knowledge.js";
import { prepareJoinEvidence, verifyJoinEvidence, verifyJoinExecutionSchema } from "../src/join-evidence.js";
import { createClickHouseClient, clickHouseCommand, clickHouseInsert, clickHouseQueryBounded } from "../src/clickhouse-client.js";
import { createTableSql, smallWarehouse, WAREHOUSE_TABLES } from "../src/warehouse.js";
import { reviewSql } from "../src/clickhouse-review.js";
import { clickHouseReviewPolicy } from "../src/clickhouse-review-policy.js";

const rules: TableRule[] = [
  { table: "facts", allowed_columns: ["event_date", "id", "channel", "value", "cost"], sensitive_columns: ["secret"], must_filter: ["event_date"] },
  { table: "labels", allowed_columns: ["id", "label"], sensitive_columns: [], must_filter: [] },
];
const joins = [{ tables: ["facts", "labels"], keys: ["id"] }];
const grains = new Map([["facts", ["event_date", "id", "channel"]], ["labels", ["id"]]]);
const options = { leftJoinDimensions: new Set(["labels"]) };
const base = "SELECT f.id AS k, SUM(f.value) AS v, SUM(f.cost) AS c FROM facts f WHERE f.event_date >= '2026-10-01' AND f.event_date <= '2026-10-02' GROUP BY f.id";
const wrap1 = "SELECT k AS item, v AS revenue, c AS cost FROM a";
const wrap2 = "SELECT w.item AS product, w.revenue AS r, w.cost AS c2 FROM b w";
const select = "SELECT p.product, d.label, SUM(p.r) AS total, SUM(p.c2) AS total_cost FROM SOURCE LEFT JOIN labels d ON p.product = d.id GROUP BY p.product, d.label ORDER BY p.product";
const cte = `WITH a AS (${base}), b AS (${wrap1}), c AS (${wrap2}) ${select.replace("SOURCE", "c p")}`;
const derived = select.replace("SOURCE", `(SELECT w.item AS product, w.revenue AS r, w.cost AS c2 FROM (SELECT k AS item, v AS revenue, c AS cost FROM (${base}) a) w) p`);

test("多层一对一列投影保留预聚合、连接与结果等价", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE facts(event_date TEXT,id TEXT,channel TEXT,value INTEGER,cost INTEGER,secret TEXT); CREATE TABLE labels(id TEXT,label TEXT); INSERT INTO facts VALUES ('2026-10-01','a','c1',3,1,'x'),('2026-10-02','a','c2',5,2,'x'),('2026-10-01','b','c1',7,4,'x'); INSERT INTO labels VALUES ('a','A')");
    const query = (sql: string) => db.prepare(sql).all().map((row) => ({ ...row }));
    for (const sql of [cte, derived, cte.replace("LEFT JOIN", "INNER JOIN")]) {
      const guarded = guardSql(sql, rules); assert.deepEqual(guarded.tables.sort(), ["facts", "labels"]);
      assert.doesNotThrow(() => assertJoinKeys(sql, joins, grains, options));
      const proof = rewritePreaggregatedDimensionJoin(parseReadonlySql(sql).ast); assert.ok(proof);
      assert.deepEqual(query(sql), query(proof.sql));
      assert.deepEqual(query(sql)[0], { product: "a", label: "A", total: 8, total_cost: 3 });
      if (sql.includes("LEFT JOIN")) assert.deepEqual(query(sql)[1], { product: "b", label: null, total: 7, total_cost: 4 });
    }
  } finally { db.close(); }
});

test("多层作用域拒绝遗漏列、附加过滤、越权、无界扫描和错误 JOIN", () => {
  const bad = [
    cte.replace("v AS revenue, c AS cost", "v AS revenue, v AS cost"),
    cte.replace("FROM a)", "FROM a WHERE v = '1')"),
    cte.replace("SUM(f.value) AS v", "SUM(f.secret) AS v"),
    cte.replace("f.event_date >= '2026-10-01' AND f.event_date <= '2026-10-02'", "f.id = 'a'"),
    cte.replace("p.product = d.id", "p.product = d.label"),
    cte.replace("WITH a AS", "WITH spare AS (SELECT secret FROM facts), a AS"),
    derived.replace("v AS revenue, c AS cost", "v AS revenue, v AS cost"),
  ];
  for (const sql of bad) assert.throws(() => { guardSql(sql, rules); assertJoinKeys(sql, joins, grains, options); }, SqlRejected, sql);
});

test("隔离 ClickHouse 多层 CTE/派生表的真实查询和证据 SQL 结果相同", async () => {
  const kb = loadKnowledge("knowledge/harborlight");
  const fact = kb.contract_by_table.get("fact_fox_daily_payment")!.contract!;
  const dim = kb.contract_by_table.get("dim_fox_title")!.contract!;
  const guards = [fact, dim].map((c) => ({ table: c.table, allowed_columns: c.columns.map((x) => x.name).filter((x) => !c.sensitive_columns.includes(x)), sensitive_columns: c.sensitive_columns, must_filter: c.must_filter }));
  const first = "SELECT f.title_id AS id, SUM(f.amount_usd) AS amount, SUM(f.cost_usd) AS cost FROM fact_fox_daily_payment f WHERE f.event_date >= '2026-10-06' AND f.event_date <= '2026-10-08' AND f.title_id = 'paper_lantern' AND f.platform = 'ios' AND f.country_code = 'US' AND f.channel_id = 'mist_ads' GROUP BY f.title_id";
  const q = "SELECT p.product, d.title_name AS label, SUM(p.revenue) AS total, SUM(p.cost2) AS expense FROM SOURCE LEFT JOIN dim_fox_title d ON p.product = d.title_id GROUP BY p.product, d.title_name ORDER BY p.product";
  const queries = [
    `WITH a AS (${first}), b AS (SELECT id AS item, amount AS price, cost AS c FROM a), c AS (SELECT item AS product, price AS revenue, c AS cost2 FROM b) ${q.replace("SOURCE", "c p")}`,
    q.replace("SOURCE", `(SELECT item AS product, price AS revenue, c AS cost2 FROM (SELECT id AS item, amount AS price, cost AS c FROM (${first}) a) b) p`),
  ];
  const name = `dataagent-layered-${randomUUID()}`; const password = randomBytes(20).toString("hex"); const ownedContainers: string[] = [];
  try {
    await runOwnedContainer(["run", "--pull=never", "-d", "--name", name, "--label", `dataagent.test.run=${name}`, "--tmpfs", "/var/lib/clickhouse:rw,size=512m", "--ulimit", "nofile=262144:262144", "-p", "127.0.0.1::8123", "-e", `CLICKHOUSE_PASSWORD=${password}`, "-e", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1", "clickhouse/clickhouse-server:24.8.14.39"], name, name, ownedContainers);
    const port = await loopbackPort(name, 8123); assert.ok(port > 0);
    const url = `http://127.0.0.1:${port}`; const deadline = Date.now() + 45_000;
    while (true) { try { if ((await fetch(`${url}/ping`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {} if (Date.now() > deadline) throw new Error("isolated_clickhouse_start_timeout"); await new Promise((resolve) => setTimeout(resolve, 250)); }
    const ch = createClickHouseClient({ url, username: "default", password, database: "default", maxRowsToRead: 1_000_000, timeoutSeconds: 10 }, false);
    try {
      for (const t of [fact.table, dim.table]) { const spec = WAREHOUSE_TABLES.find((s) => s.table === t); assert.ok(spec); await clickHouseCommand(ch, createTableSql(spec)); }
      const data = smallWarehouse(); await clickHouseInsert(ch, fact.table, data.payments); await clickHouseInsert(ch, dim.table, data.titles);
      for (const sql of queries) {
        assert.doesNotThrow(() => guardSql(sql, guards));
        assert.doesNotThrow(() => assertJoinKeys(sql, kb.joins, new Map([[fact.table, fact.grain!], [dim.table, dim.grain!]]), { leftJoinDimensions: new Set([dim.table]) }));
        const plan = prepareJoinEvidence(sql, fact, dim, kb.joins); assert.ok(plan);
        const nativePlan = prepareJoinEvidence(sql, fact, dim, kb.joins, true); assert.ok(nativePlan, "多层 CTE/派生表应由 ClickHouse AST 生成证明");
        const nativeRules = [fact, dim].map((contract) => ({ table: contract.table, allowed_columns: contract.columns.map((column) => column.name).filter((name) => !contract.sensitive_columns.includes(name)), sensitive_columns: contract.sensitive_columns, must_filter: contract.must_filter, column_types: Object.fromEntries(contract.columns.map((column) => [column.name, column.type])) }));
        const policy = clickHouseReviewPolicy("default", nativeRules, 100);
        assert.equal(reviewSql(sql, policy).ok, true, JSON.stringify(reviewSql(sql, policy)));
        assert.ok(nativePlan.authorizationSql);
        assert.equal(reviewSql(nativePlan.authorizationSql, policy).ok, true, JSON.stringify(reviewSql(nativePlan.authorizationSql, policy)));
        for (const invalid of [
          sql.replace("amount AS price, cost AS c", "amount AS price, amount AS c"),
          sql.replace("p.product = d.title_id", "p.product = d.title_name"),
          sql.replace("f.event_date >= '2026-10-06' AND f.event_date <= '2026-10-08'", "f.title_id = 'paper_lantern'"),
          sql.replace("SUM(f.amount_usd)", "SUM(f.amount_usd AS hidden_alias)"),
        ]) assert.ok(!prepareJoinEvidence(invalid, fact, dim, kb.joins, true) || !reviewSql(invalid, policy).ok, "不安全包装不得同时通过规划与授权");
        const original = await clickHouseQueryBounded(ch, sql, 100, 500_000); const proof = await clickHouseQueryBounded(ch, plan.executionSql, 100, 500_000);
        assert.equal(proof.truncated, false); assert.equal(verifyJoinExecutionSchema(plan, fact, dim, proof.column_types), true);
        assert.deepEqual(proof.rows.map(({ __da_join_proof: _ignored, ...row }) => row), original.rows);
        const nativeProof = await clickHouseQueryBounded(ch, nativePlan.executionSql, 100, 500_000);
        assert.equal(verifyJoinExecutionSchema(nativePlan, fact, dim, nativeProof.column_types), true);
        assert.deepEqual(nativeProof.rows.map(({ __da_join_proof: _ignored, ...row }) => row), original.rows);
        const values = verifyJoinEvidence(plan, proof.rows); assert.ok(values);
        assert.deepEqual(values.map((x) => [x.column, x.value]), [["amount_usd", "90071992547411.00"], ["cost_usd", "2.13"]]);
      }
    } finally { await ch.close(); }
  } finally { for (const owned of ownedContainers) await isolatedDocker(["rm", "-f", owned]).catch(() => undefined); }
});
