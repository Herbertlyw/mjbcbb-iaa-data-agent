import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setImmediate as tick } from "node:timers/promises";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

function source(name: string): string {
  return ts.transpileModule(readFileSync(new URL(`../src/web/${name}.js`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
}

interface Item { session_id?: string; job_id?: string; title?: string; status?: string }
interface Page { items: Item[]; next_cursor: string | null; has_more: boolean }
interface Pager {
  state: Page & { phase: string; error: string };
  reset(scope: string): void;
  load(options?: { refresh: boolean }): Promise<boolean>;
  upsert(item: Item): void;
}
type PagerFactory = (options: { fetchPage(scope: string, cursor: string | null): Promise<Page>; key: string; onChange(): void }) => Pager;
function pagerFactory(): PagerFactory {
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(source("history"), { exports });
  return exports.createHistoryPager as PagerFactory;
}

test("历史翻页失败保留已有页和游标，可重试；切换范围后旧响应和旧失败均失效", async () => {
  const pending: Array<{ scope: string; cursor: string | null; resolve(page: Page): void; reject(error: Error): void }> = [];
  const pager = pagerFactory()({ key: "session_id", onChange() {}, fetchPage: (scope, cursor) => new Promise((resolve, reject) => pending.push({ scope, cursor, resolve, reject })) });
  pager.reset("A");
  const initial = pager.load();
  pending[0]!.resolve({ items: [{ session_id: "1" }], next_cursor: "next", has_more: true });
  assert.equal(await initial, true);
  const failed = pager.load(); pending[1]!.reject(new Error("offline")); assert.equal(await failed, false);
  assert.equal(pager.state.items.length, 1); assert.equal(pager.state.next_cursor, "next");
  const retry = pager.load();
  assert.equal(pending[2]!.cursor, "next");
  pending[2]!.resolve({ items: [{ session_id: "1" }, { session_id: "2" }], next_cursor: null, has_more: false });
  await retry; assert.equal(pager.state.items.length, 2);
  const late = pager.load({ refresh: true });
  pager.reset("B"); const current = pager.load();
  pending[4]!.resolve({ items: [{ session_id: "B" }], next_cursor: null, has_more: false }); await current;
  pending[3]!.reject(new Error("late A")); await late;
  assert.equal(pager.state.phase, "ready"); assert.equal(pager.state.items[0]?.session_id, "B");
  const older = pager.load({ refresh: true });
  pager.reset("C"); const latest = pager.load();
  pending[6]!.resolve({ items: [{ session_id: "C" }], next_cursor: null, has_more: false }); await latest;
  pending[5]!.resolve({ items: [{ session_id: "late B" }], next_cursor: "wrong", has_more: true }); await older;
  assert.equal(pager.state.items[0]?.session_id, "C"); assert.equal(pager.state.next_cursor, null);
});

class Element {
  textContent = ""; innerHTML = ""; value = ""; title = ""; className = "";
  disabled = false; hidden = false; children: Element[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<(event: { preventDefault(): void; key?: string }) => unknown>>();
  readonly classList = { toggle() {} };
  constructor(readonly id = "") {}
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name); }
  addEventListener(name: string, callback: (event: { preventDefault(): void; key?: string }) => unknown) {
    const list = this.listeners.get(name) ?? []; list.push(callback); this.listeners.set(name, list);
  }
  replaceChildren(...children: Element[]) { this.children = children; this.innerHTML = ""; }
  append(child: Element) { this.children.push(child); if (["#model", "#reasoning"].includes(this.id) && !this.value) this.value = child.value; }
  querySelectorAll() { return []; }
  focus() {}
  async click() { for (const callback of this.listeners.get("click") ?? []) await callback({ preventDefault() {} }); }
  async submit() { for (const callback of this.listeners.get("submit") ?? []) await callback({ preventDefault() {} }); }
}

interface Job { job_id: string; session_id: string; user_text: string; status: string; events: object[]; created_at: string }
type Reply = { status?: number; body: unknown };
const empty = { has_more: false, next_cursor: null };
const session = (id: string) => ({ session_id: id, title: id, created_at: "2026-11-09T00:00:00.000Z", active_job_id: null });
const job = (id: string, sessionId: string, status = "completed"): Job => ({ job_id: id, session_id: sessionId, user_text: id, status, events: [], created_at: "2026-11-09T00:00:00.000Z" });

function browser(handler: (url: URL, method: string) => Reply | Promise<Reply>, saved?: string, storage = new Map<string,string>()) {
  const elements = new Map<string, Element>();
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id)!; };
  const historyExports: Record<string, unknown> = {};
  vm.runInNewContext(source("history"), { exports: historyExports });
  const requests: Array<{ url: URL; method: string; body?: string }> = [];
  let terminal: ((id: string) => Promise<void>) | undefined;
  const streamStarts:string[] = [];
  const context = {
    exports: {}, URLSearchParams, Headers, Error, TypeError, console, setTimeout, clearTimeout,
    crypto: { randomUUID }, EventSource: class {},
    sessionStorage: { getItem: (key:string) => storage.get(key) ?? (key === "lumenfox-session" ? saved : null), setItem: (key:string,value:string) => storage.set(key,value), removeItem:(key:string)=>storage.delete(key) }, window: { addEventListener() {} },
    document: {
      title: "", createElement: () => new Element(),
      querySelector: (id: string) => id === "#retry" ? null : get(id),
      querySelectorAll: (selector: string) => selector.includes("#sessions button") ? [...get("#sessions").children, ...get("#history").children] : [],
    },
    fetch: async (url: string, options?: { method?: string; body?: string }) => {
      const parsed = new URL(url, "http://127.0.0.1"); const method = options?.method ?? "GET";
      requests.push({ url: parsed, method, body:options?.body });
      let reply: Reply;
      if (parsed.pathname === "/api/demo") reply = { body: { scenario: "VV Data Agent", title: "VV Data Agent", placeholder: "默认输入", questions: [] } };
      else if (parsed.pathname === "/api/health") reply = { body: { model_mode: "deterministic", model_catalog: { models: [{ id: "synthetic", reasoning: ["off"] }] } } };
      else reply = await handler(parsed, method);
      return { ok: (reply.status ?? 200) < 400, status: reply.status ?? 200, json: async () => reply.body };
    },
    require: (name: string) => {
      if (name === "./history.js") return historyExports;
      if (name === "./view.js") return { labels: { completed: "完成", queued: "排队" }, renderJob: (value: Job) => `result:${value.job_id}`, escapeHtml: String, displayCell: String, alignmentRowHtml() {}, updatePaginationCount() {} };
      if (name === "./stream.js") return { createJobStream: (options: { onTerminal(id: string): Promise<void> }) => { terminal = options.onTerminal; return { start(id:string) {streamStarts.push(id);}, stop() {} }; } };
      if (name === "./examples.js") return { mountExamples() {}, releaseDescription: () => "合成范围" };
      throw new Error(name);
    },
  };
  vm.runInNewContext(source("app"), context);
  return { get, requests, streamStarts, terminal: (id: string) => terminal!(id) };
}

