import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEMO_QUESTIONS } from "../src/demo.js";

const root = fileURLToPath(new URL("..", import.meta.url));

function startProcess(dir: string, port: number, env: Record<string, string>): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATABASE_PATH: path.join(dir, "business.sqlite"),
      STATE_DATABASE_PATH: path.join(dir, "state.sqlite"),
      FRESHNESS_PATH: path.join(dir, "freshness-current.json"),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForListen(child: ChildProcess): Promise<void> {
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(output || "服务没有启动")), 8000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("127.0.0.1")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`服务退出 ${code}: ${output}`));
    });
  });
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

test("独立进程通过 HTTP/SSE 恢复任务，并拒绝错配的幂等键", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lumenfox-http-"));
  const port = 18000 + Math.floor(Math.random() * 10000);
  const base = `http://127.0.0.1:${port}`;
  let first: ChildProcess | undefined;
  let second: ChildProcess | undefined;
  try {
    first = startProcess(dir, port, { TOOL_DELAY_MS: "1500", LEASE_MS: "400", HEARTBEAT_MS: "50", POLL_MS: "30" });
    await waitForListen(first);
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
    first.kill("SIGKILL");
    await new Promise((resolve) => first?.once("exit", resolve));

    second = startProcess(dir, port, { TOOL_DELAY_MS: "0", LEASE_MS: "5000", POLL_MS: "30" });
    await waitForListen(second);
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
    const replay = await fetch(`${base}/api/jobs/${queued.job_id}/events?after=2`);
    const body = await replay.text();
    const seqs = [...body.matchAll(/"seq":(\d+)/g)].map((match) => Number(match[1]));
    assert.ok(seqs.length > 0);
    assert.ok(seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]!));
    assert.ok(seqs.every((seq) => seq > 2));
    const foreign = await fetch(`${base}/api/sessions/${otherSession.session_id}`);
    const foreignBody = (await foreign.json()) as { jobs: Array<{ job_id: string }> };
    assert.equal(foreignBody.jobs.some((item) => item.job_id === queued.job_id), false);

  } finally {
    if (first && first.exitCode === null) first.kill("SIGKILL");
    if (second) await stopProcess(second);
    rmSync(dir, { recursive: true, force: true });
  }
});
