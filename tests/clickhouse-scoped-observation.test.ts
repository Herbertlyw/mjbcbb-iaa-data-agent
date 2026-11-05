import assert from "node:assert/strict";
import test from "node:test";
import { loadKnowledge } from "../src/knowledge.js";
import { reviewScopedObservation } from "../src/clickhouse-scoped-observation.js";

const contract = loadKnowledge("knowledge/harborlight").contract_by_table.get("fact_fox_daily_install")!.contract!;
const rule = { table: contract.table, allowed_columns: contract.columns.map((column) => column.name).filter((name) => !contract.sensitive_columns.includes(name)), sensitive_columns: contract.sensitive_columns, must_filter: contract.must_filter, column_types: Object.fromEntries(contract.columns.map((column) => [column.name, column.type])) };
const inner = "SELECT country_code, SUM(new_users) AS total FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-08' GROUP BY country_code";
const sql = `WITH a AS (${inner}), b AS (SELECT country_code, total FROM a) SELECT country_code, total FROM b`;
const review = (value: string) => reviewScopedObservation(value, contract, rule, "harborlight", 100);

test("聚合 CTE 的 CK 原生观察只绑定物理来源和扫描范围", () => {
  assert.deepEqual(review(sql)?.time_range, { start: "2026-10-06", end: "2026-10-08" });
  assert.deepEqual(review(`SELECT country_code, total FROM (${inner}) AS x`)?.time_range, { start: "2026-10-06", end: "2026-10-08" });
  assert.equal(review("SELECT scoped.event_date, scoped.new_users FROM (SELECT event_date, new_users FROM fact_fox_daily_install WHERE event_date = '2026-10-06') scoped"), null, "普通投影应保留已有业务证据路径");
  for (const rejected of [
    sql.replace("SUM(new_users)", "SUM(device_token)"),
    sql.replace("event_date >= '2026-10-06' AND event_date <= '2026-10-08'", "country_code = 'US'"),
    sql.replace("SELECT country_code, total FROM b", "SELECT country_code, device_token FROM b"),
    sql.replace("SELECT country_code, total FROM b", "SELECT country_code, total FROM b LIMIT 1"),
    sql.replace("SELECT country_code, total FROM b", "SELECT country_code, total FROM b UNION ALL SELECT country_code, total FROM b"),
    sql.replace("SELECT country_code, total FROM b", "SELECT country_code, total FROM b JOIN a ON b.country_code = a.country_code"),
    sql.replace("FROM fact_fox_daily_install", "FROM file('sensitive.csv')"),
  ]) assert.equal(review(rejected), null, rejected);
});
