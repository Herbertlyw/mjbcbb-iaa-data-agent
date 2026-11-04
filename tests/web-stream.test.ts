import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function page() {
  const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);
  const elements = new Map<string, { hidden: boolean; textContent: string; innerHTML: string; className: string; addEventListener: () => void; append: () => void }>();
  const element = () => ({ hidden: true, textContent: "", innerHTML: "", className: "", addEventListener() {}, append() {} });
  const document = {
    querySelector(selector: string) { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); },
    createElement: element,
  };
  const timers: Array<() => void> = [];
  class MockSource {
    static instances: MockSource[] = [];
    closed = false;
    onerror: (() => void) | undefined;
    onmessage: ((event: { data: string; lastEventId: string }) => void) | undefined;
    constructor(readonly url: string) { MockSource.instances.push(this); }
    close() { this.closed = true; }
    send(seq: number, type: string) { this.onmessage?.({ data: JSON.stringify({ seq, type, payload: {} }), lastEventId: String(seq) }); }
  }
  const context = vm.createContext({ document, EventSource: MockSource, setTimeout: (fn: () => void) => { timers.push(fn); } });
  vm.runInContext(script.replace(/^\s*initialize\(\);\s*$/mu, "") + "\nglobalThis.testApi = { state, listen, renderCalculationTables, displayCell, usageSummary };", context);
  const api = context.testApi as { state: { jobId: string | null; lastSeq: number }; listen: (id: string) => void; renderCalculationTables: (analysis: unknown) => string; displayCell: (value: unknown) => unknown; usageSummary: (value: unknown) => string };
  return { api, timers, sources: MockSource.instances };
}

test("旧任务延迟重连不能关闭新任务的事件流", () => {
  const { api, timers, sources } = page();
  api.state.jobId = "old";
  api.listen("old");
  sources[0]!.onerror?.();
  api.state.jobId = "new";
  api.listen("new");
  timers.forEach((fn) => fn());
  assert.equal(sources.length, 2);
  assert.equal(sources[1]!.closed, false);
  assert.match(sources[1]!.url, /\/new\/events\?after=0$/u);
});

test("预算拒绝与可能已派发次数在页面分别展示，未知用量不写成零", () => {
  const { api } = page();
  const html = api.usageSummary({ usage: { model_attempts: 2, model_calls: 1, provider_not_dispatched: 1, provider_completed: 1, provider_outcome_unknown: 0, input_tokens: 4308, output_tokens: 78, cache_hit_tokens: 0, cache_miss_tokens: null, usage_source: "reported" } });
  assert.match(html, /模型尝试至少 2/); assert.match(html, /可能已派发上限 1/); assert.match(html, /明确未派发 1/);
  assert.match(html, /输入 token：4308/);
  assert.match(html, /缓存命中：0/); assert.match(html, /缓存未命中：未知/);
  const unknown = api.usageSummary({ usage: { model_attempts: 1, model_calls: 0, provider_not_dispatched: 1, provider_completed: 0, provider_outcome_unknown: 0, input_tokens: null, output_tokens: null, usage_source: "not_dispatched" } });
  assert.match(unknown, /输入 token：未知/); assert.doesNotMatch(unknown, /输入 token：0/);
});

test("页面展示经核验的变换、NULL 对齐状态及绑定哈希的续页，并转义显示值", () => {
  const { api } = page();
  const html = api.renderCalculationTables({ resource_hashes: { x: "valid-hash", y: "second-hash" }, transform_results: [{ resource_id: "x", source_resource_id: "source", total_rows: 21, result: { columns: [{ name: "amount", label: "合计", unit: "人" }], rows: [{ amount: "<script>" }] } }], alignment_results: [{ resource_id: "y", total_rows: 2, coverage_incomplete: true, spec: { op: "divide", left: { resource_id: "a" }, right: { resource_id: "b" } }, rows: [{ group: { country_code: null }, status: "partial_nulls", left: { value: "0", unit: "人" }, right: { value: null, unit: "人" }, result: null }] }] });
  assert.match(html, /已核验的结果变换/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
  assert.match(html, /country_code=NULL/); assert.match(html, /部分 NULL/); assert.match(html, /来源覆盖不完整/); assert.match(html, /0 人/);
  assert.match(html, /data-hash="valid-hash"/); assert.match(html, /data-hash="second-hash"/);
  const keys = api.renderCalculationTables({ alignment_results: [{ resource_id: "z", spec: { op: "divide", left: { resource_id: "a" }, right: { resource_id: "b" } }, rows: [{ group: { country_code: null }, status: "matched" }, { group: { country_code: "NULL" }, status: "zero_divisor" }] }] });
  assert.match(keys, /country_code=NULL（空键）/);
  assert.match(keys, /country_code=&quot;NULL&quot;（字符串）/);
  assert.equal(api.displayCell(null), "NULL（空值）");
  assert.equal(api.displayCell("NULL"), '"NULL"（字符串）');
});

test("事件缺号后从最后连续序号续读", () => {
  const { api, timers, sources } = page();
  api.state.jobId = "job";
  api.listen("job");
  sources[0]!.send(1, "job_queued");
  sources[0]!.send(2, "job_started");
  sources[0]!.send(4, "tool_started");
  assert.equal(api.state.lastSeq, 2);
  assert.equal(sources[0]!.closed, true);
  timers.forEach((fn) => fn());
  assert.match(sources[1]!.url, /after=2$/u);
});
