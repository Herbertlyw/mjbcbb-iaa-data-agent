import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyst, bindTables, withRuntime } from "./helpers.js";
import type { TransformResource } from "../src/types.js";

test("仅观察值契约在直接计算和排序后均保留 actual_only 语义，旧资源不被改写", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime); await bindTables(runtime, session.session_id, ["contract.daily_installs"]); runtime.sessions.setActiveJob(session.session_id, "job_observed_scope");
    const sql = "SELECT event_date, country_code, new_users FROM daily_installs WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-08' AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'US' AND channel = 'nebula_ads'";
    const query = await runtime.tools.query(session.session_id, { sql }); assert.ok(query.ok, JSON.stringify(query)); if (!query.ok) return;
    const operations = [{ op: "sum" as const, column: "new_users", predicted: "actual_only" as const, as: "total" }];
    const direct = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: String(query.resource_id), operations });
    assert.ok(direct.ok, JSON.stringify(direct)); if (!direct.ok) return;
    const directResource = runtime.sessions.lookupResource(session.session_id, String(direct.resource_id));
    assert.ok(directResource.ok && directResource.resource.kind === "calculation" && directResource.resource.evaluated_table_v1?.table.prediction_scope === "observed_only");
    const sorted = await runtime.tools.calculateSessionCells(session.session_id, { transform: { resource_id: String(query.resource_id), steps: [{ op: "sort", keys: [{ column: "event_date", direction: "desc", nulls: "last" }] }] } });
    assert.ok(sorted.ok, JSON.stringify(sorted)); if (!sorted.ok) return;
    const derived = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: String(sorted.resource_id), operations });
    assert.ok(derived.ok, JSON.stringify(derived)); if (!derived.ok) return;
    assert.equal(String((direct.cells as Record<string, unknown>).total), "215");
    assert.equal(String((derived.cells as Record<string, unknown>).total), "215");
    const result = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(derived.resource_id)] });
    assert.ok(result.ok, JSON.stringify(result)); if (result.ok) assert.equal(result.status, "completed", JSON.stringify(result));
    const arithmetic = await runtime.tools.calculateSessionCells(session.session_id, { arithmetic: { op: "add", left: { resource_id: String(direct.resource_id), cell: "total" }, right: { resource_id: String(direct.resource_id), cell: "total" } } });
    assert.ok(arithmetic.ok, JSON.stringify(arithmetic)); if (!arithmetic.ok) return;
    const arithmeticCells = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: String(arithmetic.resource_id), operations: [{ op: "sum", column: "result", predicted: "actual_only", as: "total" }] });
    assert.ok(arithmeticCells.ok, JSON.stringify(arithmeticCells)); if (!arithmeticCells.ok) return;
    assert.equal(String((arithmeticCells.cells as Record<string, unknown>).total), "430");
    const aligned = await runtime.tools.calculateSessionCells(session.session_id, { align: { op: "add", keys: ["event_date"], left: { resource_id: String(query.resource_id), cell: "new_users" }, right: { resource_id: String(query.resource_id), cell: "new_users" } } });
    assert.ok(aligned.ok, JSON.stringify(aligned)); if (!aligned.ok) return;
    const alignedCells = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: String(aligned.resource_id), operations: [{ op: "sum", column: "result_value", predicted: "actual_only", as: "total" }] });
    assert.ok(alignedCells.ok, JSON.stringify(alignedCells)); if (!alignedCells.ok) return;
    assert.equal(String((alignedCells.cells as Record<string, unknown>).total), "430");
    const oldQuery = await runtime.tools.query(session.session_id, { sql }); assert.ok(oldQuery.ok); if (!oldQuery.ok) return;
    const old = runtime.sessions.lookupResource(session.session_id, String(oldQuery.resource_id)); assert.ok(old.ok && old.resource.kind === "query_result"); if (!old.ok || old.resource.kind !== "query_result") return;
    const saved = structuredClone(old.resource); delete saved.result_semantics_version; runtime.state.saveResource(saved);
    const oldSorted = await runtime.tools.calculateSessionCells(session.session_id, { transform: { resource_id: String(oldQuery.resource_id), steps: [{ op: "sort", keys: [{ column: "event_date", direction: "asc", nulls: "last" }] }] } });
    assert.ok(oldSorted.ok, JSON.stringify(oldSorted)); if (!oldSorted.ok) return;
    const cannotInfer = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: String(oldSorted.resource_id), operations });
    assert.equal(cannotInfer.ok, false, "旧资源不能凭展示标签补造预测语义");
  });
});

