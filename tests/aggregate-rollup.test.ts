import assert from "node:assert/strict";
import test from "node:test";
import { verifyGroupRollup } from "../src/aggregate-rollup.js";
import { loadKnowledge } from "../src/knowledge.js";
import type { QueryResource } from "../src/types.js";
import { analyst, bindTables, withRuntime } from "./helpers.js";

const contract = loadKnowledge("knowledge/harborlight").contract_by_table.get("fact_fox_daily_install")!.contract!;
const sql = "SELECT event_date, SUM(new_users) AS total FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-08' AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'US' AND channel_id = 'mist_ads' GROUP BY event_date ORDER BY event_date";
const base = {
  resource_id: "res_rollup_fixture", engine: "clickhouse-local", tables: [contract.table], sql,
  truncated: false, sql_limited: false, complete_population: true, total_rows_exact: true,
  total_rows: 3, returned_rows: 3, scan_limit: 5_000_000,
  time_range: { start: "2026-10-06", end: "2026-10-08", timezone: contract.timezone },
  coverage: { status: "known", absent_dates: [], null_dates: [], zero_dates: ["2026-10-07"], predicted_dates: [], unknown_prediction_dates: [], groups: [] },
  rows: [{ event_date: "2026-10-06", total: "100" }, { event_date: "2026-10-07", total: "0" }, { event_date: "2026-10-08", total: "120" }],
} as unknown as QueryResource;

test("可信日期分组精确汇总，分组的行数与零不能冒充事实明细计数", () => {
  const total = verifyGroupRollup(base, contract, { op: "sum", column: "total", predicted: "actual_only", as: "model_alias" }, "220");
  assert.ok(total); assert.equal(total.value, "220"); assert.equal(total.unit, "人");
  assert.deepEqual(total.grouped_by, ["event_date"]); assert.equal(total.filters.country_code, "US");
  assert.deepEqual(total.range, base.time_range);
  assert.equal(verifyGroupRollup(base, contract, { op: "count_rows", as: "n" }, 3)?.value, "3");
  assert.equal(verifyGroupRollup(base, contract, { op: "count_null", column: "total", as: "n" }, 0)?.value, "0");
  assert.equal(verifyGroupRollup(base, contract, { op: "count_zero", column: "total", as: "n" }, 1)?.value, "1");
  assert.equal(verifyGroupRollup(base, contract, { op: "sum", column: "total", as: "n" }, "221"), null);
  assert.equal(verifyGroupRollup(base, contract, { op: "sum", column: "total", predicted: "predicted_only", as: "n" }, "220"), null);
});

test("CK 原生审查的分组结果以 CK 投影形状复核后继续求和", () => {
  const native = { ...structuredClone(base), sql_review_engine: "clickhouse_ast_direct" as const };
  const op = { op: "sum" as const, column: "total", as: "result" };
  assert.equal(verifyGroupRollup(native, contract, op, "220")?.value, "220");
  const incorrect = structuredClone(native); incorrect.rows[2]!.total = "121";
  assert.equal(verifyGroupRollup(incorrect, contract, op, "220"), null);
  const forged = structuredClone(native); forged.sql = forged.sql.replace("SUM(new_users) AS total", "SUM(new_users) OVER () AS total");
  assert.equal(verifyGroupRollup(forged, contract, op, "220"), null);
  const hidden = structuredClone(native); hidden.sql = hidden.sql.replace("SUM(new_users)", "SUM(device_token)");
  assert.equal(verifyGroupRollup(hidden, contract, op, "220"), null);
});

