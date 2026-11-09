import assert from "node:assert/strict";
import test from "node:test";
import { loadKnowledge } from "../src/knowledge.js";
import { prepareWideAggregateProof, verifyWideAggregateProof, wideCaptureHash, type WideQueryResource } from "../src/wide-aggregate-proof.js";
import { aggregateObservationInput, aggregateObservationValue, selectedAggregateReferences } from "../src/aggregate-observation.js";
import { ResultPolicy } from "../src/result-policy.js";
import { workingQueryCell } from "../src/working-query-cell.js";

const contract = loadKnowledge("knowledge/starhaven").contract_by_table.get("fact_delivery_daily")!.contract!;
const range = { start: "2026-11-07", end: "2026-11-07", timezone: "UTC" };
const sql = "SELECT ua_channel_id, SUM(discounted_cost_usd) AS cost_usd, SUM(af_registers) AS af_registers, COUNT() AS row_count FROM fact_delivery_daily WHERE business_date = toDate('2026-11-07') AND app_id = 'gridfit_android' GROUP BY ua_channel_id ORDER BY ua_channel_id";
const plan = prepareWideAggregateProof(sql, contract, range)!;

function source(): WideQueryResource {
  const rows = [{ ua_channel_id: "moss", cost_usd: "2.902374", af_registers: "2", row_count: "1" }];
  const captured = rows.map((row) => ({ ...row, __da_wide_0: "2" }));
  const types = { ua_channel_id: "String", cost_usd: "Nullable(Decimal(38,6))", af_registers: "Nullable(UInt64)", row_count: "UInt64", __da_wide_0: "Nullable(UInt128)" };
  const column_types = Object.fromEntries(Object.entries(types).filter(([name]) => !name.startsWith("__da_wide")));
  return { resource_id: "res_test", engine: "clickhouse-local", sql_review_engine: "clickhouse_ast_direct", result_semantics_version: 2, key_lineage_version: 1, sql, executed_sql: plan.executionSql, tables: [contract.table], time_range: range, execution_id: "exec_test", scan_limit: 5_000_000, truncated: false, sql_limited: false, complete_population: true, total_rows_exact: true, returned_rows: 1, total_rows: 1, columns: Object.keys(column_types), column_types, decimal_types: { "fact_delivery_daily.discounted_cost_usd": "Nullable(Decimal(24,6))" }, coverage: { status: "known", absent_dates: [], null_dates: [], zero_dates: [], predicted_dates: [], unknown_prediction_dates: [], groups: [] }, rows, wide_aggregate_proof: { rows: captured, column_types: types, capture_hash: wideCaptureHash(sql, plan.executionSql, "exec_test", captured, types) } } as unknown as WideQueryResource;
}

test("same-query wide sum proves only direct authorized UInt64 outputs", () => {
  assert.ok(plan);
  assert.match(plan.executionSql, /toUInt128\(fact_delivery_daily\.af_registers\)/u);
  assert.deepEqual([...verifyWideAggregateProof(source(), contract)!], ["af_registers"]);
  assert.equal(prepareWideAggregateProof(sql.replace("SUM(af_registers)", "SUM(af_registers + 1)"), contract, range), null);
  assert.equal(prepareWideAggregateProof(sql.replace("AS row_count", "AS __da_wide_0"), contract, range), null);
  assert.equal(prepareWideAggregateProof(sql + " LIMIT 1", contract, range), null);
});

test("auxiliary extrema and literal status counts do not hide safe SUM proofs", () => {
  const extrema = sql.replace("COUNT() AS row_count", "COUNT() AS row_count, MIN(completeness_state) AS observed_min, MAX(completeness_state) AS observed_max");
  const counts = sql.replace("COUNT() AS row_count", "COUNT() AS row_count, countIf(completeness_state = 'partial') AS partial_rows, countIf(af_registers IS NULL) AS null_rows");
  assert.ok(prepareWideAggregateProof(extrema, contract, range));
  assert.ok(prepareWideAggregateProof(counts, contract, range));
});