test("完整明细按业务日期和国家全键对齐并递归交付", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime); await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    runtime.sessions.setActiveJob(session.session_id, "job_date_alignment");
    const sql = "SELECT event_date, country_code, new_users FROM daily_installs WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-08' AND product_id = 'starlane_drift' AND platform = 'ios' AND channel = 'nebula_ads'";
    const left = await runtime.tools.query(session.session_id, { sql }); const right = await runtime.tools.query(session.session_id, { sql });
    assert.ok(left.ok && right.ok, JSON.stringify({ left, right })); if (!left.ok || !right.ok) return;
    const result = await runtime.tools.calculateSessionCells(session.session_id, { align: { op: "subtract", keys: ["event_date", "country_code"], left: { resource_id: String(left.resource_id), cell: "new_users" }, right: { resource_id: String(right.resource_id), cell: "new_users" } } });
    assert.ok(result.ok, JSON.stringify(result)); if (!result.ok) return;
    const rows = result.rows as Array<{ group: { event_date: string; country_code: string }; result: { value: string } }>;
    assert.ok(rows.some((row) => row.group.event_date === "2026-10-06" && row.group.country_code === "US" && row.result.value === "0"));
    assert.ok(rows.some((row) => row.group.event_date === "2026-10-08" && row.group.country_code === "US" && row.result.value === "0"));
    const delivered = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(left.resource_id), String(right.resource_id), String(result.resource_id)] });
    assert.ok(delivered.ok, JSON.stringify(delivered));
    if (delivered.ok) assert.match(String(delivered.answer), /event_date=2026-10-06/);
  });
});

test("完整明细与数据库分组 SUM 可按契约键对齐并递归复核", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime); await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    runtime.sessions.setActiveJob(session.session_id, "job_mixed_alignment");
    const where = (day: string) => `event_date = '${day}' AND product_id = 'starlane_drift' AND platform = 'ios' AND channel = 'nebula_ads'`;
    const left = await runtime.tools.query(session.session_id, { sql: `SELECT event_date, country_code, new_users FROM daily_installs WHERE ${where("2026-10-06")}` });
    const right = await runtime.tools.query(session.session_id, { sql: `SELECT country_code, SUM(new_users) AS total FROM daily_installs WHERE ${where("2026-10-08")} GROUP BY country_code` });
    assert.ok(left.ok && right.ok, JSON.stringify({ left, right })); if (!left.ok || !right.ok) return;
    const aligned = await runtime.tools.calculateSessionCells(session.session_id, { align: { op: "subtract", keys: ["country_code"], left: { resource_id: String(left.resource_id), cell: "new_users" }, right: { resource_id: String(right.resource_id), cell: "total" } } });
    assert.ok(aligned.ok, JSON.stringify(aligned)); if (!aligned.ok) return;
    assert.deepEqual((aligned.rows as Array<{ group: { country_code: string }; result: { value: string } }>).map((row) => [row.group.country_code, row.result.value]), [["JP", "0"], ["US", "25"]]);
    const transformed = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: String(aligned.resource_id), transform: { resource_id: String(aligned.resource_id), steps: [{ op: "filter", column: "result_value", comparison: "gt", value: "0" }, { op: "group", by: [], aggregates: [{ op: "sum", column: "result_value", as: "sum" }] }] } });
    assert.ok(transformed.ok, JSON.stringify(transformed)); if (!transformed.ok) return;
    const ref = { resource_id: String(transformed.resource_id), execution_id: String(transformed.execution_id), cell: "sum", row: 0 };
    const doubled = await runtime.tools.calculateSessionCells(session.session_id, { arithmetic: { op: "add", left: ref, right: ref } });
    assert.ok(doubled.ok, JSON.stringify(doubled)); if (!doubled.ok) return;
    assert.equal((doubled.result as { value: string }).value, "50");
    assert.equal((doubled.result as { interpretation: string }).interpretation, "mathematical_only");
    const chainedRef = { resource_id: String(doubled.resource_id), cell: "result" };
    const chained = await runtime.tools.calculateSessionCells(session.session_id, { arithmetic: { op: "add", left: chainedRef, right: chainedRef } });
    assert.ok(chained.ok, JSON.stringify(chained)); if (!chained.ok) return;
    assert.equal((chained.result as { value: string }).value, "100");
    const final = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(chained.resource_id)] });
    assert.ok(final.ok, JSON.stringify(final)); if (final.ok) { assert.equal(final.status, "completed"); assert.match(String(final.answer), /数学运算 add：100 人/); assert.match(String(final.answer), /不认证业务指标名称/); }
    const wrongId = await runtime.tools.calculateSessionCells(session.session_id, { arithmetic: { op: "add", left: { ...ref, execution_id: "wrong" }, right: ref } });
    assert.equal(wrongId.ok, false);
    const conflicting = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: String(left.resource_id), transform: { resource_id: String(aligned.resource_id), steps: [{ op: "group", by: [], aggregates: [{ op: "count_all", as: "n" }] }] } });
    assert.equal(conflicting.ok, false);
    if (!conflicting.ok) assert.equal(conflicting.code, "invalid_transform");
    const answer = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(left.resource_id), String(right.resource_id), String(transformed.resource_id)] });
    assert.ok(answer.ok, JSON.stringify(answer)); if (answer.ok) { assert.equal(answer.status, "completed"); assert.match(String(answer.answer), /的合计=25（人）/); }
    runtime.sessions.setActiveJob(session.session_id, "other_job");
    const stale = await runtime.tools.calculateSessionCells(session.session_id, { align: { op: "subtract", keys: ["country_code"], left: { resource_id: String(left.resource_id), cell: "new_users" }, right: { resource_id: String(right.resource_id), cell: "total" } } });
    assert.equal(stale.ok, false);
  });
});