test("SUM、COUNT 和空值辅助计数同查询时可核验汇总，辅助列不能冒充指标", () => {
  const source = structuredClone(base);
  source.sql = source.sql.replace("SUM(new_users) AS total", "SUM(new_users) AS total, COUNT(new_users) AS observed, COUNT(*) AS total_rows, countIf(new_users IS NULL) AS missing");
  source.column_types = { observed: "UInt64", total_rows: "UInt64", missing: "UInt64" };
  source.rows = source.rows.map((row) => ({ ...row, observed: "1", total_rows: "1", missing: "0" }));
  const op = { op: "sum" as const, column: "total", as: "n" };
  assert.equal(verifyGroupRollup(source, contract, op, "220")?.value, "220");
  const noArgCount = structuredClone(source);
  noArgCount.sql = noArgCount.sql.replace("COUNT(*)", "COUNT()");
  assert.equal(verifyGroupRollup(noArgCount, contract, op, "220")?.value, "220");
  const inconsistentCount = structuredClone(noArgCount); inconsistentCount.rows[0]!.total_rows = "0";
  assert.equal(verifyGroupRollup(inconsistentCount, contract, op, "220"), null);
  const sqliteCount = structuredClone(noArgCount); sqliteCount.engine = "sqlite-local";
  assert.equal(verifyGroupRollup(sqliteCount, contract, op, "220"), null);
  assert.equal(verifyGroupRollup(source, contract, { ...op, column: "total_rows" }, "3"), null);
  const invalid = (mutate: (item: QueryResource) => void) => { const item = structuredClone(source); mutate(item); assert.equal(verifyGroupRollup(item, contract, op, "220"), null); };
  invalid((s) => { s.rows[0]!.missing = "1"; });
  invalid((s) => { s.rows[0]!.total_rows = "5000001"; });
  invalid((s) => { s.column_types!.missing = "String"; });
  invalid((s) => { s.sql = s.sql.replace("new_users IS NULL", "device_token IS NULL"); });
  invalid((s) => { s.sql = s.sql.replace("new_users IS NULL", "new_users > 0"); });
  invalid((s) => { s.sql = s.sql.replace("AS missing", "AS platform"); });
  invalid((s) => { s.rows[0]!.missing = null; });
  invalid((s) => { s.coverage.null_dates = ["2026-10-06"]; });
});

test("缺日期、NULL、未知预测、截断、别名欺骗和不完整保存均不可核验", () => {
  const operation = { op: "sum" as const, column: "total", as: "n" };
  const mutate = (f: (source: QueryResource) => void) => { const source = structuredClone(base); f(source); assert.equal(verifyGroupRollup(source, contract, operation, "220"), null); };
  mutate((s) => { s.coverage.absent_dates = ["2026-10-07"]; });
  mutate((s) => { s.coverage.null_dates = ["2026-10-07"]; });
  mutate((s) => { s.coverage.predicted_dates = ["2026-10-07"]; });
  mutate((s) => { s.coverage.unknown_prediction_dates = ["2026-10-07"]; });
  mutate((s) => { s.coverage.status = "unknown"; });
  mutate((s) => { s.truncated = true; });
  mutate((s) => { s.sql_limited = true; });
  mutate((s) => { s.total_rows_exact = false; });
  mutate((s) => { s.rows.pop(); });
  mutate((s) => { s.rows.pop(); s.returned_rows = 2; s.total_rows = 2; });
  mutate((s) => { s.rows[1]!.total = null; });
  mutate((s) => { s.rows[1]!.event_date = "2026-10-06"; });
  mutate((s) => { s.rows[1]!.event_date = "2026-10-09"; });
  mutate((s) => { s.sql = s.sql.replace("AS total", "AS platform"); });
  mutate((s) => { s.rows[2]!.total = "121"; });
  mutate((s) => { s.coverage.groups_has_more = true; });
  mutate((s) => { (s.coverage as unknown as Record<string, unknown>).null_dates = null; });
  mutate((s) => { (s.rows as unknown[])[1] = null; });
  mutate((s) => { s.time_range.timezone = "UTC"; });
  const predicted = structuredClone(contract); predicted.series!.predicted_column = "is_predicted";
  assert.equal(verifyGroupRollup(base, predicted, operation, "220"), null);
});

test("多维 IN 分组不能丢失请求组合，且每个已返回分组必须覆盖全部日期", () => {
  const source = structuredClone(base);
  source.sql = source.sql.replace("event_date, SUM", "event_date, country_code, SUM")
    .replace("country_code = 'US'", "country_code IN ('US', 'JP')")
    .replace("GROUP BY event_date", "GROUP BY event_date, country_code");
  source.rows = [
    ...base.rows.map((row) => ({ ...row, country_code: "US" })),
    ...base.rows.map((row) => ({ ...row, country_code: "JP" })),
  ];
  source.returned_rows = 6; source.total_rows = 6;
  const operation = { op: "sum" as const, column: "total", as: "n" };
  const verified = verifyGroupRollup(source, contract, operation, "440");
  assert.ok(verified); assert.deepEqual(verified.grouped_by, ["country_code", "event_date"]);
  assert.deepEqual(verified.in_sets.country_code, ["JP", "US"]);
  const missingDate = structuredClone(source);
  missingDate.rows.pop(); missingDate.returned_rows = 5; missingDate.total_rows = 5;
  assert.equal(verifyGroupRollup(missingDate, contract, operation, "320"), null);
  const missingCountry = structuredClone(source);
  missingCountry.rows = missingCountry.rows.filter((row) => row.country_code === "US");
  missingCountry.returned_rows = 3; missingCountry.total_rows = 3;
  assert.equal(verifyGroupRollup(missingCountry, contract, operation, "220"), null);
});

