import assert from "node:assert/strict";
import test from "node:test";
import { demoForScenario } from "../src/demo.js";
import { shiftSyntheticDates, syntheticDayShift } from "../src/synthetic-clock.js";
import { startFakeOpenAI } from "./openai-fake-server.js";

test("滚动合成示例使用注入的业务日，固定示例和用户原文不受影响", () => {
  assert.match(demoForScenario(true).questions[0]!.text, /2026-10-06 到 2026-10-12/u);
  assert.match(demoForScenario(true, "2027-02-15").questions[0]!.text, /2027-01-23 到 2027-01-29/u);
  assert.match(demoForScenario(true, "2027-02-15").questions[2]!.text, /2027-01-23 到 2027-01-25/u);
  assert.match(demoForScenario(false, "2027-02-15").questions[0]!.text, /2026-10-06 到 2026-10-12/u);
  assert.equal(shiftSyntheticDates("2026-02-30", 10), "2026-02-30");
  assert.throws(() => syntheticDayShift("2027-02-30"), /invalid_synthetic_clock/u);
});

test("本机脚本假服务按合成日期平移固定工具调用并识别追问", async () => {
  const fake = await startFakeOpenAI("fictional-clock-token", { syntheticDateShiftDays: syntheticDayShift("2027-02-15") });
  try {
    const first = "纸灯 在 2027-01-23 到 2027-01-29（美国、iOS、雾帆）的新增用户是多少？";
    const response = await fetch(`${fake.url}/chat/completions`, {
      method: "POST", headers: { authorization: "Bearer fictional-clock-token", "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: first }, { role: "assistant", content: "" }, { role: "user", content: "那日本呢？" }, { role: "tool", content: "{}" }] }),
    });
    assert.equal(response.status, 200);
    const stream = await response.text();
    const pieces = stream.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)) as { choices?: Array<{ delta?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }> });
    const args = pieces.map((frame) => frame.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments ?? "").join("");
    const call = JSON.parse(args) as { sql: string };
    assert.match(call.sql, /event_date >= '2027-01-23'.*event_date <= '2027-01-29'.*country_code = 'JP'/u);
    assert.deepEqual(fake.observations[0]?.userMessages, [first, "那日本呢？"]);
  } finally { await fake.close(); }
});
