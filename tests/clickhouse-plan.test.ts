import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { planClickHouse } from "../src/clickhouse-plan.js";
import { loadKnowledge } from "../src/knowledge.js";
import { SqlRejected } from "../src/sql.js";
import type { DataContract } from "../src/types.js";

const knowledge = loadKnowledge("knowledge/harborlight");
const fact = knowledge.contract_by_table.get(
  "fact_fox_daily_install",
)!.contract!;
const dim = knowledge.contract_by_table.get("dim_fox_title")!.contract!;
const where =
  "event_date >= '2026-10-06' AND event_date <= '2026-10-08' AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'US' AND channel_id = 'mist_ads'";
const rule = (contract: DataContract) => ({
  table: contract.table,
  allowed_columns: contract.columns
    .map((column) => column.name)
    .filter((name) => !contract.sensitive_columns.includes(name)),
  sensitive_columns: contract.sensitive_columns,
  must_filter: contract.must_filter,
  column_types: Object.fromEntries(
    contract.columns.map((column) => [column.name, column.type]),
  ),
});
const plan = (sql: string, contracts = [fact]) =>
  planClickHouse(
    sql,
    contracts.map(rule),
    contracts,
    knowledge.joins,
    "synthetic",
    1000,
  );

test("ClickHouse 唯一计划不调用旧解析器，直接查询和复杂表达式分别保留证明范围", () => {
  const require = createRequire(import.meta.url);
  const { Parser } = require("node-sql-parser") as {
    Parser: { prototype: { astify: (...args: unknown[]) => unknown } };
  };
  const previous = Parser.prototype.astify;
  let legacyCalls = 0;
  Parser.prototype.astify = () => {
    legacyCalls++;
    throw new Error("legacy_parser_forbidden");
  };
  try {
    for (const sql of [
      `SELECT event_date, new_users FROM fact_fox_daily_install WHERE ${where}`,
      `SELECT country_code, SUM(new_users) AS total FROM fact_fox_daily_install WHERE ${where} GROUP BY country_code`,
      `SELECT sumIf(new_users, new_users > 0) AS total FROM fact_fox_daily_install WHERE ${where}`,
      `SELECT event_date, new_users FROM fact_fox_daily_install WHERE ${where} LIMIT 1`,
      `WITH a AS (SELECT event_date, new_users FROM fact_fox_daily_install WHERE ${where}) SELECT SUM(new_users + 1) AS total FROM a`,
    ]) {
      const result = plan(sql);
      assert.deepEqual(
        result.receipt.time_range,
        { start: "2026-10-06", end: "2026-10-08" },
        sql,
      );
      assert.deepEqual(result.receipt.tables, [fact.table]);
      assert.equal(result.receipt.sql_limited, sql.endsWith("LIMIT 1"));
    }
    const scoped = plan(
      `WITH a AS (SELECT event_date, new_users AS amount FROM fact_fox_daily_install WHERE ${where}) SELECT event_date, amount FROM a`,
    );
    assert.equal(scoped.receipt.engine, "clickhouse_ast_scoped");
    assert.ok(scoped.receipt.proof_sql);
    assert.equal(legacyCalls, 0, "捕获旧解析器异常后继续也算失败");
  } finally {
    Parser.prototype.astify = previous;
  }
});

test("原生计划约束所有物理扫描，未知表达式不能绕过字段、日期和结构授权", () => {
  for (const sql of [
    `SELECT device_token FROM fact_fox_daily_install WHERE ${where}`,
    `SELECT SUM(new_users) FROM fact_fox_daily_install WHERE ${where} OR 1 = 1`,
    `SELECT new_users FROM fact_fox_daily_install`,
    `SELECT new_users FROM fact_fox_daily_install WHERE ${where}; SELECT 1`,
    `SELECT sleep(1) FROM fact_fox_daily_install WHERE ${where}`,
    `SELECT sumIf(new_users, device_token = 'x') FROM fact_fox_daily_install WHERE ${where}`,
    `WITH a AS (SELECT new_users FROM fact_fox_daily_install WHERE ${where}) SELECT device_token FROM a`,
    `SELECT new_users FROM fact_fox_daily_install FINAL WHERE ${where}`,
    `SELECT new_users FROM fact_fox_daily_install SAMPLE 0.1 WHERE ${where}`,
    `SELECT country_code, SUM(new_users) FROM fact_fox_daily_install WHERE ${where} GROUP BY country_code WITH TOTALS`,
    `SELECT new_users FROM fact_fox_daily_install WHERE ${where.replace("'2026-10-08'", "'2029-10-08'")}`,
  ])
    assert.throws(() => plan(sql), SqlRejected, sql);
});

