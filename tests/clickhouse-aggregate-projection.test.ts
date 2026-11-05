import assert from "node:assert/strict";
import test from "node:test";
import { loadKnowledge } from "../src/knowledge.js";
import { clickHouseAggregateProjection } from "../src/clickhouse-aggregate-projection.js";
import { reviewScopedClickHouse } from "../src/clickhouse-direct-review.js";

const contract = loadKnowledge("knowledge/harborlight").contract_by_table.get("fact_fox_daily_install")!.contract!;
const rule = { table: contract.table, allowed_columns: contract.columns.map((column) => column.name).filter((name) => !contract.sensitive_columns.includes(name)), sensitive_columns: contract.sensitive_columns, must_filter: contract.must_filter, column_types: Object.fromEntries(contract.columns.map((column) => [column.name, column.type])) };
const base = "SELECT country_code, SUM(new_users) AS total FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-08' AND title_id = 'paper_lantern' AND platform = 'ios' AND channel_id = 'mist_ads' AND country_code IN ('US', 'JP') GROUP BY country_code";
const sql = `WITH a AS (${base}), b AS (SELECT country_code, total FROM a) SELECT country_code, total FROM b`;

test("分组 SUM 的多层等价投影可生成独立授权的物理证明", () => {
  for (const input of [sql, `SELECT x.country_code, x.total FROM (${base}) x`]) {
    const proof = clickHouseAggregateProjection(input, contract); assert.ok(proof, input);
    assert.match(proof, /SUM\(new_users\) AS total/u);
    assert.deepEqual(reviewScopedClickHouse(input, contract, rule, "harborlight", 100)?.guarded.time_range, { start: "2026-10-06", end: "2026-10-08" });
  }
  for (const input of [
    sql.replace("SELECT country_code, total FROM b", "SELECT total FROM b"),
    sql.replace("SELECT country_code, total FROM b", "SELECT country_code, total FROM b WHERE total > 0"),
    sql.replace("SUM(new_users)", "SUM(device_token)"),
    sql.replace("SUM(new_users)", "sumIf(new_users, new_users > 0)"),
    sql.replace("SELECT country_code, total FROM b", "SELECT country_code, total FROM b LIMIT 1"),
    sql.replace("SELECT country_code, total FROM a", "SELECT country_code, total, total AS another FROM a"),
    sql.replace("SELECT country_code, total FROM a", "SELECT country_code AS total, total AS amount FROM a").replace("SELECT country_code, total FROM b", "SELECT total, amount FROM b"),
    sql.replace("SELECT country_code, total FROM b", "SELECT country_code AS total, total AS amount FROM b"),
  ]) assert.equal(reviewScopedClickHouse(input, contract, rule, "harborlight", 100), null, input);
  const aliasInFilter = base.replace("SELECT country_code,", "SELECT country_code AS region,").replace("WHERE event_date", "WHERE region = 'US' AND event_date");
  assert.equal(clickHouseAggregateProjection(`SELECT region, total FROM (${aliasInFilter}) x`, contract), null, "内部筛选依赖投影别名时不能移动或重命名该别名");
});
