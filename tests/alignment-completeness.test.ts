import assert from "node:assert/strict";
import test from "node:test";
import { alignmentHasUnresolvedRows } from "../src/alignment-completeness.js";
import { computeArithmetic, type ArithmeticValue } from "../src/exact-arithmetic.js";
import type { AlignedRow } from "../src/result-alignment.js";
import { alignAggregates } from "../src/result-alignment.js";
import { renderAlignment } from "../src/analysis-renderer.js";
import type { VerifiedAggregate } from "../src/aggregate-evidence.js";
import type { AlignmentResource } from "../src/types.js";

test("完整精确零分母不是缺项；NULL、缺组、截断和未认证范围仍不完整", () => {
  const input = (value: string, column: string): ArithmeticValue => ({ value, scale: 0, unit: "人", basis: { table: "synthetic", column, operation: "sum", unit: "人", prediction: "actual_observed_only", timezone: "UTC" }, scopes: [{ filters: { channel: "organic" }, start: "2026-01-01", end: "2026-01-01" }] });
  for (const column of ["registrations", "active", "conversions"]) {
    const left = input("10", column); const right = input("0", column);
    const result = computeArithmetic("divide", left, right)!;
    const row: AlignedRow = { group: { channel: "organic" }, status: "zero_divisor", left, right, result, left_null_count: 0, right_null_count: 0 };
    assert.equal(alignmentHasUnresolvedRows([row]), false);
    assert.equal(alignmentHasUnresolvedRows([{ ...row, left_null_count: 1 }]), true);
    assert.equal(alignmentHasUnresolvedRows([{ ...row, status: "missing_right", right: null }]), true);
    assert.equal(alignmentHasUnresolvedRows([{ ...row, group: { channel: null } }]), true);
    assert.equal(alignmentHasUnresolvedRows([{ ...row, result: { ...result, partial: true } }]), true);
    assert.equal(alignmentHasUnresolvedRows([{ ...row, result: { ...result, scope_unverified: true } }]), true);
    assert.equal(alignmentHasUnresolvedRows([{ ...row, result: { ...result, undefined_reason: "null_input" } }]), true);
  }
});

test("两渠道独立合成结果保留 100/20=5 与 0/0 未知，不把缺侧补零", () => {
  const aggregate = (column: string, unit: string, group: string, value: string): VerifiedAggregate => ({ source_resource_id: `res_${column}`, table: "synthetic", column, output_column: column, operation: "sum", value, scale: 0, unit, description: column, filters: { product: "sample" }, group: { channel: group }, range: { start: "2026-01-01", end: "2026-01-01", timezone: "UTC" }, prediction: "actual_observed_only" });
  const cost = [aggregate("cost", "USD", "paid", "100"), aggregate("cost", "USD", "organic", "0")];
  const count = [aggregate("registrations", "人", "paid", "20"), aggregate("registrations", "人", "organic", "0")];
  const rows = alignAggregates(cost, count, ["channel"], "divide", (op, a, b) => computeArithmetic(op, a, b, true));
  assert.ok(rows);
  assert.deepEqual(rows.map((row) => [row.group.channel, row.result?.value, row.status]), [["organic", null, "zero_divisor"], ["paid", "5.000000000000000000", "matched"]]);
  assert.equal(alignmentHasUnresolvedRows(rows), false);
  const resource: AlignmentResource = { kind: "alignment", resource_id: "res_alignment", session_id: "ses_synthetic", job_id: "job_synthetic", created_at: "2026-01-01T00:00:00Z", spec: { op: "divide", keys: ["channel"], left: { resource_id: "res_cost", cell: "cost" }, right: { resource_id: "res_registrations", cell: "registrations" } }, input_hashes: {}, rows, input_truncated: false, complete_population: true };
  const text = renderAlignment(resource, rows).join("\n");
  assert.match(text, /channel=organic.*除数为零/);
  assert.match(text, /channel=paid.*100 USD.*20 人.*5\.000000000000000000/);
  const missing = alignAggregates(cost, count.filter((item) => item.group.channel === "paid"), ["channel"], "divide", (op, a, b) => computeArithmetic(op, a, b, true));
  assert.ok(missing);
  assert.equal(alignmentHasUnresolvedRows(missing), true);
});
