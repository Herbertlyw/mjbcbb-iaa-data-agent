import assert from "node:assert/strict";
import test from "node:test";
import { RESULT_CALCULATION_MAX_ROWS, transformResult, type ResultTable, type TransformStep } from "../src/result-transform.js";
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

test("参考计算模块：NULL 谓词、列比较筛选和等值十进制分组", () => {
  const missing = transformResult(fixture, [{ op: "filter", column: "amount", comparison: "is_null" }]);
  assert.deepEqual(missing?.rows.map((row) => row.country), ["US", "JP"]);
  const present = transformResult(fixture, [{ op: "filter", column: "amount", comparison: "is_not_null" }, { op: "filter", column: "amount", comparison: "gt", other_column: "cost" }]);
  assert.deepEqual(present?.rows.map((row) => row.country), ["US"]);
  assert.equal(transformResult(fixture, [{ op: "filter", column: "amount", comparison: "gt", other_column: "country" }]), null);
  const numericKeys: ResultTable = { columns: [{ name: "key", type: "decimal", unit: "人", label: "数字", scale: 2 }], rows: [{ key: "1.0" }, { key: "1.00" }, { key: "1e0" }, { key: null }] };
  const groups = transformResult(numericKeys, [{ op: "group", by: ["key"], aggregates: [{ op: "count_all", as: "n" }] }]);
  assert.deepEqual(groups?.rows.map((row) => ({ ...row })), [{ key: "1", n: "3" }, { key: null, n: "1" }]);
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

test("超过预览页的完整结果参与多步变换，NULL、真实零与精确和分开", () => {
  const data: ResultTable = {
    columns: [
      { name: "channel", type: "text", unit: "渠道", label: "渠道" },
      { name: "amount", type: "decimal", unit: "USD", label: "金额", scale: 2 },
    ],
    // 401 rows deliberately exceed both the old limit of 200 and a 100-row page.
    rows: Array.from({ length: 401 }, (_, index) => ({
      channel: index % 2 ? "B" : "A",
      amount: index === 0 ? "90071992547409.91" : index % 100 === 0 ? null : index % 2 ? "0.00" : "0.01",
    })),
  };
  const result = transformResult(data, [
    { op: "filter", column: "amount", comparison: "is_not_null" },
    { op: "sort", keys: [{ column: "amount", direction: "desc", nulls: "last" }] },
    { op: "group", by: ["channel"], aggregates: [{ op: "sum", column: "amount", as: "total" }, { op: "count_all", as: "n" }] },
  ]);
  assert.ok(result);
  assert.deepEqual(result.rows.map((row) => ({ ...row })).sort((a, b) => String(a.channel).localeCompare(String(b.channel))), [
    { channel: "A", total: "90071992547411.87", n: "197" },
    { channel: "B", total: "0.00", n: "200" },
  ]);
});

test("完整计算对行数、字节和步骤设硬边界，超过预算不以样本代替", () => {
  const columns: ResultTable["columns"] = [{ name: "item", type: "text", unit: "维度", label: "项目" }];
  const count: TransformStep[] = [{ op: "group", by: [], aggregates: [{ op: "count_all", as: "n" }] }];
  const rows = Array.from({ length: RESULT_CALCULATION_MAX_ROWS }, () => ({ item: "x" }));
  assert.equal(transformResult({ columns, rows }, [...count])?.rows[0]?.n, String(RESULT_CALCULATION_MAX_ROWS));
  assert.equal(transformResult({ columns, rows: [...rows, { item: "x" }] }, [...count]), null);
  const oversized = Array.from({ length: 8_000 }, () => ({ item: "x".repeat(255) }));
  assert.equal(transformResult({ columns, rows: oversized }, [...count]), null);
  const elevenSteps = Array.from({ length: 11 }, () => ({ op: "filter" as const, column: "item", comparison: "ne" as const, value: "y" }));
  assert.equal(transformResult({ columns, rows: [{ item: "x" }] }, elevenSteps), null);
});

test("超过 200 个分组做全集对齐，缺侧与零除数仍有独立状态", () => {
  const row = (group: string, value: string): VerifiedAggregate => ({ source_resource_id: "synthetic", table: "synthetic", column: "metric", output_column: "total", operation: "sum", value, scale: 0, unit: "人", description: "合成数量", filters: { product: "A" }, group: { channel: group }, range: { start: "2026-01-01", end: "2026-01-01", timezone: "UTC" }, prediction: "actual_observed_only" });
  const left = Array.from({ length: 301 }, (_, i) => row(`G${String(i).padStart(3, "0")}`, "6"));
  const right = Array.from({ length: 300 }, (_, i) => row(`G${String(i + 1).padStart(3, "0")}`, i === 0 ? "0" : "3"));
  const result = alignAggregates(left, right, ["channel"], "divide", computeArithmetic);
  assert.ok(result);
  assert.equal(result.length, 301);
  assert.equal(result[0]?.status, "missing_right");
  assert.equal(result[1]?.status, "zero_divisor");
  assert.equal(result[300]?.result?.value, "2.000000000000000000");
  assert.equal(alignAggregates([...left, left[0]!], right, ["channel"], "divide", computeArithmetic), null, "重复组不能冒充完整对齐");
});
