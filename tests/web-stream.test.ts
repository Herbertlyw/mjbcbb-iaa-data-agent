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
  vm.runInContext(script.replace(/^\s*initialize\(\);\s*$/mu, "") + "\nglobalThis.testApi = { state, listen };", context);
  const api = context.testApi as { state: { jobId: string | null; lastSeq: number }; listen: (id: string) => void };
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