test("已出现分组全部匹配也不能抹去输入缺日期，递归变换仍为部分完成", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "synthetic-gapped-alignment-"));
  try {
  const knowledgeDir = path.join(root, "knowledge"); cpSync(path.resolve("knowledge/lumenfox"), knowledgeDir, { recursive: true });
  const seedPath = path.join(knowledgeDir, "seed.sql"); const seed = readFileSync(seedPath, "utf8");
  const removed = "  ('2026-10-07', 'ios', 'JP', 'nebula_ads', 10),\n"; assert.ok(seed.includes(removed)); writeFileSync(seedPath, seed.replace(removed, ""));
  await withRuntime({ knowledgeDir }, async (runtime) => {
    const session = analyst(runtime); await bindTables(runtime, session.session_id, ["contract.daily_installs"]); runtime.sessions.setActiveJob(session.session_id, "job_gapped_alignment");
    const day = async (start: string, end: string) => { const q = await runtime.tools.query(session.session_id, { sql: `SELECT event_date, country_code, new_users FROM daily_installs WHERE event_date >= '${start}' AND event_date <= '${end}' AND product_id = 'starlane_drift' AND platform = 'ios' AND channel = 'nebula_ads'` }); assert.equal(q.ok, true, JSON.stringify(q)); if (!q.ok) throw new Error("query"); return String(q.resource_id); };
    const left = await day("2026-10-06", "2026-10-07"); const right = await day("2026-10-10", "2026-10-11");
    const result = await runtime.tools.calculateSessionCells(session.session_id, { align: { op: "subtract", keys: ["country_code"], left: { resource_id: left, cell: "new_users" }, right: { resource_id: right, cell: "new_users" } } });
    assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) return;
    assert.ok((result.rows as Array<{ status: string }>).every((row) => row.status === "matched"));
    const resource = runtime.sessions.lookupResource(session.session_id, String(result.resource_id)); assert.ok(resource.ok && resource.resource.kind === "alignment"); if (resource.ok && resource.resource.kind === "alignment") assert.equal(resource.resource.coverage_incomplete, true);
    const alignedAnswer = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [left, right, String(result.resource_id)] });
    assert.equal(alignedAnswer.ok, true); if (alignedAnswer.ok) { assert.equal(alignedAnswer.status, "partial"); assert.match(String(alignedAnswer.answer), /仅为已观察记录的计算/); }
    const transformed = await runtime.tools.calculateSessionCells(session.session_id, { transform: { resource_id: String(result.resource_id), steps: [{ op: "group", by: [], aggregates: [{ op: "sum", column: "result_value", as: "total" }] }] } });
    assert.equal(transformed.ok, true, JSON.stringify(transformed)); if (!transformed.ok) return;
    const ref = { resource_id: String(transformed.resource_id), execution_id: String(transformed.execution_id), cell: "total", row: 0 };
    const calculated = await runtime.tools.calculateSessionCells(session.session_id, { arithmetic: { op: "add", left: ref, right: ref } });
    assert.equal(calculated.ok, true, JSON.stringify(calculated));
    if (calculated.ok) { const result = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(calculated.resource_id)] }); assert.equal(result.ok, true); if (result.ok) assert.equal(result.status, "partial"); }
    const answer = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [left, right, String(transformed.resource_id)] });
    assert.equal(answer.ok, true); if (answer.ok) { assert.equal(answer.status, "partial"); assert.ok((answer.server_reasons as string[]).includes("alignment_incomplete")); }
  });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("完整资源按 NULL 键对齐并与字符串 NULL 区分；部分 NULL 降级且递归复核", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "synthetic-null-alignment-"));
  try {
    const knowledgeDir = path.join(root, "knowledge"); cpSync(path.resolve("knowledge/lumenfox"), knowledgeDir, { recursive: true });
    const seedPath = path.join(knowledgeDir, "seed.sql"); const seed = readFileSync(seedPath, "utf8");
    writeFileSync(seedPath, seed.replace("country_code TEXT NOT NULL,", "country_code TEXT,") + `\nINSERT INTO daily_installs (event_date,product_id,platform,country_code,channel,new_users) VALUES
      ('2026-10-06','starlane_drift','ios',NULL,'nebula_ads',4), ('2026-10-07','starlane_drift','ios',NULL,'nebula_ads',1),
      ('2026-10-08','starlane_drift','ios',NULL,'nebula_ads',2), ('2026-10-09','starlane_drift','ios',NULL,'nebula_ads',1),
      ('2026-10-06','starlane_drift','ios','NULL','nebula_ads',7), ('2026-10-07','starlane_drift','ios','NULL','nebula_ads',1),
      ('2026-10-08','starlane_drift','ios','NULL','nebula_ads',0), ('2026-10-09','starlane_drift','ios','NULL','nebula_ads',0),
      ('2026-10-06','starlane_drift','ios','XX','nebula_ads',NULL), ('2026-10-07','starlane_drift','ios','XX','nebula_ads',2),
      ('2026-10-08','starlane_drift','ios','XX','nebula_ads',1), ('2026-10-09','starlane_drift','ios','XX','nebula_ads',1);\n`);
    const contractPath = path.join(knowledgeDir, "contracts", "daily-installs.json");
    const contract = JSON.parse(readFileSync(contractPath, "utf8"));
    const dimension = contract.columns.find((column: { name: string }) => column.name === "country_code"); dimension.type = "Nullable(String)"; dimension.nullable = true;
    writeFileSync(contractPath, JSON.stringify(contract));
    await withRuntime({ knowledgeDir }, async (runtime) => {
      const session = analyst(runtime); await bindTables(runtime, session.session_id, ["contract.daily_installs"]); runtime.sessions.setActiveJob(session.session_id, "job_nullable_keys");
      const query = async (start: string, end: string) => {
        const result = await runtime.tools.query(session.session_id, { sql: `SELECT event_date, country_code, new_users FROM daily_installs WHERE event_date >= '${start}' AND event_date <= '${end}' AND product_id = 'starlane_drift' AND platform = 'ios' AND channel = 'nebula_ads'` });
        assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error("query rejected"); return String(result.resource_id);
      };
      const left = await query("2026-10-06", "2026-10-07"); const right = await query("2026-10-08", "2026-10-09");
      const result = await runtime.tools.calculateSessionCells(session.session_id, { align: { op: "divide", keys: ["country_code"], left: { resource_id: left, cell: "new_users" }, right: { resource_id: right, cell: "new_users" } } });
      assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) return;
      const rows = result.rows as Array<{ group: { country_code: string | null }; status: string; left_count?: number; left_null_count?: number; result: { value: string | null } | null }>;
      const nullKey = rows.find((row) => row.group.country_code === null); assert.ok(nullKey); assert.equal(nullKey.status, "matched"); assert.equal(nullKey.result?.value, "1.666666666666666667");
      const literal = rows.find((row) => row.group.country_code === "NULL"); assert.ok(literal); assert.equal(literal.status, "zero_divisor"); assert.equal(literal.result?.value, null);
      const partial = rows.find((row) => row.group.country_code === "XX"); assert.ok(partial); assert.equal(partial.status, "partial_nulls"); assert.equal(partial.left_count, 2); assert.equal(partial.left_null_count, 1); assert.equal(partial.result?.value, "1.000000000000000000");
      const delivered = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [left, right, String(result.resource_id)] });
      assert.equal(delivered.ok, true); if (delivered.ok) { assert.equal(delivered.status, "partial"); assert.match(String(delivered.answer), /NULL 键作为独立分组/); assert.match(String(delivered.answer), /仅非 NULL 部分/); assert.match(String(delivered.answer), /country_code=NULL（空键）/); assert.match(String(delivered.answer), /country_code="NULL"（字符串）/); }
      const display = await runtime.tools.calculateSessionCells(session.session_id, { transform: { resource_id: left, steps: [{ op: "sort", keys: [{ column: "country_code", direction: "asc", nulls: "first" }] }] } });
      assert.equal(display.ok, true); if (display.ok) {
        const rendered = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [left, String(display.resource_id)] });
        assert.equal(rendered.ok, true); if (rendered.ok) { assert.match(String(rendered.answer), /=NULL（空值）/); assert.match(String(rendered.answer), /="NULL"（字符串）/); }
      }
      const transformed = await runtime.tools.calculateSessionCells(session.session_id, { transform: { resource_id: String(result.resource_id), steps: [{ op: "filter", column: "country_code", comparison: "is_null" }, { op: "group", by: [], aggregates: [{ op: "count_all", as: "number_of_groups" }] }] } });
      assert.equal(transformed.ok, true, JSON.stringify(transformed));
      if (transformed.ok) {
        assert.equal(((transformed.result as { rows: Array<{ number_of_groups: string }> }).rows[0]!).number_of_groups, "1");
        const answer = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [left, right, String(transformed.resource_id)] });
        assert.equal(answer.ok, true); if (answer.ok) assert.equal(answer.status, "partial");
      }
      const saved = runtime.sessions.lookupResource(session.session_id, String(result.resource_id)); assert.ok(saved.ok && saved.resource.kind === "alignment");
      if (saved.ok && saved.resource.kind === "alignment") { const forged = structuredClone(saved.resource); forged.rows[0]!.status = "matched"; forged.rows[0]!.left_null_count = 999; runtime.state.saveResource(forged); const rejected = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [left, right, String(result.resource_id)] }); assert.equal(rejected.ok, true); if (rejected.ok) assert.ok((rejected.server_reasons as string[]).includes("alignment_lineage_unsupported")); }
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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
    const nullResult = await align(left, nullDay); assert.equal(nullResult.ok, true, JSON.stringify(nullResult));
    if (!nullResult.ok) return;
    const us = (nullResult.rows as Array<{ group: { country_code: string | null }; status: string; right: { value: string | null } | null; right_null_count?: number; result: unknown }>).find((row) => row.group.country_code === "US");
    assert.ok(us); assert.equal(us.status, "null_input"); assert.equal(us.right?.value, null); assert.equal(us.right_null_count, 1); assert.equal(us.result, null);
    const partial = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [left, nullDay, String(nullResult.resource_id)] });
    assert.equal(partial.ok, true); if (partial.ok) { assert.equal(partial.status, "partial"); assert.match(String(partial.answer), /全 NULL/); }
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
    const ref = { resource_id: String(second.resource_id), execution_id: String(second.execution_id), cell: "result", aggregate: "sum" as const };
    const twice = await runtime.tools.calculateSessionCells(session.session_id, { arithmetic: { op: "add", left: ref, right: ref } });
    assert.ok(twice.ok, JSON.stringify(twice)); if (!twice.ok) return;
    assert.equal((twice.result as { value: string }).value, "240");
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
    const rejectedMath = await runtime.tools.calculateSessionCells(session.session_id, { arithmetic: { op: "add", left: ref, right: ref } });
    assert.equal(rejectedMath.ok, false);
    const tampered = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: ids });
    assert.equal(tampered.ok, true);
    if (tampered.ok) { assert.equal(tampered.status, "partial"); assert.doesNotMatch(String(tampered.answer), /=999/); assert.ok((tampered.server_reasons as string[]).includes("transform_lineage_unsupported")); }
    runtime.sessions.setActiveJob(session.session_id, "job_other");
    const foreign = await runtime.tools.calculateSessionCells(session.session_id, { transform: { resource_id: String(query.resource_id), steps: [{ op: "sort", keys: [{ column: "total", direction: "desc", nulls: "last" }] }] } });
    assert.equal(foreign.ok, false);
  });
});

