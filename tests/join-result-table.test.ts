import assert from "node:assert/strict";
import test from "node:test";
import { loadKnowledge } from "../src/knowledge.js";
import { prepareJoinEvidence, verifyJoinEvidence, type JoinEvidencePlan } from "../src/join-evidence.js";
import { joinResultTable } from "../src/join-result-table.js";
import { transformResult } from "../src/result-transform.js";

const knowledge = loadKnowledge("knowledge/harborlight");
const fact = knowledge.contract_by_table.get("fact_fox_daily_install")!.contract!;
const dim = knowledge.contract_by_table.get("dim_fox_title")!.contract!;
const sql = "SELECT f.title_id AS product, d.title_name AS guessed_revenue, SUM(f.new_users) AS wrong_unit, COUNT(f.new_users) AS n FROM fact_fox_daily_install f LEFT JOIN dim_fox_title d ON f.title_id = d.title_id WHERE f.event_date >= '2026-10-06' AND f.event_date <= '2026-10-12' AND f.platform = 'ios' AND f.country_code = 'JP' AND f.channel_id = 'mist_ads' GROUP BY f.title_id, d.title_name ORDER BY f.title_id";
const plan = prepareJoinEvidence(sql, fact, dim, knowledge.joins)!;
function row(p: JoinEvidencePlan, id: string, label: string | null, daily: number) {
  const fields: Record<string, string | null> = { "fact.title_id": id, "fact.platform": "ios", "fact.country_code": "JP", "fact.channel_id": "mist_ads", "dimension.title_id": label === null ? null : id, "dimension.title_name": label };
  return { product: id, guessed_revenue: label, wrong_unit: String(daily * 7), n: "7", __da_join_proof: p.expectedDates.map((date) => [date, daily, ...p.proofFields.map((field) => fields[`${field.table}.${field.column}`])]) };
}
const values = verifyJoinEvidence(plan, [row(plan, "known", "合成名称", 10), row(plan, "missing", null, 3)])!;

test("已核验 JOIN 分组转换完整表：NULL 键、计数及合计的标签来自契约", () => {
  assert.equal(values.length, 4);
  const table = joinResultTable(plan, values, fact, dim); assert.ok(table);
  assert.deepEqual(table.rows.map((item) => ({ ...item })), [
    { product: "known", guessed_revenue: "合成名称", wrong_unit: "70", n: "7" },
    { product: "missing", guessed_revenue: null, wrong_unit: "21", n: "7" },
  ]);
  assert.equal(table.columns.find((item) => item.name === "wrong_unit")?.unit, "人");
  assert.match(table.columns.find((item) => item.name === "wrong_unit")?.label ?? "", /fact_fox_daily_install\.new_users/);
  assert.doesNotMatch(table.columns.find((item) => item.name === "wrong_unit")?.label ?? "", /wrong_unit/);
  assert.equal(table.columns.find((item) => item.name === "n")?.unit, "行");
  const filtered = transformResult(table, [{ op: "filter", column: "guessed_revenue", comparison: "is_null" }, { op: "group", by: [], aggregates: [{ op: "sum", column: "wrong_unit", as: "total" }] }]);
  assert.equal(filtered?.rows[0]?.total, "21");
});

test("缺单元、重复、伪造口径、跨范围与字段冲突均拒绝", () => {
  assert.equal(joinResultTable(plan, values.slice(1), fact, dim), null);
  assert.equal(joinResultTable(plan, [...values, values[0]!], fact, dim), null);
  assert.equal(joinResultTable(plan, values.map((item, i) => i === 0 ? { ...item, unit: "USD" } : item), fact, dim), null);
  assert.equal(joinResultTable(plan, values.map((item, i) => i === 0 ? { ...item, factFilters: { ...item.factFilters, country_code: "US" } } : item), fact, dim), null);
  assert.equal(joinResultTable(plan, values.map((item, i) => i === 0 ? { ...item, range: { ...item.range, end: "2026-10-11" } } : item), fact, dim), null);
  const changed = structuredClone(plan); changed.metrics[0]!.output = changed.groups[0]!.output;
  assert.equal(joinResultTable(changed, values, fact, dim), null);
  const duplicate = structuredClone(plan); duplicate.metrics.push({ ...duplicate.metrics[0]!, output: "other" });
  assert.equal(joinResultTable(duplicate, values, fact, dim), null);
  const wrongNull = values.map((item, i) => i === 0 ? { ...item, group: { ...item.group, [`${fact.table}.title_id`]: null } } : item);
  assert.equal(joinResultTable(plan, wrongNull, fact, dim), null);
  const wrongValue = values.map((item, i) => i === 0 ? { ...item, value: "NaN" } : item);
  assert.equal(joinResultTable(plan, wrongValue, fact, dim), null);
});
