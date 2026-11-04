import assert from "node:assert/strict";
import test from "node:test";
import { verifyCell, verifiedNullMarkerPreview } from "../src/evidence.js";
import { loadKnowledge } from "../src/knowledge.js";
import type { QueryResource } from "../src/types.js";

const contract = loadKnowledge("knowledge/harborlight").contract_by_table.get("fact_fox_daily_install")!.contract!;
const base = "SELECT event_date, new_users, isNull(new_users) AS is_null FROM fact_fox_daily_install WHERE event_date >= toDate('2026-10-06') AND event_date <= toDate('2026-10-08') AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'US' AND channel_id = 'mist_ads' ORDER BY event_date";
const source = {
  resource_id: "synthetic_null_marker", engine: "clickhouse-local", tables: [contract.table], sql: base,
  truncated: false, complete_population: true, time_range: { start: "2026-10-06", end: "2026-10-08", timezone: contract.timezone },
  rows: [{ event_date: "2026-10-06", new_users: 100, is_null: 0 }, { event_date: "2026-10-07", new_users: 0, is_null: 0 }, { event_date: "2026-10-08", new_users: 120, is_null: 0 }],
} as unknown as QueryResource;
const sum = { op: "sum" as const, column: "new_users", as: "total", predicted: "actual_only" as const };

test("空值辅助投影逐行重算，仅按契约原字段交付", () => {
  const cell = verifyCell(source, contract, sum, 220);
  assert.equal(cell?.value, 220); assert.equal(cell?.unit, "人");
  assert.deepEqual(verifiedNullMarkerPreview(source, contract), [
    { event_date: "2026-10-06", new_users: 100 }, { event_date: "2026-10-07", new_users: 0 }, { event_date: "2026-10-08", new_users: 120 },
  ]);
  const inverted = structuredClone(source);
  inverted.sql = inverted.sql.replace("isNull(new_users)", "isNotNull(new_users)");
  inverted.rows = inverted.rows.map((row) => ({ ...row, is_null: 1 }));
  assert.equal(verifyCell(inverted, contract, sum, 220)?.value, 220);
  const nullable = structuredClone(source);
  nullable.rows[0]!.new_users = null; nullable.rows[0]!.is_null = 1;
  assert.equal(verifyCell(nullable, contract, { op: "count_null", column: "new_users", as: "n" }, 1)?.value, 1);
  assert.equal(verifyCell(nullable, contract, { op: "count_zero", column: "new_users", as: "n" }, 1)?.value, 1);
});

test("伪造标记、缺直接字段、敏感字段及任意表达式不能用于证据", () => {
  const forged = structuredClone(source); forged.rows[0]!.is_null = 1;
  const missing = structuredClone(source); delete missing.rows[0]!.new_users;
  const extra = structuredClone(source); extra.rows[0]!.untracked = 7;
  const hidden = structuredClone(source); hidden.sql = hidden.sql.replace("new_users, isNull", "isNull");
  const sensitive = structuredClone(source); sensitive.sql = sensitive.sql.replace("isNull(new_users)", "isNull(device_token)");
  const shadow = structuredClone(source); shadow.sql = shadow.sql.replace("AS is_null", "AS country_code");
  const expression = structuredClone(source); expression.sql = expression.sql.replace("isNull(new_users)", "isNull(new_users + 1)");
  const otherEngine = structuredClone(source); otherEngine.engine = "sqlite-local";
  for (const invalid of [forged, missing, extra, hidden, sensitive, shadow, expression, otherEngine]) {
    assert.equal(verifyCell(invalid, contract, sum, 220), null);
    assert.equal(verifiedNullMarkerPreview(invalid, contract), null);
  }
  assert.equal(verifyCell(source, contract, { op: "sum", column: "is_null", as: "forged" }, 0), null);
});
