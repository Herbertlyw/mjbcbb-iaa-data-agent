import assert from "node:assert/strict";
import test from "node:test";
import { verifyConditionalAggregates } from "../src/conditional-aggregate-evidence.js";
import { loadKnowledge } from "../src/knowledge.js";
import type { QueryResource } from "../src/types.js";

const contract = loadKnowledge("knowledge/harborlight").contract_by_table.get("fact_fox_daily_install")!.contract!;
const sql = "SELECT country_code, countIf(isNull(new_users)) AS missing, countIf(new_users = 0) AS zeros, countIf(new_users IS NOT NULL) AS known FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-08' AND title_id = 'paper_lantern' AND platform = 'ios' AND channel_id = 'mist_ads' AND country_code IN ('US','JP') GROUP BY country_code";

function sample(): QueryResource {
  return {
    resource_id: "res_synthetic", session_id: "ses_synthetic", job_id: "job_synthetic", execution_id: "ck_synthetic", engine: "clickhouse-local", tables: [contract.table], sql,
    truncated: false, sql_limited: false, complete_population: true, total_rows_exact: true, total_rows: 2, returned_rows: 2, scan_limit: 5000,
    time_range: { start: "2026-10-06", end: "2026-10-08", timezone: contract.timezone },
    column_types: { country_code: "LowCardinality(String)", missing: "UInt64", zeros: "UInt64", known: "UInt64" },
    columns: ["country_code", "missing", "zeros", "known"],
    coverage: { status: "known", absent_dates: [], null_dates: ["2026-10-07"], zero_dates: ["2026-10-08"], predicted_dates: [], unknown_prediction_dates: [], groups: [] },
    rows: [{ country_code: "JP", missing: "0", zeros: "0", known: "3" }, { country_code: "US", missing: "1", zeros: "1", known: "2" }],
  } as unknown as QueryResource;
}

test("条件计数以契约字段和行单位验证 NULL、非 NULL、真实零，覆盖不全标记部分", () => {
  const values = verifyConditionalAggregates(sample(), contract); assert.ok(values);
  assert.deepEqual(values.map(({ group, operation, value, unit, coverage_incomplete }) => [group.country_code, operation, value, unit, coverage_incomplete]), [
    ["JP", "count_null", "0", "行", true], ["JP", "count_zero", "0", "行", true], ["JP", "count_nonnull", "3", "行", true],
    ["US", "count_null", "1", "行", true], ["US", "count_zero", "1", "行", true], ["US", "count_nonnull", "2", "行", true],
  ]);
});

test("条件计数拒绝未知覆盖、SQL 越权、复杂谓词、伪造分组及不完整结果", () => {
  for (const mutate of [
    (s: QueryResource) => { s.truncated = true; },
    (s: QueryResource) => { s.sql_limited = true; },
    (s: QueryResource) => { s.total_rows_exact = false; },
    (s: QueryResource) => { s.execution_id = ""; },
    (s: QueryResource) => { s.job_id = ""; },
    (s: QueryResource) => { s.time_range.timezone = "UTC"; },
    (s: QueryResource) => { s.coverage.status = "unknown"; },
    (s: QueryResource) => { s.coverage.groups_has_more = true; },
    (s: QueryResource) => { s.coverage.groups_total = 1; },
    (s: QueryResource) => { s.coverage.groups = null as never; },
    (s: QueryResource) => { s.rows[0] = null as never; },
    (s: QueryResource) => { s.coverage.unknown_prediction_dates.push("2026-10-06"); },
    (s: QueryResource) => { s.column_types!.missing = "Int64"; },
    (s: QueryResource) => { s.rows[0]!.missing = "-1"; },
    (s: QueryResource) => { s.rows[0]!.missing = "5001"; },
    (s: QueryResource) => { s.rows[0]!.country_code = "DE"; },
    (s: QueryResource) => { s.rows[1] = { ...s.rows[0]! }; },
    (s: QueryResource) => { s.rows[0]!.unexpected = 1; },
    (s: QueryResource) => { s.sql = s.sql.replace("isNull(new_users)", "isNull(device_token)"); },
    (s: QueryResource) => { s.sql = s.sql.replace("new_users = 0", "new_users > 0"); },
    (s: QueryResource) => { s.sql = s.sql.replace("new_users = 0", "(new_users = 0 OR new_users IS NULL)"); },
  ]) { const source = sample(); mutate(source); assert.equal(verifyConditionalAggregates(source, contract), null); }
  const absent = sample(); absent.rows.pop(); absent.returned_rows = 1; absent.total_rows = 1; absent.coverage.null_dates = [];
  assert.equal(verifyConditionalAggregates(absent, contract), null, "不能把缺失的 IN 成员声明为完整");
  const predicted = structuredClone(contract); predicted.series!.predicted_column = "is_predicted";
  assert.equal(verifyConditionalAggregates(sample(), predicted), null);
});
