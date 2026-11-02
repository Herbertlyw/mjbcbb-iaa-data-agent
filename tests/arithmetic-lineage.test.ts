import assert from "node:assert/strict";
import test from "node:test";
import { analyst, bindTables, withRuntime } from "./helpers.js";
import type { ArithmeticRef, ArithmeticResource } from "../src/types.js";
import { computeArithmetic, type ArithmeticValue } from "../src/exact-arithmetic.js";

test("定点除法 18 位、半数远离零以及大数不经过浮点", () => {
  const value = (amount: string): ArithmeticValue => ({ value: amount, scale: 0, unit: "人", basis: { table: "synthetic", column: "count", operation: "sum", unit: "人", prediction: "actual", timezone: "UTC" }, scopes: [{ filters: { region: "A" }, start: "2026-01-01", end: "2026-01-01" }] });
  assert.equal(computeArithmetic("divide", value("1"), value("6"))?.value, "0.166666666666666667");
  assert.equal(computeArithmetic("divide", value("-1"), value("6"))?.value, "-0.166666666666666667");
  assert.equal(computeArithmetic("multiply", value("9007199254740993"), value("3"))?.value, "27021597764222979");
  assert.equal(computeArithmetic("divide", value("1"), value("0"))?.value, null);
});

test("同任务聚合的四则运算可递归复核，零分母、篡改和跨任务失败关闭", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    runtime.sessions.setActiveJob(session.session_id, "job_arithmetic");
    async function day(date: string): Promise<ArithmeticRef> {
      const query = await runtime.tools.query(session.session_id, { sql: `SELECT SUM(new_users) AS total FROM daily_installs WHERE event_date >= '${date}' AND event_date <= '${date}' AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'US' AND channel = 'nebula_ads'` });
      assert.equal(query.ok, true, JSON.stringify(query));
      if (!query.ok) throw new Error("query failed");
      return { resource_id: String(query.resource_id), cell: "total" };
    }
    const a = await day("2026-10-06"); const b = await day("2026-10-08"); const zero = await day("2026-10-07");
    async function calculate(op: "add" | "subtract" | "multiply" | "divide", left: ArithmeticRef, right: ArithmeticRef) {
      const result = await runtime.tools.calculateSessionCells(session.session_id, { arithmetic: { op, left, right } });
      assert.equal(result.ok, true, JSON.stringify(result));
      if (!result.ok) throw new Error("arithmetic failed");
      return { ref: { resource_id: String(result.resource_id), cell: "result" }, value: (result.result as { value: string | null }).value };
    }
    const sum = await calculate("add", a, b);
    const minus = await calculate("subtract", a, b);
    const product = await calculate("multiply", a, b);
    const ratio = await calculate("divide", b, a);
    const chain = await calculate("divide", sum.ref, a);
    const invalid = await calculate("divide", b, zero);
    assert.deepEqual([sum.value, minus.value, product.value, ratio.value, chain.value, invalid.value], ["215", "25", "11400", "0.791666666666666667", "1.791666666666666667", null]);
    const grouped = await runtime.tools.query(session.session_id, { sql: "SELECT country_code, SUM(new_users) AS total FROM daily_installs WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-06' AND product_id = 'starlane_drift' AND platform = 'ios' AND channel = 'nebula_ads' GROUP BY country_code" });
    assert.equal(grouped.ok, true);
    if (!grouped.ok) return;
    const us: ArithmeticRef = { resource_id: String(grouped.resource_id), cell: "total", group: { country_code: "US" } };
    const jp: ArithmeticRef = { resource_id: String(grouped.resource_id), cell: "total", group: { country_code: "JP" } };
    const acrossGroups = await calculate("add", us, jp);
    assert.equal(acrossGroups.value, "130");
    async function rawCell(date: string): Promise<{ query: string; cell: ArithmeticRef }> {
      const query = await runtime.tools.query(session.session_id, { sql: `SELECT event_date, new_users FROM daily_installs WHERE event_date >= '${date}' AND event_date <= '${date}' AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'US' AND channel = 'nebula_ads'` });
      assert.equal(query.ok, true);
      if (!query.ok) throw new Error("detail query failed");
      const calc = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: String(query.resource_id), operations: [{ op: "sum", column: "new_users", as: "total" }] });
      assert.equal(calc.ok, true);
      if (!calc.ok) throw new Error("detail calculation failed");
      return { query: String(query.resource_id), cell: { resource_id: String(calc.resource_id), cell: "total" } };
    }
    const rawA = await rawCell("2026-10-06"); const rawB = await rawCell("2026-10-08");
    const fromCells = await calculate("subtract", rawA.cell, rawB.cell);
    assert.equal(fromCells.value, "25");
    const fromCellsAnswer = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [rawA.query, rawB.query, rawA.cell.resource_id, rawB.cell.resource_id, fromCells.ref.resource_id] });
    assert.equal(fromCellsAnswer.ok, true);
    if (fromCellsAnswer.ok) { assert.equal(fromCellsAnswer.status, "completed"); assert.match(String(fromCellsAnswer.answer), /四则运算 subtract：25 人/); }
    const absentGroup = await runtime.tools.calculateSessionCells(session.session_id, { arithmetic: { op: "add", left: us, right: { ...jp, group: { country_code: "DE" } } } });
    assert.equal(absentGroup.ok, false);
    const ids = [a.resource_id, b.resource_id, zero.resource_id, sum.ref.resource_id, chain.ref.resource_id];
    const answer = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: ids });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    if (answer.ok) {
      assert.equal(answer.status, "completed");
      assert.match(String(answer.answer), /1\.791666666666666667/);
      assert.equal((answer.arithmetic_results as unknown[]).length, 2);
    }
    const noZero = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [b.resource_id, zero.resource_id, invalid.ref.resource_id] });
    assert.equal(noZero.ok, true);
    if (noZero.ok) { assert.equal(noZero.status, "partial"); assert.match(String(noZero.answer), /除数为零，结果不可计算/); }
    const stored = runtime.sessions.lookupResource(session.session_id, sum.ref.resource_id);
    assert.ok(stored.ok && stored.resource.kind === "arithmetic");
    if (!stored.ok || stored.resource.kind !== "arithmetic") return;
    runtime.state.saveResource({ ...stored.resource, result: { ...stored.resource.result, value: "999999" } } as ArithmeticResource);
    const tampered = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: ids });
    assert.equal(tampered.ok, true);
    if (tampered.ok) { assert.notEqual(tampered.status, "completed"); assert.doesNotMatch(String(tampered.answer), /999999/); assert.ok((tampered.server_reasons as string[]).includes("arithmetic_lineage_unsupported")); }
    runtime.state.saveResource({ ...stored.resource, left: { resource_id: stored.resource.resource_id, cell: "result" } } as ArithmeticResource);
    const cycle = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: ids });
    assert.equal(cycle.ok, true);
    if (cycle.ok) assert.ok((cycle.server_reasons as string[]).includes("arithmetic_lineage_unsupported"));
    runtime.sessions.setActiveJob(session.session_id, "job_other");
    const foreign = await runtime.tools.calculateSessionCells(session.session_id, { arithmetic: { op: "add", left: a, right: b } });
    assert.equal(foreign.ok, false);
  });
});