test("同契约同范围的两个变换结果可按完整键数学对齐，篡改来源不能继续", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime); await bindTables(runtime, session.session_id, ["contract.daily_installs"]); runtime.sessions.setActiveJob(session.session_id, "job_derived_align");
    const query = await runtime.tools.query(session.session_id, { sql: "SELECT country_code, SUM(new_users) AS total FROM daily_installs WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-06' AND product_id = 'starlane_drift' AND platform = 'ios' AND channel = 'nebula_ads' GROUP BY country_code" });
    assert.ok(query.ok, JSON.stringify(query)); if (!query.ok) return;
    const transformed = async (direction: "asc" | "desc") => runtime.tools.calculateFromProtocol(session.session_id, { operation: "transform", input: { resource_id: String(query.resource_id), execution_id: String(query.execution_id) }, steps: [{ op: "sort", keys: [{ column: "country_code", direction, nulls: "last" }] }] });
    const left = await transformed("asc"), right = await transformed("desc");
    assert.ok(left.ok && right.ok); if (!left.ok || !right.ok) return;
    const aligned = await runtime.tools.calculateFromProtocol(session.session_id, { operation: "align", align_op: "divide", keys: ["country_code"], left: { resource_id: String(left.resource_id), execution_id: String(left.execution_id), column: "total" }, right: { resource_id: String(right.resource_id), execution_id: String(right.execution_id), column: "total" } });
    assert.ok(aligned.ok, JSON.stringify(aligned)); if (!aligned.ok) return;
    const rows = aligned.rows as Array<{ group: Record<string, string>; result: { value: string; interpretation?: string } | null }>;
    assert.ok(rows.length >= 2); assert.ok(rows.every((row) => row.result?.value === "1.000000000000000000" && row.result.interpretation === "mathematical_only"));
    const sortedAlignment = await runtime.tools.calculateFromProtocol(session.session_id, { operation: "transform", input: { resource_id: aligned.resource_id, execution_id: aligned.execution_id }, steps: [{ op: "sort", keys: [{ column: "country_code", direction: "asc", nulls: "last" }] }] });
    assert.ok(sortedAlignment.ok, JSON.stringify(sortedAlignment)); if (!sortedAlignment.ok) return;
    const alignmentRef = { resource_id: sortedAlignment.resource_id, execution_id: sortedAlignment.execution_id, column: "result_value" };
    const realigned = await runtime.tools.calculateFromProtocol(session.session_id, { operation: "align", align_op: "add", keys: ["country_code"], left: alignmentRef, right: alignmentRef });
    assert.ok(realigned.ok, JSON.stringify(realigned)); if (!realigned.ok) return;
    assert.ok((realigned.rows as Array<{ result: { value: string } | null }>).every((row) => row.result?.value === "2.000000000000000000"));
    const answer = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(aligned.resource_id)] });
    assert.ok(answer.ok, JSON.stringify(answer)); if (answer.ok) assert.match(String(answer.answer), /数学对齐/);
    const wrongKey = await runtime.tools.calculateFromProtocol(session.session_id, { operation: "align", align_op: "add", keys: ["total"], left: { resource_id: String(left.resource_id), execution_id: String(left.execution_id), column: "total" }, right: { resource_id: String(right.resource_id), execution_id: String(right.execution_id), column: "total" } });
    assert.equal(wrongKey.ok, false);
    const otherQuery = await runtime.tools.query(session.session_id, { sql: "SELECT country_code, SUM(new_users) AS total FROM daily_installs WHERE event_date >= '2026-10-07' AND event_date <= '2026-10-07' AND product_id = 'starlane_drift' AND platform = 'ios' AND channel = 'nebula_ads' GROUP BY country_code" });
    assert.ok(otherQuery.ok); if (!otherQuery.ok) return;
    const other = await runtime.tools.calculateFromProtocol(session.session_id, { operation: "transform", input: { resource_id: String(otherQuery.resource_id), execution_id: String(otherQuery.execution_id) }, steps: [{ op: "sort", keys: [{ column: "country_code", direction: "asc", nulls: "last" }] }] });
    assert.ok(other.ok); if (!other.ok) return;
    const mismatch = await runtime.tools.calculateFromProtocol(session.session_id, { operation: "align", align_op: "add", keys: ["country_code"], left: { resource_id: String(left.resource_id), execution_id: String(left.execution_id), column: "total" }, right: { resource_id: String(other.resource_id), execution_id: String(other.execution_id), column: "total" } });
    assert.equal(mismatch.ok, false, "不同日期的变换结果不能被当成相同范围");
    const saved = runtime.sessions.lookupResource(session.session_id, String(left.resource_id));
    assert.ok(saved.ok && saved.resource.kind === "transform"); if (!saved.ok || saved.resource.kind !== "transform") return;
    const altered = structuredClone(saved.resource); altered.result.rows[0]!.total = "999"; runtime.state.saveResource(altered);
    const rejected = await runtime.tools.calculateFromProtocol(session.session_id, { operation: "transform", input: { resource_id: String(aligned.resource_id), execution_id: String(aligned.execution_id) }, steps: [{ op: "sort", keys: [{ column: "country_code", direction: "asc", nulls: "last" }] }] });
    assert.equal(rejected.ok, false);
  });
});

