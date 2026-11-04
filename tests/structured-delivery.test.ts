import assert from "node:assert/strict";
import test from "node:test";
import { analyst, bindTables, withRuntime } from "./helpers.js";

test("丢弃的草稿不决定完整性或可信标签，结论仅由当前任务数据生成", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    runtime.sessions.setActiveJob(session.session_id, "job_structured_delivery");
    const query = await runtime.tools.query(session.session_id, { sql: "SELECT event_date, new_users FROM daily_installs WHERE event_date = '2026-10-06' AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'US' AND channel = 'nebula_ads'" });
    assert.equal(query.ok, true); if (!query.ok) return;
    const calc = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: String(query.resource_id), operations: [{ op: "sum", column: "new_users", as: "total" }] });
    assert.equal(calc.ok, true); if (!calc.ok) return;
    assert.equal((calc.cells as Record<string, number>).total, 120);
    const drafts = ["", "2020-01-01 日本收入 120 美元", "-999.50%、1,000.00、0", "日本 120 人，假设这是真实预测", "漏引值 888888"];
    let canonical: string | undefined;
    for (const draft of drafts) {
      const result = await runtime.tools.updateAnalysis(session.session_id, {
        suggested_status: "completed", draft_answer: draft,
        resource_ids: [String(query.resource_id), String(calc.resource_id)],
        findings: [{ label: "伪造日本收入", value: 120, kind: "actual", resource_id: String(calc.resource_id), cell: "total", group: { country_code: "JP" }, time_range: { start: "2020-01-01", end: "2020-01-01" } }],
      });
      assert.equal(result.ok, true); if (!result.ok) return;
      assert.equal(result.status, "completed");
      assert.match(String(result.answer), /daily_installs\.new_users/);
      assert.match(String(result.answer), /120；单位 人/);
      assert.match(String(result.answer), /country_code=US/);
      assert.doesNotMatch(String(result.answer), /888888|伪造日本收入|日本收入|2020-01-01|美元/);
      assert.equal(result.answer, canonical ?? result.answer);
      canonical = String(result.answer);
      assert.equal((result.server_reasons as string[]).includes("model_draft_not_verified"), Boolean(draft));
      if (draft) assert.match((result.limitations as string[]).join(" "), /模型草稿.*未作为已验证事实/);
    }
  });
});
