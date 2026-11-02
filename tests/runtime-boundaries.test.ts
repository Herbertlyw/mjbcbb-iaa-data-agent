import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, repoRoot } from "../src/config.js";
import { assertJoinKeys, guardSql, SqlRejected, type TableRule } from "../src/sql.js";
import { SessionStore } from "../src/session.js";
import { domainTools } from "../src/agent.js";
import type { AnalysisRecord } from "../src/types.js";
import { probeClickHouseAndPublish } from "../src/freshness.js";
import path from "node:path";
import { analyst, ask, bindTables, withRuntime } from "./helpers.js";

test("所有查询层级的 JOIN 都执行登记键检查，逗号连接不能绕过", () => {
  const nested = [
    "WITH x AS (SELECT a.event_date FROM daily_installs a JOIN daily_ad_revenue b ON a.event_date = b.event_date) SELECT event_date FROM x",
    "SELECT event_date FROM (SELECT a.event_date FROM daily_installs a JOIN daily_ad_revenue b ON a.event_date = b.event_date) x",
    "SELECT a.event_date FROM daily_installs a, daily_ad_revenue b",
  ];
  for (const sql of nested) {
    assert.throws(() => assertJoinKeys(sql, []), (error: unknown) => error instanceof SqlRejected);
  }
});

test("连接键、别名、粒度和日期边界不能因嵌套或其他表的同名字段被绕过", () => {
  const joins = [{ tables: ["facts", "labels"], keys: ["id"] }];
  const grains = new Map([["facts", ["id", "event_date"]], ["labels", ["id"]]]);
  const on = "f.id = d.id";
  assert.doesNotThrow(() => assertJoinKeys(`WITH x AS (SELECT f.event_date FROM facts f JOIN labels d ON ${on}) SELECT event_date FROM x`, joins, grains));
  for (const clause of ["f.id = d.id OR 1 = 1", "f.id = d.id AND f.event_date = d.event_date", "f.id = f.id", "f.id = 1"]) {
    assert.throws(() => assertJoinKeys(`SELECT f.event_date FROM facts f JOIN labels d ON ${clause}`, joins, grains), SqlRejected);
  }
  assert.throws(() => assertJoinKeys(`SELECT f.event_date FROM facts f JOIN facts d ON ${on}`, joins, grains), SqlRejected);
  assert.throws(() => assertJoinKeys(`SELECT f.event_date FROM facts f JOIN labels d ON ${on}`, joins), SqlRejected);
  assert.throws(() => assertJoinKeys("WITH facts AS (SELECT id FROM labels) SELECT f.id FROM facts f JOIN labels d ON f.id = d.id", joins, grains), (error: unknown) => error instanceof SqlRejected && error.code === "join_structure_unsupported");
  const rules: TableRule[] = [
    { table: "facts", allowed_columns: ["id", "event_date", "amount"], sensitive_columns: [], must_filter: ["event_date"] },
    { table: "labels", allowed_columns: ["id", "event_date", "label"], sensitive_columns: [], must_filter: ["event_date"] },
  ];
  const range = "f.event_date >= '2026-10-06' AND f.event_date <= '2026-10-12'";
  assert.throws(() => guardSql(`SELECT f.amount FROM facts f JOIN labels d ON ${on} WHERE ${range}`, rules), (error: unknown) => error instanceof SqlRejected && error.code === "unbounded_query");
  assert.throws(() => guardSql(`SELECT f.amount FROM facts f WHERE NOT (${range})`, rules), (error: unknown) => error instanceof SqlRejected && ["unbounded_query", "dangerous_function"].includes(error.code));
  assert.throws(() => guardSql(`SELECT f.label FROM facts f JOIN labels d ON ${on} WHERE ${range} AND d.event_date >= '2026-10-06' AND d.event_date <= '2026-10-12'`, rules), (error: unknown) => error instanceof SqlRejected && error.code === "column_not_in_contract");
});

test("工具入口拒绝嵌套未登记 JOIN，且不创建资源", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs", "contract.daily_ad_revenue"]);
    const before = runtime.sessions.resourceCount();
    const result = await runtime.tools.query(session.session_id, {
      sql: "WITH x AS (SELECT a.event_date FROM daily_installs a JOIN daily_ad_revenue b ON a.event_date = b.event_date WHERE a.event_date >= '2026-10-06' AND a.event_date <= '2026-10-12' AND b.event_date >= '2026-10-06' AND b.event_date <= '2026-10-12') SELECT event_date FROM x",
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "join_key_missing");
    assert.equal(runtime.sessions.resourceCount(), before);
  });
});