test("登记维表 JOIN 与预聚合 JOIN 共用原生授权，错误关联不能降级放行", () => {
  const direct =
    "SELECT f.title_id, d.title_name AS label, SUM(f.new_users) AS total FROM fact_fox_daily_install f LEFT JOIN dim_fox_title d ON f.title_id = d.title_id WHERE f.event_date >= '2026-10-06' AND f.event_date <= '2026-10-08' AND f.platform = 'ios' AND f.country_code = 'JP' AND f.channel_id = 'mist_ads' GROUP BY f.title_id, d.title_name";
  const inner =
    "SELECT title_id, SUM(new_users) AS total FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-08' AND platform = 'ios' AND country_code = 'JP' AND channel_id = 'mist_ads' GROUP BY title_id";
  const cte = `WITH p AS (${inner}) SELECT p.title_id, d.title_name AS label, SUM(p.total) AS total FROM p LEFT JOIN dim_fox_title d ON p.title_id = d.title_id GROUP BY p.title_id, d.title_name`;
  for (const sql of [direct, cte]) {
    const result = plan(sql, [fact, dim]);
    assert.equal(result.receipt.engine, "clickhouse_ast_join");
    assert.ok(result.join, sql);
    assert.equal(result.coverage, "join");
  }
  for (const sql of [
    direct.replace("f.title_id = d.title_id", "f.platform = d.title_id"),
    direct.replace(
      "f.title_id = d.title_id",
      "f.title_id = d.title_id OR 1 = 1",
    ),
    direct.replace("LEFT JOIN", "CROSS JOIN"),
  ])
    assert.throws(() => plan(sql, [fact, dim]), SqlRejected, sql);
  const self =
    "SELECT a.new_users FROM fact_fox_daily_install a JOIN fact_fox_daily_install b ON a.title_id = b.title_id WHERE a.event_date = '2026-10-06' AND b.event_date = '2026-10-06'";
  assert.throws(() => plan(self), SqlRejected);
});

test("原生审查保留未登记关联、无界子查询及粒度错误的稳定工具诊断", () => {
  const experiment = knowledge.contract_by_table.get(
    "fact_fox_experiment_metric",
  )!.contract!;
  const revenue = knowledge.contract_by_table.get(
    "fact_fox_ad_receipt",
  )!.contract!;
  const unregistered =
    "SELECT a.event_date, b.metric_value FROM fact_fox_daily_install a JOIN fact_fox_experiment_metric b ON a.event_date = b.event_date WHERE a.event_date >= '2026-10-06' AND a.event_date <= '2026-10-12' AND b.event_date >= '2026-10-06' AND b.event_date <= '2026-10-12'";
  const grain =
    "SELECT i.event_date, i.new_users, r.revenue_usd FROM fact_fox_daily_install i JOIN fact_fox_ad_receipt r ON i.event_date = r.event_date AND i.title_id = r.title_id AND i.platform = r.platform AND i.country_code = r.country_code WHERE i.event_date >= '2026-10-06' AND i.event_date <= '2026-10-12' AND r.event_date >= '2026-10-06' AND r.event_date <= '2026-10-12'";
  for (const [sql, contracts, code] of [
    [unregistered, [fact, experiment], "missing_join_constraint"],
    [
      `WITH x AS (${unregistered}) SELECT event_date FROM x`,
      [fact, experiment],
      "missing_join_constraint",
    ],
    [
      `SELECT event_date, new_users FROM fact_fox_daily_install WHERE ${where} AND title_id IN (SELECT title_id FROM fact_fox_daily_install)`,
      [fact],
      "unbounded_query",
    ],
    [grain, [fact, revenue], "join_grain_mismatch"],
    [
      `SELECT * FROM fact_fox_daily_install WHERE ${where}`,
      [fact],
      "wildcard_projection",
    ],
  ] as const)
    assert.throws(
      () => plan(sql, [...contracts]),
      (error: unknown) => error instanceof SqlRejected && error.code === code,
      sql,
    );
});

