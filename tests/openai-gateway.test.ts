import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, type AppConfig } from "../src/config.js";
import { analyst, ask, openRuntime, waitForJob, withRuntime } from "./helpers.js";
import { startFakeOpenAI } from "./openai-fake-server.js";

const token = "fictional-loopback-token";

test("openai-compatible 缺少配置、远程地址或未知参数时失败，不会改用 faux", () => {
  assert.throws(() => loadConfig(gateway({ piBaseUrl: "" })), /PI_BASE_URL/);
  assert.throws(() => loadConfig(gateway({ piApiKey: "" })), /PI_API_KEY/);
  assert.throws(() => loadConfig(gateway({ piBaseUrl: "https://example.com/v1" })), /远程 HTTPS 供应商默认关闭/);
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
    piContextWindow: 8000,
    piMaxOutputTokens: 512,
    piReasoning: "off",
    ...overrides,
  };
}
