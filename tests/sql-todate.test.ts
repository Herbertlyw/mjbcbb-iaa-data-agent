import assert from "node:assert/strict";
import test from "node:test";
import { loadKnowledge } from "../src/knowledge.js";
import { provenCoverageFilters } from "../src/coverage.js";
import { exactCalendarDatePredicate, guardSql, parseReadonlySql, SqlRejected, type TableRule } from "../src/sql.js";

const kb = loadKnowledge("knowledge/harborlight");
const contract = kb.contract_by_table.get("fact_fox_daily_install")!.contract!;
const rules: TableRule[] = [{ table: contract.table, allowed_columns: contract.columns.filter((column) => !contract.sensitive_columns.includes(column.name)).map((column) => column.name), sensitive_columns: contract.sensitive_columns, must_filter: contract.must_filter }];
const filters = "title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'JP' AND channel_id = 'mist_ads'";
const select = "SELECT event_date, title_id, platform, country_code, channel_id, new_users FROM fact_fox_daily_install WHERE ";

test("ClickHouse 常量 toDate 可证明日期范围及覆盖，SQLite 明确拒绝", () => {
  for (const [predicate, expected] of [
    ["event_date = toDate('2026-10-06')", { start: "2026-10-06", end: "2026-10-06" }],
    ["event_date BETWEEN toDate('2026-10-06') AND toDate('2026-10-08')", { start: "2026-10-06", end: "2026-10-08" }],
    ["event_date >= toDate('2026-10-06') AND event_date <= toDate('2026-10-08')", { start: "2026-10-06", end: "2026-10-08" }],
    ["event_date = toDate('1970-01-01')", { start: "1970-01-01", end: "1970-01-01" }],
    ["event_date = toDate('2149-06-06')", { start: "2149-06-06", end: "2149-06-06" }],
  ] as const) {
    const sql = `${select}${predicate} AND ${filters}`;
    const guarded = guardSql(sql, rules, "clickhouse"); assert.deepEqual(guarded.time_range, expected);
    assert.deepEqual(provenCoverageFilters(sql, contract, expected), { title_id: "paper_lantern", platform: "ios", country_code: "JP", channel_id: "mist_ads" });
    assert.throws(() => guardSql(sql, rules, "sqlite"), (error) => error instanceof SqlRejected && error.code === "clickhouse_function_only");
  }
  const expression = parseReadonlySql(`${select}event_date = toDate('2026-10-06')`).ast.where;
  assert.deepEqual(exactCalendarDatePredicate(expression, "event_date", contract.table), { start: "2026-10-06", end: "2026-10-06" });
  assert.equal(exactCalendarDatePredicate(expression, "other", contract.table), null);
});

test("toDate 动态参数、非规范或越界日期及权限绕过均失败关闭", () => {
  const bad = [
    "event_date = toDate(event_date)", "event_date = toDate(0)", "event_date = toDate(NULL)",
    "event_date = toDate('2026-02-30')", "event_date = toDate('2026-1-01')",
    "event_date = toDate('1969-12-31')", "event_date = toDate('2149-06-07')",
    "event_date = toDate('2026-10-06', 'UTC')", "event_date = toDate(lower('2026-10-06'))",
    "event_date = toDate('2026-10-06') OR country_code = 'JP'",
  ];
  for (const predicate of bad) assert.throws(() => guardSql(`${select}${predicate} AND ${filters}`, rules, "clickhouse"), SqlRejected, predicate);
  assert.throws(() => guardSql(`SELECT device_token FROM fact_fox_daily_install WHERE event_date = toDate('2026-10-06')`, rules, "clickhouse"), SqlRejected);
  assert.throws(() => guardSql(`${select}event_date = toDate('2026-10-06'); DELETE FROM fact_fox_daily_install`, rules, "clickhouse"), SqlRejected);
  assert.throws(() => guardSql(`${select}event_date = toDate('2026-10-06') SETTINGS max_threads = 1`, rules, "clickhouse"), SqlRejected);
});
