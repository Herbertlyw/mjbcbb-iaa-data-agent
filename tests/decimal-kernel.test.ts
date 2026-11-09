import assert from "node:assert/strict";
import test from "node:test";
import { decimalOperation, normalizeDecimal, parseDecimal, sumDecimals } from "../src/decimal-kernel.js";
import { computeArithmetic, sumDecimalStrings, type ArithmeticValue } from "../src/exact-arithmetic.js";
import { calculateResultCells } from "../src/result-cells.js";
import { transformResult, type ResultTable } from "../src/result-transform.js";

test("共享十进制内核保留大数、指数与负数舍入，并拒绝溢出", () => {
  assert.equal(normalizeDecimal("+001.2300e+2"), "123");
  assert.equal(normalizeDecimal("-0.00"), "0");
  assert.equal(sumDecimals(["90071992547409.91", "1e-2", "-0.02"], 2), "90071992547409.90");
  assert.equal(decimalOperation("subtract", "90071992547409.91", "1.00", 2), "90071992547408.91");
  assert.equal(decimalOperation("divide", "-1", "200", 2), "-0.01");
  assert.equal(decimalOperation("divide", "-1", "201", 2), "0.00");
  assert.equal(decimalOperation("divide", "1", "0", 18), null);
  assert.equal(decimalOperation("add", "0.001", "1", 2), undefined);
  assert.equal(decimalOperation("multiply", "9".repeat(76), "10", 0), undefined);
  assert.equal(parseDecimal("1e999"), null);
  assert.equal(sumDecimals([], 2), null);
  assert.equal(sumDecimalStrings(["1.001"], 2), null, "严格金额接口不能默默截掉精度");
});

test("单元、分组与标量四则共用数学结果，输入路径不改变金额", () => {
  const table: ResultTable = { columns: [
    { name: "income", type: "decimal", scale: 2, unit: "USD", label: "合成流水" },
    { name: "cost", type: "decimal", scale: 2, unit: "USD", label: "合成成本" },
  ], rows: [{ income: "1.00", cost: "2.00" }] };
  const transformed = transformResult(table, [{ op: "subtract", left: "income", right: "cost", as: "delta" }], () => true);
  const cells = transformed && calculateResultCells(transformed, [{ op: "sum", column: "delta", as: "total" }]);
  const basis = { table: "synthetic", column: "amount", operation: "sum", unit: "USD", prediction: "actual", timezone: "UTC" };
  const make = (value: string): ArithmeticValue => ({ value, scale: 2, unit: "USD", basis, scopes: [{ filters: {}, start: "2026-10-08", end: "2026-10-08" }] });
  assert.equal(cells?.table.rows[0]?.total, "-1.00");
  assert.equal(computeArithmetic("subtract", make("1.00"), make("2.00"))?.value, "-1.00");
  assert.equal(computeArithmetic("divide", make("1.00"), make("0.09"))?.value, "11.111111111111111111");
  assert.equal(transformResult({ ...table, rows: [{ income: "1.00", cost: "0.09" }] }, [{ op: "divide", left: "income", right: "cost", as: "ratio" }], () => true)?.rows[0]?.ratio, "11.111111111111111111");
});

test("实际和预测分开计算，空集与全 NULL 不变成零", () => {
  const table: ResultTable = { columns: [
    { name: "amount", type: "decimal", scale: 2, unit: "USD", label: "合成金额" },
    { name: "forecast", type: "decimal", scale: 0, unit: "标记", label: "预测标记" },
  ], prediction: { column: "forecast", actual: "0", predicted: "1" }, rows: [
    { amount: "1.00", forecast: "0" }, { amount: "0.00", forecast: "0" }, { amount: null, forecast: "0" }, { amount: "2.00", forecast: "1" },
  ] };
  const calculated = calculateResultCells(table, [
    { op: "sum", column: "amount", predicted: "actual_only", as: "actual" },
    { op: "sum", column: "amount", predicted: "predicted_only", as: "forecast" },
    { op: "count_null", column: "amount", predicted: "actual_only", as: "missing" },
    { op: "count_zero", column: "amount", predicted: "actual_only", as: "zeros" },
  ]);
  assert.deepEqual({ ...calculated?.table.rows[0] }, { actual: "1.00", forecast: "2.00", missing: "1", zeros: "1" });
  assert.equal(calculated?.incomplete, true);
  const mixed = calculateResultCells(table, [{ op: "sum", column: "amount", as: "mixed" }]);
  assert.equal(mixed?.table.rows[0]?.mixed, null);
  assert.equal(mixed?.incomplete, true);
  const actualCells = calculateResultCells(table, [{ op: "sum", column: "amount", predicted: "actual_only", as: "total" }]);
  assert.equal(actualCells?.table.prediction_scope, "observed_only");
  const actual = transformResult(table, [{ op: "filter", column: "forecast", comparison: "eq", value: "0" }]);
  assert.equal(actual?.prediction_scope, "observed_only");
  assert.equal(calculateResultCells({ ...table, rows: [{ amount: null, forecast: "0" }] }, [{ op: "sum", column: "amount", predicted: "actual_only", as: "total" }])?.table.rows[0]?.total, null);
});
