import assert from "node:assert/strict";
import test from "node:test";
import { verifyDatabaseAggregates } from "../src/aggregate-evidence.js";
import { loadKnowledge } from "../src/knowledge.js";
import type { QueryResource } from "../src/types.js";

test("数据库日期分组必须是契约日期且每个实际值有效、唯一和在查询范围内", () => {
  const contract = loadKnowledge("knowledge/harborlight").contract_by_table.get("fact_fox_daily_install")!.contract!;
  const sql = "SELECT event_date, channel_id, SUM(new_users) AS total FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-08' AND title_id = 'date_demo' AND platform = 'android' AND country_code = 'ZZ' GROUP BY event_date, channel_id";
  const source = {
    resource_id: "res_date_gold", engine: "clickhouse-local", tables: [contract.table], sql,
    truncated: false, complete_population: true, scan_limit: 5_000_000,
    time_range: { start: "2026-10-06", end: "2026-10-08", timezone: contract.timezone },
    coverage: { status: "known", absent_dates: [], null_dates: [], zero_dates: [], predicted_dates: [], unknown_prediction_dates: [], groups: [] },
    rows: [{ event_date: "2026-10-06", channel_id: "mist_ads", total: "3" }, { event_date: "2026-10-07", channel_id: "mist_ads", total: "0" }],
  } as unknown as QueryResource;
  const verified = verifyDatabaseAggregates(source, contract);
  assert.deepEqual(verified?.map((row) => [row.group.event_date, row.group.channel_id, row.value]), [["2026-10-06", "mist_ads", "3"], ["2026-10-07", "mist_ads", "0"]]);
  for (const bad of ["2026-02-30", "2026-10-05", "2026-10-09", "2026-10-6", null]) {
    const changed = structuredClone(source); changed.rows[0]!.event_date = bad;
    assert.equal(verifyDatabaseAggregates(changed, contract), null);
  }
  const duplicate = structuredClone(source); duplicate.rows[1] = { ...duplicate.rows[0]! };
  assert.equal(verifyDatabaseAggregates(duplicate, contract), null);
  const truncated = structuredClone(source); truncated.truncated = true;
  assert.equal(verifyDatabaseAggregates(truncated, contract), null);
});
