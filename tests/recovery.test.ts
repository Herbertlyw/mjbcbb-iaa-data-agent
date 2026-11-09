import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEMO_QUESTIONS } from "../src/demo.js";
import { SqliteStateStore } from "../src/state-store.js";
import { isTerminal } from "../src/types.js";
import { ask, openRuntime, waitForJob } from "./helpers.js";

const TERMINALS = new Set(["job_finished", "job_failed", "job_cancelled", "job_timed_out"]);

test("重启后仍能读取会话、消息、任务和证据", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lumenfox-restart-"));
  let first: ReturnType<typeof openRuntime> | undefined;
  let second: ReturnType<typeof openRuntime> | undefined;
  try {
    first = openRuntime(dir);
    const session = first.sessions.create("analyst", "重启演示");
    const done = await ask(first, session.session_id, DEMO_QUESTIONS[2].text, "restart-key");
    assert.equal(done.status, "partial");
    assert.ok(done.analysis?.server_reasons.includes("calculation_input_incomplete"));
    assert.ok(!done.analysis?.server_reasons.includes("calculation_lineage_unsupported"));
    await first.close();
    first = undefined;

    second = openRuntime(dir, { startWorker: false });
    const restored = second.sessions.require(session.session_id);
    assert.equal(restored.title, "重启演示");
    assert.equal(restored.slots?.platform, "ios");
    assert.equal(restored.slots?.country, "JP");
    const messages = second.state.listMessages(session.session_id);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.text, DEMO_QUESTIONS[2].text);
    const job = second.jobs.require(done.job_id);
    assert.equal(job.status, "partial");
    assert.match(job.analysis?.answer ?? "", /70/);
    assert.equal(job.analysis?.calculations.find((item) => Object.hasOwn(item.cells, "revenue_predicted"))?.cells.revenue_predicted, null);
    assert.deepEqual(job.analysis?.calculations, done.analysis?.calculations);
    assert.equal(job.events[0]?.type, "job_queued");
    assert.deepEqual(
      job.events.map((event) => event.seq),
      job.events.map((_, index) => index + 1),
    );
    const replay = job.events.filter((event) => event.seq > 2);
    assert.equal(replay[0]?.seq, 3);
    assert.deepEqual(
      replay.map((event) => event.seq),
      job.events.slice(2).map((event) => event.seq),
    );
    const again = second.jobs.submit(session.session_id, DEMO_QUESTIONS[2].text, "restart-key");
    assert.equal(again.job_id, done.job_id);
    const reopened = second;
    assert.throws(() => reopened.jobs.submit(session.session_id, "另一句不同的问题", "restart-key"), (error: unknown) => {
      return error instanceof Error && "code" in error && error.code === "idempotency_conflict";
    });
    const other = second.sessions.create("analyst");
    const resourceId = job.analysis?.citations[0]?.resource_id ?? "";
    const foreign = await second.tools.readSessionResource(other.session_id, { resource_id: resourceId });
    assert.equal(foreign.ok, false);
    if (!foreign.ok) assert.equal(foreign.code, "cross_session_resource");
    await second.close();
    second = undefined;
  } finally {
    if (first) await first.close({ abandon: true });
    if (second) await second.close({ abandon: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("租约过期后旧执行者不能覆盖新执行者，崩溃任务会被回收一次", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lumenfox-lease-"));
  try {
    const first = openRuntime(dir, { toolDelayMs: 1200, leaseMs: 400, heartbeatMs: 50, pollMs: 20 });
    const session = first.sessions.create("analyst");
    const submitted = first.jobs.submit(session.session_id, DEMO_QUESTIONS[2].text, "lease-key");
    const started = Date.now();
    while (!first.jobs.require(submitted.job_id).events.some((event) => event.type === "tool_started")) {
      if (Date.now() - started > 2000) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    first.jobs.pauseHeartbeats();
    first.jobs.expireLease(submitted.job_id);
    const second = openRuntime(dir, { leaseMs: 5000, pollMs: 20 });
    const done = await waitForJob(second, submitted.job_id);
    assert.equal(isTerminal(done.status), true);
    assert.equal(done.events.filter((event) => TERMINALS.has(event.type)).length, 1);
    assert.deepEqual(
      done.events.map((event) => event.seq),
      done.events.map((_, index) => index + 1),
    );
    await first.close({ abandon: true });
    const after = second.jobs.require(submitted.job_id);
    assert.equal(after.status, done.status);
    assert.equal(after.events.filter((event) => TERMINALS.has(event.type)).length, 1);
    await second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("并发领取只有一个成功，过期围栏不能写终态", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lumenfox-fence-"));
  const file = path.join(dir, "state.sqlite");
  const now = Date.now();
  try {
    const left = new SqliteStateStore(file);
    const right = new SqliteStateStore(file);
    left.createSession({
      session_id: "ses_fence",
      title: "围栏",
      role: "analyst",
      created_at: new Date(now).toISOString(),
      slots: null,
      bindings: [],
    });
    left.createJob({
      job: {
        job_id: "job_fence",
        session_id: "ses_fence",
        status: "queued",
        user_text: "并发领取",
        idempotency_key: "fence",
        turn: {
          kind: "new_question",
          intent: "performance",
          raw_text: "并发领取",
          slots: { game: "starlane_drift", metrics: [] },
          inherited: [],
          replaced: [],
          missing_slots: ["platform"],
          search_query: "",
          read_asset_ids: [],
          contract_asset_ids: [],
          clarification_question: null,
        },
        events: [],
        next_seq: 2,
        version: 1,
        analysis: null,
        error: null,
        abort_reason: null,
        fence: 0,
        lease_owner: null,
        lease_until: null,
        cancel_requested: false,
        simulated: true,
        created_at: new Date(now).toISOString(),
      },
      session: {
        session_id: "ses_fence",
        title: "围栏",
        role: "analyst",
        created_at: new Date(now).toISOString(),
        slots: null,
        bindings: [],
      },
      message: {
        message_id: "msg_fence",
        session_id: "ses_fence",
        job_id: "job_fence",
        role: "user",
        text: "并发领取",
        created_at: new Date(now).toISOString(),
      },
    });
    const claims = await Promise.all([
      Promise.resolve().then(() => left.claimNext("owner-a", now, 5_000)),
      Promise.resolve().then(() => right.claimNext("owner-b", now, 5_000)),
    ]);
    assert.equal(claims.filter((claim) => claim !== null).length, 1);
    const winner = claims.find((claim) => claim !== null);
    if (!winner) throw new Error("没有执行者领到任务");
    left.expireLease("job_fence");
    const recovered = right.claimNext("owner-b", Date.now(), 5_000);
    assert.ok(recovered);
    if (!recovered) return;
    assert.notEqual(recovered.fence, winner.fence);
    assert.equal(left.appendEvent("job_fence", winner.owner, winner.fence, "tool_finished", { late: true }), null);
    assert.equal(left.finish("job_fence", winner.owner, winner.fence, "completed", null, null), false);
    assert.equal(right.finish("job_fence", recovered.owner, recovered.fence, "failed", null, { code: "recovered", message: "新执行者收口" }), true);
    const job = left.getJob("job_fence");
    assert.equal(job?.status, "failed");
    assert.equal(job?.events.filter((event) => TERMINALS.has(event.type)).length, 1);
    assert.equal(job?.error?.code, "recovered");
    const duplicate = left.createJob({
      job: {
        job_id: "job_other",
        session_id: "ses_fence",
        status: "queued",
        user_text: "并发领取",
        idempotency_key: "fence",
        turn: job!.turn,
        events: [],
        next_seq: 2,
        version: 1,
        analysis: null,
        error: null,
        abort_reason: null,
        fence: 0,
        lease_owner: null,
        lease_until: null,
        cancel_requested: false,
        simulated: true,
        created_at: new Date().toISOString(),
      },
      session: {
        session_id: "ses_fence",
        title: "围栏",
        role: "analyst",
        created_at: new Date().toISOString(),
        slots: null,
        bindings: [],
      },
      message: {
        message_id: "msg_dup",
        session_id: "ses_fence",
        job_id: "job_other",
        role: "user",
        text: "并发领取",
        created_at: new Date().toISOString(),
      },
    });
    assert.equal(duplicate.job_id, "job_fence");
    left.close();
    right.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
