import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyst, bindTables, withRuntime } from "./helpers.js";
import type { TransformResource } from "../src/types.js";

test("完整明细按契约键先精确汇总再对齐，NULL 和跨任务资源不能冒充零", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime); await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    runtime.sessions.setActiveJob(session.session_id, "job_raw_alignment");
    const queryDay = async (date: string) => {
      const result = await runtime.tools.query(session.session_id, { sql: `SELECT event_date, country_code, new_users FROM daily_installs WHERE event_date = '${date}' AND product_id = 'starlane_drift' AND platform = 'ios' AND channel = 'nebula_ads'` });
      assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error("query rejected");
      return String(result.resource_id);
    };
    const left = await queryDay("2026-10-06"); const right = await queryDay("2026-10-08");
    const align = (a: string, b: string) => runtime.tools.calculateSessionCells(session.session_id, { align: { op: "subtract", keys: ["country_code"], left: { resource_id: a, cell: "new_users" }, right: { resource_id: b, cell: "new_users" } } });
    const result = await align(left, right); assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.deepEqual((result.rows as Array<{ group: { country_code: string }; result: { value: string } }>).map((row) => [row.group.country_code, row.result.value]), [["JP", "0"], ["US", "25"]]);
    const delivered = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [left, right, String(result.resource_id)] });
    assert.equal(delivered.ok, true); if (delivered.ok) assert.equal(delivered.status, "completed");
    const nullDay = await queryDay("2026-10-09");
    const nullResult = await align(left, nullDay); assert.equal(nullResult.ok, false);
    runtime.sessions.setActiveJob(session.session_id, "job_raw_other");
    const foreign = await align(left, right); assert.equal(foreign.ok, false);
  });
});

test("完整明细按受契约约束的字段分组并能复核交付，其他任务不得引用", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    runtime.sessions.setActiveJob(session.session_id, "job_raw_transform");
    const query = await runtime.tools.query(session.session_id, { sql: "SELECT event_date, country_code, new_users FROM daily_installs WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-06' AND product_id = 'starlane_drift' AND platform = 'ios' AND channel = 'nebula_ads'" });
    assert.equal(query.ok, true, JSON.stringify(query));
    if (!query.ok) return;
    const transformed = await runtime.tools.calculateSessionCells(session.session_id, { transform: { resource_id: String(query.resource_id), steps: [
      { op: "group", by: ["country_code"], aggregates: [{ op: "sum", column: "new_users", as: "users" }] },
      { op: "sort", keys: [{ column: "country_code", direction: "asc", nulls: "last" }] },
    ] } });
    assert.equal(transformed.ok, true, JSON.stringify(transformed));
    if (!transformed.ok) return;
    assert.deepEqual((transformed.result as { rows: object[] }).rows.map((row) => ({ ...row })), [{ country_code: "JP", users: "10" }, { country_code: "US", users: "120" }]);
    const delivered = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(query.resource_id), String(transformed.resource_id)] });
    assert.equal(delivered.ok, true, JSON.stringify(delivered));
    if (delivered.ok) { assert.equal(delivered.status, "completed"); assert.match(String(delivered.answer), /daily_installs\.new_users（实际观察） 的合计=10/); }
    runtime.sessions.setActiveJob(session.session_id, "job_raw_other");
    const foreign = await runtime.tools.calculateSessionCells(session.session_id, { transform: { resource_id: String(query.resource_id), steps: [{ op: "group", by: [], aggregates: [{ op: "count_all", as: "n" }] }] } });
    assert.equal(foreign.ok, false);
  });
});