async function flush() { for (let n = 0; n < 15; n++) await tick(); }

test("响应丢失后刷新不自动重发，手动继续沿用同一完整提交键，新分析使用新键", async () => {
  const storage = new Map<string,string>(); let lost = true;
  const handler = (url:URL, method:string):Reply => {
    if (url.pathname === "/api/sessions" && method === "GET") return {body:{sessions:[session("s")],...empty}};
    if (url.pathname === "/api/sessions" && method === "POST") return {body:session("s")};
    if (url.pathname === "/api/sessions/s") return {body:session("s")};
    if (url.pathname === "/api/sessions/s/jobs") return {body:{jobs:[],active_job_id:null,...empty}};
    if (url.pathname === "/api/sessions/s/messages") { if (lost) {lost=false; throw new TypeError("synthetic_connection_lost");} return {body:job("accepted","s")}; }
    if (url.pathname === "/api/jobs/accepted") return {body:job("accepted","s")};
    throw new Error(`unexpected ${url}`);
  };
  const first=browser(handler,undefined,storage); await flush();
  first.get("#question").value="合成待确认问题"; await first.get("#composer").submit(); await flush();
  const sent=first.requests.filter(r=>r.url.pathname.endsWith("/messages")); assert.equal(sent.length,1);
  assert.equal(first.get("#pending-submission").hidden,false); assert.ok(storage.has("vv-pending-submission"));
  const reloaded=browser(handler,undefined,storage); await flush();
  assert.equal(reloaded.requests.filter(r=>r.method==="POST" && r.url.pathname.endsWith("/messages")).length,0);
  assert.equal(reloaded.get("#pending-submission").hidden,false);
  await reloaded.get("#pending-resume").click(); await flush();
  const retried=reloaded.requests.filter(r=>r.method==="POST" && r.url.pathname.endsWith("/messages")); assert.equal(retried.length,1);
  assert.equal(retried[0]?.body,sent[0]?.body); assert.equal(storage.has("vv-pending-submission"),false);
  assert.deepEqual(reloaded.streamStarts, [], "恢复已终态任务不得启动空事件流并无限重连");
  reloaded.get("#question").value="合成待确认问题"; await reloaded.get("#composer").submit(); await flush();
  const all=reloaded.requests.filter(r=>r.method==="POST" && r.url.pathname.endsWith("/messages")); assert.equal(all.length,2);
  assert.notEqual(JSON.parse(all[1]!.body!).idempotency_key,JSON.parse(sent[0]!.body!).idempotency_key);
});

