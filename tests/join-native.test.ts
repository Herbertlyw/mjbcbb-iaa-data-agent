import test from "node:test";
import assert from "node:assert/strict";
import { loadKnowledge } from "../src/knowledge.js";
import { prepareJoinEvidence } from "../src/join-evidence.js";

test("ClickHouse JOIN AST 绑定登记键并与既有证明规划一致", () => {
  const knowledge = loadKnowledge("knowledge/harborlight");
  const fact = knowledge.contract_by_table.get("fact_fox_daily_install")!.contract!;
  const dimension = knowledge.contract_by_table.get("dim_fox_title")!.contract!;
  const sql = "SELECT f.title_id, d.title_name AS label, SUM(f.new_users) AS total FROM fact_fox_daily_install f LEFT JOIN dim_fox_title d ON f.title_id = d.title_id WHERE f.event_date >= '2026-10-06' AND f.event_date <= '2026-10-12' AND f.platform = 'android' AND f.country_code = 'ZZ' AND f.channel_id = 'mist_ads' GROUP BY f.title_id, d.title_name ORDER BY f.title_id";
  const old = prepareJoinEvidence(sql, fact, dimension, knowledge.joins);
  const native = prepareJoinEvidence(sql, fact, dimension, knowledge.joins, true);
  assert.ok(old); assert.deepEqual(native, old);
  for (const invalid of [
    sql.replace("LEFT JOIN", "ANY LEFT JOIN"),
    sql.replace("f.title_id = d.title_id", "f.title_id = d.title_name"),
    sql.replace("f.title_id = d.title_id", "f.title_id = d.title_id AND f.platform = d.title_name"),
    sql.replace("f.event_date <= '2026-10-12'", "f.event_date <= '2026-10-12' OR f.event_date = '2025-01-01'"),
    sql + " LIMIT 1",
    sql.replace("SUM(f.new_users)", "SUM(DISTINCT f.new_users)"),
    sql.replace("SUM(f.new_users)", "SUM(f.new_users AS hidden_alias)"),
    sql.replace("ORDER BY f.title_id", "ORDER BY f.title_id NULLS FIRST"),
  ]) assert.equal(prepareJoinEvidence(invalid, fact, dimension, knowledge.joins, true), null, invalid);
});

test("ClickHouse 预聚合 JOIN 在 AST 层展开并保留登记键与粒度", () => {
  const knowledge = loadKnowledge("knowledge/harborlight");
  const fact = knowledge.contract_by_table.get("fact_fox_daily_install")!.contract!;
  const dimension = knowledge.contract_by_table.get("dim_fox_title")!.contract!;
  const inner = "SELECT f.event_date, f.title_id, f.platform, f.country_code, f.channel_id, SUM(f.new_users) AS subtotal FROM fact_fox_daily_install f WHERE f.event_date >= '2026-10-06' AND f.event_date <= '2026-10-12' AND f.platform = 'ios' AND f.country_code = 'JP' AND f.channel_id = 'mist_ads' GROUP BY f.event_date, f.title_id, f.platform, f.country_code, f.channel_id";
  const sql = `WITH p AS (${inner}) SELECT p.title_id, d.title_name AS label, SUM(p.subtotal) AS total FROM p LEFT JOIN dim_fox_title d ON p.title_id = d.title_id GROUP BY p.title_id, d.title_name ORDER BY p.title_id`;
  const previous = prepareJoinEvidence(sql, fact, dimension, knowledge.joins);
  const native = prepareJoinEvidence(sql, fact, dimension, knowledge.joins, true);
  assert.ok(previous); assert.ok(native, "原生预聚合应生成完整证明计划");
  assert.equal(native.executionSql, previous.executionSql);
  assert.equal(native.originalSql, sql);
  assert.ok(native.authorizationSql);
  for (const invalid of [
    sql.replace("p.title_id = d.title_id", "p.title_id = d.title_name"),
    sql.replace("SUM(p.subtotal)", "AVG(p.subtotal)"),
    sql.replace("SUM(f.new_users)", "SUM(DISTINCT f.new_users)"),
    sql.replace("SUM(f.new_users)", "SUM(f.new_users AS hidden_alias)"),
    sql.replace("GROUP BY f.event_date", "LIMIT 2 GROUP BY f.event_date"),
  ]) assert.equal(prepareJoinEvidence(invalid, fact, dimension, knowledge.joins, true), null, invalid);
});
