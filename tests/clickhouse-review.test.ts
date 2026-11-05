import test from "node:test";
import assert from "node:assert/strict";
import { reviewSql, type SqlReviewPolicy } from "../src/clickhouse-review.js";
import { clickHouseReviewPolicy, safeNativeConditionalAggregates, safeNativeDateFunctions } from "../src/clickhouse-review-policy.js";
import { reviewDirectClickHouse, reviewScopedClickHouse } from "../src/clickhouse-direct-review.js";
import { loadKnowledge } from "../src/knowledge.js";
import { clickHouseScopedProjection } from "../src/clickhouse-scoped-projection.js";

const policy: SqlReviewPolicy = {
  defaultDatabase: "synthetic", allowDetail: true, maxRows: 1000,
  tables: [{ fqn: "synthetic.daily_sales", partitionColumn: "day", maxScanDays: 31, requiredFilters: [], columns: [
    { name: "day" }, { name: "country" }, { name: "amount" }, { name: "secret", privacy: "forbidden" },
  ] }],
  allowedFunctions: ["sum", "count", "countIf", "ifNull", "toDate"], aggregateFunctions: ["sum", "count", "countIf"],
};

test("原项目 CK reviewer 适配宿主默认数据库与受限日期范围", () => {
  const where = "day >= '2026-10-01' AND day <= '2026-10-03'";
  const direct = reviewSql(`SELECT country, SUM(amount) AS total FROM daily_sales WHERE ${where} GROUP BY country`, policy);
  assert.equal(direct.ok, true, JSON.stringify(direct));
  const detail = reviewSql(`SELECT day, amount FROM daily_sales WHERE ${where}`, policy);
  assert.equal(detail.ok, true, JSON.stringify(detail));
  for (const sql of [
    "SELECT secret FROM daily_sales WHERE day = '2026-10-01'",
    "SELECT amount FROM daily_sales",
    "SELECT amount FROM otherdb.daily_sales WHERE day = '2026-10-01'",
    "SELECT amount FROM daily_sales WHERE day = '2026-10-01' ORDER BY secret",
    "SELECT amount FROM daily_sales WHERE day = '2026-10-01' AND secret = 'x'",
    "WITH c AS (SELECT secret AS amount FROM daily_sales WHERE day = '2026-10-01') SELECT amount FROM c",
    "SELECT sleep(1) FROM daily_sales WHERE day = '2026-10-01'",
    "SELECT amount FROM daily_sales WHERE day = '2026-10-01'; DROP TABLE daily_sales",
  ]) assert.equal(reviewSql(sql, policy).ok, false, sql);
});

test("原生直接授权只接受契约、封闭日期和受限覆盖筛选的共同证明", () => {
  const contract = loadKnowledge("knowledge/harborlight").contract_by_table.get("fact_fox_daily_install")!.contract!;
  const rule = { table: contract.table, allowed_columns: contract.columns.map((column) => column.name).filter((name) => !contract.sensitive_columns.includes(name)), sensitive_columns: contract.sensitive_columns, must_filter: contract.must_filter, column_types: Object.fromEntries(contract.columns.map((column) => [column.name, column.type])) };
  const query = "SELECT SUM(new_users) AS total FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-08' AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'US' AND channel_id = 'mist_ads'";
  const review = (sql: string) => reviewDirectClickHouse(sql, contract, rule, "synthetic", 1000);
  assert.deepEqual(review(query)?.time_range, { start: "2026-10-06", end: "2026-10-08" });
  const inner = query.replace("SUM(new_users) AS total", "event_date, title_id, platform, country_code, channel_id, new_users");
  const scoped = `WITH a AS (SELECT event_date, title_id, platform, country_code, channel_id, new_users FROM (${inner})) SELECT event_date, new_users FROM a`;
  assert.ok(reviewScopedClickHouse(scoped, contract, rule, "synthetic", 1000));
  assert.equal(reviewScopedClickHouse(scoped.replace("event_date, new_users FROM a", "event_date, device_token FROM a"), contract, rule, "synthetic", 1000), null);
  assert.equal(reviewScopedClickHouse(scoped + " LIMIT 1", contract, rule, "synthetic", 1000), null);
  for (const invalid of [
    query.replace("SUM(new_users)", "SUM(device_token)"),
    query.replace("SUM(new_users)", "SUM(new_users) + sleep(1)"),
    query.replace("SUM(new_users)", "countIf(new_users > device_token)"),
    query.replace("SUM(new_users)", "toYear(country_code)"),
    query.replace("SUM(new_users)", "sumIf(new_users, country_code = 'US')"),
    query.replace("fact_fox_daily_install WHERE", "fact_fox_daily_install SAMPLE 0.1 WHERE"),
    query.replace("fact_fox_daily_install WHERE", "fact_fox_daily_install FINAL WHERE"),
    query.replace("country_code = 'US'", "(country_code = 'US' OR device_token = 'x')"),
    query.replace("event_date <= '2026-10-08'", "event_date <= '2029-10-08'"),
    `${query} LIMIT 1`,
    query.replace("SUM(new_users) AS total", "country_code, SUM(new_users) AS total") + " GROUP BY country_code WITH TOTALS",
    query.replace("SUM(new_users) AS total", "country_code, SUM(new_users) AS total") + " GROUP BY country_code ORDER BY country_code WITH FILL",
  ]) assert.equal(review(invalid), null, invalid);
});

