import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DEMO_QUESTIONS } from "../src/demo.js";
import { decideResume, modelRequestEvidence, openGovernedSession, SESSION_SNAPSHOT_FORMAT } from "../src/pi-session.js";
import { ask, analyst, openRuntime, waitForJob, withRuntime } from "./helpers.js";

const question = DEMO_QUESTIONS[0].text;

test("真实 AgentSession 保存 JSONL 分支，知识正文进入下一次 faux 请求", async () => {
  await withRuntime({ modelMode: "pi", piProvider: "faux" }, async (runtime) => {
    const session = analyst(runtime);
    const job = await ask(runtime, session.session_id, question);
    assert.equal(job.status, "partial");
    assert.equal(job.usage?.input_tokens, null);
    assert.equal(job.usage?.cost, null);
    assert.equal(job.usage?.usage_source, "faux_unmeasured");
    const settled = runtime.state.loadAgentSnapshot(session.session_id, { kind: "settled" });
    assert.equal(settled?.body.format, SESSION_SNAPSHOT_FORMAT);
    assert.equal(settled?.body.sdk_version, "1.1.0");
    const jsonl = String(settled?.body.jsonl);
    assert.match(jsonl, /"type":"session"/);
    assert.match(jsonl, /"type":"compaction"|用户原话|Starlane Drift/);
    assert.equal(jsonl.includes("<trusted_turn>"), false);
    assert.equal(jsonl.includes("\"name\":\"bash\""), false);
    assert.equal(jsonl.includes("\"name\":\"edit\""), false);
    assert.equal(jsonl.includes("\"name\":\"write\""), false);
    const evidence = modelRequestEvidence(session.session_id);
    assert.ok(evidence && evidence.knowledgeBodyChars > 0, JSON.stringify(evidence));
    assert.ok(job.events.some((event) => event.type === "tool_started" && (event.payload.args as { knowledge_body_visible?: boolean } | undefined)?.knowledge_body_visible === true));
    const seqs = job.events.map((event) => event.seq);
    assert.deepEqual(seqs, [...seqs].sort((left, right) => left - right));
    assert.equal(new Set(seqs).size, seqs.length);

    const root = mkdtempSync(path.join(tmpdir(), "lumenfox-reopen-"));
    const file = path.join(root, "session.jsonl");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, jsonl);
    const reopened = SessionManager.open(file, root, root);
    assert.equal(reopened.getLeafId(), settled?.body.leaf_id);
    assert.deepEqual(reopened.getBranch().map((entry) => entry.id), settled?.body.branch_entry_ids);
    const roles = reopened.buildSessionContext().messages.map((message) => message.role);
    assert.ok(roles.includes("toolResult"));
    assert.equal(roles.includes("compactionSummary"), false);

    const follow = await ask(runtime, session.session_id, "那安卓呢？");
    assert.notEqual(follow.status, "failed", JSON.stringify(follow.error));
    const followed = runtime.state.loadAgentSnapshot(session.session_id, { kind: "settled" });
    const followedJsonl = String(followed?.body.jsonl);
    assert.match(followedJsonl, /那安卓呢/);
    assert.match(followedJsonl, /Starlane Drift/);
    const stale = runtime.state.saveAgentSnapshot({
      sessionId: session.session_id,
      jobId: follow.job_id,
      owner: "stale-worker",
      fence: follow.fence,
      kind: "progress",
      body: { format: SESSION_SNAPSHOT_FORMAT },
    });
    assert.equal(stale, false);
  });
});

test("坏快照、分支不一致和缺失工具回执会失败，不回退到消息数组", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lumenfox-pi-bad-"));
  const runtime = openRuntime(dir, { modelMode: "pi", piProvider: "faux", startWorker: false });
  try {
    const session = runtime.sessions.create("analyst");
    const corrupt = runtime.jobs.submit(session.session_id, question, "corrupt");
    insertSnapshot(dir, session.session_id, corrupt.job_id, {
      format: SESSION_SNAPSHOT_FORMAT,
      sdk: "@earendil-works/pi-coding-agent",
      sdk_version: "1.1.0",
      leaf_id: "x",
      branch_entry_ids: ["x"],
      user_message_sha256: createHash("sha256").update(question).digest("hex"),
      jsonl: `%%%\n${question}\n`,
    });
    runtime.jobs.start();
    const failed = await waitForJob(runtime, corrupt.job_id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error?.code, "session_snapshot_corrupt");
    assert.equal(failed.analysis, null);

    const mismatch = runtime.jobs.submit(session.session_id, "看看收入", "mismatch");
    const built = sessionFile("看看收入");
    insertSnapshot(dir, session.session_id, mismatch.job_id, {
      ...built.body,
      leaf_id: "missing-leaf",
    });
    const mismatched = await waitForJob(runtime, mismatch.job_id);
    assert.equal(mismatched.status, "failed");
    assert.equal(mismatched.error?.code, "session_branch_mismatch");

    const missing = runtime.jobs.submit(session.session_id, "工具回执缺失", "missing-receipt");
    const receipt = sessionFile("工具回执缺失", true);
    insertSnapshot(dir, session.session_id, missing.job_id, receipt.body);
    const rejected = await waitForJob(runtime, missing.job_id);
    assert.equal(rejected.status, "failed");
    assert.equal(rejected.error?.code, "tool_receipt_missing");
  } finally {
    await runtime.close();
  }
});

