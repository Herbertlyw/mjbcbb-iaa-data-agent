// Explicit VV native integration: Python owns the DB; this runner owns API and script HTTP.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { clickHouseQuery } from "../src/clickhouse-client.js";
import { normalizeDecimal } from "../src/decimal-kernel.js";
import { probeClickHouseAndPublish } from "../src/freshness.js";
import { createRuntime } from "../src/runtime.js";
import { startServer } from "../src/server.js";
import type { AnalysisRecord, QueryResource } from "../src/types.js";
import { startBusinessFake, type BusinessScript } from "./vv-business-fake.js";
import { businessCalculations, businessPreparations, type BusinessInput } from "./vv-business-calculations.js";

const [credentialsPath, knowledgeDir, goldPath, workDir, reportPath, mode] = process.argv.slice(2);
assert.ok(credentialsPath && knowledgeDir && goldPath && workDir && reportPath);
const credentials = JSON.parse(readFileSync(credentialsPath, "utf8")) as {
  url: string; database: string; username: string; password: string; dataset_version: string;
};
const gold = JSON.parse(readFileSync(goldPath, "utf8")) as { dataset_version: string;
  scenarios: Array<BusinessScript & { queries: Array<BusinessScript["queries"][number] & {
    query_id: string; groups: string[]; expected_rows: Array<Record<string, unknown>>;
  }>; expected_business: unknown }> };