test("未统一治理的供应商不得从配置启用", () => {
  assert.throws(() => loadConfig({ modelMode: "pi", piProvider: "anthropic", piModel: "fictional", piApiKey: "fictional" }), /provider.*disabled|供应商.*禁用/iu);
  assert.throws(() => loadConfig({ modelMode: "pi", piProvider: "openai-compatible", piModel: "fictional", piApiKey: "fictional", piBaseUrl: "https://example.invalid/v1", piContextWindow: 64000, piMaxOutputTokens: 1000, allowRemoteHttps: true }), /远程 HTTPS 供应商默认关闭/);
  assert.throws(() => loadConfig({ host: "0.0.0.0" }), /127\.0\.0\.1/);
});

test("进度事件不包含用户原话，授权会话仍保留原话", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    const marker = "synthetic_private_marker_83a7";
    const job = await ask(runtime, session.session_id, marker);
    assert.equal(JSON.stringify(job.events).includes(marker), false);
    assert.ok(runtime.state.listMessages(session.session_id).some((message) => message.text === marker));
    assert.ok(job.events.filter((event) => event.type === "tool_started").every((event) => !JSON.stringify(event.payload.args).includes(marker)));
  });
});

test("按正文检索仅使用主体有读取权限的资产", async () => {
  await withRuntime({}, async (runtime) => {
    const asset = runtime.knowledge.by_id.get("metric.new_users");
    assert.ok(asset);
    const token = "synthetic_body_only_6d28";
    asset.body += `\n${token}`;
    const allowed = analyst(runtime);
    const viewer = runtime.sessions.create("viewer");
    const found = await runtime.tools.searchAssets(allowed.session_id, { query: token });
    const hidden = await runtime.tools.searchAssets(viewer.session_id, { query: token });
    assert.equal(found.ok, true);
    assert.equal(hidden.ok, true);
    if (!found.ok || !hidden.ok) return;
    assert.ok((found.hits as Array<{ asset_id: string }>).some((hit) => hit.asset_id === asset.asset_id));
    assert.match(String((found.hits as Array<{ asset_id: string; match_excerpt?: string }>).find((hit) => hit.asset_id === asset.asset_id)?.match_excerpt), /synthetic_body_only_6d28/);
    assert.equal((hidden.hits as Array<{ asset_id: string }>).some((hit) => hit.asset_id === asset.asset_id), false);
  });
});

