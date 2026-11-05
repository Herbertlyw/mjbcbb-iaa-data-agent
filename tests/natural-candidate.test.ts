import test from "node:test";
import assert from "node:assert/strict";
import { naturalCandidate } from "../src/natural-candidate.js";

const msg = (text: string, stopReason = "stop") => ({ role: "assistant", stopReason, content: [{ type: "text", text }] });

test("仅选择当前任务成功回执中的最终结果，不自动选择探索结果", () => {
  const allowed = new Set(["res_a", "res_b"]);
  assert.deepEqual(naturalCandidate([{ role: "user", content: "旧问题" }, msg("结果 [[result:res_b]]")], allowed), { kind: "answer", text: "结果 [[result:res_b]]", resourceIds: ["res_b"] });
  assert.equal(naturalCandidate([msg("[[result:res_c]]")], allowed), null);
  assert.equal(naturalCandidate([msg("无需交付探索结果")], allowed), null);
  assert.equal(naturalCandidate([msg("[[result:res_a]]", "length")], allowed), null);
  assert.equal(naturalCandidate([msg("[[result:res_a]]"), { role: "user", content: "新问题" }], allowed), null);
  const comparison = naturalCandidate([msg("[[result:res_a]] [[result:res_b]] [[compare:res_a.total,res_b.total]]")], allowed);
  assert.ok(comparison?.kind === "answer");
  assert.deepEqual(comparison.comparisons, [{ left: { resource_id: "res_a", cell: "total" }, right: { resource_id: "res_b", cell: "total" } }]);
  assert.equal(naturalCandidate([msg("[[result:res_a]] [[compare:res_a.total,res_b.total]]")], allowed), null);
});

test("澄清是独立的无结果问句，不能承载数字或伪造结果选择", () => {
  assert.deepEqual(naturalCandidate([msg("[[clarify]] 请补充产品和日期范围？")], new Set()), { kind: "clarification", question: "请补充产品和日期范围？" });
  assert.equal(naturalCandidate([msg("[[clarify]] 收入是 70，请问产品？")], new Set()), null);
  assert.equal(naturalCandidate([msg("[[clarify]] [[result:res_a]] 请问产品？")], new Set(["res_a"])), null);
});