const questions = JSON.parse(readFileSync(path.join(knowledgeDir, "demo-catalog.json"), "utf8")) as { questions: Array<{ id: string; text: string }> };
const scripts = gold.scenarios.map(item => ({ id: item.id,
  text: questions.questions.find(question => question.id === item.id)!.text, recipe: item.recipe,
  queries: item.queries.map(({ sql, table, join_dimension }) => ({ sql, table, join_dimension })),
}));
assert.equal(credentials.dataset_version, gold.dataset_version);
mkdirSync(workDir, { recursive: true });
const fake = await startBusinessFake(scripts);
const runtime = createRuntime({ knowledgeDir, businessEngine: "clickhouse", stateMode: "sqlite", startWorker: false,
  databasePath: path.join(workDir, "business.sqlite"), stateDatabasePath: path.join(workDir, "state.sqlite"),
  freshnessPath: path.join(workDir, "freshness.json"), freshnessTargetsPath: path.join(knowledgeDir, "freshness-targets.json"),
  publishFreshnessOnStart: false, modelMode: "pi", piProvider: "openai-compatible", protocolScript: "vv-business-recipes",
  piBaseUrl: fake.url, piApiKey: "fictional-vv-protocol", piModel: "vv-script", piContextWindow: 128_000,
  piMaxOutputTokens: 2048, maxKnownTokens: 1_000_000, maxModelCalls: 16, maxToolCalls: 40,
  jobTimeoutMs: 120_000, simulatedToday: "2026-11-08", ephemeralDir: undefined,
  clickhouseUrl: credentials.url, clickhouseUser: credentials.username, clickhousePassword: credentials.password,
  clickhouseDatabase: credentials.database, clickhouseLockedReadonly: true, clickhouseMaxRowsToRead: 5_000_000,
  queryTimeoutMs: 3000, maxResultRows: 10_000, maxResultBytes: 2_000_000,
});
const server = startServer(runtime);
try {
  assert.ok(runtime.clickhouse);
  await probeClickHouseAndPublish({ targetsPath: runtime.config.freshnessTargetsPath,
    destinationPath: runtime.config.freshnessPath, simulatedToday: "2026-11-08",
    query: sql => clickHouseQuery(runtime.clickhouse!, sql) as Promise<Array<{ event_date: string }>> });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const demo = await fetch(`${url}/api/demo`).then(response => response.json()) as { questions: unknown[]; release_state: string };
  assert.equal(demo.release_state, "bound");
  assert.equal(demo.questions.length, 18);
  const results: Array<Record<string, unknown>> = [];
  let verifiedArithmetic = 0;
  for (const sample of gold.scenarios) {
    const session = runtime.sessions.create("analyst");
    runtime.sessions.setActiveJob(session.session_id, `job_vv_${sample.id}`);
    const resources: QueryResource[] = [];
    for (const query of sample.queries) {
      for (const table of [query.table, ...(query.join_dimension ? [query.join_dimension] : [])]) {
        const binding = await runtime.tools.readDataContractView(session.session_id, { asset_id: `contract.${table}` });
        assert.equal(binding.ok, true, JSON.stringify(binding));
      }
      const result = await runtime.tools.query(session.session_id, { sql: query.sql });
      assert.equal(result.ok, true, `${sample.id}/${query.query_id}: ${JSON.stringify(result)}`);
      const lookup = runtime.sessions.lookupResource(session.session_id, String(result.resource_id));
      assert.ok(lookup.ok && lookup.resource.kind === "query_result");
      const saved = lookup.resource;
      assert.equal(saved.truncated, false);
      assert.equal(saved.sql, query.sql);
      assert.ok(saved.execution_id);
      assert.equal(saved.job_id, `job_vv_${sample.id}`);
      assert.deepEqual(canonicalRows(saved.rows), canonicalRows(query.expected_rows), `${sample.id}/${query.query_id}`);
      resources.push(saved);
    }
    if (resources.length) {
      const inputs = resources.map(resource => ({
        resource_id: resource.resource_id, execution_id: resource.execution_id!, rows: resource.rows,
      }));
      const computedIds: string[] = [];
      const prepared: BusinessInput[] = [];
      for (const params of businessPreparations(sample.recipe, inputs)) {
        const computed = await runtime.tools.calculateFromProtocol(session.session_id, params);
        assert.equal(computed.ok, true, `${sample.id}/prepare: ${JSON.stringify(computed)}`);
        const found = runtime.sessions.lookupResource(session.session_id, String(computed.resource_id));
        assert.ok(found.ok && found.resource.kind === "transform");
        prepared.push({ resource_id: found.resource.resource_id, execution_id: found.resource.execution_id!, rows: found.resource.result.rows });
        computedIds.push(found.resource.resource_id);
      }
      const calculations = businessCalculations(sample.recipe, inputs, prepared);
      for (const calculation of calculations) {
        const computed = await runtime.tools.calculateFromProtocol(session.session_id, calculation.params);
        assert.equal(computed.ok, true, `${sample.id}/${calculation.metric}: ${JSON.stringify(computed)}`);
        const reference = runtime.sessions.lookupResource(session.session_id, String(computed.resource_id));
        assert.ok(reference.ok && reference.resource.kind === "arithmetic");
        const value = reference.resource.result.value;
        const expectedRows = sample.expected_business;
        const expected = Array.isArray(expectedRows)
          ? expectedRows.find((row: Record<string, unknown>) => sample.queries[0]!.groups.every(key => row[key] === resources[0]!.rows[calculation.row]![key]))
          : expectedRows;
        assert.ok(expected && typeof expected === "object");
        const expectedValue = (expected as Record<string, unknown>)[calculation.metric];
        assert.equal(roundedRatio(value, calculation.factor), expectedValue, `${sample.id}/${calculation.metric}/${calculation.row}`);
        computedIds.push(reference.resource.resource_id);
        verifiedArithmetic++;
      }
      const delivery = await runtime.tools.updateAnalysis(session.session_id, {
        suggested_status: "completed", draft_answer: "", resource_ids: [...resources.map(resource => resource.resource_id), ...computedIds],
      });
      assert.equal(delivery.ok, true, `${sample.id}: ${JSON.stringify(delivery)}`);
      const analysis = delivery as unknown as AnalysisRecord;
      assert.equal(analysis.sources.length, resources.length);
      results.push({ id: sample.id, sql_gold_equal: true, query_count: resources.length,
        formal_status: analysis.status, arithmetic_count: computedIds.length, server_reasons: analysis.server_reasons,
        sources: analysis.sources.map(source => ({ resource_id: source.resource_id, execution_id: source.execution_id })),
        expected_business: sample.expected_business });
    }
  }
  runtime.jobs.start();
  const protocol: Array<Record<string, unknown>> = [];
  let channelSession: string | null = null;
  for (const sample of scripts) {
    const created: { session_id: string } = sample.id === "acquisition-followup" && channelSession
      ? { session_id: channelSession }
      : await fetch(`${url}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(response => response.json()) as { session_id: string };
    if (sample.id === "acquisition-channel") channelSession = created.session_id;
    const response: Response = await fetch(`${url}/api/sessions/${created.session_id}/messages`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ text: sample.text, idempotency_key: sample.id }) });
    assert.equal(response.status, 202);
    const submitted = await response.json() as { job_id: string };
    const deadline = Date.now() + 120_000;
    let job = runtime.state.getJob(submitted.job_id)!;
    while (job.status === "running" || job.status === "queued") {
      assert.ok(Date.now() < deadline, sample.id);
      await delay(30);
      job = runtime.state.getJob(submitted.job_id)!;
    }
    assert.ok(["completed", "partial", "needs_clarification"].includes(job.status), `${sample.id}: ${JSON.stringify({ error: job.error, events: job.events })}`);
    if (sample.id === "revenue-clarify") assert.equal(job.status, "needs_clarification");
    else assert.ok(job.analysis?.sources.length);
    assert.equal(job.events.filter(event => ["job_finished", "job_failed", "job_cancelled"].includes(event.type)).length, 1);
    protocol.push({ id: sample.id, job_id: job.job_id, status: job.status,
      sources: job.analysis?.sources.map(source => ({ resource_id: source.resource_id, execution_id: source.execution_id })),
      server_reasons: job.analysis?.server_reasons });
  }
  writeFileSync(reportPath, JSON.stringify({ status: "passed", dataset_version: gold.dataset_version,
    scenario_count: scripts.length, query_count: results.reduce((total, item) => total + Number(item.query_count), 0),
    arithmetic_count: verifiedArithmetic, direct_tools: results, pi_script_protocol: protocol, external_model_requests: 0,
    scope: "Owned native ClickHouse HTTP + API/Pi local recipe script + SQLite state; not MySQL/Redis or model generalisation",
  }, null, 2) + "\n");
  if (mode === "browser") {
    console.log(`VV_BROWSER_URL=${url}`);
    console.log(`VV_BROWSER_STOP=${path.join(workDir, "stop-browser")}`);
    while (!existsSync(path.join(workDir, "stop-browser"))) await delay(250);
  }
} finally {
  await runtime.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await fake.close();
}

function canonicalRows(rows: Array<Record<string, unknown>>): string[] {
  return rows.map(row => JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) =>
    [name, typeof value === "number" || typeof value === "string" && /^-?\d+(?:\.\d+)?$/u.test(value)
      ? normalizeDecimal(String(value)) : value])))).sort();
}

function roundedRatio(value: string | null, factor: number): string | null {
  if (value === null) return null;
  const match = /^(-?)(\d+)\.(\d{18})$/u.exec(value);
  assert.ok(match, value);
  const scaled = BigInt(match[2]! + match[3]!) * BigInt(factor);
  const divisor = 10n ** 12n;
  const rounded = scaled / divisor + (scaled % divisor >= divisor / 2n ? 1n : 0n);
  return `${match[1]}${rounded / 1_000_000n}.${String(rounded % 1_000_000n).padStart(6, "0")}`;
}
