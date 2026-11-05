import test from "node:test";
import assert from "node:assert/strict";
import { SessionAnalysisRecords } from "../src/analysis-declaration.js";

test("工作记录版本、继承和活动分支工具回执恢复", () => {
  const records = new SessionAnalysisRecords();
  const first = records.update({ scope: "合成地区", grain: "日", expected_group_keys: [], unresolved_questions: [], source_excerpts: [{ asset_id: "a", content_hash: "h", quote: "q" }] });
  assert.equal(first.revision, 1);
  const second = records.update({ scope: "合成地区", grain: "月", expected_group_keys: [], unresolved_questions: [] });
  assert.equal(second.revision, 2); assert.equal(second.declaration.source_excerpts?.[0]?.quote, "q");
  const message = (id: string, record: unknown, details: unknown = record) => [
    { role: "assistant", content: [{ type: "toolCall", id, name: "update_analysis" }] },
    { role: "toolResult", toolCallId: id, toolName: "update_analysis", isError: false, details: { analysis_record: details }, content: [{ type: "text", text: JSON.stringify({ analysis_record: record }) }] },
  ];
  const recovered = new SessionAnalysisRecords();
  recovered.restoreFromPersistedMessages([...message("first", first), ...message("second", second), ...message("late", first)]);
  assert.deepEqual(recovered.currentProjection(), second);
  recovered.restoreFromPersistedMessages(message("forged", second, first));
  assert.equal(recovered.currentProjection(), undefined);
  recovered.restoreFromPersistedMessages(message("unmatched", first).slice(1));
  assert.equal(recovered.currentProjection(), undefined);
});