test("多来源对齐的独立变换可再次对齐，篡改任一来源仍失败关闭", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime); await bindTables(runtime, session.session_id, ["contract.daily_installs"]); runtime.sessions.setActiveJob(session.session_id, "job_multileaf_realign");
    const sql = "SELECT country_code, SUM(new_users) AS total FROM daily_installs WHERE event_date = '2026-10-06' AND product_id = 'starlane_drift' AND platform = 'ios' AND channel = 'nebula_ads' GROUP BY country_code";
    const first = await runtime.tools.query(session.session_id, { sql }); const second = await runtime.tools.query(session.session_id, { sql });
    assert.ok(first.ok && second.ok, JSON.stringify({ first, second })); if (!first.ok || !second.ok) return;
    const sorted = async (resource_id: string, execution_id: string, direction: "asc" | "desc") => runtime.tools.calculateFromProtocol(session.session_id, { operation: "transform", input: { resource_id, execution_id }, steps: [{ op: "sort", keys: [{ column: "country_code", direction, nulls: "last" }] }] });
    const left = await sorted(String(first.resource_id), String(first.execution_id), "asc"); const right = await sorted(String(second.resource_id), String(second.execution_id), "desc");
    assert.ok(left.ok && right.ok); if (!left.ok || !right.ok) return;
    const aligned = await runtime.tools.calculateFromProtocol(session.session_id, { operation: "align", align_op: "divide", keys: ["country_code"], left: { resource_id: String(left.resource_id), execution_id: String(left.execution_id), column: "total" }, right: { resource_id: String(right.resource_id), execution_id: String(right.execution_id), column: "total" } });
    assert.ok(aligned.ok, JSON.stringify(aligned)); if (!aligned.ok) return;
    const a = await sorted(String(aligned.resource_id), String(aligned.execution_id), "asc"); const b = await sorted(String(aligned.resource_id), String(aligned.execution_id), "desc");
    assert.ok(a.ok && b.ok); if (!a.ok || !b.ok) return;
    const ref = (value: typeof a) => ({ resource_id: String(value.resource_id), execution_id: String(value.execution_id), column: "result_value" });
    const again = await runtime.tools.calculateFromProtocol(session.session_id, { operation: "align", align_op: "subtract", keys: ["country_code"], left: ref(a), right: ref(b) });
    assert.ok(again.ok, JSON.stringify(again)); if (!again.ok) return;
    assert.ok((again.rows as Array<{ result: { value: string; interpretation?: string } | null }>).every((row) => row.result?.value === "0.000000000000000000" && row.result.interpretation === "mathematical_only"));
    const delivered = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(again.resource_id)] });
    assert.ok(delivered.ok, JSON.stringify(delivered)); if (delivered.ok) assert.match(String(delivered.answer), /数学对齐/);
    const saved = runtime.sessions.lookupResource(session.session_id, String(second.resource_id));
    assert.ok(saved.ok && saved.resource.kind === "query_result"); if (!saved.ok || saved.resource.kind !== "query_result") return;
    const altered = structuredClone(saved.resource); altered.rows[0]!.total = 999; runtime.state.saveResource(altered);
    const rejected = await runtime.tools.calculateFromProtocol(session.session_id, { operation: "align", align_op: "subtract", keys: ["country_code"], left: ref(a), right: ref(b) });
    assert.equal(rejected.ok, false);
  });
});