test("超过模型窗口时自动压缩，原始用户原话仍留在会话记录", async () => {
  await withRuntime(
    { modelMode: "pi", piProvider: "faux", fauxContextWindow: 1500, compactionReserveTokens: 0, compactionKeepRecentTokens: 200 },
    async (runtime) => {
      const session = analyst(runtime);
      const governed = await openGovernedSession({
        config: runtime.config,
        appSessionId: session.session_id,
        tools: runtime.tools,
        userText: question,
      });
      try {
        await governed.session.prompt(question, { expandPromptTemplates: false, source: "rpc" });
        const entries = governed.session.sessionManager.getEntries();
        assert.ok(entries.some((entry) => entry.type === "compaction"), entries.map((entry) => entry.type).join(","));
        assert.ok(entries.some((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("Starlane Drift")));
        const context = governed.session.sessionManager.buildSessionContext();
        assert.equal(context.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("这是压缩摘要")), false);
        assert.ok(context.messages.some((message) => message.role === "compactionSummary"));
      } finally {
        governed.dispose();
      }
    },
  );
});

test("压缩摘要保持独立记录，取消只产生一次终态", async () => {
  const decision = decideResume({
    contextMessages: [
      { role: "user", content: [{ type: "text", text: "原话" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "1", name: "query", arguments: {} }] },
    ],
    leafParentId: "user-entry",
    jobUserText: "原话",
    hasAnalysis: false,
    resumingProgress: true,
  });
  assert.equal(decision.action, "redo_tool_call");
  if (decision.action === "redo_tool_call") assert.equal(decision.query_may_rerun, true);
  const summary = decideResume({
    contextMessages: [
      { role: "user", content: "原话" },
      { role: "compactionSummary" },
    ],
    leafParentId: null,
    jobUserText: "原话",
    hasAnalysis: false,
    resumingProgress: true,
  });
  assert.equal(summary.action, "reject");
  if (summary.action === "reject") assert.match(summary.message, /压缩摘要/);

  await withRuntime({ modelMode: "pi", piProvider: "faux", toolDelayMs: 300 }, async (runtime) => {
    const session = analyst(runtime);
    const queued = runtime.jobs.submit(session.session_id, question, "cancel-pi");
    await new Promise((resolve) => setTimeout(resolve, 80));
    runtime.jobs.cancel(queued.job_id);
    const cancelled = await waitForJob(runtime, queued.job_id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.events.filter((event) => ["job_finished", "job_failed", "job_cancelled"].includes(event.type)).length, 1);

    const governed = await openGovernedSession({
      config: runtime.config,
      appSessionId: session.session_id,
      tools: runtime.tools,
      userText: question,
    });
    try {
      await governed.session.prompt(question, { expandPromptTemplates: false, source: "rpc" });
      const result = await governed.session.compact("保留原始用户约束，不要把摘要写成新的用户原话。");
      assert.match(result.summary, /不是新的用户原话/);
      assert.match(result.summary, /Starlane Drift/);
      const entries = governed.session.sessionManager.getEntries();
      assert.ok(entries.some((entry) => entry.type === "compaction"));
      assert.ok(entries.some((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("Starlane Drift")));
      const context = governed.session.sessionManager.buildSessionContext();
      assert.ok(context.messages.some((message) => message.role === "compactionSummary"));
      assert.equal(
        context.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("这是压缩摘要")),
        false,
      );
    } finally {
      governed.dispose();
    }
    const held = await openGovernedSession({
      config: { ...runtime.config, modelHoldMs: 800 },
      appSessionId: session.session_id,
      tools: runtime.tools,
      userText: question,
    });
    try {
      await held.session.prompt(question, { expandPromptTemplates: false, source: "rpc" });
      const pending = held.session.compact("保留原始用户约束，不要把摘要写成新的用户原话。");
      await new Promise((resolve) => setTimeout(resolve, 80));
      held.session.abortCompaction();
      await pending.catch(() => undefined);
      const entries = held.session.sessionManager.getEntries();
      assert.equal(entries.some((entry) => entry.type === "compaction"), false);
      assert.ok(entries.some((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("Starlane Drift")));
      const context = held.session.sessionManager.buildSessionContext();
      assert.equal(context.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("这是压缩摘要")), false);
    } finally {
      held.dispose();
    }
  });
});

function insertSnapshot(dir: string, sessionId: string, jobId: string, body: Record<string, unknown>): void {
  const db = new DatabaseSync(path.join(dir, "state.sqlite"));
  db.prepare("INSERT INTO agent_snapshots (session_id, job_id, fence, kind, body_json, created_at) VALUES (?, ?, 0, 'progress', ?, ?)").run(
    sessionId,
    jobId,
    JSON.stringify(body),
    new Date().toISOString(),
  );
  db.close();
}

function sessionFile(text: string, withReceipt = false): { body: Record<string, unknown> } {
  const root = mkdtempSync(path.join(tmpdir(), "lumenfox-jsonl-"));
  const manager = SessionManager.create(path.join(root, "cwd"), path.join(root, "sessions"));
  manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
  if (withReceipt) {
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "tool-1", name: "update_analysis", arguments: {} }],
      api: "faux",
      provider: "lumenfox-local",
      model: "deterministic-analyst",
      stopReason: "toolUse",
      timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "update_analysis",
      content: [{ type: "text", text: "{\"ok\":true}" }],
      isError: false,
      timestamp: Date.now(),
    });
  }
  const file = manager.getSessionFile();
  if (!file) throw new Error("session file missing");
  return {
    body: {
      format: SESSION_SNAPSHOT_FORMAT,
      sdk: "@earendil-works/pi-coding-agent",
      sdk_version: "1.1.0",
      leaf_id: manager.getLeafId(),
      branch_entry_ids: manager.getBranch().map((entry) => entry.id),
      user_message_sha256: createHash("sha256").update(text).digest("hex"),
      jsonl: readFileSync(file, "utf8"),
    },
  };
}