test("宿主规则转换保留敏感列、分区与默认数据库，模糊配置失败关闭", () => {
  const rule = { table: "daily_sales", allowed_columns: ["day", "country", "amount"], sensitive_columns: ["secret"], must_filter: ["day"], column_types: { day: "Date" } };
  const derived = clickHouseReviewPolicy("synthetic", [rule], 1000);
  assert.equal(reviewSql("SELECT amount FROM daily_sales WHERE day = '2026-10-01'", derived).ok, true);
  assert.equal(reviewSql("SELECT secret FROM daily_sales WHERE day = '2026-10-01'", derived).ok, false);
  assert.throws(() => clickHouseReviewPolicy("synthetic", [{ ...rule, column_types: {} }], 1000), /partition_unsupported/);
  assert.throws(() => clickHouseReviewPolicy("bad.name", [rule], 1000), /policy_invalid/);
  assert.throws(() => clickHouseReviewPolicy("synthetic", [rule, rule], 1000), /policy_invalid/);
  assert.equal(safeNativeConditionalAggregates("SELECT countIf(amount > 0) FROM daily_sales WHERE day = '2026-10-01'"), true);
  assert.equal(safeNativeConditionalAggregates("SELECT countIf(amount IS NULL) FROM daily_sales WHERE day = '2026-10-01'"), true);
  assert.equal(safeNativeConditionalAggregates("SELECT countIf(amount > country) FROM daily_sales WHERE day = '2026-10-01'"), false);
  assert.equal(reviewSql("SELECT sumIf(amount, country = 'US') FROM daily_sales WHERE day = '2026-10-01'", derived).ok, false);
  assert.equal(safeNativeDateFunctions("SELECT toYear(day) FROM daily_sales WHERE day = '2026-10-01'", rule), true);
  assert.equal(safeNativeDateFunctions("SELECT toYear(country) FROM daily_sales WHERE day = '2026-10-01'", rule), false);
  assert.equal(safeNativeDateFunctions("SELECT toDate(country) FROM daily_sales WHERE day = '2026-10-01'", rule), false);
  assert.equal(safeNativeDateFunctions("SELECT isNull(toYear(day)) FROM daily_sales WHERE day = '2026-10-01'", rule), false);
});

test("CTE 来源只暴露已授权投影，每个物理表独立证明日期", () => {
  const second = { fqn: "synthetic.daily_cost", partitionColumn: "day", maxScanDays: 31, columns: [{ name: "day" }, { name: "country" }, { name: "cost" }] };
  const grants = { ...policy, tables: [...policy.tables, second] };
  const cte = "WITH c AS (SELECT day, country, amount FROM daily_sales WHERE day >= '2026-10-01' AND day <= '2026-10-03') SELECT country, SUM(amount) AS total FROM c GROUP BY country";
  assert.equal(reviewSql(cte, grants).ok, true, JSON.stringify(reviewSql(cte, grants)));
  const hidden = cte.replace("SELECT country, SUM(amount)", "SELECT secret, SUM(amount)").replace("GROUP BY country", "GROUP BY secret");
  assert.equal(reviewSql(hidden, grants).ok, false);
  const shadowed = "WITH c AS (SELECT day, amount FROM daily_sales WHERE day = '2026-10-01'), c AS (SELECT day, amount FROM daily_sales WHERE day = '2026-10-02') SELECT SUM(amount) FROM c";
  assert.equal(reviewSql(shadowed, grants).ok, false);
  const bounded = "SELECT a.country, SUM(a.amount), SUM(b.cost) FROM daily_sales a INNER JOIN daily_cost b ON a.country = b.country AND a.day = b.day WHERE a.day >= '2026-10-01' AND a.day <= '2026-10-03' AND b.day >= '2026-10-01' AND b.day <= '2026-10-03' GROUP BY a.country";
  assert.equal(reviewSql(bounded, grants).ok, true, JSON.stringify(reviewSql(bounded, grants)));
  assert.equal(reviewSql(bounded.replace(" AND b.day >= '2026-10-01' AND b.day <= '2026-10-03'", ""), grants).ok, false);
  // Reviewer approval alone does not authorize a JOIN: the caller must still
  // verify a registered relationship, grain and duplicate-key evidence.
});

test("多层恒等投影生成的内部证明保持物理筛选，改名或内层截断拒绝", () => {
  const base = "SELECT day, country, amount FROM daily_sales WHERE day >= '2026-10-01' AND day <= '2026-10-03' AND country = 'US'";
  const query = `WITH c AS (SELECT day, country, amount FROM (${base})) SELECT country, SUM(amount) AS total FROM c GROUP BY country`;
  const proof = clickHouseScopedProjection(query, "daily_sales");
  assert.ok(proof, "应可证明恒等投影");
  assert.equal(reviewSql(query, policy).ok, true, JSON.stringify(reviewSql(query, policy)));
  assert.equal(reviewSql(proof, policy).ok, true, JSON.stringify(reviewSql(proof, policy)));
  assert.equal(clickHouseScopedProjection(query.replace("day, country, amount FROM (", "day, country AS market, amount FROM ("), "daily_sales"), null);
  assert.equal(clickHouseScopedProjection(query.replace("country = 'US'", "country = 'US' LIMIT 1"), "daily_sales"), null);
  assert.equal(clickHouseScopedProjection(query.replace("SELECT country, SUM(amount)", "SELECT secret, SUM(amount)"), "daily_sales"), null);
});