test("同任务完整聚合可链式变换并在交付前重新验证全部来源", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    runtime.sessions.setActiveJob(session.session_id, "job_transform");
    const query = await runtime.tools.query(session.session_id, { sql: "SELECT country_code, SUM(new_users) AS total FROM daily_installs WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-06' AND product_id = 'starlane_drift' AND platform = 'ios' AND channel = 'nebula_ads' GROUP BY country_code" });
    assert.equal(query.ok, true, JSON.stringify(query));
    if (!query.ok) return;
    const first = await runtime.tools.calculateSessionCells(session.session_id, { transform: { resource_id: String(query.resource_id), steps: [
      { op: "filter", column: "country_code", comparison: "ne", value: "JP" },
      { op: "sort", keys: [{ column: "total", direction: "desc", nulls: "last" }] },
    ] } });
    assert.equal(first.ok, true, JSON.stringify(first));
    if (!first.ok) return;
    const second = await runtime.tools.calculateSessionCells(session.session_id, { transform: { resource_id: String(first.resource_id), steps: [
      { op: "group", by: [], aggregates: [{ op: "sum", column: "total", as: "result" }, { op: "count_all", as: "n" }] },
    ] } });
    assert.equal(second.ok, true, JSON.stringify(second));
    if (!second.ok) return;
    assert.deepEqual((second.result as { rows: object[] }).rows.map((row) => ({ ...row })), [{ result: "120", n: "1" }]);
    const ids = [String(query.resource_id), String(first.resource_id), String(second.resource_id)];
    const answer = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: ids });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    if (answer.ok) {
      assert.equal(answer.status, "completed");
      assert.match(String(answer.answer), /daily_installs\.new_users 合计 的合计=120（人）/);
      assert.match(String(answer.answer), /筛选 daily_installs\.country_code ne "JP"/);
    }
    const stored = runtime.sessions.lookupResource(session.session_id, String(first.resource_id));
    assert.ok(stored.ok && stored.resource.kind === "transform");
    if (!stored.ok || stored.resource.kind !== "transform") return;
    const altered = structuredClone(stored.resource) as TransformResource;
    altered.result.rows[0]!.total = "999";
    runtime.state.saveResource(altered);
    const tampered = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: ids });
    assert.equal(tampered.ok, true);
    if (tampered.ok) { assert.equal(tampered.status, "partial"); assert.doesNotMatch(String(tampered.answer), /=999/); assert.ok((tampered.server_reasons as string[]).includes("transform_lineage_unsupported")); }
    runtime.sessions.setActiveJob(session.session_id, "job_other");
    const foreign = await runtime.tools.calculateSessionCells(session.session_id, { transform: { resource_id: String(query.resource_id), steps: [{ op: "sort", keys: [{ column: "total", direction: "desc", nulls: "last" }] }] } });
    assert.equal(foreign.ok, false);
  });
});

