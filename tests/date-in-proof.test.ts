import assert from "node:assert/strict";
import test from "node:test";
import { clickHouseCoverageAnalysis } from "../src/clickhouse-coverage-scope.js";
import { provenCoverageFilters } from "../src/coverage.js";
import { planClickHouse } from "../src/clickhouse-plan.js";
import { clickHouseReviewPolicy } from "../src/clickhouse-review-policy.js";
import { reviewSql } from "../src/clickhouse-review.js";
import { clickHouseScanRange } from "../src/clickhouse-scan-range.js";
import { loadKnowledge } from "../src/knowledge.js";
import { SqlRejected } from "../src/sql.js";
import { REAL_A_PAYMENT_SQL, REAL_A_SPEND_SQL } from "./real-model-a-sql.js";

const knowledge = loadKnowledge("knowledge/harborlight");
const contracts = ["fact_fox_daily_payment", "fact_fox_daily_spend"].map(
  (table) => knowledge.contract_by_table.get(table)!.contract!,
);
const rules = contracts.map((contract) => ({
  table: contract.table,
  allowed_columns: contract.columns
    .filter((column) => !contract.sensitive_columns.includes(column.name))
    .map((column) => column.name),
  sensitive_columns: contract.sensitive_columns,
  must_filter: contract.must_filter,
  column_types: Object.fromEntries(
    contract.columns.map((column) => [column.name, column.type]),
  ),
}));
const range = { start: "2026-10-08", end: "2026-10-08" };

test("实际 A 的单日期 IN 与有界等值范围一致，原始 SQL 不改写", () => {
  for (const [index, original] of [
    REAL_A_PAYMENT_SQL,
    REAL_A_SPEND_SQL,
  ].entries()) {
    const contract = contracts[index]!;
    for (const sql of [
      original,
      original.replace("IN (toDate('2026-10-08'))", "IN ('2026-10-08')"),
    ]) {
      const plan = planClickHouse(
        sql,
        rules,
        contracts,
        knowledge.joins,
        "synthetic",
        1000,
      );
      assert.equal(plan.guarded.sql, sql);
      assert.equal(plan.receipt.engine, "clickhouse_ast_direct");
      assert.deepEqual(plan.guarded.time_range, range);
      assert.deepEqual(clickHouseScanRange(sql, contract), range);
      assert.deepEqual(clickHouseCoverageAnalysis(sql, contract), {
        time_range: range,
        scope: {
          equalities: {
            country_code: "US",
            platform: "ios",
            channel_id: "mist_ads",
            title_id: "paper_lantern",
          },
          inSets: {},
        },
      });
      assert.equal(
        reviewSql(sql, clickHouseReviewPolicy("synthetic", rules, 1000)).ok,
        true,
      );
    }
  }
});

test("单值 IN 不扩大到动态日期、NULL、数组、子查询、NOT IN 或 OR 绕过", () => {
  for (const predicate of [
    "event_date IN (toDate('2026-02-30'))",
    "event_date IN (toDate('1969-12-31'))",
    "event_date IN (toDate('2149-06-07'))",
    "event_date IN (toDate(event_date))",
    "event_date IN (toDate(NULL))",
    "event_date IN (toDate('2026-10-08', 'UTC'))",
    "event_date IN (NULL)",
    "event_date IN (today())",
    "event_date IN (['2026-10-08'])",
    "event_date IN (SELECT event_date FROM fact_fox_daily_payment)",
    "event_date NOT IN (toDate('2026-10-08'))",
    "(event_date IN (toDate('2026-10-08')) OR country_code = 'US')",
    "wrong.event_date IN (toDate('2026-10-08'))",
  ]) {
    const sql = REAL_A_PAYMENT_SQL.replace(
      "event_date IN (toDate('2026-10-08'))",
      predicate,
    );
    assert.throws(
      () =>
        planClickHouse(
          sql,
          rules,
          contracts,
          knowledge.joins,
          "synthetic",
          1000,
        ),
      SqlRejected,
      predicate,
    );
    assert.equal(
      clickHouseCoverageAnalysis(sql, contracts[0]!),
      null,
      predicate,
    );
  }
  const sparse = REAL_A_PAYMENT_SQL.replace(
    "IN (toDate('2026-10-08'))",
    "IN ('2026-10-08', '2026-10-10')",
  );
  assert.equal(
    reviewSql(sparse, clickHouseReviewPolicy("synthetic", rules, 1000)).ok,
    true,
    "原有有限日期列表仍可证明扫描边界",
  );
  const analysis = clickHouseCoverageAnalysis(sparse, contracts[0]!);
  assert.deepEqual(analysis?.scope.selectedDates, ["2026-10-08", "2026-10-10"]);
  assert.deepEqual(analysis?.time_range, { start: "2026-10-08", end: "2026-10-10" });
  assert.equal(provenCoverageFilters(sparse, contracts[0]!, analysis!.time_range), null,
    "离散日期不得作为连续范围交给旧覆盖证明");
});