test("租约到期及接管后旧 worker 不能修改会话和资源", async () => {
  await withRuntime({ startWorker: false }, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    const result = await runtime.tools.query(session.session_id, { sql: "SELECT event_date, new_users FROM daily_installs WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-12'" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const original = runtime.sessions.lookupResource(session.session_id, String(result.resource_id));
    assert.equal(original.ok, true);
    if (!original.ok) return;
    const job = runtime.jobs.submit(session.session_id, "合成围栏问题", "lease-test");
    const a = runtime.state.claimJob(job.job_id, "worker-a", Date.now(), 30_000);
    assert.ok(a);
    const old = new SessionStore(runtime.state);
    old.setActiveJob(session.session_id, job.job_id, { owner: "worker-a", fence: a.fence });
    const oldSession = old.require(session.session_id);
    const resource = { ...original.resource, resource_id: "res_fence_test", job_id: job.job_id };
    old.saveResource(resource);
    runtime.state.expireLease(job.job_id);
    assert.throws(() => old.save({ ...oldSession, title: "stale" }), /execution_fence_rejected/);
    assert.throws(() => old.saveResource(resource), /execution_fence_rejected/);
    const b = runtime.state.claimJob(job.job_id, "worker-b", Date.now(), 30_000);
    assert.ok(b && b.fence > a.fence);
    assert.throws(() => old.save({ ...oldSession, title: "stale" }), /execution_fence_rejected/);
    const current = new SessionStore(runtime.state);
    current.setActiveJob(session.session_id, job.job_id, { owner: "worker-b", fence: b.fence });
    current.save({ ...current.require(session.session_id), title: "current" });
    assert.equal(current.require(session.session_id).title, "current");
  });
});

test("长知识正文按 Unicode 码点分页，版本变化或越权不能拼接", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    const asset = runtime.knowledge.by_id.get("metric.new_users");
    assert.ok(asset);
    asset.body = "汉🙂字".repeat(3200);
    asset.content_hash = "synthetic-version-one";
    let offset = 0;
    let body = "";
    let hash = "";
    for (;;) {
      const page = await runtime.tools.readAsset(session.session_id, { asset_id: asset.asset_id, body_offset: offset, body_limit: 1700, ...(offset ? { expected_content_hash: hash } : {}) });
      assert.equal(page.ok, true);
      if (!page.ok) return;
      body += String(page.body);
      hash = String(page.content_hash);
      if (!page.has_more) break;
      offset = Number(page.next_body_offset);
    }
    assert.equal(body, asset.body);
    assert.equal(Array.from(body).length, 9600);
    asset.content_hash = "synthetic-version-two";
    const changed = await runtime.tools.readAsset(session.session_id, { asset_id: asset.asset_id, body_offset: 1700, body_limit: 10, expected_content_hash: hash });
    assert.equal(changed.ok, false);
    if (!changed.ok) assert.equal(changed.code, "asset_version_changed");
    const viewer = runtime.sessions.create("viewer");
    assert.equal((await runtime.tools.readAsset(viewer.session_id, { asset_id: asset.asset_id, body_offset: 0, body_limit: 1 })).ok, false);
  });
});

test("空正文和多字节正文的分页边界与读取预算", async () => {
  await withRuntime({ maxAssetReadBytes: 9 }, async (runtime) => {
    const session = analyst(runtime);
    const asset = runtime.knowledge.by_id.get("metric.new_users");
    assert.ok(asset);
    asset.body = "";
    const empty = await runtime.tools.readAsset(session.session_id, { asset_id: asset.asset_id });
    assert.equal(empty.ok, true);
    if (!empty.ok) return;
    assert.equal(empty.body, "");
    assert.equal(empty.has_more, false);
    asset.body = "汉🙂字";
    asset.content_hash = "fixture-version";
    const first = await runtime.tools.readAsset(session.session_id, { asset_id: asset.asset_id, body_limit: 2 });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.body, "汉🙂");
    const blocked = await runtime.tools.readAsset(session.session_id, { asset_id: asset.asset_id, body_offset: 2, body_limit: 1, expected_content_hash: "fixture-version" });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.code, "asset_read_budget_exceeded");
    const invalid = await runtime.tools.readAsset(session.session_id, { asset_id: asset.asset_id, body_offset: 4, expected_content_hash: "fixture-version" });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.code, "invalid_asset_page");
  });
});

test("资源分页区分续页和源截断，版本变化及跨会话拒绝", async () => {
  await withRuntime({ maxResultRows: 4 }, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    const query = await runtime.tools.query(session.session_id, { sql: "SELECT event_date, new_users FROM daily_installs WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-12'" });
    assert.equal(query.ok, true);
    if (!query.ok) return;
    const id = String(query.resource_id);
    const first = await runtime.tools.readSessionResource(session.session_id, { resource_id: id, row_limit: 2, columns: ["event_date"] });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.has_more, true);
    assert.equal(first.resource_truncated, true);
    assert.equal((first.resource as { rows: unknown[] }).rows.length, 2);
    const next = await runtime.tools.readSessionResource(session.session_id, { resource_id: id, row_offset: 2, row_limit: 2, expected_resource_hash: String(first.resource_hash) });
    assert.equal(next.ok, true);
    if (!next.ok) return;
    assert.equal(next.has_more, false);
    assert.equal(next.resource_truncated, true);
    const foreign = analyst(runtime);
    assert.equal((await runtime.tools.readSessionResource(foreign.session_id, { resource_id: id })).ok, false);
    const stored = runtime.sessions.lookupResource(session.session_id, id);
    assert.ok(stored.ok && stored.resource.kind === "query_result");
    if (!stored.ok || stored.resource.kind !== "query_result") return;
    runtime.state.saveResource({ ...stored.resource, rows: [] });
    const changed = await runtime.tools.readSessionResource(session.session_id, { resource_id: id, row_offset: 2, expected_resource_hash: String(first.resource_hash) });
    assert.equal(changed.ok, false);
    if (!changed.ok) assert.equal(changed.code, "resource_version_changed");
  });
});