test("继续待确认提交时切换会话，迟到成功不能覆盖新会话", async () => {
  const storage=new Map<string,string>([["vv-pending-submission",JSON.stringify({identity:"local_mock",sessionId:"A",body:{text:"合成",idempotency_key:"old-key",model_id:"synthetic",reasoning:"off"}})]]);
  let resolveOld:((value:Reply)=>void)|undefined;
  const app=browser((url,method)=>{
    if(url.pathname==="/api/sessions")return {body:{sessions:[session("A"),session("B")],...empty}};
    if(url.pathname==="/api/sessions/A"||url.pathname==="/api/sessions/B")return {body:session(url.pathname.endsWith("A")?"A":"B")};
    if(url.pathname==="/api/sessions/A/jobs")return {body:{jobs:[],active_job_id:null,...empty}};
    if(url.pathname==="/api/sessions/B/jobs")return {body:{jobs:[{...job("job-B","B"),user_text_preview:"B"}],active_job_id:null,...empty}};
    if(url.pathname==="/api/jobs/job-B")return {body:job("job-B","B")};
    if(url.pathname==="/api/sessions/A/messages"&&method==="POST")return new Promise<Reply>(resolve=>{resolveOld=resolve});
    throw new Error(`unexpected ${url}`);
  },"A",storage);
  await flush(); const resuming=app.get("#pending-resume").click(); await flush(); assert.ok(resolveOld);
  const b=app.get("#sessions").children.find(item=>item.textContent.includes("B")); assert.ok(b); await b.click(); await flush();
  assert.equal(app.get("#result").innerHTML,"result:job-B");
  resolveOld!({body:job("job-A","A")}); await resuming; await flush();
  assert.equal(app.get("#result").innerHTML,"result:job-B"); assert.equal(storage.has("vv-pending-submission"),false);
});

test("历史首次 500 不禁用提问；创建/发送成功后刷新失败不重复 POST，也不干扰终态", async () => {
  let healthy = false;
  const app = browser((url, method) => {
    if (url.pathname === "/api/sessions" && method === "GET") return healthy ? { body: { sessions: [session("s")], ...empty } } : { status: 500, body: { error: { message: "synthetic history unavailable" } } };
    if (url.pathname === "/api/sessions" && method === "POST") return { body: session("s") };
    if (url.pathname === "/api/sessions/s/messages") return { body: job("j", "s", "queued") };
    if (url.pathname === "/api/jobs/j") return { body: job("j", "s") };
    throw new Error(`unexpected ${url}`);
  });
  await flush();
  assert.equal(app.get("#ask").disabled, false);
  assert.equal(app.get("#new-session").disabled, false);
  assert.equal(app.get("#sessions-retry").hidden, false);
  await app.get("#new-session").click(); await flush();
  app.get("#question").value = "synthetic question";
  await app.get("#composer").submit(); await flush();
  assert.equal(app.requests.filter(item => item.method === "POST" && item.url.pathname === "/api/sessions").length, 1);
  assert.equal(app.requests.filter(item => item.method === "POST" && item.url.pathname.endsWith("/messages")).length, 1);
  assert.equal(app.get("#result").innerHTML, "result:j");
  await app.terminal("j"); await flush();
  assert.equal(app.get("#ask").disabled, false);
  healthy = true;
  await app.get("#sessions-retry").click(); await flush();
  assert.equal(app.get("#sessions-retry").hidden, true);
  assert.equal(app.get("#sessions").children.length, 1);
});

