import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEMO_QUESTIONS } from "../src/demo.js";
import { stopProcess } from "./process-control.js";

const root = fileURLToPath(new URL("..", import.meta.url));

function startProcess(dir: string, port: number, env: Record<string, string>): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      HOST: "127.0.0.1",
      PORT: String(port),
      STATE_MODE: "sqlite",
      BUSINESS_ENGINE: "sqlite",
      MODEL_MODE: "deterministic",
      SIMULATED_TODAY: "2026-10-29",
      DATABASE_PATH: path.join(dir, "business.sqlite"),
      STATE_DATABASE_PATH: path.join(dir, "state.sqlite"),
      FRESHNESS_PATH: path.join(dir, "freshness-current.json"),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error("临时回环端口分配失败");
  return port;
}

async function waitForListen(child: ChildProcess, base: string, timeoutMs = 45000): Promise<void> {
  let output = "";
  let exited = false;
  let launchFailed = false;
  const onData = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4096); };
  const onExit = () => { exited = true; };
  const onError = () => { launchFailed = true; };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.once("exit", onExit);
  child.once("error", onError);
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (launchFailed || exited || child.exitCode !== null || child.signalCode !== null) throw new Error("本机演示子进程启动失败或已退出");
      // The marker ties the subsequent health response to this child: a
      // pre-existing service on a raced port is not accepted as our test.
      if (output.includes(`Lumenfox Data Agent 本地演示：${base}`)) {
        let response: Response | undefined;
        try { response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) }); } catch { /* still starting */ }
        if (response?.ok) {
          const body = await response.json() as { ok?: boolean; simulated?: boolean; state_mode?: string; business_engine?: string; model_mode?: string; external_model?: boolean };
          if (!body.ok || body.simulated !== true || body.state_mode !== "sqlite" || body.business_engine !== "sqlite" || body.model_mode !== "deterministic" || body.external_model !== false) throw new Error("本机演示健康检查的隔离模式不匹配");
          if (exited || child.exitCode !== null || child.signalCode !== null) throw new Error("本机演示子进程启动后已退出");
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("本机演示启动或健康检查超时");
  } finally {
    child.stdout?.off("data", onData);
    child.stderr?.off("data", onData);
    child.off("exit", onExit);
    child.off("error", onError);
  }
}

test("启动检查及时发现子进程提前退出", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(7)"], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await assert.rejects(() => waitForListen(child, "http://127.0.0.1:1", 15000), /子进程启动失败或已退出/);
    assert.equal(child.exitCode, 7);
  } finally { await stopProcess(child); }
});

test("启动检查拒绝模式不匹配的本机健康响应", async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const script = `const http = require('node:http'); const port = Number(process.argv[1]); http.createServer((_req, res) => { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({ok:true, simulated:true, state_mode:'mysql', business_engine:'sqlite', model_mode:'deterministic', external_model:false})); }).listen(port, '127.0.0.1', () => console.log('Lumenfox Data Agent 本地演示：http://127.0.0.1:' + port));`;
  const child = spawn(process.execPath, ["-e", script, String(port)], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } });
  try {
    await assert.rejects(() => waitForListen(child, base, 15000), /健康检查的隔离模式不匹配/);
  } finally { await stopProcess(child); }
});

test("独立进程通过 HTTP/SSE 恢复任务，并拒绝错配的幂等键", async () => {
  const port = await freePort();
  const dir = mkdtempSync(path.join(tmpdir(), "lumenfox-http-"));
  const base = `http://127.0.0.1:${port}`;
  let first: ChildProcess | undefined;
  let second: ChildProcess | undefined;
  try {
    first = startProcess(dir, port, { TOOL_DELAY_MS: "1500", LEASE_MS: "400", HEARTBEAT_MS: "50", POLL_MS: "30" });
    await waitForListen(first, base);
    const created = await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const session = (await created.json()) as { session_id: string };
    const other = await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const otherSession = (await other.json()) as { session_id: string };
    const posted = await fetch(`${base}/api/sessions/${session.session_id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: DEMO_QUESTIONS[2].text, idempotency_key: "http-same" }),
    });
    const queued = (await posted.json()) as { job_id: string; status: string };
    const conflict = await fetch(`${base}/api/sessions/${session.session_id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "完全不同的问题", idempotency_key: "http-same" }),
    });
    assert.equal(conflict.status, 409);
    const conflictBody = (await conflict.json()) as { error: { code: string } };
    assert.equal(conflictBody.error.code, "idempotency_conflict");
    const raceSession = await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const race = (await raceSession.json()) as { session_id: string };
    const racing = await fetch(`${base}/api/sessions/${race.session_id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "看看收入", idempotency_key: "cancel-race" }),
    });
    const raceJob = (await racing.json()) as { job_id: string };
    const startedRace = Date.now();
    while (Date.now() - startedRace < 2000) {
      const current = (await (await fetch(`${base}/api/jobs/${raceJob.job_id}`)).json()) as { status: string };
      if (current.status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    const cancelled = await fetch(`${base}/api/jobs/${raceJob.job_id}/cancel`, { method: "POST" });
    const cancelBody = (await cancelled.json()) as { status: string; events: Array<{ type: string }> };
    assert.equal(cancelBody.status, "cancelled");
    assert.equal(cancelBody.events.filter((event) => ["job_finished", "job_failed", "job_cancelled", "job_timed_out"].includes(event.type)).length, 1);
    await stopProcess(first, "SIGKILL");

    second = startProcess(dir, port, { TOOL_DELAY_MS: "0", LEASE_MS: "5000", POLL_MS: "30" });
    await waitForListen(second, base);
    let job: { status: string; events: Array<{ seq: number; type: string }>; session_id: string } | undefined;
    const started = Date.now();
    while (Date.now() - started < 8000) {
      const response = await fetch(`${base}/api/jobs/${queued.job_id}`);
      job = (await response.json()) as typeof job;
      if (job && ["completed", "partial", "failed", "cancelled", "timed_out", "needs_clarification"].includes(job.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(job?.status, "partial");
    assert.equal(job?.events.filter((event) => ["job_finished", "job_failed", "job_cancelled", "job_timed_out"].includes(event.type)).length, 1);
    const replay = await fetch(`${base}/api/jobs/${queued.job_id}/events?after=2`, { signal: AbortSignal.timeout(10000) });
    const body = await replay.text();
    const seqs = [...body.matchAll(/"seq":(\d+)/g)].map((match) => Number(match[1]));
    assert.ok(seqs.length > 0);
    assert.ok(seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]!));
    assert.ok(seqs.every((seq) => seq > 2));
    const foreign = await fetch(`${base}/api/sessions/${otherSession.session_id}/jobs`);
    const foreignBody = (await foreign.json()) as { jobs: Array<{ job_id: string }> };
    assert.equal(foreignBody.jobs.some((item) => item.job_id === queued.job_id), false);

  } finally {
    if (first) await stopProcess(first, "SIGKILL");
    if (second) await stopProcess(second);
    rmSync(dir, { recursive: true, force: true });
  }
});
