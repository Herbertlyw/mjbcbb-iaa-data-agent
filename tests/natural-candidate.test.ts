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

test("模型可主动标识有证据的部分回答，不能借标记选择其他任务结果", () => {
  const selected = naturalCandidate([msg("[[partial]] 仍有范围未能核验。 [[result:res_a]]")], new Set(["res_a"]));
  assert.ok(selected?.kind === "answer");
  assert.equal(selected.suggestedStatus, "partial");
  assert.deepEqual(selected.resourceIds, ["res_a"]);
  assert.equal(naturalCandidate([msg("[[partial]] [[result:res_b]]")], new Set(["res_a"])), null);
  assert.equal(naturalCandidate([msg("[[partial]] 尚无任何证据")], new Set(["res_a"])), null);
  assert.equal(naturalCandidate([msg("[[result:res_a]] [[partial]]")], new Set(["res_a"])), null);
  assert.equal(naturalCandidate([msg("[[partial]] [[partial]] [[result:res_a]]")], new Set(["res_a"])), null);
});

test("澄清是独立的无结果问句，不能承载数字或伪造结果选择", () => {
  assert.deepEqual(naturalCandidate([msg("[[clarify]] 请补充产品和日期范围？")], new Set()), { kind: "clarification", question: "请补充产品和日期范围？" });
  assert.equal(naturalCandidate([msg("[[clarify]] 收入是 70，请问产品？")], new Set()), null);
  assert.deepEqual(naturalCandidate([{ role: "user", content: "看 2026 年收入" }, msg("[[clarify]] 请问 2026 年的哪个产品？")], new Set()), { kind: "clarification", question: "请问 2026 年的哪个产品？" });
  assert.equal(naturalCandidate([msg("[[clarify]] [[result:res_a]] 请问产品？")], new Set(["res_a"])), null);
  const followup = "目前无法确定口径。你希望看支付还是广告收入？另外请一并说明时间范围，以及想按哪个维度看。";
  assert.deepEqual(naturalCandidate([msg(`[[clarify]] ${followup}`)], new Set()), { kind: "clarification", question: followup });
  assert.equal(naturalCandidate([msg("[[clarify]] 你想看哪个产品？收入已经上涨。")], new Set()), null);
  assert.equal(naturalCandidate([msg("[[clarify]] 你想看哪个产品？另外请确认收入 70 元。")], new Set()), null);
  assert.equal(naturalCandidate([msg("[[clarify]] 你想看哪个产品？另外请参考 [[compare:res_a.x,res_b.y]]。")], new Set()), null);
});
