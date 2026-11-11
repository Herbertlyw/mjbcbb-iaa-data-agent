import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function loadBrowserModule(name: string): Record<string, unknown> {
  const source = readFileSync(
    new URL(`../src/web/${name}.js`, import.meta.url),
    "utf8",
  );
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(code, { exports });
  return exports;
}

function page(onTerminal: () => Promise<void> = async () => {}) {
  const timers: Array<() => void> = [];
  const cancelled = new Set<number>();
  const events: Array<{ seq: number; type: string }> = [];
  const connections: string[] = [];
  class MockSource {
    static instances: MockSource[] = [];
    closed = false;
    onerror: (() => void) | undefined;
    onmessage:
      | ((event: { data: string; lastEventId: string }) => Promise<void>)
      | undefined;
    constructor(readonly url: string) {
      MockSource.instances.push(this);
    }
    close() {
      this.closed = true;
    }
    send(seq: number, type: string) {
      return this.onmessage?.({
        data: JSON.stringify({ seq, type, payload: {} }),
        lastEventId: String(seq),
      });
    }
  }
  const create = loadBrowserModule("stream").createJobStream as (options: {
    createSource(url: string): MockSource;
    schedule(fn: () => void, ms: number): number;
    cancelSchedule(id: number): void;
    onEvent(event: { seq: number; type: string }): void;
    onConnection(status: string): void;
    onTerminal(): Promise<void>;
  }) => {
    start(id: string, after?: number): void;
    stop(): void;
    readonly cursor: number;
  };
  const stream = create({
    createSource: (url) => new MockSource(url),
    schedule: (fn) => {
      const id = timers.length;
      timers.push(() => {
        if (!cancelled.has(id)) fn();
      });
      return id;
    },
    cancelSchedule: (id) => {
      cancelled.add(id);
    },
    onEvent: (event) => events.push(event),
    onConnection: (status) => connections.push(status),
    onTerminal,
  });
  const views = loadBrowserModule("view") as {
    renderCalculationTables(analysis: unknown): string;
    displayCell(value: unknown): unknown;
    usageSummary(value: unknown): string;
    renderJob(value: unknown): string;
  };
  const state = {
    jobId: null as string | null,
    get lastSeq() {
      return stream.cursor;
    },
  };
  const api = {
    ...views,
    state,
    listen: (id: string) => stream.start(id),
    stop: () => stream.stop(),
  };
  return {
    api,
    timers,
    sources: MockSource.instances,
    events,
    connections,
    stream,
  };
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
  const html = api.usageSummary({
    usage: {
      model_attempts: 2,
      model_calls: 1,
      provider_not_dispatched: 1,
      provider_completed: 1,
      provider_outcome_unknown: 0,
      input_tokens: 4308,
      output_tokens: 78,
      cache_hit_tokens: 0,
      cache_miss_tokens: null,
      usage_source: "reported",
    },
  });
  assert.match(html, /模型尝试至少 2/);
  assert.match(html, /可能已派发上限 1/);
  assert.match(html, /明确未派发 1/);
  assert.match(html, /输入 token：4308/);
  assert.match(html, /缓存命中：0/);
  assert.match(html, /缓存未命中：未知/);
  const unknown = api.usageSummary({
    usage: {
      model_attempts: 1,
      model_calls: 0,
      provider_not_dispatched: 1,
      provider_completed: 0,
      provider_outcome_unknown: 0,
      input_tokens: null,
      output_tokens: null,
      usage_source: "not_dispatched",
    },
  });
  assert.match(unknown, /输入 token：未知/);
  assert.doesNotMatch(unknown, /输入 token：0/);
});

