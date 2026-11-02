import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DEMO_QUESTIONS } from "../src/demo.js";
import { RequestError } from "../src/jobs.js";
import { startServer } from "../src/server.js";
import { resolveTurn } from "../src/turn.js";
import type { AnalysisRecord } from "../src/types.js";
import { ask, analyst, waitForJob, withRuntime } from "./helpers.js";

test("追问、纠正和换题由服务端合并范围", () => {
  const first = resolveTurn(null, DEMO_QUESTIONS[0].text);
  assert.equal(first.slots.platform, "ios");
  assert.equal(first.slots.country, "US");
  assert.deepEqual(first.missing_slots, []);
  const follow = resolveTurn(first.slots, "那安卓呢？");
  assert.equal(follow.kind, "follow_up");
  assert.equal(follow.slots.platform, "android");
  assert.equal(follow.slots.country, "US");
  assert.equal(follow.slots.start, "2026-10-06");
  assert.ok(follow.inherited.includes("country"));
  const correction = resolveTurn(first.slots, "不对，国家是日本不是美国");
  assert.equal(correction.kind, "correction");
  assert.equal(correction.slots.country, "JP");
  assert.equal(correction.slots.platform, "ios");
  const topic = resolveTurn(first.slots, "换成看留存");
  assert.equal(topic.kind, "topic_switch");
  assert.equal(topic.intent, "retention_missing");
  assert.equal(topic.slots.platform, undefined);
  const vague = resolveTurn(null, "看看收入");
  assert.ok(vague.missing_slots.includes("date_range"));
  assert.ok(vague.clarification_question);
});

test("重复提交、事件顺序、重复执行和终态", async () => {
  await withRuntime({ toolDelayMs: 40 }, async (runtime) => {
    const session = analyst(runtime);
    const first = runtime.jobs.submit(session.session_id, "看看收入", "same-key");
    const replay = runtime.jobs.submit(session.session_id, "看看收入", "same-key");
    assert.equal(replay.job_id, first.job_id);
    assert.throws(() => runtime.jobs.submit(session.session_id, "另一个问题", "other-key"), (error: unknown) => {
      return error instanceof RequestError && error.code === "session_busy";
    });
    await waitForJob(runtime, first.job_id);
    runtime.jobs.requeue(first.job_id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const job = runtime.jobs.require(first.job_id);
    assert.equal(job.events.filter((event) => event.type === "job_started").length, 1);
    assert.deepEqual(
      job.events.map((event) => event.seq),
      job.events.map((_, index) => index + 1),
    );
    assert.equal(job.events[0]?.type, "job_queued");
    assert.equal(job.events.at(-1)?.type, "job_finished");
    assert.equal(job.status, "needs_clarification");
    assert.throws(() => runtime.jobs.submit(session.session_id, "这是另一句完全不同的问题", "same-key"), (error: unknown) => {
      return error instanceof RequestError && error.code === "idempotency_conflict";
    });
    const again = runtime.jobs.cancel(job.job_id);
    assert.equal(again.status, "needs_clarification");
    assert.equal(job.events.filter((event) => event.type === "job_cancelled").length, 0);
  });
});

test("取消排队任务不会启动，运行中的取消不会变成完成", async () => {
  await withRuntime({ startWorker: false }, async (runtime) => {
    const session = analyst(runtime);
    const queued = runtime.jobs.submit(session.session_id, DEMO_QUESTIONS[0].text, "queued");
    const cancelled = runtime.jobs.cancel(queued.job_id);
    assert.equal(cancelled.status, "cancelled");
    runtime.jobs.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const job = runtime.jobs.require(queued.job_id);
    assert.equal(job.status, "cancelled");
    assert.equal(job.events.some((event) => event.type === "job_started"), false);
  });

  await withRuntime({ toolDelayMs: 250, jobTimeoutMs: 30_000 }, async (runtime) => {
    const session = analyst(runtime);
    const submitted = runtime.jobs.submit(session.session_id, DEMO_QUESTIONS[0].text, "running");
    const started = Date.now();
    while (!runtime.jobs.require(submitted.job_id).events.some((event) => event.type === "tool_started")) {
      if (Date.now() - started > 2000) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    runtime.jobs.cancel(submitted.job_id);
    const job = await waitForJob(runtime, submitted.job_id);
    assert.equal(job.status, "cancelled");
    assert.equal(job.events.some((event) => event.type === "tool_started"), true);
  });
});

test("任务超时和客户端断开", async () => {
  await withRuntime({ jobTimeoutMs: 40, toolDelayMs: 300 }, async (runtime) => {
    const session = analyst(runtime);
    const job = await ask(runtime, session.session_id, "看看收入");
    assert.equal(job.status, "timed_out");
    assert.equal(job.error?.code, "job_timed_out");
  });

  await withRuntime({ toolDelayMs: 200 }, async (runtime) => {
    const server = startServer(runtime);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("没有测试端口");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const created = await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const session = (await created.json()) as { session_id: string };
      const posted = await fetch(`${base}/api/sessions/${session.session_id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "看看收入", idempotency_key: "http-1" }),
      });
      const job = (await posted.json()) as { job_id: string };
      const stream = await fetch(`${base}/api/jobs/${job.job_id}/events`);
      const reader = stream.body?.getReader();
      await reader?.read();
      await reader?.cancel();
      const finished = await waitForJob(runtime, job.job_id);
      assert.equal(finished.status, "needs_clarification");
      assert.notEqual(finished.status, "cancelled");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

test("失败、超时或取消时不交付旧候选，历史记录也不会被 API 当正式答案展示", async () => {
  await withRuntime({ startWorker: false }, async (runtime) => {
    const server = startServer(runtime);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("没有测试端口");
    const database = new DatabaseSync(runtime.config.stateDatabasePath);
    try {
      for (const terminal of ["failed", "timed_out", "cancelled"] as const) {
        const session = analyst(runtime);
        const job = runtime.jobs.submit(session.session_id, "synthetic candidate", `candidate-${terminal}`);
        const claim = runtime.state.claimJob(job.job_id, "candidate-worker", Date.now(), 10_000);
        assert.ok(claim);
        const candidate = { answer: "synthetic_candidate_must_not_be_delivered" } as AnalysisRecord;
        assert.equal(runtime.state.finish(job.job_id, claim.owner, claim.fence, terminal, candidate, { code: "synthetic_failure", message: "synthetic failure" }), true);
        assert.equal(runtime.state.getJob(job.job_id)?.analysis, null);
        // Reproduce an old record without rewriting or deleting any real history.
        database.prepare("UPDATE jobs SET analysis_json = ? WHERE job_id = ?").run(JSON.stringify(candidate), job.job_id);
        const response = await fetch(`http://127.0.0.1:${address.port}/api/jobs/${job.job_id}`);
        const body = await response.json() as { status: string; analysis: unknown };
        assert.equal(body.status, terminal);
        assert.equal(body.analysis, null);
        assert.notEqual(runtime.state.getJob(job.job_id)?.analysis, null, "API 屏蔽不得改写历史记录");
      }
    } finally {
      database.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
