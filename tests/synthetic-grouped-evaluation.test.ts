import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadKnowledge } from "../src/knowledge.js";
import { joinCaptureHash } from "../src/join-resource-proof.js";
import { assessSyntheticGroupedRatio } from "../src/synthetic-grouped-evaluation.js";

// Synthetic real-call shape: expected answers were computed independently from
// JSONL and checked against the isolated ClickHouse release.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/synthetic-grouped-real-shape.json", import.meta.url), "utf8"));
const knowledge = loadKnowledge("knowledge/starhaven");
const version = "sv_55c525926d882d7044f9";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const copy = () => structuredClone(fixture);
const score = (x: any) => assessSyntheticGroupedRatio(x.oracle, x.job, x.resources, knowledge, version);

function addZeroDenominator(x: any) {
  const analysis = x.job.analysis;
  const source = x.resources.find((r: any) => r.kind === "query_result");
  const original = x.resources.find((r: any) => r.kind === "arithmetic");
  const row = source.rows.findIndex((r: any) => r.ua_channel_id === "organic");
  assert.ok(row >= 0);
  const saved = structuredClone(original);
  saved.resource_id = "res_synthetic_zero";
  saved.execution_id = "calc_synthetic_zero";
  saved.left.row = row;
  saved.right.row = row;
  saved.result.value = null;
  saved.result.undefined_reason = "zero_divisor";
  x.resources.push(saved);
  analysis.arithmetic_results.push({ resource_id: saved.resource_id, operation: saved.operation, left: saved.left, right: saved.right, result: saved.result });
  analysis.resource_hashes[saved.resource_id] = hash(saved);
  analysis.citations.push({ resource_id: saved.resource_id, note: "arithmetic" });
  analysis.answer += `\n${saved.resource_id}：除数为零，结果未知。`;
}

test("正式结果漏掉零分母组时 completed 评为错误；partial 不误判为完整", () => {
  const x = copy();
  assert.equal(score(x).verdict, "incorrect");
  x.job.status = "partial";
  assert.equal(score(x).verdict, "partial");
  x.job.status = "failed";
  assert.equal(score(x).verdict, "pending");
});

test("同一查询每组均有可回读的计算资源和零分母提示才可判正确", () => {
  const x = copy(); addZeroDenominator(x);
  assert.equal(score(x).verdict, "correct");
  x.job.analysis.answer = x.job.analysis.answer.replace("除数为零，结果未知。", "结果为零。");
  assert.equal(score(x).verdict, "pending");
});

test("来源、契约、新鲜度、查询范围和计算篡改不能被当作正确结果", () => {
  const mutations: Array<(x: any) => void> = [
    x => { x.resources[0].job_id = "another_job"; },
    x => { x.resources[0].truncated = true; },
    x => { x.resources[0].freshness_receipts[1].table = x.resources[0].freshness_receipts[0].table; },
    x => { x.resources[0].contract_revisions.fact_delivery_daily = "old"; },
    x => { x.resources[0].time_range.start = "2026-10-25"; },
    x => { x.job.analysis.arithmetic_results[0].result.value = "999"; },
    x => { x.job.analysis.arithmetic_results[0].left.row = 0; },
    x => { x.resources[1].input_hashes[x.resources[0].resource_id] = "tampered"; x.job.analysis.resource_hashes[x.resources[1].resource_id] = hash(x.resources[1]); },
    x => { x.job.analysis.transform_results = [{ resource_id: "other" }]; },
    x => { x.resources[0].join_proof.rows[0] = null; },
  ];
  for (const mutate of mutations) {
    const x = copy(); addZeroDenominator(x); mutate(x);
    assert.equal(score(x).verdict, "pending");
  }
});

test("篡改事实发布版本并重新计算表面哈希仍不能借数字相同通过", () => {
  const x = copy(); addZeroDenominator(x);
  const source = x.resources[0];
  // Captured proof tuple contains date, two metric values, then fact version.
  source.join_proof.rows[0].__da_join_proof[0][3] = "sv_aaaaaaaaaaaaaaaaaaaa";
  source.join_proof.capture_hash = joinCaptureHash(source.sql, source.executed_sql, source.execution_id, source.join_proof.rows, source.join_proof.column_types);
  x.job.analysis.resource_hashes[source.resource_id] = hash(source);
  for (const saved of x.resources.filter((r: any) => r.kind === "arithmetic")) {
    saved.input_hashes[source.resource_id] = hash(source);
    x.job.analysis.resource_hashes[saved.resource_id] = hash(saved);
  }
  assert.equal(score(x).verdict, "pending");
});
