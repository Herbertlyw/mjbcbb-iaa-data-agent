import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { demoLocalModel } from "../src/demo-local-model.js";
import { startFakeOpenAI } from "./openai-fake-server.js";
import { stopProcess } from "./process-control.js";

const token = "fictional-local-fixture";
const settings = { PI_BASE_URL: "http://127.0.0.1:43123/v1", PI_MODEL: "synthetic-model", PI_API_KEY: token, PI_CONTEXT_WINDOW: "64000", PI_MAX_OUTPUT_TOKENS: "512" };

test("本机模型配置不探测服务，拒绝远程、URL 凭据和不完整预算", () => {
  assert.equal(demoLocalModel(settings).PI_PROTOCOL_SCRIPT, "");
  for (const base of ["https://127.0.0.1:43123/v1", "http://localhost:43123/v1", "http://127.0.0.1/v1", "http://u:p@127.0.0.1:43123/v1", "http://127.0.0.1:43123/v1?token=fake"]) {
    assert.throws(() => demoLocalModel({ ...settings, PI_BASE_URL: base }));
  }
  assert.throws(() => demoLocalModel({ ...settings, PI_CONTEXT_WINDOW: "0" }));
  assert.throws(() => demoLocalModel({ ...settings, PI_MAX_OUTPUT_TOKENS: "64001" }));
  assert.equal(demoLocalModel({ ...settings, PI_API_KEY: "" }).PI_API_KEY, "local-placeholder");
});

test("显式本机服务模式接通隔离栈，假服务用量标为自报而非已验证模型", { timeout: 150_000 }, async () => {
  const fake = await startFakeOpenAI(token);
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/local-isolated-stack.ts", "--local-model"], {
    cwd: path.resolve("."), env: { PATH: process.env.PATH ?? "", ...settings, PI_BASE_URL: fake.url }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  try {
    let port = 0; const deadline = Date.now() + 90_000;
    while (!port && Date.now() < deadline) {
      assert.equal(child.exitCode, null, "isolated stack exited before ready");
      port = Number(/本机演示：http:\/\/127\.0\.0\.1:(\d+)/u.exec(output)?.[1] ?? 0);
      if (!port) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(port, "isolated stack did not become ready");
    const base = `http://127.0.0.1:${port}`;
    const health = await (await fetch(`${base}/api/health`)).json() as { model_service: string; protocol_scripted: boolean; external_model: unknown; model_catalog: { models: Array<{ verified_here: boolean }> } };
    assert.equal(health.model_service, "configured-loopback-unverified");
    assert.equal(health.protocol_scripted, false);
    assert.equal(health.external_model, null);
    assert.equal(health.model_catalog.models[0]?.verified_here, false);
    const session = await (await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json() as { session_id: string };
    const submitted = await (await fetch(`${base}/api/sessions/${session.session_id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "纸灯 在 2026-10-06 到 2026-10-12（美国、iOS、雾帆）的新增用户是多少？", idempotency_key: crypto.randomUUID() }) })).json() as { job_id: string };
    let result: { status?: string; analysis?: { answer?: string }; usage?: { usage_source?: string } } = {};
    const jobDeadline = Date.now() + 60_000;
    while (Date.now() < jobDeadline) {
      result = await (await fetch(`${base}/api/jobs/${submitted.job_id}`)).json() as typeof result;
      if (!["queued", "running"].includes(result.status ?? "")) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.match(result.analysis?.answer ?? "", /670/u);
    assert.equal(result.usage?.usage_source, "reported");
    assert.equal(output.includes(token), false);
    assert.ok(fake.observations.length > 0 && fake.observations.every((item) => item.authorizationMatched));
  } finally {
    await stopProcess(child, "SIGINT");
    await fake.close();
  }
});

test("DeepSeek 显式隔离栈启动和健康标识不触发模型请求", { timeout: 150_000 }, async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/local-isolated-stack.ts", "--deepseek"], {
    cwd: path.resolve("."), env: { PATH: process.env.PATH ?? "", DEEPSEEK_API_KEY: token }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  try {
    let port = 0; const deadline = Date.now() + 90_000;
    while (!port && Date.now() < deadline) {
      assert.equal(child.exitCode, null, `隔离栈启动失败：${output.replaceAll(token, "[redacted]")}`);
      port = Number(/本机演示：http:\/\/127\.0\.0\.1:(\d+)/u.exec(output)?.[1] ?? 0);
      if (!port) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(port, "隔离栈启动超时");
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json() as { model_provider: string; model_service: string; external_model: boolean; remote_dispatch: boolean; model_catalog: { models: Array<{ id: string; verified_here: boolean }> } };
    assert.equal(health.model_provider, "deepseek");
    assert.equal(health.model_service, "deepseek-official-unverified");
    assert.equal(health.external_model, true);
    assert.equal(health.remote_dispatch, true);
    assert.equal(health.model_catalog.models[0]?.id, "deepseek-flash");
    assert.equal(health.model_catalog.models[0]?.verified_here, false);
    assert.equal(output.includes(token), false);
    // No task is submitted, so even this fictional key is never dispatched.
  } finally { await stopProcess(child, "SIGINT"); }
});