test("页面展示经核验的变换、NULL 对齐状态及绑定哈希的续页，并转义显示值", () => {
  const { api } = page();
  const html = api.renderCalculationTables({
    resource_hashes: { x: "valid-hash", y: "second-hash" },
    transform_results: [
      {
        resource_id: "x",
        source_resource_id: "source",
        total_rows: 21,
        result: {
          columns: [{ name: "amount", label: "合计", unit: "人" }],
          rows: [{ amount: "<script>" }],
        },
      },
    ],
    alignment_results: [
      {
        resource_id: "y",
        total_rows: 2,
        coverage_incomplete: true,
        spec: {
          op: "divide",
          left: { resource_id: "a" },
          right: { resource_id: "b" },
        },
        rows: [
          {
            group: { country_code: null },
            status: "partial_nulls",
            left: { value: "0", unit: "人" },
            right: { value: null, unit: "人" },
            result: null,
          },
        ],
      },
    ],
  });
  assert.match(html, /已核验的结果变换/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /country_code=NULL/);
  assert.match(html, /部分 NULL/);
  assert.match(html, /来源覆盖不完整/);
  assert.match(html, /0 人/);
  assert.match(html, /data-hash="valid-hash"/);
  assert.match(html, /data-hash="second-hash"/);
  const keys = api.renderCalculationTables({
    alignment_results: [
      {
        resource_id: "z",
        spec: {
          op: "divide",
          left: { resource_id: "a" },
          right: { resource_id: "b" },
        },
        rows: [
          { group: { country_code: null }, status: "matched" },
          { group: { country_code: "NULL" }, status: "zero_divisor" },
        ],
      },
    ],
  });
  assert.match(keys, /country_code=NULL（空键）/);
  assert.match(keys, /country_code=&quot;NULL&quot;（字符串）/);
  assert.equal(api.displayCell(null), "NULL（空值）");
  assert.equal(api.displayCell("NULL"), '"NULL"（字符串）');
});