test("真实维表读取形状按无分区契约审查，事实表仍须有界日期", () => {
  for (const sql of [
    "SELECT title_id, title_name FROM dim_fox_title ORDER BY title_id",
    "SELECT title_id, title_name FROM dim_fox_title",
    "SELECT title_id, title_name, genre, launched_on FROM dim_fox_title WHERE title_id IN (SELECT title_id FROM dim_fox_title)",
    "SELECT title_id, title_name FROM dim_fox_title WHERE title_id IN ('paper_lantern','glass_minnow')",
    "SELECT title_id, title_name FROM dim_fox_title WHERE title_name IN ('纸灯','玻璃鲦')",
    "SELECT title_id, title_name, genre FROM dim_fox_title WHERE title_id = 'paper_lantern'",
    "SELECT title_id, title_name, genre, launched_on FROM dim_fox_title WHERE launched_on >= toDate('2026-01-01')",
    "SELECT COUNT() AS n FROM dim_fox_title",
    "SELECT title_name FROM dim_fox_title",
    "SELECT title_id, title_name FROM dim_fox_title WHERE title_id IN ('paper_lantern', 'glass_minnow') AND genre NOT IN ('__none__')",
  ]) {
    const result = plan(sql, [dim]);
    assert.equal(result.coverage, "dimension", sql);
    assert.equal(result.receipt.scope?.kind, "dimension_snapshot");
  }
  assert.throws(
    () => plan("SELECT title_id, new_users FROM fact_fox_daily_install"),
    SqlRejected,
  );
  assert.throws(
    () => plan("SELECT nonexistent FROM dim_fox_title", [dim]),
    SqlRejected,
  );
});

test("真实 JOIN 可同时证明字面日期函数、维表键筛选和辅助 NULL 计数", () => {
  const sql =
    "SELECT t.title_id AS title_id, t.title_name AS title_name, SUM(f.new_users) AS new_users_sum, COUNT(f.new_users) AS rows_non_null, countIf(f.new_users IS NULL) AS rows_null FROM fact_fox_daily_install AS f JOIN dim_fox_title AS t ON f.title_id = t.title_id WHERE f.event_date >= toDate('2026-10-06') AND f.event_date <= toDate('2026-10-12') AND f.country_code = 'JP' AND f.platform = 'ios' AND f.channel_id = 'mist_ads' AND t.title_id = 'paper_lantern' GROUP BY t.title_id, t.title_name";
  const result = plan(sql, [fact, dim]);
  assert.equal(result.coverage, "join");
  assert.equal(result.join?.factFilters.title_id, "paper_lantern");
  assert.deepEqual(
    result.join?.metrics.map((item) => item.operation),
    ["sum", "count_nonnull", "count_null"],
  );
  assert.match(
    result.join!.executionSql,
    /countIf\(isNull\(f\.new_users\)\) AS rows_null/,
  );
  assert.throws(
    () =>
      plan(
        sql.replace(
          "t.title_id = 'paper_lantern'",
          "t.title_id = 'paper_lantern' AND f.title_id = 'glass_minnow'",
        ),
        [fact, dim],
      ),
    SqlRejected,
  );
  assert.throws(
    () =>
      plan(
        sql.replace(
          "SELECT t.title_id AS title_id",
          "SELECT title_id AS title_id",
        ),
        [fact, dim],
      ),
    SqlRejected,
  );
});
