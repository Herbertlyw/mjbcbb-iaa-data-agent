import test from "node:test";
import assert from "node:assert/strict";
import { typedObservation } from "../src/typed-observation.js";
import type { QueryResource } from "../src/types.js";

test("有类型表达式观察保留大整数与 Decimal，不认证模型别名或单位", () => {
  const source = { engine: "clickhouse-local", sql_review_engine: "clickhouse_ast_direct", execution_id: "exec_1", truncated: false, sql_limited: false, complete_population: true, total_rows_exact: true, returned_rows: 1, total_rows: 1, columns: ["fake_profit", "counted"], column_types: { fake_profit: "Nullable(Decimal(38,2))", counted: "UInt64" }, rows: [{ fake_profit: "9007199254740993.25", counted: "18446744073709551615" }] } as unknown as QueryResource;
  const table = typedObservation(source);
  assert.deepEqual({ ...table?.rows[0] }, { fake_profit: "9007199254740993.25", counted: "18446744073709551615" });
  assert.equal(table?.columns[0]?.unit, "未认证");
  assert.doesNotMatch(table?.columns[0]?.label ?? "", /fake_profit/);
  assert.equal(typedObservation({ ...source, rows: [{ fake_profit: 9007199254740992, counted: "1" }] }), null, "Decimal 不能先转浮点");
  assert.equal(typedObservation({ ...source, rows: [{ fake_profit: "0.00", counted: "18446744073709551616" }] }), null, "不能超出数据库整数类型");
  assert.equal(typedObservation({ ...source, truncated: true }), null);
  assert.equal(typedObservation({ ...source, sql_limited: true }), null);
  assert.equal(typedObservation({ ...source, sql_review_engine: "legacy_guard" }), null);
  const floating = { ...source, columns: ["mean"], column_types: { mean: "Nullable(Float64)" }, rows: [{ mean: 73.33333333333333 }] };
  const floatTable = typedObservation(floating);
  assert.equal(floatTable?.rows[0]?.mean, "73.33333333333333");
  assert.equal(floatTable?.columns[0]?.approximate, true);
  assert.equal(typedObservation({ ...floating, rows: [{ mean: "NaN" }] }), null);
});
