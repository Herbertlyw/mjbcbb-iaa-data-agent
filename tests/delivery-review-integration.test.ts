import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { analyst, ask, withRuntime } from "./helpers.js";

type Message = { role: string; content?: unknown };
const messageText = (message: Message) => typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((part: { text?: unknown }) => typeof part?.text === "string" ? part.text : "").join("") : "";
type Mode = "one" | "missing" | "forged" | "repair" | "knowledge" | "equivalent" | "supplement" | "optional";
const token = "fictional-review-integration";
const sql = (day: string) => `SELECT SUM(new_users) AS total FROM daily_installs WHERE event_date = '${day}' AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'US' AND channel = 'nebula_ads'`;

async function scripted(mode: Mode) {
  let requests = 0;
  const feedbacks: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: Message[] };
    const lastFeedback = body.messages.filter((message) => /(?:宿主反馈：|宿主正文核对：)/u.test(messageText(message))).at(-1);
    if (lastFeedback && !feedbacks.includes(messageText(lastFeedback))) feedbacks.push(messageText(lastFeedback));
    const ids = body.messages.filter((message) => message.role === "tool").flatMap((message) => {
      try { const item = JSON.parse(String(message.content)) as { resource_id?: unknown }; return typeof item.resource_id === "string" ? [item.resource_id] : []; } catch { return []; }
    });
    const stage = requests++;
    let tool: { name: string; arguments: object } | undefined;
    let text = "";
    if (mode === "knowledge") text = "假设演算：10 除以 2 等于 5；这是根据用户给定数字计算。";
    else if (stage === 0) tool = { name: "read_data_contract_view", arguments: { asset_id: "contract.daily_installs" } };
    else if (stage === 1) tool = { name: "query", arguments: { sql: sql("2026-10-06") } };
    else if (mode === "repair" && stage === 2) tool = { name: "update_analysis", arguments: { scope: "合成范围", grain: "日", expected_group_keys: [], unresolved_questions: ["2026-10-08 的新增人数尚未查询"] } };
    else if (mode === "repair" && stage === 3) text = `[[result:${ids[0]}]]`;
    else if (mode === "repair" && stage === 4) tool = { name: "query", arguments: { sql: sql("2026-10-08") } };
    else if (mode === "repair" && stage === 5) tool = { name: "update_analysis", arguments: { scope: "合成范围", grain: "日", expected_group_keys: [], unresolved_questions: [] } };
    else if (mode === "optional" && stage === 2) tool = { name: "update_analysis", arguments: { scope: "合成范围", grain: "日", expected_group_keys: [], unresolved_questions: ["后续可选研究"] } };
    else if (mode === "optional" && stage === 3) text = `当前结果已取得。 [[result:${ids[0]}]]`;
    else if (mode === "supplement" && stage === 3) tool = { name: "read_data_contract_view", arguments: { asset_id: "contract.daily_ad_revenue" } };
    else if (mode === "supplement" && stage === 4) tool = { name: "query", arguments: { sql: "SELECT event_date, product_id, platform, country_code, placement, revenue_usd, is_predicted FROM daily_ad_revenue WHERE event_date = '2026-10-06' AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'US'" } };
    else if (mode === "equivalent" && stage === 3) tool = { name: "query", arguments: { sql: sql("2026-10-06") } };
    else if (mode !== "repair" && stage === 2) text = `已取得当前结果。 [[result:${ids[0]}]]`;
    else {
      const references = mode === "repair" || mode === "supplement" ? ids : mode === "equivalent" ? ids.slice(-1) : ids.slice(0, 1);
      const items = mode === "optional" ? [{ requirement: "新增人数", status: "answered", resource_ids: references }, { requirement: "后续可选研究", status: "optional", resource_ids: [] }] : mode === "missing"
        ? [{ requirement: "新增人数", status: "answered", resource_ids: references }, { requirement: "广告收入", status: "missing", resource_ids: [] }]
        : [{ requirement: "合成范围内的新增人数", status: "answered", resource_ids: mode === "forged" ? ["res_not_selected"] : references }];
      const body = mode === "missing" ? "[[partial]] 广告收入仍然缺失，不能安全计算。" : mode === "repair" ? "两日新增均已取得。" : mode === "supplement" ? "新增人数 120，广告收入 12.5 美元。" : "已核对当前合成结果。";
      text = `${body} ${references.map((id) => `[[result:${id}]]`).join(" ")}${mode === "forged" || mode === "optional" ? ` [[review:${JSON.stringify({ items })}]]` : ""}`;
    }
    const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `review_${stage}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { role: "assistant", content: text };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "local-review", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests: () => requests, feedbacks, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

test("用户给数的假设演算不凭空查询业务库，正文仍标为模型分析", async () => {
  const fake = await scripted("knowledge");
  try {
    await withRuntime({ modelMode: "pi", piProvider: "openai-compatible", piModel: "local-protocol", piApiKey: token, piBaseUrl: fake.url, piContextWindow: 128000, piMaxOutputTokens: 512, piReasoning: "off", protocolScript: "local-review-only", maxModelCalls: 16, stateMode: "sqlite", businessEngine: "sqlite" }, async (runtime) => {
      const session = analyst(runtime);
      const job = await ask(runtime, session.session_id, "假设 10 除以 2，请计算。");
      assert.equal(job.status, "completed");
      assert.match(job.analysis?.model_answer ?? "", /10 除以 2 等于 5/);
      assert.equal(job.analysis?.source_review?.status, "not_applicable");
      assert.equal(job.events.some((event) => event.type === "tool_started" && event.payload.tool_name === "query"), false);
      assert.equal(fake.requests(), 1);
    });
  } finally { await fake.close(); }
});

for (const mode of ["one", "missing", "forged", "repair", "equivalent", "supplement", "optional"] as const) {
  test(`Pi 本机脚本交付复核：${mode}`, async () => {
    const fake = await scripted(mode);
    try {
      await withRuntime({ modelMode: "pi", piProvider: "openai-compatible", piModel: "local-protocol", piApiKey: token, piBaseUrl: fake.url, piContextWindow: 128000, piMaxOutputTokens: 512, piReasoning: "off", protocolScript: "local-review-only", maxModelCalls: 16, stateMode: "sqlite", businessEngine: "sqlite" }, async (runtime) => {
        const session = analyst(runtime);
        const question = mode === "repair" ? "分别给出 2026-10-06 和 2026-10-08 合成产品的新增人数。" : mode === "missing" || mode === "supplement" ? "给出合成产品的新增人数与广告收入。" : "给出合成产品的新增人数。";
        const job = await ask(runtime, session.session_id, question);
        assert.equal(job.status, ["one", "repair", "equivalent", "supplement", "optional"].includes(mode) ? "completed" : "partial", JSON.stringify({ error: job.error, reasons: job.analysis?.server_reasons, draft: job.analysis?.model_draft, events: job.events.filter((event) => event.type.startsWith("candidate_")) }));
        assert.equal(job.events.filter((event) => event.type === "candidate_feedback").length, 1);
        assert.equal(job.events.filter((event) => ["job_finished", "job_failed", "job_cancelled", "job_timed_out"].includes(event.type)).length, 1);
        assert.ok(job.analysis?.server_reasons.includes("request_coverage_unverified"));
        assert.match(job.analysis?.model_answer ?? "", mode === "missing" ? /广告收入仍然缺失/ : mode === "repair" ? /两日新增均已取得/ : mode === "supplement" ? /广告收入 12\.5/ : /已核对当前合成结果/);
        assert.doesNotMatch(job.analysis?.model_answer ?? "", /\[\[(?:result|review):/);
        assert.equal(job.analysis?.text_review?.correctness, "not_certified");
        if (mode === "one" || mode === "repair" || mode === "equivalent" || mode === "supplement") assert.equal(job.analysis?.text_review?.status, "model_checked");
        if (mode === "missing") assert.match(job.analysis?.model_answer ?? "", /广告收入仍然缺失/);
        if (mode === "forged") assert.ok(job.analysis?.server_reasons.includes("request_coverage_review_incomplete"));
        if (mode === "optional") assert.ok(job.analysis?.limitations.some((line) => line.includes("可选研究") && line.includes("未被宿主独立认证")));
        if (mode === "repair") {
          assert.equal(job.analysis?.sources.length, 2);
          assert.match(job.analysis?.answer ?? "", /2026-10-06/);
          assert.match(job.analysis?.answer ?? "", /2026-10-08/);
          assert.match(job.analysis?.answer ?? "", /120/);
          assert.match(job.analysis?.answer ?? "", /95/);
          assert.equal(job.events.filter((event) => event.type === "tool_started" && event.payload.tool_name === "query").length, 2);
          assert.ok(!job.analysis?.server_reasons.includes("unresolved_requirements_unverified"));
        }
        if (mode === "equivalent") {
          assert.equal(job.events.filter((event) => event.type === "tool_started" && event.payload.tool_name === "query").length, 2);
          assert.equal(job.events.some((event) => event.type === "candidate_revision_discarded"), false);
          assert.match(job.analysis?.answer ?? "", /120/);
        }
        if (mode === "supplement") {
          assert.equal(job.analysis?.sources.length, 2);
          assert.equal(job.events.filter((event) => event.type === "tool_started" && event.payload.tool_name === "query").length, 2, "不重复查询已成功的来源");
          assert.match(job.analysis?.answer ?? "", /120/);
          assert.match(job.analysis?.answer ?? "", /12\.5/);
          assert.ok(fake.feedbacks.some((feedback) => feedback.includes(question) && feedback.includes("已取得当前结果")), "正文核对应包含原题及首份候选");
          for (const source of job.analysis?.sources ?? []) {
            const page = await runtime.tools.readSessionResource(session.session_id, { resource_id: source.resource_id, row_limit: 1 });
            assert.equal(page.ok, true, JSON.stringify(page));
          }
        }
        if (mode === "supplement" || mode === "repair") console.log("合成主链跟踪", JSON.stringify({ mode, question, feedback: fake.feedbacks, tools: job.events.filter((event) => event.type === "tool_finished").map((event) => event.payload), sources: job.analysis?.sources.map((source) => ({ resource_id: source.resource_id, execution_id: source.execution_id, sql: source.sql, coverage: source.coverage })), model_answer: job.analysis?.model_answer, answer: job.analysis?.answer, reasons: job.analysis?.server_reasons, status: job.status }));
        assert.ok(fake.requests() >= 4);
      });
    } finally { await fake.close(); }
  });
}
