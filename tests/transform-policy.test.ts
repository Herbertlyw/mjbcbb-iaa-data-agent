import assert from "node:assert/strict";
import test from "node:test";
import { loadKnowledge } from "../src/knowledge.js";
import { ToolService } from "../src/tools.js";
import type { ResultTable, TransformStep } from "../src/result-transform.js";

test("JOIN 比率必须有契约方向；NULL 或零分母在完整变换后仍标记部分", () => {
  const knowledge = loadKnowledge("knowledge/harborlight");
  // Exercise the actual host policy, rather than granting the transform
  // callback unconditionally. Real resource construction is covered by the
  // separate ClickHouse/Pi integration test.
  const service = Object.create(ToolService.prototype) as { ctx: unknown; applyProvenTransform: (table: ResultTable, steps: TransformStep[]) => { table: ResultTable; undefinedDivide: boolean } | null };
  service.ctx = { knowledge };
  const metric = (column: string) => ({ table: "fact_fox_daily_payment", column, operation: "sum" as const });
  const input: ResultTable = { columns: [
    { name: "revenue", type: "decimal", unit: "USD", label: "收入", scale: 2, metric: metric("amount_usd") },
    { name: "cost", type: "decimal", unit: "USD", label: "成本", scale: 2, metric: metric("cost_usd") },
  ], rows: [{ revenue: "5.00", cost: "2.00" }, { revenue: "1.00", cost: "0.00" }, { revenue: null, cost: "2.00" }] };
  const ratio: TransformStep = { op: "divide", left: "revenue", right: "cost", as: "ratio" };
  const result = service.applyProvenTransform(input, [ratio, { op: "filter", column: "ratio", comparison: "is_not_null" }]);
  assert.ok(result); assert.equal(result.undefinedDivide, true);
  assert.deepEqual(result.table.rows.map((row) => row.ratio), ["2.500000000000000000"]);
  assert.equal(service.applyProvenTransform(input, [{ op: "divide", left: "cost", right: "revenue", as: "ratio" }]), null, "反向关系未声明");
  const forgedUnit = structuredClone(input); forgedUnit.columns[0]!.unit = "人";
  assert.equal(service.applyProvenTransform(forgedUnit, [ratio]), null);
  const unproven = structuredClone(input); delete unproven.columns[0]!.metric;
  assert.equal(service.applyProvenTransform(unproven, [ratio]), null);
  assert.equal(service.applyProvenTransform(input, [
    { op: "group", by: [], aggregates: [{ op: "sum", column: "revenue", as: "revenue" }, { op: "sum", column: "cost", as: "cost" }] }, ratio,
  ]), null, "聚合后不能自动声称原始粒度和指标关系");
});
