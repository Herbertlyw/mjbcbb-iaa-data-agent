import assert from "node:assert/strict";
import test from "node:test";
import { clickHouseCoverageAnalysis } from "../src/clickhouse-coverage-scope.js";
import { planClickHouse } from "../src/clickhouse-plan.js";
import { verifyCell } from "../src/evidence.js";
import { loadKnowledge } from "../src/knowledge.js";
import { rawResultTable } from "../src/result-adapters.js";
import { ResultPolicy } from "../src/result-policy.js";
import { queryRowsMatchScope } from "../src/query-observation.js";
import { workingQueryCell } from "../src/working-query-cell.js";
import type { QueryResource } from "../src/types.js";

const knowledge = loadKnowledge("knowledge/starhaven");
const contract = knowledge.contract_by_table.get("fact_activity_daily")!.contract!;
const sql = "SELECT activity_date, acquisition_country_code, ua_channel_id, completeness_state, active_devices, dataset_version FROM fact_activity_daily WHERE activity_date IN (toDate('2026-10-26'), toDate('2026-11-07')) AND app_id = 'blockfall_android' ORDER BY activity_date, acquisition_country_code, ua_channel_id";
const dates = ["2026-10-26", "2026-11-07"];

function source(): QueryResource {
  const rows = [
    { activity_date: dates[0], acquisition_country_code: "JP", ua_channel_id: "breeze", completeness_state: "complete", active_devices: "4", dataset_version: "synthetic_v1" },
    { activity_date: dates[1], acquisition_country_code: "US", ua_channel_id: "moss", completeness_state: "complete", active_devices: "15", dataset_version: "synthetic_v1" },
  ];
  return { resource_id: "res_sparse", session_id: "session", job_id: "job", engine: "clickhouse-local", sql_review_engine: "clickhouse_ast_direct", result_semantics_version: 2, key_lineage_version: 1, execution_id: "exec_sparse", sql, executed_sql: sql, tables: [contract.table], time_range: { start: dates[0], end: dates[1], selected_dates: dates, timezone: "UTC" }, truncated: false, sql_limited: false, complete_population: true, total_rows_exact: true, returned_rows: rows.length, total_rows: rows.length, columns: Object.keys(rows[0]!), column_types: { activity_date: "Date", acquisition_country_code: "String", ua_channel_id: "String", completeness_state: "String", active_devices: "Nullable(UInt64)", dataset_version: "String" }, coverage: { status: "unknown", absent_dates: [], null_dates: [], zero_dates: [], predicted_dates: [], actual_dates: [], unknown_prediction_dates: [], groups: [] }, rows } as unknown as QueryResource;
}

test("literal sparse date sets keep their exact dates and reject ambiguous predicates", () => {
  const expected = { equalities: { app_id: "blockfall_android" }, inSets: {}, selectedDates: dates };
  assert.deepEqual(clickHouseCoverageAnalysis(sql, contract)?.scope, expected);
  assert.deepEqual(clickHouseCoverageAnalysis(sql.replace("toDate('2026-10-26'), toDate('2026-11-07')", "'2026-11-07', '2026-10-26'"), contract)?.scope, expected);
  for (const invalid of [
    sql.replace("toDate('2026-11-07')", "toDate('2026-10-26')"),
    sql.replace("toDate('2026-11-07')", "today()"),
    sql.replace("toDate('2026-11-07')", "toDate('2026-02-30')"),
    sql.replace(" AND app_id", " OR app_id"),
    sql.replace(" AND app_id", " AND activity_date >= '2026-11-01' AND app_id"),
  ]) assert.equal(clickHouseCoverageAnalysis(invalid, contract), null, invalid);
  const rule = { table: contract.table, allowed_columns: contract.columns.map((column) => column.name), sensitive_columns: contract.sensitive_columns, must_filter: contract.must_filter, column_types: Object.fromEntries(contract.columns.map((column) => [column.name, column.type])) };
  const plan = planClickHouse(sql, [rule], [contract], [], "synthetic", 1000);
  assert.equal(plan.receipt.engine, "clickhouse_ast_direct");
  assert.deepEqual(plan.guarded.time_range.selected_dates, dates);
});

test("sparse direct rows retain physical labels without proving complete coverage", () => {
  const original = source(); const table = rawResultTable(original, contract); assert.ok(table);
  assert.equal(queryRowsMatchScope(original, contract), true);
  assert.equal(table.columns.find((column) => column.name === "active_devices")?.unit, "设备×App");
  assert.match(table.columns.find((column) => column.name === "active_devices")!.label, /fact_activity_daily\.active_devices/);
  assert.equal(verifyCell(original, contract, { op: "sum", column: "active_devices", as: "total" }, 19), null);
  assert.equal(workingQueryCell(original, contract, 0, "active_devices"), null);
  const grouped = new ResultPolicy(knowledge).applyProvenTransform(table, [
    { op: "group", by: ["activity_date"], aggregates: [{ op: "sum", column: "active_devices", as: "daily_total" }] },
  ], true);
  assert.ok(grouped);
  assert.deepEqual(grouped.table.rows.map((row) => [row.activity_date, row.daily_total]), [[dates[0], "4"], [dates[1], "15"]]);
  const changed = (mutate: (value: QueryResource) => void) => { const value = source(); mutate(value); assert.equal(rawResultTable(value, contract), null); };
  changed((value) => { value.time_range.selected_dates = [dates[0]]; });
  changed((value) => { value.rows[1]!.activity_date = "2026-11-01"; });
  const wrongDay = source(); wrongDay.rows[1]!.activity_date = "2026-11-01";
  assert.equal(queryRowsMatchScope(wrongDay, contract), false, "中间日期虽在最小/最大范围内，也不属于实际选择的集合");
  changed((value) => { value.truncated = true; });
  changed((value) => { value.coverage.status = "known"; });
  changed((value) => { value.column_types!.active_devices = "Float64"; });
  const secret = structuredClone(contract); secret.sensitive_columns.push("active_devices");
  assert.equal(rawResultTable(original, secret), null);
});
