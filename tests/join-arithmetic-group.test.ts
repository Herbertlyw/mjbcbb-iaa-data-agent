import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderArithmetic } from "../src/analysis-renderer.js";
import { verifiedJoinArithmeticGroup } from "../src/join-arithmetic-group.js";
import { prepareJoinEvidence, verifyJoinEvidence } from "../src/join-evidence.js";
import { loadKnowledge } from "../src/knowledge.js";

test("已验证同次 JOIN 的零分母计算显示物理分组；错误行、执行号和别名不能冒用分组", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/synthetic-grouped-real-shape.json", import.meta.url), "utf8"));
  const source = fixture.resources.find((item: any) => item.kind === "query_result");
  const arithmetic = structuredClone(fixture.job.analysis.arithmetic_results[0]);
  const knowledge = loadKnowledge("knowledge/starhaven");
  const fact = knowledge.contract_by_table.get("fact_delivery_daily")!.contract!;
  const dimension = knowledge.contract_by_table.get("dim_ua_channel")!.contract!;
  const plan = prepareJoinEvidence(source.sql, fact, dimension, knowledge.joins, true);
  assert.ok(plan);
  const values = verifyJoinEvidence(plan, source.join_proof.rows);
  assert.ok(values);
  const row = source.rows.findIndex((item: any) => item.ua_channel_id === "organic");
  arithmetic.left.row = row; arithmetic.right.row = row;
  arithmetic.result.value = null; arithmetic.result.undefined_reason = "zero_divisor";
  const group = verifiedJoinArithmeticGroup(arithmetic, source, plan, values);
  assert.equal(group?.["dim_ua_channel.ua_channel_id"], "organic");
  const text = renderArithmetic(arithmetic, group ?? undefined);
  assert.match(text, /除数为零，结果不可计算/u);
  assert.match(text, /dim_ua_channel\.ua_channel_id="organic"/u);
  assert.match(text, /不认证业务指标名称、用户意图或完整范围/u);
  for (const mutate of [
    (a: any) => { a.right.row = row + 1; },
    (a: any) => { a.left.execution_id = "other"; },
    (a: any) => { a.right.cell = "different_alias"; },
    (a: any) => { a.right.resource_id = "res_other"; },
  ]) {
    const bad = structuredClone(arithmetic); mutate(bad);
    assert.equal(verifiedJoinArithmeticGroup(bad, source, plan, values), null);
  }
});