test("auxiliary expressions stay unverified while the direct SUMs retain observed lineage", () => {
  for (const kind of ["extrema", "counts"] as const) {
    const value = source();
    value.sql = value.sql.replace("COUNT() AS row_count", kind === "extrema" ? "COUNT() AS row_count, MIN(completeness_state) AS observed_min, MAX(completeness_state) AS observed_max" : "COUNT() AS row_count, countIf(completeness_state = 'partial') AS partial_rows, countIf(af_registers IS NULL) AS null_rows");
    const p = prepareWideAggregateProof(value.sql, contract, range)!; value.executed_sql = p.executionSql;
    const extra = kind === "extrema" ? { observed_min: "complete", observed_max: "complete" } : { partial_rows: "0", null_rows: "0" };
    const extraTypes = kind === "extrema" ? { observed_min: "String", observed_max: "String" } : { partial_rows: "UInt64", null_rows: "UInt64" };
    value.rows = value.rows.map((row) => ({ ...row, ...extra })); value.columns.push(...Object.keys(extra)); Object.assign(value.column_types!, extraTypes);
    value.wide_aggregate_proof!.rows = value.rows.map((row) => ({ ...row, __da_wide_0: "2" })); Object.assign(value.wide_aggregate_proof!.column_types, extraTypes);
    value.wide_aggregate_proof!.capture_hash = wideCaptureHash(value.sql, value.executed_sql, value.execution_id!, value.wide_aggregate_proof!.rows, value.wide_aggregate_proof!.column_types);
    const observed = aggregateObservationInput(value, contract); assert.ok(observed);
    assert.equal(observed.incomplete, true); assert.equal(observed.observations.length, 2);
    for (const name of Object.keys(extra)) assert.equal(observed.table.columns.find((item) => item.name === name)?.unit, "未认证");
    const sensitive = structuredClone(contract); sensitive.sensitive_columns.push("completeness_state");
    assert.equal(aggregateObservationInput(value, sensitive), null);
  }
});

test("observed grouped decimal and wide-integer sums retain units without claiming complete business scope", () => {
  const value = source(); const observed = aggregateObservationInput(value, contract);
  assert.ok(observed);
  assert.equal(observed.incomplete, true);
  assert.deepEqual(observed.observations.map((x) => [x.column, x.value, x.unit, x.scope_complete]), [["discounted_cost_usd", "2.902374", "USD", false], ["af_registers", "2", "报表注册", false]]);
  delete value.wide_aggregate_proof;
  assert.equal(aggregateObservationInput(value, contract), null);
});

test("普通日期范围内按安全属性分组保留属性并明确仅是观察", () => {
  const value = source();
  value.sql = sql.replace("SELECT ua_channel_id,", "SELECT ua_channel_id, completeness_state,").replace("GROUP BY ua_channel_id", "GROUP BY ua_channel_id, completeness_state");
  const attributePlan = prepareWideAggregateProof(value.sql, contract, range); assert.ok(attributePlan);
  value.executed_sql = attributePlan.executionSql;
  value.rows = value.rows.map((row) => ({ ua_channel_id: row.ua_channel_id, completeness_state: "complete", cost_usd: row.cost_usd, af_registers: row.af_registers, row_count: row.row_count }));
  value.columns = ["ua_channel_id", "completeness_state", "cost_usd", "af_registers", "row_count"];
  value.column_types = { ...value.column_types, completeness_state: "String" };
  value.wide_aggregate_proof!.column_types.completeness_state = "String";
  value.wide_aggregate_proof!.rows = value.rows.map((row) => ({ ...row, __da_wide_0: "2" }));
  value.wide_aggregate_proof!.capture_hash = wideCaptureHash(value.sql, value.executed_sql, value.execution_id!, value.wide_aggregate_proof!.rows, value.wide_aggregate_proof!.column_types);
  const observed = aggregateObservationInput(value, contract); assert.ok(observed);
  assert.equal(observed.incomplete, true);
  assert.ok(observed.observations.every((item) => item.filters.completeness_state === "complete" && item.coverage_incomplete));
  const sensitive = structuredClone(contract); sensitive.sensitive_columns.push("completeness_state");
  assert.equal(aggregateObservationInput(value, sensitive), null);
  const nullable = structuredClone(contract); nullable.columns.find((item) => item.name === "completeness_state")!.nullable = true;
  assert.equal(aggregateObservationInput(value, nullable), null);
  const tampered = structuredClone(value); tampered.rows[0]!.completeness_state = "partial";
  assert.equal(aggregateObservationInput(tampered, contract), null);
});

