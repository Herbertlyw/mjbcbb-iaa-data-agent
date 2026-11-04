import assert from "node:assert/strict";
import test from "node:test";
import { alignCompleteTables, type CompleteKeyedInput } from "../src/result-alignment.js";
import { computeArithmetic, type ArithmeticValue } from "../src/exact-arithmetic.js";
import type { ResultTable, ResultValue } from "../src/result-transform.js";

const columns: ResultTable["columns"] = [
  { name: "country", type: "text", unit: "维度 country", label: "虚构地区" },
  { name: "channel", type: "text", unit: "维度 channel", label: "虚构渠道" },
  { name: "amount", type: "decimal", unit: "USD", label: "合成金额", scale: 2 },
];
function input(rows: ResultTable["rows"], column = "amount", basisColumn = "amount"): CompleteKeyedInput {
  return {
    table: { columns: structuredClone(columns), rows }, valueColumn: column, keyColumns: ["country", "channel"],
    // Test metadata is host-generated; production callers must establish this
    // identity from contracts, not from the model or untrusted column labels.
    valueForGroup: (sum: string, _keys: ReadonlyArray<ResultValue>): ArithmeticValue => ({ value: sum, scale: 2, unit: "USD", basis: { table: "synthetic", column: basisColumn, operation: "sum", unit: "USD", prediction: "actual_observed_only", timezone: "UTC" }, scopes: [{ filters: {}, start: "2026-01-01", end: "2026-01-01" }] }),
  };
}
const calc = (op: Parameters<typeof computeArithmetic>[0], a: ArithmeticValue, b: ArithmeticValue) => computeArithmetic(op, a, b);

test("完整明细先分组再全键对齐：NULL 键、缺侧、全 NULL、部分 NULL 与零分母分开", () => {
  const left = input([
    { country: "JP", channel: "A", amount: "1.00" }, { country: "JP", channel: "A", amount: null },
    { country: "US", channel: "A", amount: "0.00" }, { country: null, channel: "A", amount: "6.00" },
    { country: "N", channel: "A", amount: null }, { country: "LEFT", channel: "A", amount: "5.00" },
  ]);
  const right = input([
    { country: "JP", channel: "A", amount: "2.00" }, { country: "US", channel: "A", amount: "0.00" },
    { country: null, channel: "A", amount: "3.00" }, { country: "N", channel: "A", amount: "1.00" },
    { country: "RIGHT", channel: "A", amount: "7.00" },
  ]);
  const rows = alignCompleteTables(left, right, "divide", calc);
  assert.ok(rows);
  const byCountry = (country: string | null) => rows.find((row) => row.group.country === country)!;
  assert.equal(byCountry(null).result?.value, "2.000000000000000000");
  assert.equal(byCountry("JP").result?.value, "0.500000000000000000");
  assert.deepEqual(byCountry("JP").left, { value: "1.00", count: 2, null_count: 1 });
  assert.equal(byCountry("JP").status, "partial_nulls");
  assert.equal(byCountry("US").status, "zero_divisor");
  assert.deepEqual(byCountry("US").left, { value: "0.00", count: 1, null_count: 0 });
  assert.equal(byCountry("N").status, "null_input");
  assert.equal(byCountry("N").left?.value, null);
  assert.equal(byCountry("LEFT").status, "missing_right");
  assert.equal(byCountry("RIGHT").status, "missing_left");
});

test("多页规模与大整数精确求和，半数远离零除法不经浮点", () => {
  const left = input(Array.from({ length: 271 }, (_, index) => ({ country: "S", channel: "A", amount: `${index + 1}.00` })));
  const right = input([{ country: "S", channel: "A", amount: "2.00" }]);
  const result = alignCompleteTables(left, right, "divide", calc);
  assert.equal(result?.[0]?.left?.count, 271);
  assert.equal(result?.[0]?.left?.value, "36856.00");
  assert.equal(result?.[0]?.result?.value, "18428.000000000000000000");
  const big = alignCompleteTables(input([{ country: "S", channel: "A", amount: "90071992547409.91" }, { country: "S", channel: "A", amount: "0.09" }]), right, "divide", calc);
  assert.equal(big?.[0]?.left?.value, "90071992547410.00");
  assert.equal(big?.[0]?.result?.value, "45035996273705.000000000000000000");
  const one = input([{ country: "S", channel: "A", amount: "-1.00" }]);
  const six = input([{ country: "S", channel: "A", amount: "6.00" }]);
  assert.equal(alignCompleteTables(one, six, "divide", calc)?.[0]?.result?.value, "-0.166666666666666667");
});

test("三百多个完整键全集不丢组，也不把缺侧或零分母当成零", () => {
  const region = (n: number) => `S${String(n).padStart(3, "0")}`;
  const left = input(Array.from({ length: 301 }, (_, i) => ({ country: region(i), channel: "A", amount: `${i}.00` })));
  const right = input(Array.from({ length: 301 }, (_, i) => ({ country: region(i + 1), channel: "A", amount: i === 0 ? "0.00" : "2.00" })));
  const rows = alignCompleteTables(left, right, "divide", calc);
  assert.equal(rows?.length, 302);
  const lookup = (name: string) => rows?.find((row) => row.group.country === name);
  assert.equal(lookup("S000")?.status, "missing_right");
  assert.equal(lookup("S001")?.status, "zero_divisor");
  assert.equal(lookup("S300")?.result?.value, "150.000000000000000000");
  assert.equal(lookup("S301")?.status, "missing_left");
});

test("无分组空输入、数值键归一、契约不兼容及预算均失败关闭", () => {
  const empty = input([]); empty.keyColumns = [];
  assert.equal(alignCompleteTables(empty, empty, "add", calc)?.[0]?.status, "empty_inputs");
  const a = input([{ country: "S", channel: "A", amount: "1.00" }]);
  const b = input([{ country: "S", channel: "A", amount: "2.00" }], "amount", "other_metric");
  assert.equal(alignCompleteTables(a, b, "divide", calc), null, "不同指标必须由宿主契约明确允许");
  assert.equal(alignCompleteTables(a, b, "divide", (op, x, y) => computeArithmetic(op, x, y, true))?.[0]?.result?.value, "0.500000000000000000");
  const incompatible = structuredClone(b.table); incompatible.columns[0]!.unit = "维度 unrelated";
  assert.equal(alignCompleteTables(a, { ...b, table: incompatible }, "add", calc), null);
  const wrongType = structuredClone(b.table); wrongType.columns[0]!.type = "boolean";
  assert.equal(alignCompleteTables(a, { ...b, table: wrongType }, "add", calc), null);
  const broken = input([{ country: "S", channel: "A", amount: "not-a-number" }]);
  assert.equal(alignCompleteTables(broken, a, "add", calc), null);
  const oversized = input(Array.from({ length: 10_001 }, () => ({ country: "S", channel: "A", amount: "1.00" })));
  assert.equal(alignCompleteTables(oversized, a, "add", calc), null);
  const numericKey: ResultTable = { columns: [{ name: "k", type: "decimal", unit: "维度 k", label: "键", scale: 2 }, columns[2]!], rows: [{ k: "1.0", amount: "1.00" }, { k: "1.00", amount: "2.00" }] };
  const one = { ...a, table: numericKey, keyColumns: ["k"] };
  const two = { ...a, table: { ...numericKey, rows: [{ k: "1", amount: "3.00" }] }, keyColumns: ["k"] };
  const aligned = alignCompleteTables(one, two, "divide", calc);
  assert.equal(aligned?.length, 1); assert.equal(aligned?.[0]?.result?.value, "1.000000000000000000");
});
