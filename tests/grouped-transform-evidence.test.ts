import assert from "node:assert/strict";
import test from "node:test";
import { groupedTransformObservation } from "../src/grouped-transform-evidence.js";
import { loadKnowledge } from "../src/knowledge.js";
import { rawResultTable } from "../src/result-adapters.js";
import { ResultPolicy } from "../src/result-policy.js";
import { transformResult, type TransformStep } from "../src/result-transform.js";
import type { ArithmeticRef, QueryResource, TransformResource } from "../src/types.js";

const knowledge = loadKnowledge("knowledge/starhaven");
const contract = knowledge.contract_by_table.get("fact_delivery_daily")!.contract!;
const steps: TransformStep[] = [{ op: "group", by: ["ua_channel_id"], aggregates: [{ op: "sum", column: "discounted_cost_usd", as: "cost" }, { op: "sum", column: "af_registers", as: "registrations" }] }];

function fixture() {
  const rows = [{ ua_channel_id: "moss", discounted_cost_usd: "1.100000", af_registers: "1" }, { ua_channel_id: "moss", discounted_cost_usd: "1.802374", af_registers: "1" }, { ua_channel_id: "organic", discounted_cost_usd: "0.000000", af_registers: "0" }];
  const source = { resource_id: "res_query", session_id: "session", job_id: "job", engine: "clickhouse-local", result_semantics_version: 2, key_lineage_version: 1, execution_id: "exec_query", sql: "SELECT ua_channel_id, discounted_cost_usd, af_registers FROM fact_delivery_daily WHERE business_date = toDate('2026-11-07') AND app_id = 'gridfit_android'", tables: [contract.table], time_range: { start: "2026-11-07", end: "2026-11-07", timezone: "UTC" }, truncated: false, sql_limited: false, complete_population: true, total_rows_exact: true, returned_rows: rows.length, total_rows: rows.length, columns: ["ua_channel_id", "discounted_cost_usd", "af_registers"], column_types: { ua_channel_id: "String", discounted_cost_usd: "Nullable(Decimal(24,6))", af_registers: "Nullable(UInt64)" }, decimal_types: { "fact_delivery_daily.discounted_cost_usd": "Nullable(Decimal(24,6))" }, coverage: { status: "known", absent_dates: [], null_dates: [], zero_dates: [], predicted_dates: [], unknown_prediction_dates: [], groups: [] }, rows } as unknown as QueryResource;
  const input = rawResultTable(source, contract); assert.ok(input);
  const result = transformResult(input, steps); assert.ok(result);
  const transform = { kind: "transform", resource_id: "res_group", source_resource_id: source.resource_id, execution_id: "exec_group", steps, result } as unknown as TransformResource;
  const ref = (cell: string, row: number): ArithmeticRef => ({ resource_id: transform.resource_id, execution_id: transform.execution_id!, cell, row });
  return { source, result, transform, ref };
}

test("complete direct rows grouped in memory retain partial, exact same-row metric lineage", () => {
  const { source, result, transform, ref } = fixture();
  const cost = groupedTransformObservation(source, contract, transform, result, ref("cost", 0));
  const regs = groupedTransformObservation(source, contract, transform, result, ref("registrations", 0));
  assert.ok(cost && regs); assert.equal(cost.value, "2.902374"); assert.equal(regs.value, "2");
  assert.deepEqual(cost.scopes[0]!.filters, { app_id: "gridfit_android", ua_channel_id: "moss" });
  const ratio = new ResultPolicy(knowledge).computeProvenArithmetic("divide", cost, regs);
  assert.equal(ratio?.value, "1.451187000000000000"); assert.equal(ratio?.partial, true); assert.equal(ratio?.scope_unverified, true);
  const zero = groupedTransformObservation(source, contract, transform, result, ref("registrations", 1));
  assert.equal(zero?.value, "0");
  assert.equal(new ResultPolicy(knowledge).computeProvenArithmetic("divide", cost, zero!)?.interpretation, "mathematical_only");
});

test("a single authorized source can group and divide in one transform without certifying the population", () => {
  const { source } = fixture(); const input = rawResultTable(source, contract)!;
  const recipe: TransformStep[] = [...steps, { op: "divide", left: "cost", right: "registrations", as: "ratio" }];
  const policy = new ResultPolicy(knowledge);
  assert.equal(policy.applyProvenTransform(input, recipe), null, "single-query authority must be established by the caller");
  const computed = policy.applyProvenTransform(input, recipe, true); assert.ok(computed);
  assert.equal(computed.observedPartialArithmetic, true); assert.equal(computed.undefinedArithmetic, true);
  assert.equal(computed.table.rows[0]!.ratio, "1.451187000000000000"); assert.equal(computed.table.rows[1]!.ratio, null);
  const mismatched = structuredClone(input); mismatched.columns.find((c) => c.name === "af_registers")!.value_lineage!.table = "other_table";
  assert.equal(policy.applyProvenTransform(mismatched, recipe, true), null);
});

test("grouped evidence rejects changed source, wrong execution, truncation, forged keys and integer overflow", () => {
  const f = fixture();
  assert.equal(groupedTransformObservation({ ...f.source, truncated: true }, contract, f.transform, f.result, f.ref("cost", 0)), null);
  assert.equal(groupedTransformObservation(f.source, contract, { ...f.transform, source_resource_id: "foreign" }, f.result, f.ref("cost", 0)), null);
  assert.equal(groupedTransformObservation(f.source, contract, f.transform, f.result, { ...f.ref("cost", 0), execution_id: "other" }), null);
  // The evaluator reconstructs and compares the complete result before this helper.
  const invalid = structuredClone(f.source); invalid.rows[0]!.af_registers = "18446744073709551616";
  assert.equal(rawResultTable(invalid, contract), null);
  assert.equal(groupedTransformObservation(invalid, contract, f.transform, f.result, f.ref("registrations", 0)), null);
  const oversized = structuredClone(f.source); oversized.rows[0]!.discounted_cost_usd = "9999999999999999999.000000";
  assert.equal(rawResultTable(oversized, contract), null);
});
