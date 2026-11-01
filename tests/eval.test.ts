import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { diagnoseKnowledge } from "../src/knowledge-doctor.js";
import { ask, analyst, bindTables, withRuntime } from "./helpers.js";

const cases = JSON.parse(readFileSync(new URL("../eval/lumenfox-cases.json", import.meta.url), "utf8")) as {
  cases: Array<{ id: string; question: string; expect_status: string; expect_text: string[]; forbid_tool?: string }>;
};

test("知识体检只检查，不改文件", () => {
  const issues = diagnoseKnowledge();
  assert.deepEqual(issues, []);
});

test("合成评测题对照手工预期，不把代理计算当金标准", async () => {
  await withRuntime({}, async (runtime) => {
    for (const item of cases.cases) {
      const session = analyst(runtime);
      const job = await ask(runtime, session.session_id, item.question, item.id);
      assert.equal(job.status, item.expect_status, item.id);
      const text = `${job.analysis?.answer ?? ""} ${job.analysis?.clarification_question ?? ""}`;
      for (const fragment of item.expect_text) assert.match(text, new RegExp(fragment), item.id);
      if (item.forbid_tool) {
        assert.equal(job.events.some((event) => event.payload.tool_name === item.forbid_tool), false, item.id);
      }
    }
  });
});

test("没有连接依据或契约哈希变化时停止查询", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs", "contract.player_device_map"]);
    const joined = await runtime.tools.query(session.session_id, {
      sql: "SELECT a.event_date, b.platform FROM daily_installs a JOIN player_device_map b ON a.event_date = b.event_date WHERE a.event_date >= '2026-10-06' AND a.event_date <= '2026-10-12' AND b.event_date >= '2026-10-06' AND b.event_date <= '2026-10-12'",
    });
    assert.equal(joined.ok, false);
    if (!joined.ok) assert.equal(joined.code, "missing_join_constraint");
    const asset = runtime.knowledge.by_id.get("contract.daily_installs");
    if (!asset) throw new Error("缺少契约");
    asset.content_hash = "changed-for-test";
    const stale = await runtime.tools.query(session.session_id, {
      sql: "SELECT event_date, new_users FROM daily_installs WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-12'",
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, "asset_revision_changed");
  });
});