test("standalone selected grouped results expose observed cells while calculations select their own metrics", () => {
  const value = source();
  value.rows.push({ ua_channel_id: "organic", cost_usd: "0.000000", af_registers: "0", row_count: "1" });
  value.total_rows = value.returned_rows = 2;
  value.wide_aggregate_proof!.rows.push({ ...value.rows[1]!, __da_wide_0: "0" });
  value.wide_aggregate_proof!.capture_hash = wideCaptureHash(value.sql, value.executed_sql!, value.execution_id!, value.wide_aggregate_proof!.rows, value.wide_aggregate_proof!.column_types);
  const observed = aggregateObservationInput(value, contract)!;
  assert.ok(observed.incomplete);
  assert.deepEqual(selectedAggregateReferences(observed, [], true), [
    { row: 0, column: "cost_usd" }, { row: 0, column: "af_registers" },
    { row: 1, column: "cost_usd" }, { row: 1, column: "af_registers" },
  ]);
  assert.deepEqual(selectedAggregateReferences(observed, [{ row: 0, column: "cost_usd" }], false), [
    { row: 0, column: "cost_usd" }, { row: 1, column: "cost_usd" },
  ]);
  assert.deepEqual(selectedAggregateReferences(observed, [], false), []);
  assert.deepEqual(selectedAggregateReferences(null, [], true), []);
  value.truncated = true;
  assert.equal(aggregateObservationInput(value, contract), null);
});

test("working notes can cite proven grouped sums with physical field, scope and overflow checks", () => {
  const value = source();
  const cell = workingQueryCell(value, contract, 0, "cost_usd");
  assert.ok(cell);
  assert.equal(cell.field, "fact_delivery_daily.discounted_cost_usd（数据库分组求和）");
  assert.equal(cell.value, "2.902374");
  assert.equal(cell.unit, "USD");
  assert.deepEqual(cell.observation?.filters, { app_id: "gridfit_android", ua_channel_id: "moss" });
  assert.equal(cell.observation?.scope_complete, false);
  assert.equal(workingQueryCell(value, contract, 0, "row_count"), null);
  assert.equal(workingQueryCell(value, contract, 9, "cost_usd"), null);
  const sensitive = structuredClone(contract); sensitive.sensitive_columns.push("discounted_cost_usd");
  assert.equal(workingQueryCell(value, sensitive, 0, "cost_usd"), null);
  const tampered = source(); tampered.wide_aggregate_proof!.rows[0]!.__da_wide_0 = "18446744073709551616";
  assert.equal(workingQueryCell(tampered, contract, 0, "af_registers"), null);
  const truncated = source(); truncated.truncated = true;
  assert.equal(workingQueryCell(truncated, contract, 0, "cost_usd"), null);
  const otherEngine = source(); otherEngine.engine = "sqlite-local";
  assert.equal(workingQueryCell(otherEngine, contract, 0, "cost_usd"), null);
});

test("folded observations can form a declared partial ratio only within the identical saved row", () => {
  const observed = aggregateObservationInput(source(), contract)!;
  const [cost, registrations] = observed.observations;
  const left = aggregateObservationValue([cost!], cost!.value, cost!.scale, true, true)!;
  const right = aggregateObservationValue([registrations!], registrations!.value, registrations!.scale, true, true)!;
  const policy = new ResultPolicy(loadKnowledge("knowledge/starhaven"));
  const ratio = policy.computeProvenArithmetic("divide", left, right);
  assert.equal(ratio?.value, "1.451187000000000000");
  assert.equal(ratio?.scope_unverified, true); assert.equal(ratio?.partial, true);
  assert.equal(policy.computeProvenArithmetic("divide", left, { ...right, row_identity: { ...right.row_identity!, row: 1 } })?.interpretation, "mathematical_only");
  assert.equal(policy.computeProvenArithmetic("divide", left, { ...right, row_identity: { ...right.row_identity!, resource_id: "other_resource" } })?.interpretation, "mathematical_only");
  assert.equal(policy.computeProvenArithmetic("divide", left, { ...right, scopes: [{ ...right.scopes[0]!, filters: { app_id: "another" } }] })?.interpretation, "mathematical_only");
  assert.equal(aggregateObservationValue([cost!], cost!.value, cost!.scale, true), null);
  const zero = policy.computeProvenArithmetic("divide", left, { ...right, value: "0" });
  assert.equal(zero?.value, null); assert.equal(zero?.undefined_reason, "zero_divisor"); assert.equal(zero?.partial, true);
});

