import assert from "node:assert/strict";
import test from "node:test";
import { compareDecimalAggregates, compareVerifiedDecimalCells } from "../src/aggregate-comparison.js";
import type { VerifiedAggregate } from "../src/aggregate-evidence.js";

function cell(value: string, resource: string, date: string, scale = 2): VerifiedAggregate {
  return { source_resource_id: resource, table: "synthetic_amount", column: "amount", output_column: "total", operation: "sum", value, scale, unit: "USD", description: "合成金额", filters: { country: "US" }, group: {}, range: { start: date, end: date, timezone: "America/Los_Angeles" }, prediction: "actual_observed_only" };
}

test("精确金额比较使用定点整数、半数远离零，并拒绝不兼容或零分母", () => {
  const huge = compareDecimalAggregates(cell("90071992547409.91", "a", "2026-10-06"), cell("1.00", "b", "2026-10-07"));
  assert.deepEqual([huge?.difference, huge?.ratio, huge?.change_percent], ["90071992547408.91", "90071992547409.9100", "9007199254740891.00"]);
  const rounded = compareDecimalAggregates(cell("1.000", "a", "2026-10-06", 3), cell("32.000", "b", "2026-10-07", 3));
  assert.deepEqual([rounded?.difference, rounded?.ratio, rounded?.change_percent], ["-31.000", "0.0313", "-96.88"]);
  const negative = compareDecimalAggregates(cell("-1.00", "a", "2026-10-06"), cell("8.00", "b", "2026-10-07"));
  assert.deepEqual([negative?.difference, negative?.ratio, negative?.change_percent], ["-9.00", "-0.1250", "-112.50"]);
  const zero = compareDecimalAggregates(cell("1.00", "a", "2026-10-06"), cell("0.00", "b", "2026-10-07"));
  assert.deepEqual([zero?.difference, zero?.ratio, zero?.change_percent], ["1.00", null, null]);
  assert.equal(compareDecimalAggregates(cell("1.00", "a", "2026-10-06"), { ...cell("8.00", "b", "2026-10-07"), unit: "EUR" }), null);
  assert.equal(compareDecimalAggregates(cell("1.00", "a", "2026-10-06"), { ...cell("8.00", "b", "2026-10-07"), group: { country: "JP" } }), null);
  assert.equal(compareDecimalAggregates(cell("1.00", "a", "2026-10-06"), cell("8.00", "a", "2026-10-07")), null);
});

test("已验证的整数字符串和 Decimal 单元可比较，范围与单位不符仍拒绝", () => {
  const direct = (value: string, id: string, day: string) => ({ value, table: "fact_activity_daily", column: "active_devices", unit: "设备×App", description: "当日活跃", filters: { app_id: "synthetic_app" }, range: { start: day, end: day, timezone: "UTC" }, source_resource_id: id, prediction: "actual_observed_only" as const });
  const left = direct("9007199254740993", "query_a", "2026-11-01");
  const right = direct("9007199254740991", "query_b", "2026-11-06");
  assert.equal(compareVerifiedDecimalCells(left, right, "first", "second")?.difference, "2");
  assert.equal(compareVerifiedDecimalCells(left, { ...right, unit: "人" }, "first", "second"), null);
  assert.equal(compareVerifiedDecimalCells(left, { ...right, source_resource_id: "query_a" }, "first", "second"), null);
  assert.equal(compareVerifiedDecimalCells(left, { ...right, filters: {} }, "first", "second"), null);
  assert.equal(compareVerifiedDecimalCells(left, { ...right, range: left.range }, "first", "second"), null);
  const a = { ...left, value: "1.500000", unit: "USD" }, b = { ...right, value: "0.500000", unit: "USD" };
  assert.equal(compareVerifiedDecimalCells(a, b, "a", "b")?.difference, "1.000000");
  assert.equal(compareVerifiedDecimalCells(a, { ...b, value: "0.000000" }, "a", "b")?.ratio, null);
  assert.equal(compareVerifiedDecimalCells(a, { ...b, value: "1.1234567" }, "a", "b"), null);
});
