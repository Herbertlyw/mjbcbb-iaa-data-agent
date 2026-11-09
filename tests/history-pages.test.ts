import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { parseEventAfter, parseHistoryPage } from "../src/history-page.mjs";
import { SqliteStateStore } from "../src/state-store.js";
import { startServer } from "../src/server.js";
import { withRuntime } from "./helpers.js";

const first = () => parseHistoryPage(new URLSearchParams(), "sessions", "demo-analyst");

test("会话分页覆盖 0/1/63/64/65/70/100，相同时间戳及翻页间新增不重不漏", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vv-history-state-"));
  const store = new SqliteStateStore(path.join(dir, "state.sqlite"));
  const created = "2026-11-09T00:00:00.000Z";
  const insert = (id: string, actor = "demo-analyst") => store.createSession({ session_id: id, title: id, role: "analyst", actor_id: actor, created_at: created, slots: null, bindings: [] });
  try {
    assert.deepEqual(store.listSessionSummaries("demo-analyst", first()), { items: [], has_more: false, next_cursor: null });
    for (let n = 1; n <= 100; n++) {
      insert(`ses_${String(n).padStart(3, "0")}`);
      if ([1, 63, 64, 65, 70, 100].includes(n)) {
        const page = store.listSessionSummaries("demo-analyst", first());
        assert.equal(page.items.length, Math.min(n, 25));
        assert.equal(page.has_more, n > 25);
        assert.ok(!JSON.stringify(page).includes("bindings"));
      }
    }
    insert("ses_private", "demo-viewer");
    let page = store.listSessionSummaries("demo-analyst", first());
    const seen = page.items.map(item => item.session_id);
    // Both IDs fall below the first page's last sort key. A timestamp-only
    // high-water mark would leak these late inserts into the ongoing traversal.
    insert("ses_050_late"); insert("ses_000_late");
    while (page.has_more) {
      const input = parseHistoryPage(new URLSearchParams({ before: page.next_cursor! }), "sessions", "demo-analyst");
      const repeat = store.listSessionSummaries("demo-analyst", input);
      assert.deepEqual(store.listSessionSummaries("demo-analyst", input), repeat);
      page = repeat;
      seen.push(...page.items.map(item => item.session_id));
    }
    assert.equal(seen.length, 100);
    assert.equal(new Set(seen).size, 100);
    assert.ok(!seen.some(id => id.includes("late") || id.includes("private")));
    const all = store.listSessionSummaries("demo-analyst", parseHistoryPage(new URLSearchParams({ limit: "50" }), "sessions", "demo-analyst"));
    assert.equal(all.items.length, 50);
    assert.equal(store.listSessionSummaries("demo-viewer", parseHistoryPage(new URLSearchParams(), "sessions", "demo-viewer")).items.length, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("分页和事件游标严格校验，不能跨主体或会话重用", () => {
  for (const limit of ["0", "51", "-1", "1.5", "Infinity", "NaN", "", "01", "9999999999"]) assert.throws(() => parseHistoryPage(new URLSearchParams({ limit }), "sessions", "a"));
  const cursor = Buffer.from(JSON.stringify({ v: 1, kind: "sessions", scope: "a", snapshot: "100", at: "2026-11-09T00:00:00.000Z", id: "ses_1" })).toString("base64url");
  assert.equal(parseHistoryPage(new URLSearchParams({ before: cursor }), "sessions", "a").cursor?.id, "ses_1");
  assert.throws(() => parseHistoryPage(new URLSearchParams({ before: cursor }), "sessions", "b"));
  assert.throws(() => parseHistoryPage(new URLSearchParams({ before: cursor }), "jobs", "a"));
  for (const value of ["", "NaN", "Infinity", "-1", "1.2", "9007199254740992", " 1", "+1", "01"]) assert.throws(() => parseEventAfter(new URLSearchParams({ after: value })));
  assert.equal(parseEventAfter(new URLSearchParams()), 0);
  assert.equal(parseEventAfter(new URLSearchParams({ after: "9007199254740991" })), Number.MAX_SAFE_INTEGER);
});

test("旧 SQLite 状态库增补分页索引并保留数据", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vv-history-migrate-"));
  const file = path.join(dir, "state.sqlite");
  const legacy = new DatabaseSync(file);
  legacy.exec("CREATE TABLE sessions (session_id TEXT PRIMARY KEY, title TEXT NOT NULL, role TEXT NOT NULL, slots_json TEXT, bindings_json TEXT NOT NULL, created_at TEXT NOT NULL)");
  legacy.prepare("INSERT INTO sessions VALUES (?, ?, ?, NULL, '[]', ?)").run("ses_legacy", "旧会话", "analyst", "2026-11-09T00:00:00.000Z");
  legacy.close();
  const store = new SqliteStateStore(file);
  const reader = new DatabaseSync(file);
  try {
    assert.equal(store.listSessionSummaries("demo-analyst", first()).items[0]?.title, "旧会话");
    const indexes = reader.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(row => row.name);
    for (const name of ["idx_sessions_history", "idx_jobs_history", "idx_jobs_active"]) assert.ok(indexes.includes(name));
  } finally { reader.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("HTTP 列表只读摘要；200 个历史任务不触发全量读取，活动任务不依赖历史页", async () => {
  await withRuntime({ startWorker: false }, async runtime => {
    const session = runtime.sessions.create("analyst");
    for (let index = 0; index < 200; index++) {
      const job = runtime.jobs.submit(session.session_id, `合成问题 ${index} ${"x".repeat(300)}`, `history-${index}`);
      runtime.state.requestCancel(job.job_id);
    }
    const active = runtime.jobs.submit(session.session_id, "当前活动任务", "active");
    runtime.state.listSessions = () => { throw new Error("unbounded_sessions_forbidden"); };
    runtime.state.listJobs = () => { throw new Error("unbounded_jobs_forbidden"); };
    const originalGet = runtime.state.getJob.bind(runtime.state);
    runtime.state.getJob = () => { throw new Error("summary_must_not_read_details"); };
    const server = startServer(runtime);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const list = await (await fetch(`${base}/api/sessions`)).json() as { sessions: object[] };
      assert.equal(list.sessions.length, 1);
      assert.ok(!JSON.stringify(list).match(/bindings|events|analysis|jobs|slots/));
      const metadata = await (await fetch(`${base}/api/sessions/${session.session_id}`)).json() as { active_job_id: string; jobs?: unknown };
      assert.equal(metadata.active_job_id, active.job_id); assert.equal(metadata.jobs, undefined);
      let cursor: string | null = null;
      const ids: string[] = [];
      do {
        const url: string = `${base}/api/sessions/${session.session_id}/jobs${cursor ? `?before=${cursor}` : ""}`;
        const response: Response = await fetch(url); assert.equal(response.status, 200);
        const text = await response.text(); assert.ok(Buffer.byteLength(text) < 45_000);
        const page = JSON.parse(text) as { jobs: Array<{ job_id: string; user_text_preview: string }>; next_cursor: string | null; active_job_id: string };
        assert.equal(page.active_job_id, active.job_id);
        assert.ok(page.jobs.length <= 25);
        assert.ok(page.jobs.every(job => job.user_text_preview.length <= 240));
        assert.doesNotMatch(text, /"analysis"|"events"|"usage"|"turn"/);
        ids.push(...page.jobs.map(job => job.job_id)); cursor = page.next_cursor;
      } while (cursor);
      assert.equal(ids.length, 201); assert.equal(new Set(ids).size, 201);
      assert.equal((await fetch(`${base}/api/sessions?limit=51`)).status, 400);
      assert.equal((await fetch(`${base}/api/sessions/${session.session_id}/jobs`, { headers: { "x-demo-actor": "demo-viewer" } })).status, 404);
      runtime.state.getJob = originalGet;
      assert.equal((await fetch(`${base}/api/jobs/${active.job_id}`)).status, 200);
    } finally {
      runtime.state.getJob = originalGet;
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
