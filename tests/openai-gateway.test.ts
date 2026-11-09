import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, repoRoot, type AppConfig } from "../src/config.js";
import { contextSizeStats, fetchDeepSeekOnly, fetchLoopbackOnly, safeProviderError } from "../src/openai-gateway.js";
import { analyst, ask, openRuntime, waitForJob, withRuntime } from "./helpers.js";
import { startFakeOpenAI } from "./openai-fake-server.js";
import type { ProviderStepBegin, ProviderStepDecision, ProviderStepSettle, StateStore } from "../src/state-store.js";
import { GlobalBudget } from "../src/global-budget.js";

const token = "fictional-loopback-token";

test("供应商连接错误只暴露固定类别并保留结果未知语义", () => {
  for (const message of ["Connection error.", "fetch failed", "ECONNRESET", "provider_connection_error"]) {
    const error = safeProviderError(new Error(`${message} ${token} 合成问题`));
    assert.equal(error.code, "provider_connection_error");
    assert.match(error.message, /未知/u);
    assert.doesNotMatch(JSON.stringify(error), /fictional-loopback-token|合成问题/u);
  }
  assert.equal(safeProviderError(new Error("connection timed out")).code, "provider_timeout");
});

test("上下文大小诊断仅按受限类别统计，不保存问题、工具正文或未知工具名", () => {
  const messages = [
    { role: "user", content: "合成原话" },
    { role: "toolResult", toolName: "query", content: "合成查询结果" },
    { role: "toolResult", toolName: "不应记录的工具名", content: "合成正文" },
  ];
  const stats = contextSizeStats({ messages });
  assert.equal(stats.user?.messages, 1);
  assert.equal(stats["tool:query"]?.utf8_bytes, Buffer.byteLength(JSON.stringify(messages[1]), "utf8"));
  assert.equal(stats["tool:other"]?.messages, 1);
  assert.doesNotMatch(JSON.stringify(stats), /合成原话|合成查询结果|不应记录的工具名|合成正文/u);
});

test("模型派发前取消不访问供应商并明确记录未派发", async () => {
  const fake = await startFakeOpenAI(token);
  try {
    await withRuntime(gateway({ piBaseUrl: fake.url, protocolScript: "happy" }), async (runtime) => {
      let release!: () => void; let entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const original = runtime.state.saveProviderPayload.bind(runtime.state);
      const state = runtime.state as unknown as { saveProviderPayload: (input: Parameters<StateStore["saveProviderPayload"]>[0]) => Promise<boolean> };
      state.saveProviderPayload = async (input) => {
        const saved = original(input);
        if (input.kind === "request") { entered(); await gate; }
        return saved;
      };
      try {
        const session = analyst(runtime);
        const submitted = runtime.jobs.submit(session.session_id, "合成问题", crypto.randomUUID());
        await ready;
        runtime.jobs.cancel(submitted.job_id);
        release();
        const job = await waitForJob(runtime, submitted.job_id);
        assert.equal(job.status, "cancelled");
        assert.equal(fake.observations.length, 0);
        const step = runtime.state.listProviderSteps(job.job_id)[0];
        assert.equal(step?.status, "not_dispatched");
        assert.equal(step?.error_code, "provider_cancelled");
        assert.equal(job.events.filter((event) => event.type === "job_cancelled").length, 1);
      } finally { release(); }
    });
  } finally { await fake.close(); }
});

