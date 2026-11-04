import assert from "node:assert/strict";
import test from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { compactPreviousAnalyses } from "../src/provider-context.js";

test("供应商历史摘要保留用户原话与活动分支，只压缩已完成的旧分析回执", () => {
  const prior = { ok: true, status: "partial", answer: "三日合计 30 人，范围为合成日期。", clarification_question: null, model_draft: "x".repeat(20_000), sources: [{ rows: "z".repeat(20_000) }] };
  const messages = [
    { role: "user", content: "合成产品日本三日新增多少？", timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "合成推理", thinkingSignature: "reasoning_content" }, { type: "toolCall", id: "call-old", name: "update_analysis", arguments: {} }], timestamp: 2 },
    { role: "toolResult", toolCallId: "call-old", toolName: "update_analysis", content: [{ type: "text", text: JSON.stringify(prior) }], details: prior, isError: false, timestamp: 3 },
    { role: "user", content: "那美国呢？", timestamp: 4 },
    { role: "toolResult", toolCallId: "call-current", toolName: "update_analysis", content: [{ type: "text", text: JSON.stringify(prior) }], details: prior, isError: false, timestamp: 5 },
  ];
  const context = { messages } as unknown as TranscriptContext;
  const before = JSON.stringify(context);
  const projected = compactPreviousAnalyses(context);
  assert.equal(JSON.stringify(context), before, "不得修改原生会话及原回执");
  assert.equal(projected.messages[0], messages[0]);
  assert.equal(projected.messages[1], messages[1]);
  assert.equal(projected.messages[3], messages[3]);
  assert.equal(projected.messages[4], messages[4], "当前轮工具结果必须原样保留");
  const compact = projected.messages[2];
  assert.equal(compact?.role, "toolResult");
  if (compact?.role !== "toolResult" || compact.content[0]?.type !== "text") throw new Error("missing compact receipt");
  const receipt = JSON.parse(compact.content[0].text);
  assert.equal(compact.toolCallId, "call-old");
  assert.equal(receipt.answer, prior.answer);
  assert.equal(receipt.history_summary, true);
  assert.match(receipt.notice, /当前任务必须重新核验/u);
  assert.equal("details" in compact, false);
  assert.equal("sources" in receipt || "model_draft" in receipt, false);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < Buffer.byteLength(JSON.stringify(messages[2])) / 10);
});

test("失败回执和无法安全完整呈现的历史答案不伪装成完整事实", () => {
  const receipt = (value: unknown, isError = false) => ({ role: "toolResult", toolCallId: "x", toolName: "update_analysis", isError, content: [{ type: "text", text: JSON.stringify(value) }], timestamp: 1 });
  const failed = receipt({ ok: false, code: "evidence_feedback" }, true);
  const long = receipt({ ok: true, status: "completed", answer: "数".repeat(8001) });
  const context = { messages: [failed, long, { role: "user", content: "追问", timestamp: 2 }] } as unknown as TranscriptContext;
  const projected = compactPreviousAnalyses(context);
  assert.equal(projected.messages[0], failed);
  const item = projected.messages[1];
  if (item?.role !== "toolResult" || item.content[0]?.type !== "text") throw new Error("missing receipt");
  assert.deepEqual([JSON.parse(item.content[0].text).answer, JSON.parse(item.content[0].text).answer_omitted], [null, true]);
});
