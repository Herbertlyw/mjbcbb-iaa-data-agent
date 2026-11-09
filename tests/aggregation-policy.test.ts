import assert from "node:assert/strict";
import test from "node:test";
import { permitsAggregation } from "../src/aggregation-policy.js";
import { loadKnowledge } from "../src/knowledge.js";
import { ResultPolicy } from "../src/result-policy.js";
import type { ResultTable, TransformStep } from "../src/result-transform.js";
import type { ArithmeticValue } from "../src/exact-arithmetic.js";

const knowledge = loadKnowledge("knowledge/starhaven");
const contract = knowledge.contract_by_table.get("fact_cohort_revenue_daily")!.contract!;
const range = { start: "2026-10-31", end: "2026-10-31", timezone: "UTC" };

test("contract policy is dimension driven, validates declarations, and does not trust unrelated labels", () => {
  assert.equal(permitsAggregation(contract, "revenue_usd", {}, [], range), false);
  assert.equal(permitsAggregation(contract, "revenue_usd", { revenue_source: "sdk" }, [], range), true);
  assert.equal(permitsAggregation(contract, "revenue_usd", {}, ["revenue_source"], range), true);
  assert.equal(permitsAggregation(contract, "revenue_usd", { app_id: "revenue_source" }, [], range), false);
  const other = structuredClone(contract);
  other.aggregation_policy = { revenue_usd: ["app_id", "revenue_source"] };
  assert.equal(permitsAggregation(other, "revenue_usd", { revenue_source: "sdk" }, [], range), false);
  assert.equal(permitsAggregation(other, "revenue_usd", { revenue_source: "sdk" }, ["app_id"], range), true);
  other.aggregation_policy = { revenue_usd: ["not_a_column"] };
  assert.equal(permitsAggregation(other, "revenue_usd", { not_a_column: "x" }, [], range), false);
  other.aggregation_policy = { revenue_usd: [] };
  assert.equal(permitsAggregation(other, "revenue_usd", {}, [], range), false);
});

test("individually valid source subtotals cannot be added across a restricted dimension", () => {
  const policy = new ResultPolicy(knowledge);
  const cell = (source: string): ArithmeticValue => ({ value: "1.000000", scale: 6, unit: "USD", basis: { table: contract.table, column: "revenue_usd", operation: "sum", unit: "USD", prediction: "actual_observed_only", timezone: "UTC" }, scopes: [{ filters: { revenue_source: source }, start: range.start, end: range.end }] });
  assert.equal(policy.computeProvenArithmetic("add", cell("sdk"), cell("af")), null);
  assert.equal(policy.computeProvenArithmetic("add", cell("sdk"), cell("sdk"))?.value, "2.000000");
  assert.equal(policy.computeProvenArithmetic("subtract", cell("sdk"), cell("af"))?.value, "0.000000");
});

test("result transforms cannot erase a required source through grouping, aliases or arithmetic", () => {
  const policy = new ResultPolicy(knowledge);
  const table: ResultTable = {
    columns: [
      { name: "source_alias", type: "text", unit: "source", label: "source", key_lineage: { table: contract.table, column: "revenue_source", physical_type: "string" } },
      { name: "value_alias", type: "decimal", unit: "USD", label: "value", scale: 6, value_lineage: { table: contract.table, column: "revenue_usd" } },
    ],
    rows: [{ source_alias: "sdk", value_alias: "1.266092" }, { source_alias: "af", value_alias: "1.139478" }],
  };
  const sum = (by: string[], column = "value_alias"): TransformStep => ({ op: "group", by, aggregates: [{ op: "sum", column, as: "total" }] });
  assert.equal(policy.applyProvenTransform(table, [sum([])]), null);
  const grouped = policy.applyProvenTransform(table, [sum(["source_alias"])]);
  assert.ok(grouped);
  assert.equal(policy.applyProvenTransform(grouped.table, [sum([], "total")]), null);
  const misleading = structuredClone(table); misleading.columns[0]!.key_lineage!.column = "app_id";
  assert.equal(policy.applyProvenTransform(misleading, [sum(["source_alias"])]), null);
  const arithmetic: TransformStep[] = [{ op: "add", left: "value_alias", right: "value_alias", as: "twice" }, sum([], "twice")];
  assert.equal(policy.applyProvenTransform(table, arithmetic), null);
});