test("缺侧分组在后续变换中仍保持部分完成并可分页回读", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "synthetic-align-"));
  try {
    const knowledgeDir = path.join(root, "knowledge");
    cpSync(path.resolve("knowledge/lumenfox"), knowledgeDir, { recursive: true });
    const seedPath = path.join(knowledgeDir, "seed.sql");
    const seed = readFileSync(seedPath, "utf8");
    const target = "  ('2026-10-08', 'ios', 'JP', 'nebula_ads', 10),\n";
    assert.ok(seed.includes(target));
    writeFileSync(seedPath, seed.replace(target, ""));
    await withRuntime({ knowledgeDir }, async (runtime) => {
      const session = analyst(runtime); await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
      runtime.sessions.setActiveJob(session.session_id, "job_missing_group");
      async function day(date: string) {
        const query = await runtime.tools.query(session.session_id, { sql: `SELECT country_code, SUM(new_users) AS total FROM daily_installs WHERE event_date >= '${date}' AND event_date <= '${date}' AND product_id = 'starlane_drift' AND platform = 'ios' AND channel = 'nebula_ads' GROUP BY country_code` });
        assert.equal(query.ok, true, JSON.stringify(query));
        if (!query.ok) throw new Error("query rejected");
        return String(query.resource_id);
      }
      const left = await day("2026-10-06"); const right = await day("2026-10-08");
      const aligned = await runtime.tools.calculateSessionCells(session.session_id, { align: { op: "subtract", keys: ["country_code"], left: { resource_id: left, cell: "total" }, right: { resource_id: right, cell: "total" } } });
      assert.equal(aligned.ok, true, JSON.stringify(aligned));
      if (!aligned.ok) return;
      assert.deepEqual((aligned.rows as Array<{ group: { country_code: string }; status: string }>).map((row) => [row.group.country_code, row.status]), [["JP", "missing_right"], ["US", "matched"]]);
      const page = await runtime.tools.readSessionResource(session.session_id, { resource_id: String(aligned.resource_id), row_limit: 1 });
      assert.equal(page.ok, true);
      if (page.ok) {
        assert.equal(page.has_more, true);
        const next = await runtime.tools.readSessionResource(session.session_id, { resource_id: String(aligned.resource_id), row_offset: 1, row_limit: 1, expected_resource_hash: String(page.resource_hash) });
        assert.equal(next.ok, true);
        if (next.ok) assert.equal(((next.resource as { rows: Array<{ group: { country_code: string } }> }).rows[0]!).group.country_code, "US");
      }
      const transformed = await runtime.tools.calculateSessionCells(session.session_id, { transform: { resource_id: String(aligned.resource_id), steps: [{ op: "group", by: [], aggregates: [{ op: "sum", column: "result_value", as: "total" }] }] } });
      assert.equal(transformed.ok, true, JSON.stringify(transformed));
      if (!transformed.ok) return;
      const answer = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [left, right, String(transformed.resource_id)] });
      assert.equal(answer.ok, true);
      if (answer.ok) { assert.equal(answer.status, "partial"); assert.ok((answer.server_reasons as string[]).includes("alignment_incomplete")); assert.match(String(answer.answer), /未知值没有补零/); }
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("两个本任务分组结果按键对齐并可复核跨期差值", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    runtime.sessions.setActiveJob(session.session_id, "job_alignment");
    async function day(date: string) {
      const result = await runtime.tools.query(session.session_id, { sql: `SELECT country_code, SUM(new_users) AS total FROM daily_installs WHERE event_date >= '${date}' AND event_date <= '${date}' AND product_id = 'starlane_drift' AND platform = 'ios' AND channel = 'nebula_ads' GROUP BY country_code` });
      assert.equal(result.ok, true, JSON.stringify(result));
      if (!result.ok) throw new Error("query rejected");
      return String(result.resource_id);
    }
    const left = await day("2026-10-06"); const right = await day("2026-10-08");
    const result = await runtime.tools.calculateSessionCells(session.session_id, { align: { op: "subtract", keys: ["country_code"], left: { resource_id: left, cell: "total" }, right: { resource_id: right, cell: "total" } } });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    const rows = result.rows as Array<{ group: { country_code: string }; result: { value: string }; status: string }>;
    assert.deepEqual(rows.map((row) => [row.group.country_code, row.result.value, row.status]), [["JP", "0", "matched"], ["US", "25", "matched"]]);
    const answer = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [left, right, String(result.resource_id)] });
    assert.equal(answer.ok, true);
    if (answer.ok) { assert.equal(answer.status, "completed"); assert.match(String(answer.answer), /country_code=US.*结果 25 人/); }
    const transformed = await runtime.tools.calculateSessionCells(session.session_id, { transform: { resource_id: String(result.resource_id), steps: [
      { op: "filter", column: "result_value", comparison: "gt", value: "0" },
      { op: "sort", keys: [{ column: "result_value", direction: "desc", nulls: "last" }] },
      { op: "group", by: [], aggregates: [{ op: "sum", column: "result_value", as: "positive_total" }] },
    ] } });
    assert.equal(transformed.ok, true, JSON.stringify(transformed));
    if (transformed.ok) {
      assert.equal(((transformed.result as { rows: Array<{ positive_total: string }> }).rows[0]!).positive_total, "25");
      const traced = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [left, right, String(transformed.resource_id)] });
      assert.equal(traced.ok, true);
      if (traced.ok) { assert.equal(traced.status, "completed"); assert.match(String(traced.answer), /的合计=25（人）/); }
    }
    const old = runtime.sessions.lookupResource(session.session_id, String(result.resource_id));
    assert.ok(old.ok && old.resource.kind === "alignment");
    if (old.ok && old.resource.kind === "alignment") {
      const altered = structuredClone(old.resource); altered.rows[1]!.result!.value = "999";
      runtime.state.saveResource(altered);
      const rejected = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [left, right, String(result.resource_id)] });
      assert.equal(rejected.ok, true);
      if (rejected.ok) { assert.equal(rejected.status, "partial"); assert.doesNotMatch(String(rejected.answer), /结果 999/); }
    }
  });
});
