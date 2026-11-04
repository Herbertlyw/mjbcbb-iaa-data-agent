import assert from "node:assert/strict";
import test from "node:test";
import { analyst, bindTables, withRuntime } from "./helpers.js";
import type { ArithmeticRef, ArithmeticResource } from "../src/types.js";
import { computeArithmetic, isExactZero, type ArithmeticValue } from "../src/exact-arithmetic.js";

test("定点除法 18 位、半数远离零以及大数不经过浮点", () => {
  const value = (amount: string): ArithmeticValue => ({ value: amount, scale: 0, unit: "人", basis: { table: "synthetic", column: "count", operation: "sum", unit: "人", prediction: "actual", timezone: "UTC" }, scopes: [{ filters: { region: "A" }, start: "2026-01-01", end: "2026-01-01" }] });
  assert.equal(computeArithmetic("divide", value("1"), value("6"))?.value, "0.166666666666666667");
  assert.equal(computeArithmetic("divide", value("-1"), value("6"))?.value, "-0.166666666666666667");
  assert.equal(computeArithmetic("multiply", value("9007199254740993"), value("3"))?.value, "27021597764222979");
  assert.equal(computeArithmetic("divide", value("1"), value("0"))?.value, null);
  const revenue = value("9"); const cost = value("3"); cost.basis = { ...cost.basis, column: "other" };
  assert.equal(computeArithmetic("divide", revenue, cost), null, "不同指标不能因数值或单位相同就自动比较");
  assert.equal(computeArithmetic("divide", revenue, cost, true)?.value, "3.000000000000000000");
  const otherCountry = { ...cost, scopes: [{ ...cost.scopes[0]!, filters: { region: "B" } }] };
  assert.equal(computeArithmetic("divide", revenue, otherCountry, true), null, "不同指标必须使用相同范围");
  for (const observed of [0, "0", "0.00", "-0.000"]) assert.equal(isExactZero(observed), true);
  for (const missing of [null, "", "0.01", "1e-9", "NULL"]) assert.equal(isExactZero(missing), false);
});

test("引用明细行和整列时绑定执行号、范围及当前任务", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime); await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    runtime.sessions.setActiveJob(session.session_id, "job_raw_arithmetic");
    const query = await runtime.tools.query(session.session_id, { sql: "SELECT event_date, country_code, new_users FROM daily_installs WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-06' AND product_id = 'starlane_drift' AND platform = 'ios' AND channel = 'nebula_ads'" });
    assert.equal(query.ok, true, JSON.stringify(query)); if (!query.ok) return;
    const rows = query.rows as Array<{ country_code: string }>;
    const ref = { resource_id: String(query.resource_id), execution_id: String(query.execution_id), cell: "new_users" };
    const jp = { ...ref, row: rows.findIndex((row) => row.country_code === "JP") };
    const us = { ...ref, row: rows.findIndex((row) => row.country_code === "US") };
    const add = await runtime.tools.calculateSessionCells(session.session_id, { arithmetic: { op: "add", left: jp, right: us } });
    assert.equal(add.ok, true, JSON.stringify(add)); if (add.ok) assert.equal((add.result as { value: string }).value, "130");
    const sum = { ...ref, aggregate: "sum" as const };
    const doubled = await runtime.tools.calculateSessionCells(session.session_id, { arithmetic: { op: "add", left: sum, right: sum } });
    assert.equal(doubled.ok, true, JSON.stringify(doubled)); if (doubled.ok) assert.equal((doubled.result as { value: string }).value, "260");
    const wrong = await runtime.tools.calculateSessionCells(session.session_id, { arithmetic: { op: "add", left: { ...jp, execution_id: "wrong" }, right: us } });
    assert.equal(wrong.ok, false);
    const missing = await runtime.tools.calculateSessionCells(session.session_id, { arithmetic: { op: "add", left: { ...jp, row: 999 }, right: us } });
    assert.equal(missing.ok, false);
    const unboundMulti = await runtime.tools.calculateSessionCells(session.session_id, { arithmetic: { op: "add", left: { resource_id: ref.resource_id, cell: ref.cell, row: 0 }, right: us } });
    assert.equal(unboundMulti.ok, false, "多行结果不能隐式选择执行 ID");
    const single = await runtime.tools.query(session.session_id, { sql: "SELECT event_date, country_code, new_users FROM daily_installs WHERE event_date = '2026-10-06' AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'US' AND channel = 'nebula_ads'" });
    assert.equal(single.ok, true); if (!single.ok) return;
    const singleRef = { resource_id: String(single.resource_id), cell: "new_users", row: 0 };
    const singleValue = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: singleRef.resource_id, arithmetic: { op: "subtract", left: singleRef, right: singleRef } });
    assert.equal(singleValue.ok, true, JSON.stringify(singleValue));
    if (singleValue.ok) assert.equal((singleValue.result as { value: string }).value, "0");
    const wrongSingle = await runtime.tools.calculateSessionCells(session.session_id, { arithmetic: { op: "subtract", left: { ...singleRef, execution_id: "wrong" }, right: singleRef } });
    assert.equal(wrongSingle.ok, false);
    if (add.ok) {
      const delivered = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [ref.resource_id, String(add.resource_id)] });
      assert.equal(delivered.ok, true, JSON.stringify(delivered));
      if (delivered.ok) { assert.equal(delivered.status, "completed"); assert.match(String(delivered.answer), /130 人/); }
    }
    runtime.sessions.setActiveJob(session.session_id, "job_raw_other");
    const foreign = await runtime.tools.calculateSessionCells(session.session_id, { arithmetic: { op: "add", left: jp, right: us } });
    assert.equal(foreign.ok, false);
  });
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
    const singleRow = { ...a, row: 0 };
    const redundantHint = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: a.resource_id, arithmetic: { op: "subtract", left: singleRow, right: singleRow } });
    assert.equal(redundantHint.ok, true, JSON.stringify(redundantHint));
    if (redundantHint.ok) assert.equal((redundantHint.result as { value: string }).value, "0");
    const conflictingHint = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: b.resource_id, arithmetic: { op: "subtract", left: singleRow, right: singleRow } });
    assert.equal(conflictingHint.ok, false);
    if (!conflictingHint.ok) assert.equal(conflictingHint.code, "invalid_arithmetic");
    const badRow = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: a.resource_id, arithmetic: { op: "subtract", left: { ...singleRow, row: 1 }, right: singleRow } });
    assert.equal(badRow.ok, false);
    const badExecution = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: a.resource_id, arithmetic: { op: "subtract", left: { ...singleRow, execution_id: "wrong" }, right: singleRow } });
    assert.equal(badExecution.ok, false);
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