test("同次查询的互斥观察分组可再次汇总并用于部分数学计算，重叠范围不可合并", () => {
  const value = source();
  value.rows.push({ ua_channel_id: "organic", cost_usd: "0.000000", af_registers: "0", row_count: "1" });
  value.total_rows = value.returned_rows = 2;
  value.wide_aggregate_proof!.rows.push({ ...value.rows[1]!, __da_wide_0: "0" });
  value.wide_aggregate_proof!.capture_hash = wideCaptureHash(value.sql, value.executed_sql!, value.execution_id!, value.wide_aggregate_proof!.rows, value.wide_aggregate_proof!.column_types);
  const input = aggregateObservationInput(value, contract)!;
  const costs = input.observations.filter((item) => item.column === "discounted_cost_usd");
  const regs = input.observations.filter((item) => item.column === "af_registers");
  assert.equal(aggregateObservationValue(costs, "2.902374", 6, true), null);
  const left = aggregateObservationValue(costs, "2.902374", 6, true, false, true)!;
  const right = aggregateObservationValue(regs, "2", 0, true, false, true)!;
  assert.ok(left && right); assert.equal(left.scope_unverified, true); assert.equal(left.partial, true);
  const ratio = new ResultPolicy(loadKnowledge("knowledge/starhaven")).computeProvenArithmetic("divide", left, right);
  assert.equal(ratio?.value, "1.451187000000000000"); assert.equal(ratio?.interpretation, "mathematical_only");
  assert.equal(aggregateObservationValue([costs[0]!, { ...costs[1]!, filters: costs[0]!.filters }], "2.902374", 6, true, false, true), null);
  assert.equal(aggregateObservationValue([costs[0]!, { ...costs[1]!, execution_id: "other" }], "2.902374", 6, true, false, true), null);
  assert.equal(aggregateObservationValue([costs[0]!, { ...costs[1]!, value: null }], "2.902374", 6, true, false, true), null);
  assert.equal(aggregateObservationValue(costs, "2.902374", 6, false, false, true), null);
});

test("wide proof rejects real overflow, tampering, truncation, wrong types and execution identity", () => {
  const change = (mutate: (x: WideQueryResource) => void) => { const value = source(); mutate(value); assert.equal(verifyWideAggregateProof(value, contract), null); };
  change((x) => { x.wide_aggregate_proof!.rows[0]!.__da_wide_0 = "18446744073709551616"; x.wide_aggregate_proof!.capture_hash = wideCaptureHash(x.sql, x.executed_sql!, x.execution_id!, x.wide_aggregate_proof!.rows, x.wide_aggregate_proof!.column_types); });
  change((x) => { x.wide_aggregate_proof!.rows[0]!.af_registers = "1"; });
  change((x) => { x.truncated = true; });
  change((x) => { x.execution_id = "another"; });
  change((x) => { x.wide_aggregate_proof!.column_types.__da_wide_0 = "UInt64"; });
  change((x) => { x.scan_limit = 2_000_000_001; });
});