test("工具预算在执行前持久预留，接管后不能重新计算额度", async () => {
  await withRuntime({ startWorker: false, maxToolCalls: 1 }, async (runtime) => {
    const session = analyst(runtime);
    const job = runtime.jobs.submit(session.session_id, "预算合成问题", "tool-budget");
    const first = runtime.state.claimJob(job.job_id, "worker-a", Date.now(), 30000);
    assert.ok(first);
    runtime.sessions.setActiveJob(session.session_id, job.job_id, { owner: first.owner, fence: first.fence });
    const search = domainTools(session.session_id, runtime.tools).find((tool) => tool.name === "search_assets");
    assert.ok(search);
    const allowed = await search.execute("call-one", { query: "新增" });
    assert.equal((allowed.details as { ok: boolean }).ok, true);
    const blocked = await search.execute("call-two", { query: "新增" });
    assert.equal((blocked.details as { code: string }).code, "budget_exhausted");
    runtime.state.expireLease(job.job_id);
    const second = runtime.state.claimJob(job.job_id, "worker-b", Date.now(), 30000);
    assert.ok(second);
    runtime.sessions.setActiveJob(session.session_id, job.job_id, { owner: second.owner, fence: second.fence });
    const recovered = await search.execute("call-three", { query: "新增" });
    assert.equal((recovered.details as { code: string }).code, "budget_exhausted");
  });
});

test("任务恢复时不重新开始墙钟预算", async () => {
  await withRuntime({ startWorker: false, jobTimeoutMs: 1000 }, async (runtime) => {
    const session = analyst(runtime);
    const job = runtime.jobs.submit(session.session_id, "合成超时问题", "wall-clock");
    const first = runtime.state.claimJob(job.job_id, "worker-a", Date.now(), 30000);
    assert.ok(first);
    runtime.state.expireLease(job.job_id);
    const db = new DatabaseSync(runtime.config.stateDatabasePath);
    try { db.prepare("UPDATE jobs SET started_at = ? WHERE job_id = ?").run(new Date(Date.now() - 5000).toISOString(), job.job_id); }
    finally { db.close(); }
    const resumed = runtime.state.claimJob(job.job_id, runtime.jobs.workerOwner, Date.now(), 30000);
    assert.ok(resumed);
    await runtime.jobs.runClaimed(resumed);
    const result = runtime.jobs.require(job.job_id);
    assert.equal(result.status, "timed_out");
    assert.equal(result.events.some((event) => event.type === "tool_started"), false);
  });
});

test("终态事件只发状态和错误码，授权任务记录仍保存答案", async () => {
  await withRuntime({ startWorker: false }, async (runtime) => {
    const session = analyst(runtime);
    const job = runtime.jobs.submit(session.session_id, "合成问题", "terminal-private");
    const lease = runtime.state.claimJob(job.job_id, "worker-a", Date.now(), 30000);
    assert.ok(lease);
    const marker = "synthetic_answer_marker_37a";
    const analysis = { answer: marker } as AnalysisRecord;
    assert.equal(runtime.state.finish(job.job_id, lease.owner, lease.fence, "partial", analysis, { code: "synthetic_error", message: marker }), true);
    const record = runtime.jobs.require(job.job_id);
    assert.equal(record.analysis?.answer, marker);
    assert.equal(JSON.stringify(record.events).includes(marker), false);
  });
});

test("新鲜度探测失败只发布错误码，不发布数据库原始错误", async () => {
  await withRuntime({}, async (runtime) => {
    const marker = "synthetic_private_error_marker";
    const publication = await probeClickHouseAndPublish({
      targetsPath: path.join(repoRoot(), "knowledge", "harborlight", "freshness-targets.json"),
      destinationPath: path.join(runtime.config.ephemeralDir!, "failed-freshness.json"),
      query: async () => { throw new Error(marker); },
    });
    assert.equal(JSON.stringify(publication).includes(marker), false);
    assert.ok(Object.values(publication.tables).some((value) => value.failure_reason === "probe_query_failed"));
  });
});
