import assert from "node:assert/strict";
import test from "node:test";
import { loadKnowledge } from "../src/knowledge.js";
import { ResultPolicy } from "../src/result-policy.js";
import type { ResultTable, TransformStep } from "../src/result-transform.js";

test("JOIN 比率必须有契约方向；NULL 或零分母在完整变换后仍标记部分", () => {
  const knowledge = loadKnowledge("knowledge/harborlight");
  // Exercise the actual host policy, rather than granting the transform
  // callback unconditionally. Real resource construction is covered by the
  // separate ClickHouse/Pi integration test.
  const service = new ResultPolicy(knowledge);
  const metric = (column: string) => ({ table: "fact_fox_daily_payment", column, operation: "sum" as const });
  const input: ResultTable = { columns: [
    { name: "revenue", type: "decimal", unit: "USD", label: "收入", scale: 2, metric: metric("amount_usd") },
    { name: "cost", type: "decimal", unit: "USD", label: "成本", scale: 2, metric: metric("cost_usd") },
  ], rows: [{ revenue: "5.00", cost: "2.00" }, { revenue: "1.00", cost: "0.00" }, { revenue: null, cost: "2.00" }] };
  const ratio: TransformStep = { op: "divide", left: "revenue", right: "cost", as: "ratio" };
  const result = service.applyProvenTransform(input, [ratio, { op: "filter", column: "ratio", comparison: "is_not_null" }]);
  assert.ok(result); assert.equal(result.undefinedArithmetic, true);
  assert.deepEqual(result.table.rows.map((row) => row.ratio), ["2.500000000000000000"]);
  assert.equal(service.applyProvenTransform(input, [{ op: "divide", left: "cost", right: "revenue", as: "ratio" }]), null, "反向关系未声明");
  const difference = service.applyProvenTransform(input, [{ op: "subtract", left: "revenue", right: "cost", as: "difference" }]);
  assert.deepEqual(difference?.table.rows.map((row) => row.difference), ["3.00", "1.00", null]);
  assert.equal(difference?.undefinedArithmetic, true);
  assert.equal(service.applyProvenTransform(input, [{ op: "subtract", left: "cost", right: "revenue", as: "difference" }]), null, "方向必须契约声明");
  assert.equal(service.applyProvenTransform(input, [{ op: "add", left: "revenue", right: "cost", as: "sum" }]), null, "相同币种不自动代表允许相加");
  const forgedUnit = structuredClone(input); forgedUnit.columns[0]!.unit = "人";
  assert.equal(service.applyProvenTransform(forgedUnit, [ratio]), null);
  const unproven = structuredClone(input); delete unproven.columns[0]!.metric;
  assert.equal(service.applyProvenTransform(unproven, [ratio]), null);
  assert.equal(service.applyProvenTransform(input, [
    { op: "group", by: [], aggregates: [{ op: "sum", column: "revenue", as: "revenue" }, { op: "sum", column: "cost", as: "cost" }] }, ratio,
  ]), null, "聚合后不能自动声称原始粒度和指标关系");
});

test("已授权 JOIN 的观察分组比率保留部分状态，NULL 和零分母不变成零", () => {
  const service = new ResultPolicy(loadKnowledge("knowledge/starhaven"));
  const metric = (column: string) => ({ table: "fact_delivery_daily", column, operation: "sum" as const });
  const input: ResultTable = { columns: [
    { name: "cost", type: "decimal", unit: "USD", label: "折后成本", scale: 6, metric: metric("discounted_cost_usd") },
    { name: "registrations", type: "decimal", unit: "报表注册", label: "注册", scale: 0, metric: metric("af_registers") },
  ], rows: [{ cost: "3.362699", registrations: "2" }, { cost: "0.000000", registrations: "0" }, { cost: null, registrations: "1" }] };
  const recipe: TransformStep[] = [{ op: "divide", left: "cost", right: "registrations", as: "ratio" }];
  assert.equal(service.applyProvenTransform(input, recipe), null, "仅有指标标签不能代替来源授权");
  const observed = service.applyProvenTransform(input, recipe, true); assert.ok(observed);
  assert.equal(observed.observedPartialArithmetic, true);
  assert.equal(observed.undefinedArithmetic, true);
  assert.deepEqual(observed.table.rows.map((row) => row.ratio), ["1.681349500000000000", null, null]);
  assert.equal(service.applyProvenTransform(input, [{ op: "divide", left: "registrations", right: "cost", as: "ratio" }], true), null);
  const wrongUnit = structuredClone(input); wrongUnit.columns[0]!.unit = "人";
  assert.equal(service.applyProvenTransform(wrongUnit, recipe, true), null);
  const mixed = structuredClone(input); mixed.columns[1]!.metric!.table = "fact_activity_daily";
  assert.equal(service.applyProvenTransform(mixed, recipe, true), null);
  const unproven = structuredClone(input); delete unproven.columns[0]!.metric;
  assert.equal(service.applyProvenTransform(unproven, recipe, true), null);
});
