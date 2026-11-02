import assert from "node:assert/strict";
import test from "node:test";
import { provenCoverageFilters } from "../src/coverage.js";
import { verifyCell } from "../src/evidence.js";
import { exactCalendarDatePredicate, guardSql, parseReadonlySql, SqlRejected, type TableRule } from "../src/sql.js";
import { analyst, bindTables, withRuntime } from "./helpers.js";

const rules: TableRule[] = [{ table: "daily_installs", allowed_columns: ["event_date", "product_id", "platform", "country_code", "channel", "new_users"], sensitive_columns: ["device_id"], must_filter: ["event_date"] }];
const scope = "product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'US' AND channel = 'nebula_ads'";

test("单日等值与 BETWEEN 通过日期证明，同时封闭长度、敏感字段和作用域边界", () => {
  const single = guardSql("SELECT new_users FROM daily_installs WHERE event_date = '2026-10-06'", rules);
  assert.deepEqual(single.time_range, { start: "2026-10-06", end: "2026-10-06" });
  const ranged = guardSql("SELECT new_users FROM daily_installs WHERE event_date BETWEEN '2026-10-06' AND '2026-10-08'", rules);
  assert.deepEqual(ranged.time_range, { start: "2026-10-06", end: "2026-10-08" });
  assert.equal(guardSql("SELECT new_users FROM daily_installs WHERE event_date BETWEEN '2025-01-01' AND '2026-02-04'", rules).time_range.end, "2026-02-04", "400 天上限含首尾两天");
  const ast = parseReadonlySql("SELECT d.new_users FROM daily_installs d WHERE d.event_date = '2026-10-06'").ast;
  assert.deepEqual(exactCalendarDatePredicate(ast.where, "event_date", "d"), { start: "2026-10-06", end: "2026-10-06" });
  assert.equal(exactCalendarDatePredicate(ast.where, "event_date", "other"), null);
  const rejected = (sql: string, code?: string) => assert.throws(() => guardSql(sql, rules), (error: unknown) => error instanceof SqlRejected && (!code || error.code === code));
  rejected("SELECT device_id FROM daily_installs WHERE event_date = '2026-10-06'", "sensitive_field");
  rejected("SELECT new_users FROM daily_installs WHERE event_date = '2026-02-30'", "invalid_date_range");
  rejected("SELECT new_users FROM daily_installs WHERE event_date BETWEEN '2025-01-01' AND '2026-02-05'", "scan_date_limit");
  rejected("SELECT new_users FROM daily_installs WHERE event_date = '2026-10-06' OR country_code = 'US'", "unsafe_predicate");
  rejected("SELECT new_users FROM daily_installs WHERE event_date = '2026-10-06' AND remote('x') = 1");
  rejected(`SELECT new_users FROM daily_installs WHERE event_date = '2026-10-06' AND '${"x".repeat(65_536)}' = 'x'`, "sql_size_limit");
  rejected(`SELECT new_users FROM daily_installs WHERE event_date = '2026-10-06' AND ${"(".repeat(65)}1=1${")".repeat(65)}`, "sql_depth_limit");
  rejected(`SELECT '${")".repeat(90)}' FROM daily_installs WHERE event_date = '2026-10-06' AND ${"(".repeat(65)}1=1${")".repeat(65)}`, "sql_depth_limit");
  rejected(`SELECT new_users FROM daily_installs /* ${")".repeat(90)} */ WHERE event_date = '2026-10-06' AND ${"(".repeat(65)}1=1${")".repeat(65)}`, "sql_depth_limit");
});

test("单日与 BETWEEN 的明细和聚合贯穿授权、查询、覆盖和服务端可验证交付", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime); await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    runtime.sessions.setActiveJob(session.session_id, "job_date_predicate");
    const detail = await runtime.tools.query(session.session_id, { sql: `SELECT event_date, product_id, platform, country_code, channel, new_users FROM daily_installs WHERE event_date = '2026-10-06' AND ${scope}` });
    assert.equal(detail.ok, true, JSON.stringify(detail)); if (!detail.ok) return;
    assert.equal((detail.coverage as { status: string }).status, "known");
    const calculate = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: String(detail.resource_id), operations: [{ op: "sum", column: "new_users", as: "sum_users" }] });
    assert.equal(calculate.ok, true, JSON.stringify(calculate)); if (!calculate.ok) return;
    assert.equal((calculate.cells as Record<string, number>).sum_users, 120);
    const stored = runtime.sessions.lookupResource(session.session_id, String(detail.resource_id));
    assert.ok(stored.ok && stored.resource.kind === "query_result");
    const contract = runtime.knowledge.contract_by_table.get("daily_installs")?.contract;
    assert.ok(contract);
    if (stored.ok && stored.resource.kind === "query_result" && contract) {
      const forged = { ...stored.resource, time_range: { ...stored.resource.time_range, end: "2026-10-07" } };
      assert.equal(verifyCell(forged, contract, { op: "sum", column: "new_users", as: "sum_users" }, 120), null, "伪造日期范围不能沿用正确数值");
      assert.equal(provenCoverageFilters(forged.sql, contract, forged.time_range), null);
    }
    const delivered = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(detail.resource_id), String(calculate.resource_id)] });
    assert.equal(delivered.ok, true, JSON.stringify(delivered)); if (!delivered.ok) return;
    assert.equal(delivered.status, "completed", JSON.stringify(delivered));
    assert.match(String(delivered.answer), /合计 120；单位 人/);
    assert.match(String(delivered.answer), /2026-10-06 到 2026-10-06/);
    const aggregate = await runtime.tools.query(session.session_id, { sql: `SELECT SUM(new_users) AS total FROM daily_installs WHERE event_date BETWEEN '2026-10-06' AND '2026-10-08' AND ${scope}` });
    assert.equal(aggregate.ok, true, JSON.stringify(aggregate)); if (!aggregate.ok) return;
    assert.equal((aggregate.rows as Array<{ total: number }>)[0]?.total, 215);
    const answer = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(aggregate.resource_id)] });
    assert.equal(answer.ok, true, JSON.stringify(answer)); if (!answer.ok) return;
    assert.equal(answer.status, "completed", JSON.stringify(answer));
    assert.match(String(answer.answer), /数据库求和 215；单位 人/);
    assert.match(String(answer.answer), /2026-10-06 到 2026-10-08/);
  });
});
