import assert from "node:assert/strict";
import test from "node:test";
import { assessCoverage, coverageHasGap, provenCoverageFilters, provenCoverageScope } from "../src/coverage.js";
import { loadKnowledge } from "../src/knowledge.js";
import { analyst, bindTables, withRuntime } from "./helpers.js";
import { clickHouseCoverageScope } from "../src/clickhouse-coverage-scope.js";

const contract = loadKnowledge("knowledge/lumenfox").contract_by_table.get("daily_installs")!.contract!;
const range = { start: "2026-10-06", end: "2026-10-07" };
const base = "SELECT country_code, channel, SUM(new_users) AS total FROM daily_installs WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-07' AND product_id = 'starlane_drift' AND platform = 'ios'";

test("ClickHouse AST 从原生谓词证明覆盖筛选，不将不支持的条件视为完整", () => {
  const ck = { ...contract, engine: "clickhouse-local" as const };
  const sql = `${base} AND country_code IN ('US', 'JP') AND channel = 'nebula_ads' GROUP BY country_code, channel`;
  assert.deepEqual(clickHouseCoverageScope(sql, ck, range), { equalities: { product_id: "starlane_drift", platform: "ios", channel: "nebula_ads" }, inSets: { country_code: ["JP", "US"] } });
  assert.deepEqual(provenCoverageScope(sql, ck, range), clickHouseCoverageScope(sql, ck, range));
  const day = { start: "2026-10-06", end: "2026-10-06" };
  assert.ok(clickHouseCoverageScope("SELECT new_users FROM daily_installs WHERE event_date = toDate('2026-10-06') AND country_code = 'US'", ck, day));
  for (const query of [
    sql.replace("country_code IN ('US', 'JP')", "country_code IN ('US', NULL)"),
    sql.replace("country_code IN ('US', 'JP')", "country_code IN ('US', 'US')"),
    sql.replace("country_code IN ('US', 'JP')", "(country_code = 'US' OR country_code = 'JP')"),
    `${sql} LIMIT 1`,
    sql.replace("daily_installs WHERE", "daily_installs AS x WHERE").replace("country_code IN", "other.country_code IN"),
  ]) assert.equal(clickHouseCoverageScope(query, ck, range), null, query);
});

test("IN 集合覆盖核对各值和笛卡尔组合，不把 NULL、缺组或零混同", () => {
  const sql = `${base} AND country_code IN ('US', 'JP') AND channel IN ('nebula_ads', 'comet_network') GROUP BY country_code, channel`;
  const scope = provenCoverageScope(sql, contract, range); assert.ok(scope);
  assert.deepEqual(scope.equalities, { product_id: "starlane_drift", platform: "ios" });
  assert.deepEqual(scope.inSets, { country_code: ["JP", "US"], channel: ["comet_network", "nebula_ads"] });
  assert.equal(provenCoverageFilters(sql, contract, range), null, "多值集合不能伪装成单值等式");
  const all = ["US", "JP"].flatMap((country_code) => ["nebula_ads", "comet_network"].flatMap((channel) => ["2026-10-06", "2026-10-07"].map((event_date) => ({ event_date, product_id: "starlane_drift", platform: "ios", country_code, channel, new_users: country_code === "US" && channel === "nebula_ads" ? 0 : 1 }))));
  const complete = assessCoverage(contract, scope.equalities, range, all, scope.inSets);
  assert.equal(complete.status, "known"); assert.equal(coverageHasGap(complete), false); assert.ok(complete.zero_dates.includes("2026-10-06"));
  const missing = assessCoverage(contract, scope.equalities, range, all.filter((row) => !(row.country_code === "JP" && row.channel === "comet_network")), scope.inSets);
  assert.equal(coverageHasGap(missing), true);
  assert.ok(missing.groups.some((group) => group.value.includes('"JP"') && group.value.includes('"comet_network"') && group.absent_dates.length === 2));
  const partialNull = assessCoverage(contract, scope.equalities, range, all.map((row, i) => i === 0 ? { ...row, new_users: null } : row), scope.inSets);
  assert.equal(coverageHasGap(partialNull), true); assert.ok(partialNull.null_dates.includes("2026-10-06"));
  assert.equal(assessCoverage(contract, scope.equalities, range, [...all, { ...all[0]!, country_code: "DE" }], scope.inSets).status, "unknown");
  for (const predicate of ["country_code NOT IN ('US', 'JP')", "country_code IN ('US', NULL)", "country_code IN ('US', 'US')", "country_code IN (SELECT country_code FROM daily_installs)", "(country_code = 'US' OR country_code = 'JP')"]) {
    assert.equal(provenCoverageScope(`${base} AND ${predicate} GROUP BY country_code, channel`, contract, range), null, predicate);
  }
});

test("两个国家的 IN 分组在当前任务按覆盖和契约交付；缺组不冒充完整", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime); await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    runtime.sessions.setActiveJob(session.session_id, "job_in_scope");
    const sql = "SELECT country_code, SUM(new_users) AS total FROM daily_installs WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-08' AND product_id = 'starlane_drift' AND platform = 'ios' AND channel = 'nebula_ads' AND country_code IN ('US','JP') GROUP BY country_code ORDER BY country_code";
    const query = await runtime.tools.query(session.session_id, { sql });
    assert.equal(query.ok, true, JSON.stringify(query)); if (!query.ok) return;
    const result = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(query.resource_id)] });
    assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) return;
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.match(String(result.answer), /country_code=US/u); assert.match(String(result.answer), /数据库求和 215/u);
    assert.match(String(result.answer), /country_code=JP/u); assert.match(String(result.answer), /数据库求和 30/u);
    const saved = runtime.sessions.lookupResource(session.session_id, String(query.resource_id));
    assert.ok(saved.ok && saved.resource.kind === "query_result"); if (!saved.ok || saved.resource.kind !== "query_result") return;
    const differingObservation = structuredClone(saved.resource);
    differingObservation.rows = differingObservation.rows.filter((row) => row.country_code === "US");
    differingObservation.total_rows = differingObservation.rows.length; differingObservation.returned_rows = differingObservation.rows.length;
    runtime.state.saveResource(differingObservation);
    const differingDelivery = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(query.resource_id)] });
    assert.ok(differingDelivery.ok, JSON.stringify(differingDelivery)); if (!differingDelivery.ok) return;
    assert.equal(differingDelivery.status, "partial");
    assert.ok((differingDelivery.server_reasons as string[]).includes("aggregate_groups_incomplete"));
    assert.match((differingDelivery.limitations as string[]).join(" "), /缺少请求的分组或日期组合/u);
    const missingQuery = await runtime.tools.query(session.session_id, { sql: sql.replace("'US','JP'", "'US','DE'") });
    assert.equal(missingQuery.ok, true, JSON.stringify(missingQuery)); if (!missingQuery.ok) return;
    const missing = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(missingQuery.resource_id)] });
    assert.equal(missing.ok, true, JSON.stringify(missing)); if (missing.ok) { assert.notEqual(missing.status, "completed"); assert.doesNotMatch(String(missing.answer), /country_code=DE.*数据库求和 0/u); }
    runtime.sessions.setActiveJob(session.session_id, "job_in_next");
    const crossed = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(query.resource_id)] });
    assert.equal(crossed.ok, false);
  });
});
