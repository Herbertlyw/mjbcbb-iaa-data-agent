import assert from "node:assert/strict";
import test from "node:test";
import { DEMO_QUESTIONS } from "../src/demo.js";
import { ask, analyst, withRuntime } from "./helpers.js";

test("提问、检索、契约、查询、引用和追问", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    const first = await ask(runtime, session.session_id, DEMO_QUESTIONS[0].text);
    assert.equal(first.status, "partial");
    const tools = first.events.filter((event) => event.type === "tool_finished").map((event) => event.payload.tool_name);
    for (const name of ["search_assets", "read_assets", "read_data_contract_view", "query", "calculate_session_cells", "read_session_resource"]) {
      assert.ok(tools.includes(name), `缺少工具 ${name}`);
    }
    assert.equal(first.events.filter((event) => event.type === "candidate_reviewed").length, 1);
    assert.match(first.analysis?.answer ?? "", /480/);
    assert.match(first.analysis?.answer ?? "", /43\.5/);
    assert.match(first.analysis?.answer ?? "", /27\.5/);
    assert.match(first.analysis?.answer ?? "", /缺失|NULL/);
    assert.match(first.analysis?.answer ?? "", /无记录|值为 NULL/);
    assert.match(first.analysis?.answer ?? "", /数值为零/);
    assert.match(first.analysis?.answer ?? "", /预测/);
    assert.equal(first.analysis?.model_suggested_status, "completed");
    assert.equal(first.analysis?.simulated, true);
    assert.equal(first.analysis?.sources[0]?.truncated, false);
    assert.equal(first.analysis?.sources[0]?.time_range.timezone, "America/Los_Angeles");
    const firstResources = new Set(first.analysis?.citations.map((item) => item.resource_id));

    const follow = await ask(runtime, session.session_id, "那安卓呢？");
    assert.equal(follow.status, "partial");
    assert.equal(follow.turn.kind, "follow_up");
    assert.equal(follow.turn.slots.platform, "android");
    assert.match(follow.analysis?.answer ?? "", /730/);
    assert.match(follow.analysis?.answer ?? "", /47/);
    for (const citation of follow.analysis?.citations ?? []) {
      assert.equal(firstResources.has(citation.resource_id), false);
    }
    const platforms = follow.analysis?.sources.flatMap((source) => source.rows.map((row) => row.platform));
    assert.ok(platforms?.every((platform) => platform === "android"));
  });
});

test("证据完整时可以完成，敏感请求和澄清不会假装查到了", async () => {
  await withRuntime({}, async (runtime) => {
    const japan = analyst(runtime);
    const done = await ask(runtime, japan.session_id, DEMO_QUESTIONS[2].text);
    assert.equal(done.status, "partial"); // 预测筛选没有行，不能把空集伪装成观测零。
    assert.match(done.analysis?.answer ?? "", /70/);
    assert.match(done.analysis?.answer ?? "", /21/);
    assert.equal(done.analysis?.calculations.flatMap((item) => item.verified_cells ?? []).some((cell) => cell.column === "revenue_usd" && cell.prediction.startsWith("预测") && cell.value === 0), false);
    assert.ok(done.analysis?.server_reasons.includes("calculation_lineage_unsupported"));

    const sensitive = analyst(runtime);
    const denied = await ask(runtime, sensitive.session_id, DEMO_QUESTIONS[4].text);
    assert.equal(denied.status, "failed");
    assert.equal(JSON.stringify(denied.analysis).includes("sim-device"), false);
    assert.equal(denied.events.some((event) => event.payload.code === "sensitive_field"), true);

    const vague = analyst(runtime);
    const clarify = await ask(runtime, vague.session_id, "看看收入");
    assert.equal(clarify.status, "needs_clarification");
    assert.equal(clarify.events.some((event) => event.payload.tool_name === "query"), false);
    assert.ok(clarify.analysis?.clarification_question);

    const switched = analyst(runtime);
    switched.slots = {
      game: "starlane_drift",
      platform: "ios",
      country: "US",
      start: "2026-10-06",
      end: "2026-10-12",
      metrics: ["new_users", "ad_revenue"],
    };
    const retention = await ask(runtime, switched.session_id, "换成看留存");
    assert.equal(retention.turn.kind, "topic_switch");
    assert.equal(retention.status, "needs_clarification");
    assert.equal(retention.events.some((event) => event.payload.tool_name === "query"), false);
    assert.equal(retention.analysis?.citations.length, 0);
  });
});
