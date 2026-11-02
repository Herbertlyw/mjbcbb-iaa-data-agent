import assert from "node:assert/strict";
import test from "node:test";
import { transformResult, type ResultTable } from "../src/result-transform.js";
import { alignAggregates } from "../src/result-alignment.js";
import { computeArithmetic } from "../src/exact-arithmetic.js";
import type { VerifiedAggregate } from "../src/aggregate-evidence.js";

const fixture: ResultTable = {
  columns: [
    { name: "channel", type: "text", unit: "渠道", label: "渠道" },
    { name: "country", type: "text", unit: "国家", label: "国家" },
    { name: "amount", type: "decimal", unit: "USD", label: "收入", scale: 2 },
    { name: "cost", type: "decimal", unit: "USD", label: "成本", scale: 2 },
  ],
  rows: [
    { channel: "A", country: "US", amount: "90071992547409.91", cost: "0.09" },
    { channel: "A", country: "JP", amount: "0.09", cost: "0.09" },
    { channel: "B", country: "US", amount: null, cost: "0.00" },
    { channel: "B", country: "JP", amount: null, cost: null },
  ],
};

test("完整行可筛选、稳定排序、分组，精确大数且区分 NULL、真实零与计数", () => {
  const result = transformResult(fixture, [
    { op: "filter", column: "country", comparison: "ne", value: "DE" },
    { op: "sort", keys: [{ column: "amount", direction: "desc", nulls: "last" }, { column: "country", direction: "asc", nulls: "last" }] },
    { op: "group", by: ["channel"], aggregates: [
      { op: "sum", column: "amount", as: "total" }, { op: "count_all", as: "rows" },
      { op: "count", column: "amount", as: "nonnull" }, { op: "min", column: "cost", as: "minimum" },
    ] },
  ]);
  assert.ok(result);
  assert.deepEqual(result.rows.map((row) => ({ ...row })), [
    { channel: "A", total: "90071992547410.00", rows: "2", nonnull: "2", minimum: "0.09" },
    { channel: "B", total: null, rows: "2", nonnull: "0", minimum: "0.00" },
  ]);
});

test("比较遇 NULL 为未知，过滤仅保留 true，NULL 顺序可指定", () => {
  const compared = transformResult(fixture, [
    { op: "compare", left: "amount", right: "cost", comparison: "gt", as: "profitable" },
    { op: "sort", keys: [{ column: "amount", direction: "asc", nulls: "first" }] },
  ]);
  assert.ok(compared);
  assert.deepEqual(compared.rows.map((row) => row.profitable), [null, null, false, true]);
  const filtered = transformResult(compared, [{ op: "filter", column: "profitable", comparison: "eq", value: true }]);
  assert.deepEqual(filtered?.rows.map((row) => row.country), ["US"]);
  const empty = transformResult({ columns: fixture.columns, rows: [] }, [{ op: "group", by: [], aggregates: [{ op: "sum", column: "amount", as: "sum" }, { op: "count_all", as: "n" }] }]);
  assert.deepEqual(empty?.rows.map((row) => ({ ...row })), [{ sum: null, n: "0" }]);
});

test("无效列、单位、原型键和非精确数值都失败关闭", () => {
  assert.equal(transformResult(fixture, [{ op: "compare", left: "amount", right: "country", comparison: "eq", as: "wrong" }]), null);
  assert.equal(transformResult(fixture, [{ op: "compare", left: "amount", right: "cost", comparison: "eq", as: "__proto__" }]), null);
  const bad = structuredClone(fixture) as ResultTable;
  (bad.rows[0] as Record<string, unknown>).amount = 90071992547409.91;
  assert.equal(transformResult(bad, [{ op: "sort", keys: [{ column: "amount", direction: "asc", nulls: "last" }] }]), null);
});

test("分组全集保留缺侧和零分母，而非填零", () => {
  const row = (group: string, value: string): VerifiedAggregate => ({ source_resource_id: "synthetic", table: "synthetic", column: "metric", output_column: "total", operation: "sum", value, scale: 0, unit: "人", description: "合成数量", filters: { product: "A" }, group: { channel: group }, range: { start: "2026-01-01", end: "2026-01-01", timezone: "UTC" }, prediction: "actual_observed_only" });
  const result = alignAggregates([row("A", "5"), row("B", "4")], [row("A", "0"), row("C", "8")], ["channel"], "divide", computeArithmetic);
  assert.deepEqual(result?.map((item) => [item.group.channel, item.status, item.result?.value ?? null]), [["A", "zero_divisor", null], ["B", "missing_right", null], ["C", "missing_left", null]]);
});
