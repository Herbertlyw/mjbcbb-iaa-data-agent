import test from "node:test";
import assert from "node:assert/strict";
import { calculateResultCells } from "../src/result-cells.js";
import type { ResultTable } from "../src/result-transform.js";

test("已验证表的单元计算区分精确数值、零、NULL 和空集", () => {
  const input: ResultTable = { columns: [{ name: "amount", type: "decimal", unit: "USD", label: "受限合成数值", scale: 2 }], rows: [{ amount: "9007199254740993.20" }, { amount: "0.00" }, { amount: null }] };
  const ops = [{ op: "sum", column: "amount", as: "total" }, { op: "count_null", column: "amount", as: "missing" }, { op: "count_zero", column: "amount", as: "zeros" }, { op: "count_rows", as: "rows" }] as const;
  const result = calculateResultCells(input, [...ops]);
  assert.deepEqual({ ...result?.table.rows[0] }, { total: "9007199254740993.20", missing: "1", zeros: "1", rows: "3" });
  assert.equal(result?.incomplete, true);
  const empty = calculateResultCells({ ...input, rows: [] }, [{ op: "sum", column: "amount", as: "total" }]);
  assert.equal(empty?.table.rows[0]?.total, null);
  assert.equal(empty?.incomplete, true);
  assert.equal(calculateResultCells(input, [{ op: "sum", column: "amount", as: "x", predicted: "actual_only" }]), null);
  const observed: ResultTable = { ...input, prediction_scope: "observed_only" };
  const actual = calculateResultCells(observed, [{ op: "sum", column: "amount", as: "x", predicted: "actual_only" }]);
  assert.equal(actual?.table.rows[0]?.x, "9007199254740993.20");
  assert.equal(actual?.table.prediction_scope, "observed_only");
  assert.equal(calculateResultCells(observed, [{ op: "sum", column: "amount", as: "x", predicted: "predicted_only" }]), null);
  assert.equal(calculateResultCells(input, [{ op: "count_zero", column: "unknown", as: "x" }]), null);
  assert.equal(calculateResultCells(input, [{ op: "count_rows", as: "x" }, { op: "count_rows", as: "x" }]), null);
});
