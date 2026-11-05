import assert from "node:assert/strict";
import test from "node:test";
import { loadKnowledge } from "../src/knowledge.js";
import { clickHouseRawDimensionJoin } from "../src/clickhouse-raw-join.js";
import { clickHouseReviewPolicy } from "../src/clickhouse-review-policy.js";
import { reviewSql } from "../src/clickhouse-review.js";
import { authorizeClickHouseJoin } from "../src/clickhouse-sql-preflight.js";

const kb = loadKnowledge("knowledge/harborlight");
const fact = kb.contract_by_table.get("fact_fox_daily_install")!.contract!;
const dimension = kb.contract_by_table.get("dim_fox_title")!.contract!;
const rules = [fact, dimension].map((contract) => ({ table: contract.table, allowed_columns: contract.columns.map((column) => column.name).filter((name) => !contract.sensitive_columns.includes(name)), sensitive_columns: contract.sensitive_columns, must_filter: contract.must_filter, column_types: Object.fromEntries(contract.columns.map((column) => [column.name, column.type])) }));
const sql = "SELECT i.event_date, i.title_id, i.new_users, t.title_name FROM fact_fox_daily_install i JOIN dim_fox_title t ON i.title_id = t.title_id WHERE i.event_date >= '2026-10-06' AND i.event_date <= '2026-10-12'";

test("CK 原生明细关联使用授权字段、登记键、维表粒度与封闭日期", () => {
  for (const query of [sql, sql.replace("JOIN dim_fox_title", "LEFT JOIN dim_fox_title")]) {
    assert.deepEqual(clickHouseRawDimensionJoin(query, fact, dimension, kb.joins), { start: "2026-10-06", end: "2026-10-12" });
    assert.equal(reviewSql(query, clickHouseReviewPolicy("harborlight", rules, 100)).ok, true);
    const fields = authorizeClickHouseJoin(query, rules); assert.equal(fields.applicable && fields.ok, true);
  }
  for (const query of [
    sql.replace("i.title_id = t.title_id", "i.title_id = t.title_name"),
    sql.replace("i.title_id = t.title_id", "i.title_id = t.title_id OR i.title_id = t.title_id"),
    sql.replace("i.event_date <= '2026-10-12'", "i.title_id = 'paper_lantern'"),
    sql.replace("i.event_date >=", "event_date >="),
    sql.replace("i.event_date, i.title_id, i.new_users, t.title_name", "*"),
    sql.replace("JOIN dim_fox_title", "ANY JOIN dim_fox_title"),
    sql.replace("i.event_date, i.title_id, i.new_users, t.title_name", "SUM(i.new_users) AS n"),
  ]) assert.equal(clickHouseRawDimensionJoin(query, fact, dimension, kb.joins), null, query);
  assert.equal(clickHouseRawDimensionJoin(sql, fact, { ...dimension, grain: [...dimension.grain!, "title_name"] }, kb.joins), null);
  assert.equal(clickHouseRawDimensionJoin(sql, fact, dimension, []), null);
  const sensitive = sql.replace("i.new_users", "i.device_token");
  const authorization = authorizeClickHouseJoin(sensitive, rules);
  assert.ok(authorization.applicable && !authorization.ok && authorization.code === "sensitive_field");
  assert.equal(reviewSql(sensitive, clickHouseReviewPolicy("harborlight", rules, 100)).ok, false);
});
