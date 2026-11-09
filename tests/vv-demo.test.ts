// Verify release-bound examples without granting query authority or leaking oracles.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { planClickHouse } from "../src/clickhouse-plan.js";
import { loadKnowledge } from "../src/knowledge.js";
import { loadVvDemo } from "../src/vv-demo.js";

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "vv-catalog-"));
  const release = { dataset_version: "sv_00000000000000000000", start_date: "2026-10-26", as_of: "2026-11-08", timezone: "UTC" };
  const catalog = { schema_version: 1, application: "VV Data Agent", release,
    categories: [{ id: "acquisition", label: "获客" }],
    questions: [{ id: "acquisition-daily", category: "acquisition", label: "新增与重装", text: "查询合成安装",
      scope: "UTC · 2026-11-01–2026-11-07", note: "安装事件不等于设备" }],
    expected_business: { hidden: "must not be returned" },
  };
  writeFileSync(path.join(directory, "release.json"), JSON.stringify(release));
  const save = () => writeFileSync(path.join(directory, "demo-catalog.json"), JSON.stringify(catalog));
  save();
  return { directory, catalog, save, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test("VV问题绑定数据截止，不随电脑日期漂移，服务端只返回公开问题字段", async () => {
  const value = fixture();
  try {
    const result = await loadVvDemo(value.directory);
    assert.equal(result.release_state, "bound");
    assert.equal(result.release?.as_of, "2026-11-08");
    assert.equal(result.questions[0]?.scope, "UTC · 2026-11-01–2026-11-07");
    assert.doesNotMatch(JSON.stringify(result), /expected_business|must not be returned|fresh/);
  } finally { value.close(); }
});

test("未绑定和发布不一致时不展示虚构的最近日期或旧问题", async () => {
  const value = fixture();
  try {
    value.catalog.release.as_of = "2026-11-09";
    value.save();
    assert.equal((await loadVvDemo(value.directory)).release_state, "invalid");
    assert.deepEqual((await loadVvDemo(value.directory)).questions, []);
    writeFileSync(path.join(value.directory, "demo-catalog.json"), JSON.stringify({ schema_version: 1, application: "VV Data Agent", release: null }));
    assert.equal((await loadVvDemo(value.directory)).release_state, "unbound");
    rmSync(path.join(value.directory, "demo-catalog.json"));
    assert.equal((await loadVvDemo(value.directory)).release_state, "unbound");
  } finally { value.close(); }
});

test("目录拒绝非法日期、重复问题、未知分类、超长内容和符号链接", async () => {
  const value = fixture();
  try {
    for (const mutation of [
      () => { value.catalog.release.start_date = "2026-02-30"; },
      () => { value.catalog.questions.push({ ...value.catalog.questions[0]! }); },
      () => { value.catalog.questions[0]!.category = "other"; },
      () => { value.catalog.questions[0]!.text = "x".repeat(2001); },
    ]) {
      const previous = JSON.stringify(value.catalog);
      mutation(); value.save();
      assert.equal((await loadVvDemo(value.directory)).release_state, "invalid");
      Object.assign(value.catalog, JSON.parse(previous));
    }
    const target = path.join(value.directory, "demo-catalog.json");
    rmSync(target);
    symlinkSync(path.join(value.directory, "release.json"), target);
    assert.equal((await loadVvDemo(value.directory)).release_state, "invalid");
  } finally { value.close(); }
});

test("22条VV业务SQL全部经过原生ClickHouse授权入口，非加性字段仍不自动认证", () => {
  const knowledge = loadKnowledge("knowledge/starhaven");
  const document = knowledge.by_id.get("starhaven.business")!.body;
  const queries = [...document.matchAll(/```sql\n([\s\S]*?)\n```/gu)].map(match => match[1]!.replaceAll("DATASET_VERSION", "sv_00000000000000000000"));
  assert.equal(queries.length, 22);
  for (const sql of queries) {
    const names = [...sql.matchAll(/(?:FROM|JOIN)\s+([a-z_]+)/gu)].map(match => match[1]!);
    const contracts = [...new Set(names)].map(name => knowledge.contract_by_table.get(name)!.contract!);
    const plan = planClickHouse(sql, contracts.map(contract => ({ table: contract.table,
      allowed_columns: contract.columns.map(column => column.name), sensitive_columns: contract.sensitive_columns,
      must_filter: contract.must_filter, column_types: Object.fromEntries(contract.columns.map(column => [column.name, column.type])) })),
    contracts, knowledge.joins, "starhaven_validation", 1000);
    assert.ok(plan.receipt, sql);
  }
  assert.ok(!knowledge.contract_by_table.get("fact_cohort_quality_daily")!.contract!.series!.metrics.includes("cohort_size_devices"));
  assert.ok(!queries.some(sql => sql.includes("fact_roi_forecast_snapshot")));
});

test("场景分类筛选保留原问题顺序和正文，不改变当前会话条件", () => {
  const source = readFileSync(new URL("../src/web/examples.js", import.meta.url), "utf8");
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports });
  const select = exports.selectExamples as (items: Array<{ category: string; text: string }>, category: string | null) => unknown[];
  const items = [{ category: "value", text: "NULL 保持未知" }, { category: "acquisition", text: "沿用上题日本" }, { category: "value", text: "ROI7 = 日龄0–6" }];
  assert.deepEqual(select(items, "value").map(item => (item as { text: string }).text), [items[0]!.text, items[2]!.text]);
  assert.equal(select(items, null), items);
  const describe = exports.releaseDescription as (value: unknown) => string;
  assert.match(describe({ release: { start_date: "2026-10-26", as_of: "2026-11-08", timezone: "UTC" } }), /不代表所有 cohort 已成熟/u);
  assert.match(describe({ release_state: "invalid" }), /不一致/u);
  assert.match(describe({ release: null }), /尚未绑定/u);
});