test("signed 64-bit sums use signed widening and preserve NULL distinctly from zero", () => {
  const signed = structuredClone(contract);
  signed.columns.find((column) => column.name === "af_registers")!.type = "Nullable(Int64)";
  const signedPlan = prepareWideAggregateProof(sql, signed, range)!;
  assert.match(signedPlan.executionSql, /toInt128\(fact_delivery_daily\.af_registers\)/u);
  const x = source(); x.executed_sql = signedPlan.executionSql;
  x.column_types!.af_registers = "Nullable(Int64)";
  x.wide_aggregate_proof!.column_types.af_registers = "Nullable(Int64)";
  x.wide_aggregate_proof!.column_types.__da_wide_0 = "Nullable(Int128)";
  for (const [visible, wide, expected] of [["-2", "-2", true], [null, null, true], ["0", null, false], ["-9223372036854775808", "9223372036854775808", false]] as const) {
    x.rows[0]!.af_registers = visible; x.wide_aggregate_proof!.rows[0]!.af_registers = visible; x.wide_aggregate_proof!.rows[0]!.__da_wide_0 = wide;
    x.wide_aggregate_proof!.capture_hash = wideCaptureHash(x.sql, x.executed_sql!, x.execution_id!, x.wide_aggregate_proof!.rows, x.wide_aggregate_proof!.column_types);
    assert.equal(Boolean(verifyWideAggregateProof(x, signed)), expected);
  }
});

