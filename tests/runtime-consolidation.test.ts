import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import type { ClickHouseClient } from "@clickhouse/client";
import { loadKnowledge } from "../src/knowledge.js";
import { ToolService } from "../src/tools.js";
import { queryCellInput } from "../src/query-cell-input.js";
import type { QueryResource } from "../src/types.js";
import { analyst, withRuntime } from "./helpers.js";

test("禁用旧解析器后工具查询、完整计算、递归交付与回执拒绝贯通（假数据库客户端）", async () => {
  await withRuntime({}, async runtime => {
    const knowledge = loadKnowledge("knowledge/harborlight");
    const fact = knowledge.contract_by_table.get("fact_fox_daily_install")!.contract!;
    const rows = [100, 0, 120].map((new_users, index) => ({ event_date: `2026-10-0${index + 6}`, title_id: "paper_lantern", platform: "ios", country_code: "US", channel_id: "mist_ads", new_users }));
    const calls: string[] = [];
    // This checks the application's boundary and persisted evidence only.
    // SQL execution itself still requires the real isolated ClickHouse suite.
    const client = { query: async ({ query }: { query: string }) => {
      calls.push(query);
      if (query.startsWith("DESCRIBE TABLE")) return { json: async () => fact.columns.map(column => ({ name: column.name, type: column.type })) };
      const names = query.startsWith("EXPLAIN PLAN") ? ["explain"] : query.startsWith("SELECT event_date, title_id") ? Object.keys(rows[0]!) : ["event_date", "new_users"];
      const types = names.map(name => name === "explain" ? "String" : fact.columns.find(column => column.name === name)!.type);
      const data = names[0] === "explain" ? [["Expression"]] : rows.map(row => names.map(name => row[name as keyof typeof row]));
      return { query_id: `fake_execution_${calls.length}`, stream: async function* () { yield [names, types, ...data].map(line => ({ json: () => line })); }, close: () => {} };
    } } as unknown as ClickHouseClient;
    const publication = JSON.parse(readFileSync(runtime.config.freshnessPath, "utf8"));
    publication.tables = { [fact.table]: { status: "fresh", as_of: "2026-10-13T00:00:00Z" } };
    writeFileSync(runtime.config.freshnessPath, JSON.stringify(publication));
    const tools = new ToolService({ config: { ...runtime.config, businessEngine: "clickhouse", clickhouseDatabase: "synthetic", freshnessTargetsPath: "knowledge/harborlight/freshness-targets.json" }, knowledge, db: runtime.db, sessions: runtime.sessions, businessEngine: "clickhouse", clickhouse: client });
    const session = analyst(runtime);
    assert.equal((await tools.readDataContractView(session.session_id, { asset_id: fact.asset_id })).ok, true);
    runtime.sessions.setActiveJob(session.session_id, "job_native_consolidation");
    const { Parser } = createRequire(import.meta.url)("node-sql-parser") as { Parser: { prototype: { astify: (...args: unknown[]) => unknown } } };
    const prior = Parser.prototype.astify;
    let legacyCalls = 0;
    Parser.prototype.astify = () => { legacyCalls++; throw new Error("legacy_parser_forbidden"); };
    try {
      const sql = "SELECT event_date, new_users FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-08' AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'US' AND channel_id = 'mist_ads'";
      const queried = await tools.query(session.session_id, { sql });
      assert.equal(queried.ok, true, JSON.stringify(queried));
      const queryId = String(queried.resource_id);
      const calc = await tools.calculateSessionCells(session.session_id, { resource_id: queryId, operations: [{ op: "sum", column: "new_users", as: "total" }] });
      assert.equal(calc.ok, true, JSON.stringify(calc));
      assert.deepEqual(calc.cells, { total: 220 });
      const transformed = await tools.calculateSessionCells(session.session_id, { transform: { resource_id: String(calc.resource_id), steps: [{ op: "sort", keys: [{ column: "total", direction: "asc", nulls: "last" }] }] } });
      assert.equal(transformed.ok, true, JSON.stringify(transformed));
      const final = await tools.calculateSessionCells(session.session_id, { resource_id: String(transformed.resource_id), operations: [{ op: "sum", column: "total", as: "again" }] });
      assert.equal(final.ok, true, JSON.stringify(final));
      assert.deepEqual(final.cells, { again: "220" });
      const answer = await tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(final.resource_id)] });
      assert.equal(answer.ok, true, JSON.stringify(answer));
      assert.match(String(answer.answer), /220/);
      assert.equal(legacyCalls, 0);
      const count = calls.length;
      assert.equal((await tools.query(session.session_id, { sql: sql.replace("event_date, new_users", "event_date, device_token") })).ok, false);
      assert.equal(calls.length, count, "越权语句不能到数据库");
      const saved = runtime.sessions.lookupResource(session.session_id, queryId);
      assert.ok(saved.ok && saved.resource.kind === "query_result");
      if (!saved.ok || saved.resource.kind !== "query_result") throw new Error("missing query fixture");
      assert.ok(saved.resource.review_plan);
      runtime.sessions.saveResource({ ...saved.resource, review_plan: { ...saved.resource.review_plan!, sql_hash: "tampered" } });
      assert.equal((await tools.calculateSessionCells(session.session_id, { resource_id: queryId, operations: [{ op: "sum", column: "new_users", as: "total" }] })).ok, false);
      assert.equal(legacyCalls, 0);
    } finally { Parser.prototype.astify = prior; }
  });
});

test("查询输入适配保留金额精度边界与 Float 来源", () => {
  const source = { columns: ["value"], column_types: { value: "Decimal(20, 2)" }, rows: [{ value: "90071992547409.91" }] } as unknown as QueryResource;
  assert.equal(queryCellInput(source)?.rows[0]?.value, "90071992547409.91");
  assert.equal(queryCellInput({ ...source, rows: [{ value: 1.25 }] }), null, "已经转浮点的 Decimal 不能恢复精确性");
  const float = queryCellInput({ ...source, column_types: { value: "Float64" }, rows: [{ value: 100 }] });
  assert.equal(float?.columns[0]?.approximate, true, "恰好是整数的 Float 仍保留来源精度");
  assert.equal(queryCellInput({ ...source, column_types: { value: "Float64" }, rows: [{ value: 1e-7 }] })?.rows[0]?.value, "0.0000001");
});