test("续页后展示实际加载行数，查询和计算结果分别保留总数", () => {
  const update = loadBrowserModule("view").updatePaginationCount as (
    table: unknown,
    button: unknown,
  ) => void;
  let shown = 70;
  const table = {
    querySelectorAll: (selector: string) =>
      selector === "tbody tr" ? Array(shown) : [],
  };
  const progress = {
    dataset: { kind: "source", total: "240" },
    textContent: "已保存 240 行，当前显示前 20 行。",
  };
  const button = {
    parentElement: {
      querySelector: (selector: string) =>
        selector === ".pagination-count" ? progress : null,
    },
  };
  update(table, button);
  assert.equal(progress.textContent, "已保存 240 行，当前显示前 70 行。");
  progress.dataset.kind = "calculation";
  shown = 240;
  update(table, button);
  assert.equal(progress.textContent, "显示 240/240 行。");
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

test("终态读取失败后重读终态事件，成功后停止重连", async () => {
  let attempts = 0;
  const { stream, sources, timers, connections } = page(async () => {
    if (++attempts === 1) throw new Error("offline");
  });
  stream.start("job");
  await sources[0]!.send(1, "job_started");
  await sources[0]!.send(2, "job_finished");
  assert.equal(stream.cursor, 1);
  timers[0]!();
  assert.match(sources[1]!.url, /after=1$/);
  await sources[1]!.send(2, "job_finished");
  assert.equal(attempts, 2);
  sources[1]!.onerror?.();
  assert.equal(timers.length, 1);
  assert.equal(connections.at(-1), "settled");
});

test("从已保存序号续读，重复事件不再展示，停止后旧回调不生效", async () => {
  const { stream, sources, events, timers } = page();
  stream.start("job", 5);
  assert.match(sources[0]!.url, /after=5$/);
  await sources[0]!.send(5, "tool_finished");
  await sources[0]!.send(6, "tool_started");
  await sources[0]!.send(6, "tool_started");
  assert.deepEqual(
    events.map((item) => item.seq),
    [6],
  );
  stream.stop();
  await sources[0]!.send(7, "tool_finished");
  sources[0]!.onerror?.();
  assert.equal(events.length, 1);
  assert.equal(timers.length, 0);
});

test("无效事件从最后连续序号恢复，不推进游标", async () => {
  const { stream, sources, timers } = page();
  stream.start("job");
  await sources[0]!.onmessage?.({ data: "not json", lastEventId: "1" });
  assert.equal(stream.cursor, 0);
  assert.equal(sources[0]!.closed, true);
  timers[0]!();
  await sources[1]!.onmessage?.({
    data: '{"seq":1.5,"type":"job_started"}',
    lastEventId: "1.5",
  });
  assert.equal(stream.cursor, 0);
});

test("结论先于用量展示，澄清、取消和模型文本保留不同含义", () => {
  const { api } = page();
  const cancelled = api.renderJob({
    status: "cancelled",
    user_text: "<img onerror=alert(1)>",
    analysis: null,
    error: { message: "provider error" },
  });
  assert.match(cancelled, /服务端终态：已取消。没有提交分析。/);
  assert.doesNotMatch(cancelled, /provider error|<img/);
  const result = api.renderJob({
    status: "completed",
    user_text: "question",
    analysis: {
      status: "completed",
      answer: "verified 30",
      sources: [],
      limitations: [],
      server_reasons: ["model_draft_not_verified"],
    },
  });
  assert.ok(result.indexOf("verified 30") < result.indexOf("模型与用量"));
  const question = api.renderJob({
    status: "needs_clarification",
    user_text: "收入",
    analysis: {
      status: "needs_clarification",
      answer: "需要补充条件",
      clarification_question: "请提供日期",
      sources: [],
      limitations: [],
    },
  });
  assert.match(question, /请提供日期/);
  assert.doesNotMatch(question, /数据来源/);
});

test("请求完整性未核验时，页面不会将执行终态展示为请求全部完成", () => {
  const { api } = page();
  for (const question of ["按地区查看收入和成本", "比较两个日期的设备数", "按渠道计算转化率"]) {
    const rendered = api.renderJob({
      status: "completed", user_text: question,
      analysis: { status: "completed", answer: "已核验的所选结果", sources: [], limitations: ["请对照原问题检查是否有漏项。"], server_reasons: ["request_coverage_unverified"] },
    });
    assert.match(rendered, /结果已生成 · 请求覆盖待核对/);
    assert.match(rendered, /请对照原问题检查是否有漏项/);
  }
});

test("模型正文、核验结果和缺口直接可见，模型 HTML 按文本转义", () => {
  const { api } = page();
  const html = api.renderJob({ status: "partial", user_text: "合成问题", analysis: {
    status: "partial", model_answer: "解释 1.146593；成本缺失。<img src=x onerror=alert(1)>", answer: "核验结果 1.146593", sources: [], calculations: [],
    limitations: ["成本缺失，差额未知"], server_reasons: [],
  } });
  assert.match(html, /模型分析 · 未逐句核验/);
  assert.match(html, /解释 1\.146593；成本缺失/);
  assert.match(html, /核验结果 1\.146593/);
  assert.match(html, /成本缺失，差额未知/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /<details class="limitations" open>/);
});

test("零分母显示已核验的同次查询分组，模型标记不泄露到解释正文", () => {
  const { api } = page();
  const html = api.renderJob({ status: "partial", user_text: "合成问题", analysis: {
    status: "partial", answer: "完整服务端结果", limitations: [], resource_hashes: {},
    sources: [{ resource_id: "res_source", evidence_eligible: true, tables: ["synthetic"], rows: [], time_range: { start: "2026-10-08", end: "2026-10-08", timezone: "UTC" }, sql: "SELECT", freshness_receipts: [] }],
    model_draft: "[[partial]] 范围待核验 [[result:res_source]]",
    arithmetic_results: [{ resource_id: "res_calc", operation: "divide", verified_group: { "dim.channel": "organic<script>", "dim.other": null }, result: { value: null, unit: "USD/人", undefined_reason: "zero_divisor", interpretation: "mathematical_only" } }],
  } });
  assert.match(html, /不可计算（除数为零）/u);
  assert.match(html, /同次查询分组/u);
  assert.match(html, /organic&lt;script&gt;/u);
  assert.doesNotMatch(html, /organic<script>|\[\[partial\]\]|\[\[result:/u);
});

test("核验结果表只使用核验单元，保留筛选、精度、零和 NULL 说明", () => {
  const { api } = page();
  const html = api.renderJob({
    status: "partial",
    user_text: "synthetic",
    analysis: {
      status: "partial",
      answer: "完整服务端结论",
      sources: [],
      limitations: ["来源不完整"],
      calculations: [
        {
          cells: { forged: 99999 },
          verified_cells: [
            {
              sourceResourceId: "res",
              table: "synthetic",
              column: "amount",
              description: "<b>收入</b>",
              range: {
                start: "2026-10-06",
                end: "2026-10-08",
                timezone: "UTC",
              },
              filters: { country: "JP" },
              value: 0,
              unit: "USD",
              operation: "sum",
              precision: "floating_point_approximate",
              prediction: "实际",
              excludedNulls: 1,
            },
          ],
        },
      ],
    },
  });
  assert.match(html, /verified-summary/);
  assert.match(html, /&lt;b&gt;收入&lt;\/b&gt;/);
  assert.match(html, /country=JP/);
  assert.match(html, /约 0/);
  assert.match(html, /不含 1 行 NULL/);
  assert.match(html, /完整服务端结论/);
  assert.doesNotMatch(html, /99999|<b>收入<\/b>/);
});

test("服务端核验的原始单元独立于模型自报展示，只接受有效来源", () => {
  const { api } = page();
  const source = {
    resource_id: "res_safe",
    evidence_eligible: true,
    tables: ["synthetic"],
    rows: [],
    time_range: { start: "2026-10-08", end: "2026-10-08", timezone: "UTC" },
    sql: "SELECT",
    freshness_receipts: [],
  };
  const declaration = {
    scope: "模型自报",
    grain: "日",
    expected_group_keys: [],
    unresolved_questions: [],
    assumptions: [],
  };
  const html = api.renderJob({
    status: "partial",
    user_text: "synthetic",
    analysis: {
      status: "partial",
      answer: "缺失值未知",
      sources: [source],
      limitations: [],
      analysis_declaration: {
        declaration,
        verified_cells: [
          {
            field: "synthetic.amount",
            value: "1.00",
            unit: "USD",
            row: 0,
            resource_id: "res_safe",
            execution_id: "exec_safe",
          },
          {
            field: "forged",
            value: "99999",
            unit: "USD",
            row: 0,
            resource_id: "res_other",
            execution_id: "exec_other",
          },
        ],
      },
    },
  });
  assert.match(html, /经核验的查询单元/);
  assert.match(html, /synthetic\.amount = 1\.00 USD/);
  assert.match(html, /仅代表所列保存结果行/);
  assert.doesNotMatch(html, /99999/);
  assert.ok(
    html.indexOf("经核验的查询单元") < html.indexOf("模型工作记录 · 自报内容"),
  );
});

test("工作记录的分组求和展示真实筛选、预测状态和观察范围", () => {
  const { api } = page();
  const html = api.renderJob({ status: "partial", analysis: {
    status: "partial", answer: "已观察", limitations: [], calculations: [],
    sources: [{ resource_id: "res_group", evidence_eligible: true, tables: ["fact"], rows: [], sql: "SELECT", freshness_receipts: [], time_range: { start: "2026-01-01", end: "2026-01-01", timezone: "UTC" } }],
    analysis_declaration: { declaration: { scope: "自报", grain: "分组", expected_group_keys: [], unresolved_questions: [] }, verified_cells: [{
      field: "fact.revenue（数据库分组求和）", value: "1.20", unit: "USD", row: 0, resource_id: "res_group", execution_id: "exec_group",
      observation: { filters: { region: "<JP>" }, prediction: "actual", scope_complete: false, coverage_incomplete: true },
    }] },
  } });
  assert.match(html, /region=&lt;JP&gt;/);
  assert.match(html, /仅观察到的分组，不代表完整总体/);
  assert.match(html, /实际/);
  assert.doesNotMatch(html, /region=<JP>/);
});

test("离散日期来源只显示实际选中日期，不显示连续范围", () => {
  const { api } = page();
  const html = api.renderJob({ status: "partial", analysis: {
    status: "partial", answer: "部分观察", limitations: [], calculations: [],
    sources: [{ resource_id: "res_sparse", evidence_eligible: true, tables: ["fact"], rows: [], sql: "SELECT", freshness_receipts: [], time_range: { start: "2026-10-26", end: "2026-11-07", timezone: "UTC", selected_dates: ["2026-10-26", "2026-11-07"] } }],
  } });
  assert.match(html, /仅所选日期：2026-10-26、2026-11-07/);
  assert.doesNotMatch(html, /2026-10-26 至 2026-11-07/);
});

test("已知金额与未知差额同时展示，无需模型工作记录且不把 NULL 显示为零", () => {
  const { api } = page();
  const range = {
    start: "2026-10-08",
    end: "2026-10-08",
    timezone: "America/Los_Angeles",
  };
  const sources = ["payment", "spend"].map((id) => ({
    resource_id: id,
    execution_id: `exec_${id}`,
    evidence_eligible: true,
    tables: [id],
    rows: [],
    time_range: range,
    sql: "SELECT",
    freshness_receipts: [],
  }));
  const base = {
    row: 0,
    description: "合成金额",
    unit: "USD",
    scale: 2,
    approximate: false,
    prediction: "actual",
    filters: { country_code: "US" },
    range,
    scope_complete: true,
    coverage_incomplete: true,
  };
  const html = api.renderJob({
    status: "partial",
    user_text: "合成比较",
    analysis: {
      status: "partial",
      answer: "完整服务端记录",
      sources,
      limitations: ["来源覆盖不完整"],
      query_observations: [
        {
          ...base,
          resource_id: "payment",
          execution_id: "exec_payment",
          table: "payment",
          column: "amount_usd",
          value: "1.00",
        },
        {
          ...base,
          resource_id: "spend",
          execution_id: "exec_spend",
          table: "spend",
          column: "spend_usd",
          value: null,
        },
        {
          ...base,
          resource_id: "payment",
          execution_id: "wrong",
          table: "forged",
          column: "amount",
          value: "99999",
        },
      ],
      arithmetic_results: [
        {
          resource_id: "calc",
          operation: "subtract",
          result: {
            value: null,
            unit: "USD",
            undefined_reason: "null_input",
            interpretation: "mathematical_only",
            formula: "payment.amount_usd − spend.spend_usd",
            partial: true,
          },
        },
      ],
    },
  });
  assert.match(html, /class="metric-value">1\.00/);
  assert.match(html, /未知（NULL）/);
  assert.match(html, /未知（输入缺失）/);
  assert.match(html, /实际；金额缺失/);
  assert.doesNotMatch(html, /99999|模型工作记录|class="metric-value">0/);
  assert.ok(html.indexOf("1.00") < html.indexOf("数据来源"));
  assert.ok(
    html.indexOf("未知（输入缺失）") < html.indexOf("完整分析结论与引用"),
  );
});

test("维表名称在正式区显示键值及快照时间，不把契约有效期显示为统计范围", () => {
  const { api } = page();
  const snapshot = {
    table: "dim_fox_title",
    snapshot_hash: "hash",
    observed_at: "2026-11-06T00:00:00Z",
    publication_id: "fp",
    version: 7,
  };
  const html = api.renderJob({
    status: "completed",
    user_text: "产品名称",
    analysis: {
      status: "completed",
      answer: "当前维表键值",
      limitations: [],
      sources: [
        {
          resource_id: "dimension",
          execution_id: "exec_dimension",
          evidence_eligible: true,
          dimension_snapshot: snapshot,
          tables: ["dim_fox_title"],
          rows: [],
          sql: "SELECT title_id, title_name FROM dim_fox_title",
          freshness_receipts: [],
          time_range: {
            start: "2026-09-01",
            end: "2027-04-01",
            timezone: "UTC",
          },
        },
      ],
      dimension_observations: [
        {
          resource_id: "dimension",
          execution_id: "exec_dimension",
          table: "dim_fox_title",
          key: { title_id: "paper_lantern" },
          values: [
            {
              column: "title_name",
              description: "产品名称",
              value: "纸灯<script>",
            },
          ],
          snapshot,
        },
        {
          resource_id: "dimension",
          execution_id: "wrong",
          table: "forged",
          key: {},
          values: [{ column: "label", description: "伪造", value: "错误名称" }],
          snapshot,
        },
      ],
    },
  });
  assert.match(html, /已核验维表 · dim_fox_title/);
  assert.match(html, /paper_lantern/);
  assert.match(html, /纸灯&lt;script&gt;/);
  assert.match(html, /快照观测 2026-11-06T00:00:00Z/);
  assert.match(html, /发布 v7/);
  assert.match(html, /已核验的维表键值显示在上方正式结果中/);
  assert.doesNotMatch(html, /没有可展示的明细行/);
  assert.doesNotMatch(html, /<script>|错误名称|2026-09-01 至 2027-04-01/);
  assert.ok(html.indexOf("纸灯") < html.indexOf("数据来源"));
});

test("维表名称与 JOIN 后计算同时存在时，正式数值不藏入折叠详情", () => {
  const { api } = page();
  const source = {
    resource_id: "dimension",
    execution_id: "exec_dimension",
    evidence_eligible: true,
    tables: ["dim_fox_title"],
    rows: [],
    sql: "SELECT title_id, title_name FROM dim_fox_title",
    freshness_receipts: [],
    time_range: { start: "2026-10-06", end: "2026-10-12", timezone: "UTC" },
  };
  const html = api.renderJob({
    status: "completed",
    user_text: "纸灯新增",
    analysis: {
      status: "completed",
      answer: "完整结论和 JOIN 分组依据",
      sources: [source],
      limitations: [],
      dimension_observations: [
        {
          resource_id: source.resource_id,
          execution_id: source.execution_id,
          table: "dim_fox_title",
          key: { title_id: "paper_lantern" },
          values: [
            { column: "title_name", description: "产品名称", value: "纸灯" },
          ],
          snapshot: { observed_at: "2026-11-06T00:00:00Z", version: 1 },
        },
      ],
      calculations: [
        {
          resource_id: "calculation",
          source_resource_id: "joined",
          cells: { forged: 99999 },
          verified_result: {
            columns: [{ name: "total", label: "新增用户<host>", unit: "人" }],
            rows: [{ total: "70" }, { total: null }, { total: "0" }],
          },
        },
      ],
    },
  });
  const formal = html.slice(0, html.indexOf("完整分析结论与引用"));
  assert.match(formal, /已核验维表/);
  assert.match(formal, /纸灯/u);
  assert.match(formal, /新增用户&lt;host&gt;（人）/u);
  assert.match(formal, /class="metric-value">70</u);
  assert.match(formal, /NULL（空值）/u);
  assert.match(formal, /class="metric-value">0</u);
  assert.doesNotMatch(formal, /99999|<host>/u);
});

test("维表名称与单表分组再求和同时显示已核验值，不能借用无效来源", () => {
  const { api } = page();
  const range = { start: "2026-10-06", end: "2026-10-12", timezone: "UTC" };
  const dimension = {
    resource_id: "dimension", execution_id: "dim-exec", evidence_eligible: true,
    tables: ["dim_fox_title"], rows: [], sql: "SELECT", freshness_receipts: [], time_range: range,
  };
  const fact = {
    resource_id: "fact", execution_id: "fact-exec", evidence_eligible: true,
    tables: ["fact_fox_daily_install"], rows: [], sql: "SELECT", freshness_receipts: [], time_range: range,
  };
  const rollup = {
    source_resource_id: "fact", table: "fact_fox_daily_install", column: "new_users",
    description: "新增用户<说明>", operation: "sum", input_operation: "sum", value: "70", unit: "人",
    filters: { title_id: "paper_lantern", country_code: "JP" }, in_sets: {}, grouped_by: ["title_id"], range,
    prediction: "actual_observed_only",
  };
  const html = api.renderJob({
    status: "completed", user_text: "按产品展示新增", analysis: {
      status: "completed", answer: "服务端完整结论", limitations: [], sources: [fact, dimension],
      dimension_observations: [{
        resource_id: "dimension", execution_id: "dim-exec", table: "dim_fox_title",
        key: { title_id: "paper_lantern" },
        values: [{ column: "title_name", description: "产品名称", value: "纸灯" }],
        snapshot: { observed_at: "2026-11-06T00:00:00Z", version: 1 },
      }],
      calculations: [{
        resource_id: "calc", source_resource_id: "fact", cells: { raw: "99999" },
        verified_group_rollups: [rollup, { ...rollup, source_resource_id: "other", value: "88888" }],
      }],
    },
  });
  const formal = html.slice(0, html.indexOf("完整分析结论与引用"));
  assert.match(formal, /纸灯/u);
  assert.match(formal, /已核验的分组计算 · fact_fox_daily_install\.new_users/u);
  assert.match(formal, /新增用户&lt;说明&gt;/u);
  assert.match(formal, /class="metric-value">70</u);
  assert.match(formal, /<td>人<\/td>/u);
  assert.match(formal, /未出现的组合没有补零/u);
  assert.match(formal, /2026-10-06 至 2026-10-12/u);
  assert.doesNotMatch(formal, /99999|88888|<说明>/u);
});

test("JOIN 正式结果直接展示核验分组、人数与行数，错误执行号不能借用", () => {
  const { api } = page();
  const values = [
    {
      operation: "sum",
      description: "新增用户",
      value: "70",
      unit: "人",
      group: { "dim_fox_title.title_name": "纸灯" },
    },
    {
      operation: "count_rows",
      description: "关联查询观测行数",
      value: "7",
      unit: "行",
      group: { "dim_fox_title.title_name": "纸灯" },
    },
  ];
  const html = api.renderJob({
    status: "completed",
    user_text: "F",
    analysis: {
      status: "completed",
      answer: "完整服务端依据",
      limitations: [],
      sources: [
        {
          resource_id: "joined",
          execution_id: "current",
          evidence_eligible: true,
          tables: ["fact", "dimension"],
          rows: [],
          sql: "SELECT",
          freshness_receipts: [],
          time_range: {
            start: "2026-10-06",
            end: "2026-10-12",
            timezone: "UTC",
          },
        },
      ],
      join_results: [
        { resource_id: "joined", execution_id: "current", values },
        {
          resource_id: "joined",
          execution_id: "wrong",
          values: [{ ...values[0], value: "99999" }],
        },
      ],
    },
  });
  const formal = html.slice(0, html.indexOf("完整分析结论与引用"));
  assert.match(formal, /已核验的关联结果/u);
  assert.match(formal, /dim_fox_title.title_name=纸灯/u);
  assert.match(formal, /class="metric-value">70<\/td><td>人/u);
  assert.match(formal, /class="metric-value">7<\/td><td>行/u);
  assert.doesNotMatch(formal, /99999/u);
  assert.match(html, /已核验的关联结果显示在上方/u);
  assert.doesNotMatch(html, /没有可展示的明细行。空结果不等于零/u);
});