test("sparse-day grouped integer sums require same-query non-NULL counts and remain partial", () => {
  const activity = loadKnowledge("knowledge/starhaven").contract_by_table.get("fact_activity_daily")!.contract!;
  const selected = ["2026-10-31", "2026-11-01"];
  const sparseRange = { start: selected[0]!, end: selected[1]!, selected_dates: selected, timezone: "UTC" };
  const text = "SELECT activity_date, SUM(active_devices) AS active_devices, SUM(new_active_devices) AS new_active_devices, MIN(completeness_state) AS completeness_state FROM fact_activity_daily WHERE activity_date IN (toDate('2026-10-31'), toDate('2026-11-01')) AND app_id = 'demo_ios' GROUP BY activity_date ORDER BY activity_date";
  const p = prepareWideAggregateProof(text, activity, sparseRange); assert.ok(p);
  assert.match(p.executionSql, /count\(fact_activity_daily\.active_devices\) AS __da_nonnull_0/u);
  assert.match(p.executionSql, /count\(\) AS __da_row_count/u);
  const make = (): WideQueryResource => {
    const rows = [{ activity_date: selected[0], active_devices: "13", new_active_devices: "4", completeness_state: "complete" }, { activity_date: selected[1], active_devices: "0", new_active_devices: "0", completeness_state: "complete" }];
    const captured = rows.map((row) => ({ ...row, __da_wide_0: row.active_devices, __da_nonnull_0: "2", __da_wide_1: row.new_active_devices, __da_nonnull_1: "2", __da_row_count: "2" }));
    const types = { activity_date: "Date", active_devices: "Nullable(UInt64)", new_active_devices: "Nullable(UInt64)", completeness_state: "String", __da_wide_0: "Nullable(UInt128)", __da_nonnull_0: "UInt64", __da_wide_1: "Nullable(UInt128)", __da_nonnull_1: "UInt64", __da_row_count: "UInt64" };
    const column_types = Object.fromEntries(Object.entries(types).filter(([name]) => !name.startsWith("__da_")));
    return { resource_id: "res_sparse_aggregate", engine: "clickhouse-local", sql_review_engine: "clickhouse_ast_direct", result_semantics_version: 2, key_lineage_version: 1, sql: text, executed_sql: p.executionSql, tables: [activity.table], time_range: sparseRange, execution_id: "exec_sparse", scan_limit: 5000000, truncated: false, sql_limited: false, complete_population: true, total_rows_exact: true, returned_rows: 2, total_rows: 2, columns: Object.keys(column_types), column_types, coverage: { status: "unknown", absent_dates: [], null_dates: [], zero_dates: [], predicted_dates: [], actual_dates: [], unknown_prediction_dates: [], groups: [] }, rows, wide_aggregate_proof: { rows: captured, column_types: types, capture_hash: wideCaptureHash(text, p.executionSql, "exec_sparse", captured, types) } } as unknown as WideQueryResource;
  };
  const good = make();
  assert.deepEqual([...verifyWideAggregateProof(good, activity)!], ["active_devices", "new_active_devices"]);
  const observed = aggregateObservationInput(good, activity); assert.ok(observed);
  assert.equal(observed.incomplete, true);
  const working = workingQueryCell(good, activity, 0, "active_devices"); assert.ok(working);
  assert.equal(working.value, "13"); assert.equal(working.observation?.coverage_incomplete, true);
  assert.deepEqual([working.observation?.range.start, working.observation?.range.end], [selected[0], selected[0]]);
  assert.deepEqual(observed.observations.map((item) => [item.column, item.value, item.unit, item.range.start, item.range.end]), [["active_devices", "13", "设备×App", selected[0], selected[0]], ["new_active_devices", "4", "设备×App", selected[0], selected[0]], ["active_devices", "0", "设备×App", selected[1], selected[1]], ["new_active_devices", "0", "设备×App", selected[1], selected[1]]]);
  const missingDay = make(); missingDay.rows.pop(); missingDay.returned_rows = missingDay.total_rows = 1; missingDay.wide_aggregate_proof!.rows.pop();
  missingDay.wide_aggregate_proof!.capture_hash = wideCaptureHash(missingDay.sql, missingDay.executed_sql!, missingDay.execution_id!, missingDay.wide_aggregate_proof!.rows, missingDay.wide_aggregate_proof!.column_types);
  assert.equal(aggregateObservationInput(missingDay, activity)?.incomplete, true, "未返回的选中日期不能被补零或认作完整");
  const groupedAttribute = make();
  groupedAttribute.sql = text.replace("MIN(completeness_state) AS completeness_state", "completeness_state").replace("GROUP BY activity_date", "GROUP BY activity_date, completeness_state");
  const attributePlan = prepareWideAggregateProof(groupedAttribute.sql, activity, sparseRange); assert.ok(attributePlan);
  groupedAttribute.executed_sql = attributePlan.executionSql;
  groupedAttribute.wide_aggregate_proof!.capture_hash = wideCaptureHash(groupedAttribute.sql, attributePlan.executionSql, groupedAttribute.execution_id!, groupedAttribute.wide_aggregate_proof!.rows, groupedAttribute.wide_aggregate_proof!.column_types);
  const attributeObservation = aggregateObservationInput(groupedAttribute, activity); assert.ok(attributeObservation);
  assert.equal(attributeObservation.incomplete, true);
  assert.ok(attributeObservation.observations.every((item) => item.filters.completeness_state === "complete"), "额外分组必须保留在可核验范围中");
  const sensitiveAttribute = structuredClone(activity); sensitiveAttribute.sensitive_columns.push("completeness_state");
  assert.equal(aggregateObservationInput(groupedAttribute, sensitiveAttribute), null);
  const nullableAttribute = structuredClone(activity); nullableAttribute.columns.find((column) => column.name === "completeness_state")!.nullable = true;
  assert.equal(aggregateObservationInput(groupedAttribute, nullableAttribute), null);
  const changed = (mutate: (value: WideQueryResource) => void) => { const value = make(); mutate(value); value.wide_aggregate_proof!.capture_hash = wideCaptureHash(value.sql, value.executed_sql!, value.execution_id!, value.wide_aggregate_proof!.rows, value.wide_aggregate_proof!.column_types); assert.equal(aggregateObservationInput(value, activity), null); };
  changed((x) => { x.wide_aggregate_proof!.rows[0]!.__da_nonnull_0 = "1"; });
  const damaged = make(); damaged.wide_aggregate_proof!.rows[0]!.__da_nonnull_0 = "1";
  assert.equal(workingQueryCell(damaged, activity, 0, "active_devices"), null, "工作记录不能引用缺失或被篡改的证明");
  changed((x) => { x.wide_aggregate_proof!.rows[0]!.__da_row_count = "0"; });
  changed((x) => { x.wide_aggregate_proof!.rows[0]!.__da_wide_0 = "18446744073709551616"; });
  changed((x) => { x.rows[0]!.activity_date = "2026-10-30"; x.wide_aggregate_proof!.rows[0]!.activity_date = "2026-10-30"; });
  changed((x) => { x.time_range.selected_dates = [selected[0]!]; });
  changed((x) => { x.truncated = true; });
  changed((x) => { x.coverage.status = "known"; });
  assert.equal(prepareWideAggregateProof(text.replace("GROUP BY activity_date", "GROUP BY app_id"), activity, sparseRange), null);
  assert.equal(prepareWideAggregateProof(text.replace("AS completeness_state", "AS __da_row_count"), activity, sparseRange), null);
});
