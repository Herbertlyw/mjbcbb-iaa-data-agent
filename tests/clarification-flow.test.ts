import assert from "node:assert/strict";
import test from "node:test";
import { analyst, bindTables, withRuntime } from "./helpers.js";

test("澄清不依赖新鲜度，但带查询来源的交付仍须重新校验权威状态", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    const query = await runtime.tools.query(session.session_id, {
      sql: "SELECT event_date, new_users FROM daily_installs WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-08' AND product_id = 'starlane_drift' AND country_code = 'US' AND platform = 'ios' AND channel = 'nebula_ads'",
    });
    assert.equal(query.ok, true, JSON.stringify(query));
    if (!query.ok) throw new Error("fixture query failed");
    runtime.config.freshnessTargetsPath = "/nonexistent/dataagent-test-targets.json";
    const invalid = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "needs_clarification", draft_answer: "", resource_ids: [], clarification_question: "   " });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.code, "clarification_question_required");
    const clarify = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "needs_clarification", draft_answer: "未验证的数字 999", resource_ids: [], clarification_question: "请补充产品和日期范围。" });
    assert.equal(clarify.ok, true, JSON.stringify(clarify));
    if (!clarify.ok) throw new Error("clarification failed");
    assert.equal(clarify.status, "needs_clarification");
    assert.match(String(clarify.answer), /模型提出的问题.*假设尚未核验/u);
    assert.doesNotMatch(String(clarify.answer), /999/u);
    assert.deepEqual(clarify.sources, []);
    const delivery = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(query.resource_id)] });
    assert.equal(delivery.ok, false);
    if (!delivery.ok) assert.equal(delivery.code, "freshness_authority_unavailable");
  });
});