test("保存的会话在首屏之外仍通过元数据恢复，问题列表只读一页和选中详情", async () => {
  const app = browser(url => {
    if (url.pathname === "/api/sessions") return { body: { sessions: [session("new")], has_more: true, next_cursor: "next" } };
    if (url.pathname === "/api/sessions/saved") return { body: session("saved") };
    if (url.pathname === "/api/sessions/saved/jobs") return { body: { jobs: [{ ...job("old", "saved"), user_text_preview: "old" }], ...empty, active_job_id: null } };
    if (url.pathname === "/api/jobs/old") return { body: job("old", "saved") };
    throw new Error(`unexpected ${url}`);
  }, "saved");
  await flush();
  assert.equal(app.get("#result").innerHTML, "result:old");
  assert.equal(app.requests.filter(item => item.url.pathname === "/api/sessions").length, 1);
  assert.equal(app.requests.filter(item => item.url.pathname.endsWith("/jobs")).length, 1);
  assert.equal(app.requests.filter(item => item.url.pathname.startsWith("/api/jobs/")).length, 1);
});

test("问题摘要页失败不阻止读取已知活动任务的详情和取消入口", async () => {
  const app = browser(url => {
    if (url.pathname === "/api/sessions") return { body: { sessions: [session("s")], ...empty } };
    if (url.pathname === "/api/sessions/s") return { body: { ...session("s"), active_job_id: "active" } };
    if (url.pathname.endsWith("/jobs")) return { status: 503, body: { error: { message: "synthetic summary unavailable" } } };
    if (url.pathname === "/api/jobs/active") return { body: job("active", "s", "running") };
    throw new Error(`unexpected ${url}`);
  });
  await flush();
  assert.equal(app.get("#result").innerHTML, "result:active");
  assert.equal(app.get("#cancel").hidden, false);
  assert.equal(app.get("#history-retry").hidden, false);
});

test("选中旧任务详情失败后独立重试，成功时清除旧错误提示", async () => {
  let attempts = 0;
  const app = browser(url => {
    if (url.pathname === "/api/sessions") return { body: { sessions: [session("s")], ...empty } };
    if (url.pathname === "/api/sessions/s") return { body: session("s") };
    if (url.pathname.endsWith("/jobs")) return { body: { jobs: ["latest", "old"].map(id => ({ ...job(id, "s"), user_text_preview: id })), ...empty, active_job_id: null } };
    if (url.pathname === "/api/jobs/latest") return { body: job("latest", "s") };
    if (url.pathname === "/api/jobs/old") return ++attempts === 1 ? { status: 503, body: { error: { message: "synthetic detail unavailable" } } } : { body: job("old", "s") };
    throw new Error(`unexpected ${url}`);
  });
  await flush();
  await app.get("#history").children[1]!.click(); await flush();
  assert.equal(app.get("#connection-notice").hidden, false);
  await app.get("#detail-retry").click(); await flush();
  assert.equal(app.get("#result").innerHTML, "result:old");
  assert.equal(app.get("#connection-notice").hidden, true);
  assert.equal(attempts, 2);
});

test("会话切换时旧元数据迟到不覆盖新会话；旧历史页不清除当前运行任务", async () => {
  let releaseA: ((reply: Reply) => void) | undefined;
  const app = browser(url => {
    if (url.pathname === "/api/sessions") return { body: { sessions: [session("A"), session("B")], ...empty } };
    if (url.pathname === "/api/sessions/A") return new Promise(resolve => { releaseA = resolve; });
    if (url.pathname === "/api/sessions/B") return { body: { ...session("B"), active_job_id: "active" } };
    if (url.pathname === "/api/sessions/B/jobs") return { body: { jobs: [{ ...job("old", "B"), user_text_preview: "old" }], has_more: false, next_cursor: null, active_job_id: "active" } };
    if (url.pathname === "/api/jobs/active") return { body: job("active", "B", "running") };
    if (url.pathname === "/api/jobs/old") return { body: job("old", "B") };
    throw new Error(`unexpected ${url}`);
  });
  await flush();
  const b = app.get("#sessions").children.find(item => item.textContent === "B")!;
  await b.click(); await flush();
  releaseA!({ body: session("A") }); await flush();
  assert.equal(app.get("#result").innerHTML, "result:active");
  await app.get("#history").children[0]!.click(); await flush();
  assert.equal(app.get("#result").innerHTML, "result:old");
  assert.equal(app.get("#cancel").hidden, false);
  assert.equal(app.get("#ask").disabled, true);
  assert.equal(app.get("#active-job").hidden, false);
});