test("变换结果的全 NULL 与零分母向后续算术传播为未知，不自动补零", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime); await bindTables(runtime, session.session_id, ["contract.daily_installs"]); runtime.sessions.setActiveJob(session.session_id, "job_derived_null");
    const query = await runtime.tools.query(session.session_id, { sql: "SELECT event_date, new_users FROM daily_installs WHERE event_date = '2026-10-09' AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'US' AND channel = 'nebula_ads'" });
    assert.ok(query.ok, JSON.stringify(query)); if (!query.ok) return;
    const transformed = await runtime.tools.calculateSessionCells(session.session_id, { transform: { resource_id: String(query.resource_id), steps: [{ op: "group", by: [], aggregates: [{ op: "sum", column: "new_users", as: "total" }] }] } });
    assert.ok(transformed.ok, JSON.stringify(transformed)); if (!transformed.ok) return;
    const ref = { resource_id: String(transformed.resource_id), execution_id: String(transformed.execution_id), cell: "total", row: 0 };
    const calculated = await runtime.tools.calculateSessionCells(session.session_id, { arithmetic: { op: "add", left: ref, right: ref } });
    assert.ok(calculated.ok, JSON.stringify(calculated)); if (!calculated.ok) return;
    assert.equal((calculated.result as { value: unknown }).value, null);
    assert.equal((calculated.result as { undefined_reason: string }).undefined_reason, "null_input");
    const delivered = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(calculated.resource_id)] });
    assert.ok(delivered.ok, JSON.stringify(delivered)); if (delivered.ok) { assert.equal(delivered.status, "partial"); assert.match(String(delivered.answer), /输入为空或 NULL，结果未知/); }
    const zeroQuery = await runtime.tools.query(session.session_id, { sql: "SELECT event_date, new_users FROM daily_installs WHERE event_date = '2026-10-07' AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'US' AND channel = 'nebula_ads'" });
    assert.ok(zeroQuery.ok, JSON.stringify(zeroQuery)); if (!zeroQuery.ok) return;
    const zero = await runtime.tools.calculateSessionCells(session.session_id, { transform: { resource_id: String(zeroQuery.resource_id), steps: [{ op: "group", by: [], aggregates: [{ op: "sum", column: "new_users", as: "total" }] }] } });
    assert.ok(zero.ok, JSON.stringify(zero)); if (!zero.ok) return;
    const zeroRef = { resource_id: String(zero.resource_id), execution_id: String(zero.execution_id), cell: "total", row: 0 };
    const division = await runtime.tools.calculateSessionCells(session.session_id, { arithmetic: { op: "divide", left: zeroRef, right: zeroRef } });
    assert.ok(division.ok, JSON.stringify(division)); if (division.ok) { assert.equal((division.result as { value: unknown }).value, null); assert.equal((division.result as { undefined_reason: string }).undefined_reason, "zero_divisor"); }
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
