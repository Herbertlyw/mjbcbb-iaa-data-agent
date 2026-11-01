import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { analyst, openRuntime } from "./helpers.js";

const root = fileURLToPath(new URL("..", import.meta.url));

test("worker 进程恢复压缩摘要时不把它当成用户原话，终态只有一个", async () => {
  const safe = await runCase("压缩后的原话", false);
  assert.equal(safe.user, "压缩后的原话");
  assert.equal(safe.terminals, 1);
  assert.equal(safe.decisions.includes("compaction_checkpoint_continued"), true, JSON.stringify(safe));
  assert.equal(safe.user.includes("压缩摘要"), false);

  const hidden = await runCase("工具被摘要盖住", true);
  assert.equal(hidden.terminals, 1);
  assert.equal(hidden.status, "failed");
  assert.equal(hidden.error, "compaction_hides_tool_results");
  assert.equal(hidden.user, "工具被摘要盖住");
});

async function runCase(text: string, hideTool: boolean): Promise<{ status: string; error: string | null; decisions: string[]; terminals: number; user: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), "lumenfox-compact-"));
  const runtime = openRuntime(dir, { modelMode: "pi", piProvider: "faux", startWorker: false });
  const session = analyst(runtime);
  const job = runtime.jobs.submit(session.session_id, text, `compact-${hideTool ? "hide" : "safe"}`);
  insertSnapshot(path.join(dir, "state.sqlite"), session.session_id, job.job_id, snapshot(text, hideTool));
  await runtime.close({ abandon: true });
  const child = spawn(process.execPath, ["--import", "tsx", "tests/compaction-child.ts", path.join(dir, "state.sqlite"), path.join(dir, "business.sqlite"), path.join(dir, "freshness-current.json"), job.job_id], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, 25_000);
    child.on("exit", (status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });
  assert.equal(code, 0, `${stderr}\n${stdout}`);
  return JSON.parse(stdout) as { status: string; error: string | null; decisions: string[]; terminals: number; user: string };
}

function snapshot(text: string, hideTool: boolean): Record<string, unknown> {
  const folder = mkdtempSync(path.join(tmpdir(), "lumenfox-jsonl-"));
  const manager = SessionManager.create(path.join(folder, "cwd"), path.join(folder, "sessions"));
  manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
  if (hideTool) {
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "query",
      content: [{ type: "text", text: "{\"ok\":true,\"resource_id\":\"res_hidden\"}" }],
      isError: false,
      timestamp: Date.now(),
    });
  }
  manager.appendCompaction("这是压缩摘要，不是用户原话", null, 20);
  const file = manager.getSessionFile();
  if (!file) throw new Error("没有会话文件");
  return {
    format: "pi-coding-agent-session-jsonl-v3",
    sdk: "@earendil-works/pi-coding-agent",
    sdk_version: "1.1.0",
    leaf_id: manager.getLeafId(),
    branch_entry_ids: manager.getBranch().map((entry) => entry.id),
    user_message_sha256: createHash("sha256").update(text).digest("hex"),
    jsonl: readFileSync(file, "utf8"),
  };
}

function insertSnapshot(file: string, sessionId: string, jobId: string, body: Record<string, unknown>): void {
  const db = new DatabaseSync(file);
  db.prepare("INSERT INTO agent_snapshots (session_id, job_id, fence, kind, body_json, created_at) VALUES (?, ?, 0, 'progress', ?, ?)").run(
    sessionId,
    jobId,
    JSON.stringify(body),
    new Date().toISOString(),
  );
  db.close();
}
