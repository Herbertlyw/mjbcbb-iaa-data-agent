// Explicit native integration runner; Python owns the temporary server and data.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { clickHouseQuery } from "../src/clickhouse-client.js";
import { probeClickHouseAndPublish } from "../src/freshness.js";
import { verifyJoinResource } from "../src/join-resource-proof.js";
import { createRuntime } from "../src/runtime.js";
import type { AnalysisRecord, QueryResource } from "../src/types.js";

const [credentialsPath, knowledgeDir, goldPath, workDir, reportPath] = process.argv.slice(2);
assert.ok(credentialsPath && knowledgeDir && goldPath && workDir && reportPath);
const credentials = JSON.parse(readFileSync(credentialsPath, "utf8")) as { url: string; database: string; username: string; password: string; dataset_version: string };
const gold = JSON.parse(readFileSync(goldPath, "utf8")) as { dataset_version: string; app_costs: Record<string, string> };
assert.equal(credentials.dataset_version, gold.dataset_version);
mkdirSync(workDir, { recursive: true });
const runtime = createRuntime({
  knowledgeDir, businessEngine: "clickhouse", stateMode: "sqlite", startWorker: false,
  databasePath: path.join(workDir, "business.sqlite"),
  stateDatabasePath: path.join(workDir, "state.sqlite"),
  freshnessPath: path.join(workDir, "freshness.json"),
  freshnessTargetsPath: path.join(knowledgeDir, "freshness-targets.json"),
  publishFreshnessOnStart: false, modelMode: "deterministic", piProvider: "faux",
  piApiKey: "", simulatedToday: "2026-11-08", ephemeralDir: undefined,
  clickhouseUrl: credentials.url, clickhouseUser: credentials.username,
  clickhousePassword: credentials.password, clickhouseDatabase: credentials.database,
  clickhouseLockedReadonly: true, clickhouseMaxRowsToRead: 5_000_000,
  queryTimeoutMs: 3000, maxResultRows: 10_000, maxResultBytes: 2_000_000,
});
try {
  assert.ok(runtime.clickhouse);
  const publication = await probeClickHouseAndPublish({
    targetsPath: runtime.config.freshnessTargetsPath,
    destinationPath: runtime.config.freshnessPath,
    simulatedToday: "2026-11-08",
    query: sql => clickHouseQuery(runtime.clickhouse!, sql) as Promise<Array<{ event_date: string }>>,
  });
  assert.equal(publication.tables.fact_delivery_daily?.status, "fresh");
  assert.equal(publication.tables.dim_app?.status, "fresh");
  const session = runtime.sessions.create("analyst");
  runtime.sessions.setActiveJob(session.session_id, "job_vv_native_join");
  for (const table of ["fact_delivery_daily", "dim_app"]) {
    const result = await runtime.tools.readDataContractView(session.session_id, { asset_id: `contract.${table}` });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  const sql = `SELECT f.app_id, d.game_name, SUM(f.discounted_cost_usd) AS cost_usd FROM fact_delivery_daily f JOIN dim_app d ON f.dataset_version = d.dataset_version AND f.app_id = d.app_id WHERE f.dataset_version = '${gold.dataset_version}' AND f.business_date BETWEEN '2026-11-01' AND '2026-11-08' GROUP BY f.app_id, d.game_name`;
  const query = await runtime.tools.query(session.session_id, { sql });
  assert.equal(query.ok, true, JSON.stringify(query));
  const found = runtime.sessions.lookupResource(session.session_id, String(query.resource_id));
  assert.ok(found.ok && found.resource.kind === "query_result");
  const resource: QueryResource = found.resource;
  const verified = verifyJoinResource(resource, runtime.sessions.require(session.session_id), runtime.knowledge, runtime.config, publication);
  assert.ok(verified, JSON.stringify({ query, resource }));
  assert.deepEqual(
    Object.fromEntries(verified.values.map(value => [value.group["fact_delivery_daily.app_id"], value.value])),
    gold.app_costs,
  );
  const delivered = await runtime.tools.updateAnalysis(session.session_id, {
    suggested_status: "completed", draft_answer: "", resource_ids: [resource.resource_id],
  });
  assert.equal(delivered.ok, true, JSON.stringify(delivered));
  const analysis = delivered as unknown as AnalysisRecord;
  assert.equal(analysis.status, "partial", JSON.stringify(analysis.server_reasons));
  assert.equal(analysis.join_results?.[0]?.values.length, Object.keys(gold.app_costs).length);
  assert.ok(analysis.join_results![0]!.values.every(value => value.unit === "USD"));
  assert.ok(!analysis.server_reasons.includes("query_expression_semantics_unverified"));
  for (const name of ["拼格", "落块", "叠叠乐"]) assert.ok(analysis.answer.includes(name), analysis.answer);
  writeFileSync(reportPath, JSON.stringify({
    status: "passed", sql, dataset_version: gold.dataset_version,
    actual_costs: gold.app_costs, analysis_status: analysis.status,
    server_reasons: analysis.server_reasons, verified_groups: verified.values.length,
    evidence_mode: verified.plan.aggregateProof ? "aggregate" : "captured",
    sources: analysis.sources.map(source => ({ resource_id: source.resource_id, execution_id: source.execution_id })),
  }, null, 2) + "\n");
} finally {
  await runtime.close();
}
