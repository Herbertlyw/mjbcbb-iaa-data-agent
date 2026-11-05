import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { inspectCompaction, openGovernedSession, SESSION_SNAPSHOT_FORMAT, type PiSessionSnapshotBody } from "../src/pi-session.js";
import { analyst, withRuntime } from "./helpers.js";

test("SDK JSONL 在活动分支恢复转义原话并绑定本轮用户条目", async () => {
  await withRuntime({ modelMode: "pi", piProvider: "faux" }, async (runtime) => {
    const session = analyst(runtime);
    for (const text of ['查询"纸灯"的收入', "第一行\n第二行", "路径 a\\b", "Unicode 🐟 日本"]) {
      const root = mkdtempSync(path.join(tmpdir(), "pi-turn-"));
      try {
        const manager = SessionManager.create(path.join(root, "cwd"), path.join(root, "sessions"));
        manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
        manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "checkpoint" }], api: "faux", provider: "lumenfox-local", model: "deterministic-analyst", stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
        const branch = manager.getBranch(); const user = branch.find((entry) => entry.type === "message" && entry.message.role === "user"); assert.ok(user);
        const snapshot: PiSessionSnapshotBody = { format: SESSION_SNAPSHOT_FORMAT, sdk: "@earendil-works/pi-coding-agent", sdk_version: "1.1.0", leaf_id: manager.getLeafId(), branch_entry_ids: branch.map((entry) => entry.id), user_message_sha256: createHash("sha256").update(text).digest("hex"), user_message_entry_id: user.id, jsonl: readFileSync(manager.getSessionFile()!, "utf8") };
        const opened = await openGovernedSession({ config: runtime.config, appSessionId: session.session_id, tools: runtime.tools, userText: text, snapshot, requireUserText: true }); opened.dispose();
        await assert.rejects(() => openGovernedSession({ config: runtime.config, appSessionId: session.session_id, tools: runtime.tools, userText: text, snapshot: { ...snapshot, user_message_entry_id: "wrong" }, requireUserText: true }), /活动分支/);
        await assert.rejects(() => openGovernedSession({ config: runtime.config, appSessionId: session.session_id, jobId: "job_current", tools: runtime.tools, userText: text, snapshot: { ...snapshot, job_id: "job_old" }, requireUserText: true }), /当前任务/);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
});

test("相同原话重复出现时必须绑定最新条目，旧回合工具不会误判为当前压缩丢失", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "同一句" } },
    { type: "message", message: { role: "toolResult", toolCallId: "old" } },
    { type: "message", message: { role: "user", content: "同一句" } },
    { type: "compaction" },
  ];
  assert.deepEqual(inspectCompaction(entries, [{ role: "compactionSummary" }], "同一句"), { hidesToolResults: false, userTextPersisted: true });
  assert.deepEqual(inspectCompaction([...entries, { type: "message", message: { role: "toolResult", toolCallId: "current" } }], [{ role: "compactionSummary" }], "同一句"), { hidesToolResults: true, userTextPersisted: true });
  assert.equal(inspectCompaction(entries, [], "不同问题").userTextPersisted, false);
});

test("SDK 重复原话与旧分支不得冒充当前任务回合", async () => {
  await withRuntime({ modelMode: "pi", piProvider: "faux" }, async (runtime) => {
    const session = analyst(runtime); const root = mkdtempSync(path.join(tmpdir(), "pi-branch-"));
    try {
      const manager = SessionManager.create(path.join(root, "cwd"), path.join(root, "sessions"));
      const first = manager.appendMessage({ role: "user", content: [{ type: "text", text: "同一句" }], timestamp: Date.now() });
      const second = manager.appendMessage({ role: "user", content: [{ type: "text", text: "同一句" }], timestamp: Date.now() });
      const makeSnapshot = (): PiSessionSnapshotBody => ({ format: SESSION_SNAPSHOT_FORMAT, sdk: "@earendil-works/pi-coding-agent", sdk_version: "1.1.0", leaf_id: manager.getLeafId(), branch_entry_ids: manager.getBranch().map((entry) => entry.id), user_message_sha256: createHash("sha256").update("同一句").digest("hex"), user_message_entry_id: second, job_id: "job_current", jsonl: readFileSync(manager.getSessionFile()!, "utf8") });
      const options = { config: runtime.config, appSessionId: session.session_id, jobId: "job_current", tools: runtime.tools, userText: "同一句", requireUserText: true };
      const opened = await openGovernedSession({ ...options, snapshot: makeSnapshot() }); opened.dispose();
      await assert.rejects(() => openGovernedSession({ ...options, snapshot: { ...makeSnapshot(), user_message_entry_id: first } }), /活动分支/);
      const legacy = makeSnapshot(); delete legacy.user_message_entry_id;
      await assert.rejects(() => openGovernedSession({ ...options, snapshot: legacy }), /重复原话/);
      manager.branch(first);
      manager.appendMessage({ role: "user", content: [{ type: "text", text: "另一个回合" }], timestamp: Date.now() });
      await assert.rejects(() => openGovernedSession({ ...options, snapshot: makeSnapshot() }), /活动分支/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
