import assert from "node:assert/strict";
import test from "node:test";
import { planClickHouse } from "../src/clickhouse-plan.js";
import { diagnoseKnowledge } from "../src/knowledge-doctor.js";
import { loadKnowledge } from "../src/knowledge.js";
import { SqlRejected } from "../src/sql.js";
import type { DataContract } from "../src/types.js";

const knowledge = loadKnowledge("knowledge/starhaven");
const contract = (table: string): DataContract => {
  const value = knowledge.contract_by_table.get(table)?.contract;
  assert.ok(value, table);
  return value;
};
const plan = (sql: string, tables: string[]) => {
  const contracts = tables.map(contract);
  return planClickHouse(
    sql,
    contracts.map((value) => ({
      table: value.table,
      allowed_columns: value.columns.map((column) => column.name),
      sensitive_columns: value.sensitive_columns,
      must_filter: value.must_filter,
      column_types: Object.fromEntries(
        value.columns.map((column) => [column.name, column.type]),
      ),
    })),
    contracts,
    knowledge.joins,
    "starhaven_validation",
    1000,
  );
};

test("VV Data Agent 的 23 个契约、字段、来源和 SQL 模板通过宿主体检", () => {
  assert.equal(knowledge.contract_by_table.size, 23);
  assert.deepEqual(diagnoseKnowledge("knowledge/starhaven"), []);
  assert.ok(
    knowledge.assets.some((asset) => asset.asset_id === "starhaven.release"),
  );
  assert.ok(
    knowledge.assets.every(
      (asset) => !/private-gold|settings\.json|cases\.json/u.test(asset.path),
    ),
  );
});

test("VV Data Agent事实表使用真实日期分区门禁，版本字段不会误当日期", () => {
  const result = plan(
    "SELECT app_id, SUM(discounted_cost_usd) AS cost FROM fact_delivery_daily WHERE business_date BETWEEN '2026-10-01' AND '2026-10-07' AND dataset_version = 'sv_00000000000000000000' GROUP BY app_id",
    ["fact_delivery_daily"],
  );
  assert.deepEqual(result.receipt.time_range, {
    start: "2026-10-01", end: "2026-10-07",
  });
  assert.deepEqual(contract("fact_delivery_daily").must_filter, ["business_date"]);
  assert.throws(
    () => plan("SELECT app_id, discounted_cost_usd FROM fact_delivery_daily", ["fact_delivery_daily"]),
    SqlRejected,
  );
});

test("VV Data Agent维表按无日期分区读取，未知字段和外部表函数仍拒绝", () => {
  assert.equal(
    plan("SELECT app_id, game_name, platform FROM dim_app ORDER BY app_id", ["dim_app"]).coverage,
    "dimension",
  );
  assert.throws(
    () => plan("SELECT nonexistent FROM dim_app", ["dim_app"]), SqlRejected,
  );
  assert.throws(
    () => plan("SELECT app_id FROM file('/tmp/anything')", ["dim_app"]), SqlRejected,
  );
});

test("窗口去重、重复基数和预测字段不会自动成为可加总业务指标", () => {
  assert.ok(!contract("fact_activity_daily").series?.metrics.includes("active_devices_30d"));
  assert.ok(!contract("fact_cohort_quality_daily").series?.metrics.includes("cohort_size_devices"));
  assert.ok(!contract("fact_experiment_cohort_daily").series?.metrics.includes("enrolled_units"));
  assert.equal(contract("fact_roi_forecast_snapshot").series, undefined);
  assert.deepEqual(contract("fact_roi_forecast_evaluation").series?.metrics, []);
  assert.ok(!contract("fact_delivery_daily").series?.metrics.includes("raw_cost_local"));
  assert.ok(!contract("fact_gameplay_daily").series?.metrics.includes("total_score"));
});
