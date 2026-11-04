import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, type AppConfig } from "../src/config.js";
import { fetchLoopbackOnly } from "../src/openai-gateway.js";
import { analyst, ask, openRuntime, waitForJob, withRuntime } from "./helpers.js";
import { startFakeOpenAI } from "./openai-fake-server.js";
import type { ProviderStepBegin, ProviderStepDecision, ProviderStepSettle } from "../src/state-store.js";

const token = "fictional-loopback-token";

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
      assert.equal(runtime.state.listProviderSteps(job.job_id).length, 0);
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
  try {
    const offRuntime = openRuntime(dir, { ...config, databasePath: path.join(dir, "off-business.sqlite"), stateDatabasePath: path.join(dir, "off-state.sqlite"), freshnessPath: path.join(dir, "off-freshness.json") });
    const offSession = analyst(offRuntime);
    const offJob = await ask(offRuntime, offSession.session_id, question, "off-key", { reasoning: "off" });
    assert.equal(offJob.reasoning, "off");
    assert.equal(fake.observations.at(-1)?.reasoningEffort, "off");
    assert.equal(fake.observations.at(-1)?.sawSystemPrompt, true);
    assert.equal(fake.observations.at(-1)?.sawUserText, true);
    assert.equal(fake.observations.at(-1)?.sawToolDefinition, true);
    await offRuntime.close({ abandon: true });

    const lowRuntime = openRuntime(dir, config);
    const lowSession = analyst(lowRuntime);
    const lowJob = await ask(lowRuntime, lowSession.session_id, question, "low-key", { reasoning: "low" });
    assert.equal(lowJob.reasoning, "low");
    assert.equal(fake.observations.at(-1)?.reasoningEffort, "low");
    await lowRuntime.close({ abandon: true });
    const child = spawnSync(process.execPath, ["--import", "tsx", "tests/read-reasoning.ts", path.join(dir, "state.sqlite"), path.join(dir, "business.sqlite"), path.join(dir, "freshness-current.json"), fake.url, lowJob.job_id], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), "low");
    const checker = openRuntime(dir, { ...config, startWorker: false });
    assert.throws(() => checker.jobs.submit(lowSession.session_id, question, "bad-level", { reasoning: "max" }), /推理档位没有启用/);
    await checker.close();
  } finally {
    await fake.close();
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
