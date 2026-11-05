import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { calculationSchema } from "../src/calculation-protocol.js";
import { analyst, bindTables, withRuntime } from "./helpers.js";

test("模型计算协议的 object 根和 operation 分支互斥，除法明确分子分母", () => {
  const ref = { resource_id: "res_a", execution_id: "exec_a", column: "amount", row: 0 };
  assert.equal(calculationSchema.type, "object");
  assert.equal(Check(calculationSchema, { operation: "divide", numerator: ref, denominator: ref }), true);
  assert.equal(Check(calculationSchema, { operation: "divide", left: ref, right: ref }), false);
  assert.equal(Check(calculationSchema, { operation: "add", left: ref, right: ref, operations: [] }), false);
  assert.equal(Check(calculationSchema, { operation: "add", left: { ...ref, aggregate: "sum" }, right: ref }), false);
  assert.equal(Check(calculationSchema, { operation: "add", left: { ...ref, execution_id: "" }, right: ref }), false);
});

test("新协议经过真实工具入口核验执行身份并组合分组与变换结果", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime); await bindTables(runtime, session.session_id, ["contract.daily_installs"]); runtime.sessions.setActiveJob(session.session_id, "job_protocol");
    const query = await runtime.tools.query(session.session_id, { sql: "SELECT event_date, new_users FROM daily_installs WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-08' AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'US' AND channel = 'nebula_ads'" });
    assert.ok(query.ok, JSON.stringify(query)); if (!query.ok) return;
    const input = { resource_id: String(query.resource_id), execution_id: String(query.execution_id) };
    const sum = await runtime.tools.calculateFromProtocol(session.session_id, { operation: "cells", input, operations: [{ op: "sum", column: "new_users", as: "total" }] });
    assert.ok(sum.ok, JSON.stringify(sum)); if (!sum.ok) return;
    assert.equal((sum.cells as Record<string, unknown>).total, 215);
    const ref = { resource_id: String(sum.resource_id), execution_id: String(sum.execution_id), column: "total", row: 0 };
    const doubled = await runtime.tools.calculateFromProtocol(session.session_id, { operation: "add", left: ref, right: ref });
    assert.ok(doubled.ok, JSON.stringify(doubled)); if (!doubled.ok) return;
    assert.equal((doubled.result as { value: string }).value, "430");
    const bad = await runtime.tools.calculateFromProtocol(session.session_id, { operation: "add", left: { ...ref, execution_id: "wrong" }, right: ref });
    assert.equal(bad.ok, false); if (!bad.ok) assert.equal(bad.code, "resource_execution_mismatch");
    const aggregate = await runtime.tools.query(session.session_id, { sql: "SELECT SUM(new_users) AS total FROM daily_installs WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-08' AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'US' AND channel = 'nebula_ads'" });
    assert.ok(aggregate.ok, JSON.stringify(aggregate)); if (!aggregate.ok) return;
    const aggregateRef = { resource_id: String(aggregate.resource_id), execution_id: String(aggregate.execution_id), column: "total", row: 0 };
    const aggregateSum = await runtime.tools.calculateFromProtocol(session.session_id, { operation: "add", left: aggregateRef, right: aggregateRef });
    assert.ok(aggregateSum.ok, JSON.stringify(aggregateSum)); if (aggregateSum.ok) assert.equal((aggregateSum.result as { value: string }).value, "430");
    const wrongAggregate = await runtime.tools.calculateFromProtocol(session.session_id, { operation: "add", left: { ...aggregateRef, execution_id: "wrong" }, right: aggregateRef });
    assert.equal(wrongAggregate.ok, false); if (!wrongAggregate.ok) assert.equal(wrongAggregate.code, "resource_execution_mismatch");
    const transform = await runtime.tools.calculateFromProtocol(session.session_id, { operation: "transform", input, steps: [{ op: "group", by: [], aggregates: [{ op: "sum", column: "new_users", as: "all_users" }] }] });
    assert.ok(transform.ok, JSON.stringify(transform)); if (!transform.ok) return;
    const transformed = { resource_id: String(transform.resource_id), execution_id: String(transform.execution_id), column: "all_users", row: 0 };
    const divided = await runtime.tools.calculateFromProtocol(session.session_id, { operation: "divide", numerator: transformed, denominator: transformed });
    assert.ok(divided.ok, JSON.stringify(divided)); if (divided.ok) assert.equal((divided.result as { value: string }).value, "1.000000000000000000");
  });
});