test("跨任务预算不可用且 HTTP 尚未创建时，任务明确记为未派发", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "global-gateway-missing-"));
  const fake = await startFakeOpenAI(token);
  try {
    await withRuntime(gateway({ piProvider: "deepseek", piModel: "deepseek-flash", piBaseUrl: fake.url, protocolScript: "happy", globalBudgetPath: path.join(dir, "absent.sqlite"), globalBudgetId: "missing-scope", globalBudgetMaxRequests: 2, globalBudgetMaxTokens: 100000 }), async (runtime) => {
      const session = analyst(runtime);
      const job = await ask(runtime, session.session_id, "合成问题");
      assert.equal(job.status, "failed");
      assert.equal(fake.observations.length, 0);
      assert.equal(job.usage?.model_attempts, 1);
      assert.equal(job.usage?.model_calls, 0);
      assert.equal(job.usage?.provider_not_dispatched, 1);
      assert.equal(job.usage?.provider_outcome_unknown, 0);
      assert.equal(job.usage?.input_tokens, null);
      const step = runtime.state.listProviderSteps(job.job_id)[0];
      assert.equal(step?.status, "not_dispatched");
      assert.equal(step?.settlement, "settled");
    });
  } finally { await fake.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("跨任务预算接入 Pi 派发，限流未知用量后不会跨会话超发", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "global-gateway-"));
  const options = { path: path.join(dir, "budget.sqlite"), budgetId: "test-scope", maxRequests: 1, maxTokens: 100000 };
  const scope = await GlobalBudget.activate(options);
  const fake = await startFakeOpenAI(token);
  try {
    await withRuntime(gateway({ piProvider: "deepseek", piModel: "deepseek-flash", piBaseUrl: fake.url, protocolScript: "rate-limit", globalBudgetPath: options.path, globalBudgetId: options.budgetId, globalBudgetMaxRequests: 1, globalBudgetMaxTokens: options.maxTokens }), async (runtime) => {
      const first = analyst(runtime);
      const second = analyst(runtime);
      const [a, b] = await Promise.all([ask(runtime, first.session_id, "合成问题甲"), ask(runtime, second.session_id, "合成问题乙")]);
      assert.equal(a.status, "failed");
      assert.equal(b.status, "failed");
      assert.equal(fake.observations.length, 1);
      assert.ok([a.error?.code, b.error?.code].includes("global_budget_exhausted"));
      const blocked = [a, b].find((job) => job.error?.code === "global_budget_exhausted")!;
      assert.equal(blocked.usage?.model_attempts, 1);
      assert.equal(blocked.usage?.model_calls, 0);
      assert.equal(blocked.usage?.provider_not_dispatched, 1);
      assert.equal(blocked.usage?.provider_outcome_unknown, 0);
      assert.equal(blocked.usage?.usage_source, "not_dispatched");
      assert.equal(blocked.usage?.input_tokens, null);
      const blockedStep = runtime.state.listProviderSteps(blocked.job_id)[0];
      assert.equal(blockedStep?.status, "not_dispatched");
      assert.equal(blockedStep?.settlement, "settled");
      const stats = await scope.stats();
      assert.equal(stats?.requests_reserved, 1);
      assert.equal(stats?.unknown_count, 1);
      assert.equal(stats?.reported_input, null);
    });
  } finally { await fake.close(); await scope.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("同任务先收到用量再被跨任务预算拒绝时，不把拒绝计为派发或冲掉已报用量", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "global-gateway-known-"));
  const options = { path: path.join(dir, "budget.sqlite"), budgetId: "known-then-blocked", maxRequests: 1, maxTokens: 100000 };
  const scope = await GlobalBudget.activate(options);
  const fake = await startFakeOpenAI(token);
  try {
    await withRuntime(gateway({ piProvider: "deepseek", piModel: "deepseek-flash", piBaseUrl: fake.url, protocolScript: "happy", globalBudgetPath: options.path, globalBudgetId: options.budgetId, globalBudgetMaxRequests: 1, globalBudgetMaxTokens: options.maxTokens }), async (runtime) => {
      const session = analyst(runtime);
      const job = await ask(runtime, session.session_id, "合成问题");
      assert.equal(job.status, "failed");
      assert.equal(job.error?.code, "global_budget_exhausted");
      assert.equal(fake.observations.length, 1);
      assert.equal(job.usage?.model_attempts, 2);
      assert.equal(job.usage?.model_calls, 1);
      assert.equal(job.usage?.provider_not_dispatched, 1);
      assert.equal(job.usage?.provider_completed, 1);
      assert.equal(job.usage?.usage_source, "simulated");
      assert.ok((job.usage?.input_tokens ?? 0) > 0);
      assert.ok((job.usage?.output_tokens ?? 0) > 0);
    });
  } finally { await fake.close(); await scope.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("本机供应商请求禁止重定向及非回环目标", async () => {
  let redirectedRequests = 0;
  const destination = createServer((_request, response) => { redirectedRequests++; response.end(); });
  await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
  const port = (destination.address() as AddressInfo).port;
  const redirect = createServer((_request, response) => { response.writeHead(302, { location: `http://127.0.0.1:${port}/v1` }); response.end(); });
  await new Promise<void>((resolve) => redirect.listen(0, "127.0.0.1", resolve));
  try {
    const redirectPort = (redirect.address() as AddressInfo).port;
    await assert.rejects(fetchLoopbackOnly(`http://127.0.0.1:${redirectPort}/v1`, { redirect: "follow" }));
    assert.equal(redirectedRequests, 0);
    await assert.rejects(fetchLoopbackOnly("http://192.0.2.1:1234/v1"), /remote_dispatch_disabled/);
  } finally {
    await Promise.all([new Promise<void>((resolve) => redirect.close(() => resolve())), new Promise<void>((resolve) => destination.close(() => resolve()))]);
  }
});

test("异步供应商账本必须先预留再派发，结算落定前不执行工具", async () => {
  const fake = await startFakeOpenAI(token);
  try {
    await withRuntime(gateway({ piBaseUrl: fake.url, protocolScript: "happy" }), async (runtime) => {
      let releaseBegin!: () => void; let releaseSettle!: () => void;
      let markBegin!: () => void; let markSettle!: () => void;
      const beginGate = new Promise<void>((resolve) => { releaseBegin = resolve; });
      const settleGate = new Promise<void>((resolve) => { releaseSettle = resolve; });
      const beginSeen = new Promise<void>((resolve) => { markBegin = resolve; });
      const settleSeen = new Promise<void>((resolve) => { markSettle = resolve; });
      const originalBegin = runtime.state.beginProviderStep.bind(runtime.state);
      const originalSettle = runtime.state.settleProviderStep.bind(runtime.state);
      const injected = runtime.state as unknown as { beginProviderStep: (input: ProviderStepBegin) => Promise<ProviderStepDecision>; settleProviderStep: (input: ProviderStepSettle) => Promise<ProviderStepDecision> };
      let firstBegin = true; let firstSettle = true;
      injected.beginProviderStep = async (input) => { if (firstBegin) { firstBegin = false; markBegin(); await beginGate; } return originalBegin(input); };
      injected.settleProviderStep = async (input) => { if (firstSettle) { firstSettle = false; markSettle(); await settleGate; } return originalSettle(input); };
      try {
        const session = analyst(runtime);
        const job = runtime.jobs.submit(session.session_id, "合成问题", crypto.randomUUID());
        await beginSeen;
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(fake.observations.length, 0, "预算尚未预留时不能派发");
        releaseBegin();
        await settleSeen;
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(runtime.jobs.require(job.job_id).events.some((event) => event.type === "tool_started"), false, "结算未落定前不能执行工具");
        releaseSettle();
        const result = await waitForJob(runtime, job.job_id);
        assert.ok(result.events.some((event) => event.type === "tool_started"));
      } finally { releaseBegin(); releaseSettle(); }
    });
  } finally { await fake.close(); }
});

test("openai-compatible 缺少配置、远程地址或未知参数时失败，不会改用 faux", () => {
  assert.throws(() => loadConfig(gateway({ piBaseUrl: "" })), /PI_BASE_URL/);
  assert.throws(() => loadConfig(gateway({ piApiKey: "" })), /PI_API_KEY/);
  assert.throws(() => loadConfig(gateway({ piBaseUrl: "https://example.com/v1" })), /远程 HTTPS 供应商默认关闭/);
  assert.throws(() => loadConfig(gateway({ piBaseUrl: "http://name:password@127.0.0.1:1234/v1" })), /只允许/);
  assert.throws(() => loadConfig(gateway({ piBaseUrl: "http://127.0.0.1:1234/v1?token=fake" })), /只允许/);
  assert.throws(() => loadConfig(gateway({ piReasoning: "ultra" })), /PI_REASONING/);
  const previous = process.env.PI_UNSUPPORTED_PARAM;
  process.env.PI_UNSUPPORTED_PARAM = "temperature-extra";
  try {
    assert.throws(() => loadConfig(), /PI_UNSUPPORTED_PARAM/);
  } finally {
    if (previous === undefined) delete process.env.PI_UNSUPPORTED_PARAM;
    else process.env.PI_UNSUPPORTED_PARAM = previous;
  }
});

test("未标脚本的本机服务用量只标记为服务自报，仍由账本结算", async () => {
  const fake = await startFakeOpenAI(token);
  try {
    await withRuntime(gateway({ piBaseUrl: fake.url, protocolScript: "" }), async (runtime) => {
      const session = analyst(runtime);
      const job = await ask(runtime, session.session_id, "纸灯 在 2026-10-06 到 2026-10-12（美国、iOS、雾帆）的新增用户是多少？");
      assert.equal(job.usage?.usage_source, "reported");
      assert.ok((job.usage?.input_tokens ?? 0) > 0);
      const steps = runtime.state.listProviderSteps(job.job_id);
      assert.ok(steps.length > 0 && steps.every((step) => step.usage_source === "reported" && step.settlement === "settled"));
      assert.equal(runtime.config.protocolScript, "");
    });
  } finally { await fake.close(); }
});

test("DeepSeek 方言的流式思考与工具调用在多轮请求中完整回传", async () => {
  const fake = await startFakeOpenAI(token, { deepseekThinking: true });
  try {
    await withRuntime(gateway({ piProvider: "deepseek", piModel: "deepseek-flash", piBaseUrl: fake.url, protocolScript: "happy", piReasoning: "low", enabledReasoning: ["off", "low"] }), async (runtime) => {
      const session = analyst(runtime);
      const first = await ask(runtime, session.session_id, "纸灯 在 2026-10-06 到 2026-10-12（美国、iOS、雾帆）的新增用户是多少？", undefined, { reasoning: "low" });
      assert.ok(first.events.some((event) => event.type === "tool_started"));
      const second = await ask(runtime, session.session_id, "那日本呢？", undefined, { reasoning: "low" });
      assert.ok(second.events.some((event) => event.type === "tool_started"));
      assert.ok(fake.observations.every((item) => item.thinkingType === "enabled" && item.reasoningEffort === "low"));
      assert.ok(fake.observations.some((item) => item.assistantReasoning.includes("合成推理片段。")));
      assert.ok(runtime.state.listProviderSteps(first.job_id).every((step) => step.provider === "deepseek"));
    });
  } finally { await fake.close(); }
});

test("DeepSeek 远程配置必须显式启用并锁定官方地址", () => {
  const base = gateway({ piProvider: "deepseek", piModel: "deepseek-flash", piBaseUrl: "https://api.deepseek.com", allowRemoteHttps: true, deepseekSyntheticOnly: true, globalBudgetId: "fixture", globalBudgetMaxRequests: 10, globalBudgetMaxTokens: 100000, knowledgeDir: path.join(repoRoot(), "knowledge", "harborlight"), businessEngine: "clickhouse", clickhouseUrl: "http://127.0.0.1:12345", clickhouseDatabase: "harborlight", clickhouseUser: "fox_reader", stateMode: "mysql", mysqlHost: "127.0.0.1", mysqlPort: 12346, redisHost: "127.0.0.1", redisPort: 12347 });
  assert.doesNotThrow(() => loadConfig(base));
  assert.throws(() => loadConfig({ ...base, allowRemoteHttps: false }), /显式启用/);
  assert.throws(() => loadConfig({ ...base, globalBudgetId: "" }), /跨任务预算/);
  assert.throws(() => loadConfig({ ...base, globalBudgetPath: "/tmp/different.sqlite" }), /跨任务预算/);
  assert.throws(() => loadConfig({ ...base, piBaseUrl: "https://api.deepseek.com.example.invalid" }), /官方 HTTPS/);
  assert.throws(() => loadConfig({ ...base, piBaseUrl: "https://api.deepseek.com/v1?key=fictional" }), /官方 HTTPS/);
  assert.throws(() => loadConfig({ ...base, protocolScript: "happy" }), /协议脚本/);
  assert.throws(() => loadConfig({ ...base, deepseekSyntheticOnly: false }), /隔离合成/);
  assert.throws(() => loadConfig({ ...base, clickhouseUrl: "http://127.0.0.1:8123" }), /隔离合成/);
  assert.throws(() => loadConfig({ ...base, mysqlPort: 3306 }), /隔离合成/);
  assert.throws(() => loadConfig({ ...base, knowledgeDir: path.join(repoRoot(), "knowledge", "lumenfox") }), /隔离合成/);
});

test("DeepSeek 传输仅接受官方 HTTPS 路径且强制禁止重定向", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_input, init) => { calls++; assert.equal(init?.redirect, "error"); return new Response("ok"); };
  try {
    await fetchDeepSeekOnly("https://api.deepseek.com/chat/completions", { redirect: "follow" });
    await assert.rejects(fetchDeepSeekOnly("https://api.deepseek.com.example.invalid/chat/completions"), /remote_dispatch_disabled/);
    await assert.rejects(fetchDeepSeekOnly("https://api.deepseek.com/other"), /remote_dispatch_disabled/);
    await assert.rejects(fetchDeepSeekOnly("http://127.0.0.1:12345/v1"), /remote_dispatch_disabled/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("DeepSeek 非思考模式显式关闭 thinking，错误不回退且无用量保持未知", async () => {
  const fake = await startFakeOpenAI(token);
  try {
    await withRuntime(gateway({ piProvider: "deepseek", piModel: "deepseek-flash", piBaseUrl: fake.url, protocolScript: "error" }), async (runtime) => {
      const session = analyst(runtime);
      const job = await ask(runtime, session.session_id, "合成问题");
      assert.equal(job.status, "failed");
      assert.equal(job.usage?.usage_source, "unknown");
      assert.equal(fake.observations.length, 1);
      assert.equal(fake.observations[0]?.thinkingType, "disabled");
      assert.equal(job.events.some((event) => event.type === "tool_started"), false);
    });
  } finally { await fake.close(); }
});

test("DeepSeek 限流只派发一次并保留未知用量", async () => {
  const fake = await startFakeOpenAI(token);
  try {
    await withRuntime(gateway({ piProvider: "deepseek", piModel: "deepseek-flash", piBaseUrl: fake.url, protocolScript: "rate-limit" }), async (runtime) => {
      const session = analyst(runtime);
      const job = await ask(runtime, session.session_id, "合成问题");
      assert.equal(job.status, "failed");
      assert.equal(job.error?.code, "provider_rate_limited");
      assert.equal(job.usage?.usage_source, "unknown");
      assert.equal(fake.observations.length, 1);
    });
  } finally { await fake.close(); }
});

test("DeepSeek 缓存命中的输入 token 仍计入任务预算", async () => {
  const fake = await startFakeOpenAI(token, { cacheHitTokens: 5 });
  try {
    await withRuntime(gateway({ piProvider: "deepseek", piModel: "deepseek-flash", piBaseUrl: fake.url, protocolScript: "happy" }), async (runtime) => {
      const session = analyst(runtime);
      const job = await ask(runtime, session.session_id, "合成问题");
      const steps = runtime.state.listProviderSteps(job.job_id);
      assert.ok(steps.length > 0);
      assert.ok(steps.every((step) => step.input_tokens === 21 && step.output_tokens === 9));
      assert.ok(steps.every((step) => step.cache_hit_tokens === 5 && step.cache_miss_tokens === null));
      assert.equal(job.usage?.input_tokens, steps.length * 21);
      assert.equal(job.usage?.cache_hit_tokens, steps.length * 5);
      assert.equal(job.usage?.cache_miss_tokens, null);
    });
  } finally { await fake.close(); }
});

test("Pi 自然澄清无需调用工具，宿主提交且不多次派发", async () => {
  const fake = await startFakeOpenAI(token);
  try {
    await withRuntime(gateway({ piProvider: "deepseek", piModel: "deepseek-flash", piBaseUrl: fake.url, protocolScript: "clarification" }), async (runtime) => {
      const session = analyst(runtime);
      const job = await ask(runtime, session.session_id, "合成问题，范围不清楚。");
      assert.equal(job.status, "needs_clarification", JSON.stringify(job.error));
      assert.equal(job.analysis?.clarification_question, "请说明分析范围？");
      assert.equal(fake.observations.length, 1);
      assert.equal(runtime.state.listProviderSteps(job.job_id).length, 1);
      assert.equal(job.events.filter((event) => ["job_finished", "job_failed", "job_cancelled", "job_timed_out"].includes(event.type)).length, 1);
    });
  } finally { await fake.close(); }
});

test("Pi 自然澄清保留原话且不发查询", async () => {
  const fake = await startFakeOpenAI(token);
  try {
    await withRuntime(gateway({ piProvider: "deepseek", piModel: "deepseek-flash", piBaseUrl: fake.url, protocolScript: "minimal-clarification" }), async (runtime) => {
      const session = analyst(runtime);
      const job = await ask(runtime, session.session_id, "帮我看一下收入。");
      assert.equal(job.status, "needs_clarification", JSON.stringify(job.error));
      assert.equal(job.analysis?.clarification_question, "请补充产品和日期范围？");
      assert.match(job.analysis?.answer ?? "", /假设尚未核验/u);
      assert.equal(job.analysis?.sources.length, 0);
      assert.deepEqual(job.events.filter((event) => event.type === "tool_started").map((event) => event.payload.tool_name), []);
      assert.deepEqual(fake.observations[0]?.userMessages, ["帮我看一下收入。"]);
      assert.equal(fake.observations.length, 1);
    });
  } finally { await fake.close(); }
});

test("Pi 保留问句后追加范围请求的自然澄清", async () => {
  const fake = await startFakeOpenAI(token);
  try {
    await withRuntime(gateway({ piProvider: "deepseek", piModel: "deepseek-flash", piBaseUrl: fake.url, protocolScript: "clarify-trailing-request" }), async (runtime) => {
      const session = analyst(runtime);
      const job = await ask(runtime, session.session_id, "帮我看一下收入。");
      assert.equal(job.status, "needs_clarification", JSON.stringify(job.error));
      assert.match(job.analysis?.clarification_question ?? "", /支付金额，还是广告变现？另外请一并说明时间范围/u);
      assert.equal(job.analysis?.sources.length, 0);
      assert.equal(job.events.some((event) => event.type === "tool_started" && event.payload.tool_name === "query"), false);
      assert.equal(fake.observations.length, 1);
    });
  } finally { await fake.close(); }
});

test("Pi 拒绝无证据候选后允许模型修订，成功澄清后结束", async () => {
  const fake = await startFakeOpenAI(token);
  try {
    await withRuntime(gateway({ piProvider: "deepseek", piModel: "deepseek-flash", piBaseUrl: fake.url, protocolScript: "clarify-retry" }), async (runtime) => {
      const session = analyst(runtime);
      const job = await ask(runtime, session.session_id, "合成问题，范围不清楚。");
      assert.equal(job.status, "needs_clarification", JSON.stringify(job.error));
      assert.equal(job.analysis?.clarification_question, "请说明分析范围？");
      const feedback = job.events.filter((event) => event.type === "candidate_feedback");
      assert.equal(feedback.length, 1);
      assert.equal(feedback[0]?.payload.code, "model_stopped_without_candidate");
      assert.equal(job.events.filter((event) => event.type === "candidate_reviewed").length, 1);
      assert.equal(fake.observations.length, 2);
    });
  } finally { await fake.close(); }
});

test("自然结束未选择结果且一次反馈无进展时失败，不把探索结果拼成答案", async () => {
  const fake = await startFakeOpenAI(token);
  try {
    await withRuntime(gateway({ piBaseUrl: fake.url, protocolScript: "no-candidate" }), async (runtime) => {
      const session = analyst(runtime);
      const job = await ask(runtime, session.session_id, "合成问题");
      assert.equal(job.status, "failed");
      assert.equal(job.error?.code, "model_stopped_without_candidate");
      assert.equal(job.analysis, null);
      assert.equal(job.events.filter((event) => event.type === "candidate_feedback").length, 1);
      assert.equal(job.events.filter((event) => event.type === "candidate_reviewed").length, 0);
      assert.equal(job.events.filter((event) => ["job_finished", "job_failed", "job_cancelled", "job_timed_out"].includes(event.type)).length, 1);
      assert.equal(fake.observations.length, 2);
    });
  } finally { await fake.close(); }
});

test("候选快照后的墙钟超时不会再触发修订派发", async () => {
  const fake = await startFakeOpenAI(token);
  try {
    await withRuntime(gateway({ piBaseUrl: fake.url, protocolScript: "no-candidate", jobTimeoutMs: 350, candidateHoldMs: 1200 }), async (runtime) => {
      const session = analyst(runtime);
      const job = await ask(runtime, session.session_id, "合成问题");
      assert.equal(job.status, "timed_out", JSON.stringify(job.error));
      assert.equal(job.analysis, null);
      assert.equal(job.events.filter((event) => event.type === "snapshot_saved" && event.payload.role === "assistant" && event.payload.stop_reason === "stop").length, 1);
      assert.equal(job.events.filter((event) => event.type === "candidate_feedback").length, 0);
      assert.equal(fake.observations.length, 1);
      assert.equal(runtime.state.listProviderSteps(job.job_id).length, 1);
      assert.equal(job.events.filter((event) => ["job_finished", "job_failed", "job_cancelled", "job_timed_out"].includes(event.type)).length, 1);
    });
  } finally { await fake.close(); }
});

test("保存候选反馈期间取消不会再派发修订请求", async () => {
  const fake = await startFakeOpenAI(token);
  try {
    await withRuntime(gateway({ piBaseUrl: fake.url, protocolScript: "no-candidate", jobTimeoutMs: 8000 }), async (runtime) => {
      let release!: () => void; let entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const original = runtime.state.saveAgentSnapshot.bind(runtime.state);
      const state = runtime.state as unknown as { saveAgentSnapshot: (input: Parameters<StateStore["saveAgentSnapshot"]>[0]) => Promise<boolean> };
      state.saveAgentSnapshot = async (input) => {
        const saved = original(input);
        if (input.kind === "progress" && typeof input.body.jsonl === "string" && input.body.jsonl.includes("lumenfox.candidate_feedback")) { entered(); await gate; }
        return saved;
      };
      try {
        const session = analyst(runtime); const submitted = runtime.jobs.submit(session.session_id, "合成问题", crypto.randomUUID());
        await ready; runtime.jobs.cancel(submitted.job_id); release();
        const job = await waitForJob(runtime, submitted.job_id);
        assert.equal(job.status, "cancelled"); assert.equal(job.analysis, null);
        assert.equal(job.events.filter((event) => event.type === "candidate_feedback").length, 1);
        assert.equal(job.events.filter((event) => event.type === "job_cancelled").length, 1);
        assert.equal(fake.observations.length, 1);
        assert.equal(runtime.state.listProviderSteps(job.job_id).length, 1);
      } finally { release(); }
    });
  } finally { await fake.close(); }
});

test("本地假 HTTP 服务经 Pi SDK 适配器处理错误、缺用量和非法工具参数", async () => {
  const fake = await startFakeOpenAI(token);
  try {
    await withRuntime(gateway({ piBaseUrl: fake.url, protocolScript: "error" }), async (runtime) => {
      const session = analyst(runtime);
      const job = await ask(runtime, session.session_id, "纸灯 在 2026-10-06 到 2026-10-12（美国、iOS、雾帆）的新增用户是多少？");
      assert.equal(job.status, "failed", JSON.stringify(job.error));
      assert.equal(job.error?.code, "provider_error", JSON.stringify(job.error));
      assert.equal(job.usage?.input_tokens, null);
      assert.equal(job.usage?.usage_source, "unknown");
      assert.equal(job.events.some((event) => event.type === "tool_started"), false);
      assert.equal(JSON.stringify(job.error).includes(token), false);
      const payloads = runtime.state.listProviderPayloads(job.job_id, session.actor_id ?? "demo-analyst");
      assert.ok(payloads.length > 0);
      for (const payload of payloads) {
        const page = runtime.state.readProviderPayload({ payloadId: payload.payload_id, actorId: session.actor_id ?? "demo-analyst", sessionId: session.session_id, offset: 0, limit: 4000 });
        assert.ok(page);
        assert.match(page.text, /metadata-only/);
        assert.equal(page.text.includes("纸灯"), false);
        assert.equal(page.text.includes(token), false);
      }
    });
    await withRuntime(gateway({ piBaseUrl: fake.url, protocolScript: "no-usage" }), async (runtime) => {
      const session = analyst(runtime);
      const job = await ask(runtime, session.session_id, "纸灯 在 2026-10-06 到 2026-10-12（美国、iOS、雾帆）的新增用户是多少？");
      assert.notEqual(job.status, "completed");
      assert.equal(job.usage?.input_tokens, null);
      assert.equal(job.usage?.output_tokens, null);
      assert.equal(job.usage?.usage_source, "unknown");
      const steps = runtime.state.listProviderSteps(job.job_id);
      assert.ok(steps.length > 0);
      assert.equal(steps.some((step) => step.usage_source === "simulated" && step.input_tokens === 0), false);
    });
    await withRuntime(gateway({ piBaseUrl: fake.url, protocolScript: "bad-args" }), async (runtime) => {
      const session = analyst(runtime);
      const job = await ask(runtime, session.session_id, "纸灯 在 2026-10-06 到 2026-10-12（美国、iOS、雾帆）的新增用户是多少？");
      assert.notEqual(job.status, "completed");
      assert.equal((job.analysis?.answer ?? "").includes("670"), false);
      assert.equal(job.events.filter((event) => event.type === "tool_started" && event.payload.tool_name === "query").length, 1);
    });
    await withRuntime(gateway({ piBaseUrl: fake.url, protocolScript: "disconnect", jobTimeoutMs: 8000 }), async (runtime) => {
      const session = analyst(runtime);
      const job = await ask(runtime, session.session_id, "纸灯 在 2026-10-06 到 2026-10-12（美国、iOS、雾帆）的新增用户是多少？");
      assert.notEqual(job.status, "completed");
      assert.equal((job.analysis?.answer ?? "").includes("670"), false);
      assert.equal(job.events.some((event) => event.type === "tool_finished" && event.payload.is_error === false), false);
    });
    await withRuntime(gateway({ piBaseUrl: fake.url, protocolScript: "hold", jobTimeoutMs: 1200 }), async (runtime) => {
      const session = analyst(runtime);
      const job = await ask(runtime, session.session_id, "纸灯 在 2026-10-06 到 2026-10-12（美国、iOS、雾帆）的新增用户是多少？");
      assert.equal(job.status, "timed_out");
      assert.equal(job.analysis, null);
      assert.equal(job.events.some((event) => event.type === "tool_started"), false);
      assert.equal(job.usage?.input_tokens, null);
    });
    await withRuntime(gateway({ piBaseUrl: fake.url, protocolScript: "hold", jobTimeoutMs: 8000 }), async (runtime) => {
      const session = analyst(runtime);
      const submitted = runtime.jobs.submit(session.session_id, "纸灯 在 2026-10-06 到 2026-10-12（美国、iOS、雾帆）的新增用户是多少？", crypto.randomUUID());
      await new Promise((resolve) => setTimeout(resolve, 300));
      runtime.jobs.cancel(submitted.job_id);
      const cancelled = await waitForJob(runtime, submitted.job_id);
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.events.some((event) => event.type === "tool_started"), false);
      assert.equal(cancelled.analysis, null);
      assert.equal(cancelled.events.filter((event) => event.type === "job_cancelled").length, 1);
    });
    assert.equal(fake.observations.some((item) => item.authorizationMatched), true);
    assert.equal(fake.observations.some((item) => item.sawUserText), true);
    assert.equal(JSON.stringify(fake.observations).includes(token), false);
  } finally {
    await fake.close();
  }
});

test("供应商 HTTP 失败只保留安全状态类别，未知用量仍占额且不会重试", async () => {
  const fake = await startFakeOpenAI(token);
  try {
    for (const [status, expected] of [[400, "provider_invalid_request"], [401, "provider_auth_rejected"], [402, "provider_balance_insufficient"], [403, "provider_auth_rejected"], [429, "provider_rate_limited"]] as const) {
      await withRuntime(gateway({ piProvider: "deepseek", piModel: "deepseek-flash", piBaseUrl: fake.url, protocolScript: `status-${status}` }), async (runtime) => {
        const before = fake.observations.length;
        const session = analyst(runtime);
        const job = await ask(runtime, session.session_id, "合成问题");
        assert.equal(job.status, "failed");
        assert.equal(job.error?.code, expected, JSON.stringify(job.error));
        assert.equal(fake.observations.length - before, 1, "供应商错误不能自动重试");
        assert.equal(job.usage?.usage_source, "unknown");
        assert.equal(job.usage?.input_tokens, null);
        const step = runtime.state.listProviderSteps(job.job_id)[0];
        assert.equal(step?.settlement, "held_unknown");
        assert.equal(step?.error_code, expected);
        assert.doesNotMatch(JSON.stringify(job), /fictional private error text|sk-fictional-do-not-store/u);
        for (const payload of runtime.state.listProviderPayloads(job.job_id, session.actor_id ?? "demo-analyst")) {
          const page = runtime.state.readProviderPayload({ payloadId: payload.payload_id, actorId: session.actor_id ?? "demo-analyst", sessionId: session.session_id, offset: 0, limit: 4000 });
          assert.ok(page);
          assert.doesNotMatch(page.text, /fictional private error text|sk-fictional-do-not-store/u);
        }
      });
    }
  } finally { await fake.close(); }
});

test("供应商连接中断经 Pi 记录为连接错误，未知用量占额且不重试", async () => {
  const fake = await startFakeOpenAI(token);
  try {
    await withRuntime(gateway({ piProvider: "deepseek", piModel: "deepseek-flash", piBaseUrl: fake.url, protocolScript: "connection-reset" }), async (runtime) => {
      const session = analyst(runtime);
      const job = await ask(runtime, session.session_id, "合成问题");
      assert.equal(job.status, "failed");
      assert.equal(job.error?.code, "provider_connection_error");
      assert.equal(fake.observations.length, 1);
      assert.equal(job.usage?.usage_source, "unknown");
      assert.equal(job.usage?.input_tokens, null);
      const step = runtime.state.listProviderSteps(job.job_id)[0];
      assert.equal(step?.settlement, "held_unknown");
      assert.equal(step?.error_code, "provider_connection_error");
    });
  } finally { await fake.close(); }
});

test("窗口预留拒绝应显示真实错误且不派发请求", async () => {
  const fake = await startFakeOpenAI(token);
  try {
    await withRuntime(gateway({ piBaseUrl: fake.url, piContextWindow: 1500 }), async (runtime) => {
      const session = analyst(runtime);
      const job = await ask(runtime, session.session_id, "合成超长上下文".repeat(1500));
      assert.equal(job.status, "failed");
      assert.equal(job.error?.code, "context_window_exceeded");
      assert.equal(job.analysis, null);
      assert.equal(fake.observations.length, 0);
      const steps = runtime.state.listProviderSteps(job.job_id);
      assert.equal(steps.length, 1);
      assert.equal(steps[0]?.status, "not_dispatched");
      assert.equal(steps[0]?.error_code, "context_window_exceeded");
      assert.equal(steps[0]?.reserved_total, 0);
      assert.equal(job.usage?.model_calls, 0);
      assert.equal(job.usage?.provider_not_dispatched, 1);
    });
  } finally {
    await fake.close();
  }
});

test("本机假服务请求体带有系统提示、原话、工具定义，off 与 low 分别写入 reasoning_effort", async () => {
  const question = "纸灯 在 2026-10-06 到 2026-10-12（美国、iOS、雾帆）的新增用户是多少？";
  const fake = await startFakeOpenAI(token);
  const dir = mkdtempSync(path.join(tmpdir(), "lumenfox-reason-"));
  const config = gateway({
    piBaseUrl: fake.url,
    protocolScript: "no-usage",
    enabledReasoning: ["off", "low"],
    piReasoning: "off",
    startWorker: true,
    ephemeralDir: undefined,
    databasePath: path.join(dir, "business.sqlite"),
    stateDatabasePath: path.join(dir, "state.sqlite"),
    freshnessPath: path.join(dir, "freshness-current.json"),
  });
  let offRuntime: ReturnType<typeof openRuntime> | undefined;
  let lowRuntime: ReturnType<typeof openRuntime> | undefined;
  let checker: ReturnType<typeof openRuntime> | undefined;
  try {
    offRuntime = openRuntime(dir, { ...config, databasePath: path.join(dir, "off-business.sqlite"), stateDatabasePath: path.join(dir, "off-state.sqlite"), freshnessPath: path.join(dir, "off-freshness.json") });
    const offSession = analyst(offRuntime);
    const offJob = await ask(offRuntime, offSession.session_id, question, "off-key", { reasoning: "off" });
    assert.equal(offJob.reasoning, "off");
    assert.equal(fake.observations.at(-1)?.reasoningEffort, "off");
    assert.equal(fake.observations.at(-1)?.sawSystemPrompt, true);
    assert.equal(fake.observations.at(-1)?.sawUserText, true);
    assert.equal(fake.observations.at(-1)?.sawToolDefinition, true);
    await offRuntime.close({ abandon: true });
    offRuntime = undefined;

    lowRuntime = openRuntime(dir, config);
    const lowSession = analyst(lowRuntime);
    const lowJob = await ask(lowRuntime, lowSession.session_id, question, "low-key", { reasoning: "low" });
    assert.equal(lowJob.reasoning, "low");
    assert.equal(fake.observations.at(-1)?.reasoningEffort, "low");
    await lowRuntime.close({ abandon: true });
    lowRuntime = undefined;
    const child = spawnSync(process.execPath, ["--import", "tsx", "tests/read-reasoning.ts", path.join(dir, "state.sqlite"), path.join(dir, "business.sqlite"), path.join(dir, "freshness-current.json"), fake.url, lowJob.job_id], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), "low");
    checker = openRuntime(dir, { ...config, startWorker: false });
    assert.throws(() => checker!.jobs.submit(lowSession.session_id, question, "bad-level", { reasoning: "max" }), /推理档位没有启用/);
    await checker.close();
    checker = undefined;
  } finally {
    await Promise.allSettled([offRuntime?.close({ abandon: true }), lowRuntime?.close({ abandon: true }), checker?.close({ abandon: true })]);
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function gateway(overrides: Partial<AppConfig> = {}): Partial<AppConfig> {
  return {
    modelMode: "pi",
    piProvider: "openai-compatible",
    piModel: "local-protocol",
    piApiKey: token,
    piBaseUrl: "http://127.0.0.1:9/v1",
    piContextWindow: 64000,
    piMaxOutputTokens: 512,
    piReasoning: "off",
    ...overrides,
  };
}