test("分组求和使用定点十进制并拒绝不匹配的声明类型和数字精度", () => {
  const decimalContract = structuredClone(contract);
  decimalContract.columns.find((column) => column.name === "new_users")!.type = "Decimal(20,2)";
  const source = structuredClone(base);
  source.decimal_types = { "fact_fox_daily_install.new_users": "Decimal(20,2)" };
  source.rows[0]!.total = "9007199254740993.10";
  source.rows[1]!.total = "0.00";
  source.rows[2]!.total = "1.65";
  const operation = { op: "sum" as const, column: "total", as: "n" };
  assert.equal(verifyGroupRollup(source, decimalContract, operation, "9007199254740994.75")?.value, "9007199254740994.75");
  assert.equal(verifyGroupRollup(source, decimalContract, operation, 9007199254740994), null);
  source.decimal_types["fact_fox_daily_install.new_users"] = "Decimal(19,2)";
  assert.equal(verifyGroupRollup(source, decimalContract, operation, "9007199254740994.75"), null);
});

test("完整数据库分组在当前任务交付精确合计并核对来源；跨任务拒绝", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime); await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    runtime.sessions.setActiveJob(session.session_id, "job_group_rollup");
    const query = await runtime.tools.query(session.session_id, { sql: "SELECT event_date, SUM(new_users) AS total FROM daily_installs WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-08' AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'US' AND channel = 'nebula_ads' GROUP BY event_date ORDER BY event_date" });
    assert.ok(query.ok, JSON.stringify(query)); if (!query.ok) return;
    const calc = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: String(query.resource_id), operations: [{ op: "sum", column: "total", as: "model_label" }, { op: "count_rows", as: "n" }, { op: "count_zero", column: "total", as: "z" }] });
    assert.ok(calc.ok, JSON.stringify(calc)); if (!calc.ok) return;
    const result = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(query.resource_id), String(calc.resource_id)] });
    assert.ok(result.ok, JSON.stringify(result)); if (!result.ok) return;
    assert.equal(result.status, "completed"); assert.match(String(result.answer), /分组求和结果再求和 215；单位 人/);
    assert.match(String(result.answer), /结果分组数 3/); assert.match(String(result.answer), /分组聚合输出为零的分组数 1/);
    assert.doesNotMatch(String(result.answer), /model_label/); assert.match(String(result.answer), /不是底层业务明细的计数/);
    const ref = { resource_id: String(calc.resource_id), cell: "model_label" };
    const twice = await runtime.tools.calculateSessionCells(session.session_id, { arithmetic: { op: "add", left: ref, right: ref } });
    assert.ok(twice.ok, JSON.stringify(twice)); if (!twice.ok) return;
    assert.equal((twice.result as { value: string }).value, "430");
    // Only the terminal resource is named; the server resolves and checks the
    // calculation and query ancestors itself.
    const derived = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(twice.resource_id)] });
    assert.ok(derived.ok, JSON.stringify(derived)); if (!derived.ok) return;
    assert.equal(derived.status, "completed"); assert.match(String(derived.answer), /430/);
    const original = runtime.sessions.lookupResource(session.session_id, String(query.resource_id));
    assert.ok(original.ok && original.resource.kind === "query_result"); if (!original.ok || original.resource.kind !== "query_result") return;
    // A changed range with identical numeric rows cannot silently give an old
    // calculation a new business meaning.
    runtime.state.saveResource({ ...original.resource, time_range: { ...original.resource.time_range, start: "2026-10-05" } });
    const altered = await runtime.tools.calculateSessionCells(session.session_id, { arithmetic: { op: "add", left: ref, right: ref } });
    assert.equal(altered.ok, false);
    const alteredDelivery = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(twice.resource_id)] });
    if (alteredDelivery.ok) { assert.notEqual(alteredDelivery.status, "completed"); assert.doesNotMatch(String(alteredDelivery.answer), /430/); }
    runtime.state.saveResource(original.resource);
    runtime.sessions.setActiveJob(session.session_id, "other_job");
    const crossedDerived = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(twice.resource_id)] });
    assert.equal(crossedDerived.ok, false);
    const crossed = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(query.resource_id), String(calc.resource_id)] });
    if (crossed.ok) { assert.notEqual(crossed.status, "completed"); assert.doesNotMatch(String(crossed.answer), /215|430/); }
  });
});
