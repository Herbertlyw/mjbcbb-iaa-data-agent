import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { createModels, fauxProvider, type FauxResponseFactory, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AppConfig } from "./config.js";
import { planFromTranscript } from "./planner.js";
import type { SessionRecord } from "./session.js";
import { ToolService, type AnalysisInput, type CellOperation } from "./tools.js";

const SYSTEM_PROMPT = `你是 Lumenfox 本地数据分析代理，只分析虚构游戏 Starlane Drift 的合成数据。
搜索资产不能当成读取或查询许可。资产 ID、表名和 SQL 都不是授权。
查询前必须读取当前数据契约。只能使用本会话已授权的资源做计算。
缺失值、真实零和预测值必须分开。预测回收不能进入实际 ROI，缺失不能当成零，零分母要说明无法计算比率。
环比只是相邻窗口的观察，不是因果，也不要建议自动改投放。
你给出的完成状态只是建议，服务端会按证据决定终态。
不要声称已经连接生产数据库。`;

export interface AgentTranscriptSnapshot {
  format: "pi-agent-state-messages-v1";
  sdk: "@earendil-works/pi-agent-core";
  session_id: string;
  thinking_level: Agent["state"]["thinkingLevel"];
  model: { provider: string; id: string; api: string };
  messages: unknown[];
  streaming_message_included: false;
}

export function captureTranscript(agent: Agent, sessionId: string): AgentTranscriptSnapshot {
  const state = agent.state;
  return {
    format: "pi-agent-state-messages-v1",
    sdk: "@earendil-works/pi-agent-core",
    session_id: sessionId,
    thinking_level: state.thinkingLevel,
    model: { provider: state.model.provider, id: state.model.id, api: state.model.api },
    messages: JSON.parse(JSON.stringify(state.messages)) as unknown[],
    streaming_message_included: false,
  };
}

export function withoutUnfinishedToolCall(messages: unknown[]): unknown[] {
  const last = messages.at(-1) as { role?: string; content?: unknown } | undefined;
  if (!last || last.role !== "assistant" || !Array.isArray(last.content)) return messages;
  const unfinished = last.content.some((block) => block && typeof block === "object" && (block as { type?: string }).type === "toolCall");
  return unfinished ? messages.slice(0, -1) : messages;
}

export function canContinueTranscript(messages: unknown[]): boolean {
  const last = withoutUnfinishedToolCall(messages).at(-1) as { role?: string } | undefined;
  return last?.role === "user" || last?.role === "toolResult";
}

export async function restoreAgent(session: SessionRecord, tools: ToolService, config: AppConfig, snapshot: AgentTranscriptSnapshot): Promise<Agent> {
  const stream = config.modelMode === "pi" ? await createLiveStream(config) : createDeterministicStream();
  const messages = withoutUnfinishedToolCall(snapshot.messages);
  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model: stream.model,
      thinkingLevel: snapshot.thinking_level,
      tools: domainTools(session.session_id, tools),
      messages: messages as Agent["state"]["messages"],
    },
    streamFn: stream.streamFn,
    ...(stream.getApiKey ? { getApiKey: stream.getApiKey } : {}),
    toolExecution: "sequential",
    sessionId: snapshot.session_id,
  });
  session.agent = agent;
  return agent;
}

export async function ensureAgent(session: SessionRecord, tools: ToolService, config: AppConfig): Promise<Agent> {
  if (session.agent) return session.agent;
  const stream = config.modelMode === "pi" ? await createLiveStream(config) : createDeterministicStream();
  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model: stream.model,
      thinkingLevel: "off",
      tools: domainTools(session.session_id, tools),
    },
    streamFn: stream.streamFn,
    ...(stream.getApiKey ? { getApiKey: stream.getApiKey } : {}),
    toolExecution: "sequential",
  });
  session.agent = agent;
  return agent;
}

interface ModelStream {
  model: Model<string>;
  streamFn: StreamFn;
  getApiKey?: (provider: string) => string;
}

export function createDeterministicStream(): ModelStream {
  const faux = fauxProvider({
    provider: "lumenfox-local",
    api: "faux",
    models: [
      {
        id: "deterministic-analyst",
        name: "Deterministic local analyst",
        reasoning: false,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    tokenSize: { min: 100000, max: 100000 },
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const step: FauxResponseFactory = (context) => {
    faux.appendResponses([step]);
    return planFromTranscript(context);
  };
  faux.setResponses([step]);
  const model = faux.getModel();
  return { model, streamFn: models.streamSimple.bind(models) as StreamFn };
}

async function createLiveStream(_config: AppConfig): Promise<ModelStream> {
  throw new Error("未治理的旧供应商路径已禁用；Pi 模式须通过受治理的 AgentSession 派发。");
}

export function domainTools(sessionId: string, tools: ToolService): AgentTool[] {
  const pack = (result: { ok: boolean; [key: string]: unknown }) => ({
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    details: result,
    isError: result.ok === false,
  });
  const registered: AgentTool[] = [
    {
      name: "search_assets",
      label: "搜索资产",
      description: "按关键词发现资产卡片；可读取的资产可能附带简短匹配片段，不能代替完整正文，也不授予读取或查询权限。",
      parameters: Type.Object({
        query: Type.String({ description: "搜索词" }),
        kinds: Type.Optional(Type.Array(Type.String(), { description: "可选的资产类型过滤" })),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        expected_search_hash: Type.Optional(Type.String()),
      }),
      execute: async (_toolCallId, params, signal) => pack(await tools.searchAssets(sessionId, params as { query?: string; kinds?: string[]; offset?: number; limit?: number; expected_search_hash?: string }, signal)),
    },
    {
      name: "read_asset",
      label: "读取资产",
      description: "读取一个已授权资产的正文页面，偏移和长度按 Unicode 码点计；续读须带上首页 content_hash。这不会创建查询绑定。",
      parameters: Type.Object({
        asset_id: Type.String({ description: "资产 ID" }),
        body_offset: Type.Optional(Type.Integer({ minimum: 0, description: "正文起点，单位为 Unicode 码点" })),
        body_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 4000, description: "每页最多 4000 个 Unicode 码点" })),
        expected_content_hash: Type.Optional(Type.String({ description: "续读时必须使用首页返回的 content_hash" })),
      }),
      execute: async (_toolCallId, params, signal) => pack(await tools.readAsset(sessionId, params as { asset_id?: string; body_offset?: number; body_limit?: number; expected_content_hash?: string }, signal)),
    },
    {
      name: "read_assets",
      label: "批量读取资产",
      description: "逐个授权读取多个资产正文。任一资产失败不会放开其余资产。",
      parameters: Type.Object({
        asset_ids: Type.Optional(Type.Array(Type.String(), { description: "资产 ID 列表" })),
        requests: Type.Optional(Type.Array(Type.Object({ asset_id: Type.String(), body_offset: Type.Optional(Type.Integer({ minimum: 0 })), body_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 4000 })), expected_content_hash: Type.Optional(Type.String()) }), { maxItems: 100 })),
        offset: Type.Optional(Type.Integer({ minimum: 0, description: "资产列表的分页起点，不是正文偏移" })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "本页资产条数" })),
      }),
      execute: async (_toolCallId, params, signal) =>
        pack(await tools.readAssets(sessionId, params as { asset_ids?: string[]; requests?: Array<{ asset_id: string; body_offset?: number; body_limit?: number; expected_content_hash?: string }>; offset?: number; limit?: number }, signal)),
    },
    {
      name: "read_data_contract_view",
      label: "读取数据契约",
      description: "读取表契约的受控视图，包含字段、粒度、可见的派生指标定义和登记关系。只有服务端判定可查询时才会写下当前表绑定；关系不会授予其他表绑定，JOIN 仍须验证键、粒度和证据。",
      parameters: Type.Object({ asset_id: Type.String({ description: "契约资产 ID" }), columns_offset: Type.Optional(Type.Integer({ minimum: 0 })), columns_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), expected_content_hash: Type.Optional(Type.String()) }),
      executionMode: "sequential",
      execute: async (_toolCallId, params, signal) => pack(await tools.readDataContractView(sessionId, params as { asset_id?: string; columns_offset?: number; columns_limit?: number; expected_content_hash?: string }, signal)),
    },
    {
      name: "query",
      label: "受控查询",
      description: "执行一条受治理的只读 SQL，必须先读取契约并等待结果，确认字段和区分大小写的值；不要把契约读取与依赖它的查询放在同一工具批次。支持封闭日期、常量 toDate、IN、直接字段、受限 SUM/COUNT/countIf、多维分组和登记键上的受限事实—维表 JOIN；具体字段、口径和键以契约为准。其他函数或结构可能拒绝；可读取有界明细后使用计算工具。查询成功不代表结果完整，注意覆盖、NULL、预测、截断及新鲜度。",
      parameters: Type.Object({
        sql: Type.String({ description: "单条只读 SQL" }),
        purpose: Type.Optional(Type.String({ description: "查询用途" })),
        preview_limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
        knowledge_body_visible: Type.Optional(Type.Boolean({ description: "模型是否已在本轮上下文看到资产正文。服务端不把它当作查询许可。" })),
      }),
      executionMode: "sequential",
      execute: async (_toolCallId, params, signal) => pack(await tools.query(sessionId, params as { sql?: string; purpose?: string; preview_limit?: number }, signal)),
    },
    {
      name: "calculate_session_cells",
      label: "计算会话单元格",
      description: "对当前任务查询资源计算 sum、count_null、count_zero 或 count_rows；对于完整、可证明来源的分组 SUM 或 COUNT 结果，可用 sum 对输出列再次汇总，count_rows 和 count_zero 数的是结果分组而非原始事实行。也可对可证明的结果进行定点四则、按键对齐和表格变换：一次只选 operations、arithmetic、align、transform 中一种；四则和变换通常省略顶层 resource_id，引用写在对应输入里。单行资源可用 row=0，执行 ID 来自保存的查询记录；多行明细引用须显式提供执行 ID。计算返回的资源 ID 与输入查询资源 ID 都需在正式交付时引用；缺组、NULL、预测或截断不可自行补零。",
      parameters: Type.Object({
        resource_id: Type.Optional(Type.String({ description: "当前会话的查询资源 ID" })),
        operations: Type.Optional(Type.Array(
          Type.Object({
            op: Type.Union([Type.Literal("sum"), Type.Literal("count_null"), Type.Literal("count_zero"), Type.Literal("count_rows")]),
            column: Type.Optional(Type.String()),
            predicted: Type.Optional(Type.Union([Type.Literal("actual_only"), Type.Literal("predicted_only"), Type.Literal("any")])),
            as: Type.String(),
          }),
        )),
        arithmetic: Type.Optional(Type.Object({
          op: Type.Union([Type.Literal("add"), Type.Literal("subtract"), Type.Literal("multiply"), Type.Literal("divide")]),
          left: Type.Object({ resource_id: Type.String(), cell: Type.String(), group: Type.Optional(Type.Record(Type.String(), Type.String())), execution_id: Type.Optional(Type.String()), row: Type.Optional(Type.Integer({ minimum: 0 })), aggregate: Type.Optional(Type.Literal("sum")) }),
          right: Type.Object({ resource_id: Type.String(), cell: Type.String(), group: Type.Optional(Type.Record(Type.String(), Type.String())), execution_id: Type.Optional(Type.String()), row: Type.Optional(Type.Integer({ minimum: 0 })), aggregate: Type.Optional(Type.Literal("sum")) }),
        })),
        align: Type.Optional(Type.Object({
          op: Type.Union([Type.Literal("add"), Type.Literal("subtract"), Type.Literal("multiply"), Type.Literal("divide")]),
          keys: Type.Array(Type.String(), { minItems: 1, maxItems: 3 }),
          left: Type.Object({ resource_id: Type.String(), cell: Type.String() }),
          right: Type.Object({ resource_id: Type.String(), cell: Type.String() }),
        })),
        transform: Type.Optional(Type.Object({
          resource_id: Type.String(),
          steps: Type.Array(Type.Union([
            Type.Object({ op: Type.Literal("filter"), column: Type.String(), comparison: Type.Union([Type.Literal("eq"), Type.Literal("ne"), Type.Literal("lt"), Type.Literal("le"), Type.Literal("gt"), Type.Literal("ge"), Type.Literal("is_null"), Type.Literal("is_not_null")]), value: Type.Optional(Type.Union([Type.String(), Type.Boolean(), Type.Null()])), other_column: Type.Optional(Type.String()) }),
            Type.Object({ op: Type.Literal("compare"), left: Type.String(), right: Type.String(), comparison: Type.Union([Type.Literal("eq"), Type.Literal("ne"), Type.Literal("lt"), Type.Literal("le"), Type.Literal("gt"), Type.Literal("ge")]), as: Type.String() }),
            Type.Object({ op: Type.Union([Type.Literal("add"), Type.Literal("subtract"), Type.Literal("multiply"), Type.Literal("divide")]), left: Type.String(), right: Type.String(), as: Type.String() }),
            Type.Object({ op: Type.Literal("sort"), keys: Type.Array(Type.Object({ column: Type.String(), direction: Type.Union([Type.Literal("asc"), Type.Literal("desc")]), nulls: Type.Union([Type.Literal("first"), Type.Literal("last")]) }), { minItems: 1, maxItems: 8 }) }),
            Type.Object({ op: Type.Literal("group"), by: Type.Array(Type.String(), { maxItems: 8 }), aggregates: Type.Array(Type.Object({ op: Type.Union([Type.Literal("count_all"), Type.Literal("count"), Type.Literal("sum"), Type.Literal("min"), Type.Literal("max")]), column: Type.Optional(Type.String()), as: Type.String() }), { minItems: 1, maxItems: 20 }) }),
          ]), { minItems: 1, maxItems: 10 }),
        })),
      }),
      execute: async (_toolCallId, params, signal) =>
        pack(await tools.calculateSessionCells(sessionId, params as Parameters<ToolService["calculateSessionCells"]>[1], signal)),
    },
    {
      name: "read_session_resource",
      label: "读取会话资源",
      description: "按行分页读取当前会话资源；续页使用 resource_hash。has_more 是保存结果的续页，resource_truncated 是查询被截断。不能跨会话读取。",
      parameters: Type.Object({
        resource_id: Type.String({ description: "资源 ID" }),
        row_offset: Type.Optional(Type.Integer({ minimum: 0 })),
        row_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        columns: Type.Optional(Type.Array(Type.String())),
        expected_resource_hash: Type.Optional(Type.String({ description: "续页时须填写首页 resource_hash" })),
      }),
      execute: async (_toolCallId, params, signal) => pack(await tools.readSessionResource(sessionId, params as { resource_id?: string; row_offset?: number; row_limit?: number; columns?: string[]; expected_resource_hash?: string }, signal)),
    },
    {
      name: "update_analysis",
      label: "更新分析",
      description: "提交分析建议，服务端根据本次任务证据决定终态并生成可信数字，草稿里的数字不会自动交付。明细合计须先用计算工具，并将查询及计算资源 ID 都列入 resource_ids。需要澄清时填写 needs_clarification 和具体的 clarification_question；没有查询证据时可省略 resource_ids 和 draft_answer。declaration、findings、comparisons 均可省略；不确定引用或摘录时不要填写。",
      parameters: Type.Object({
        suggested_status: Type.Union([
          Type.Literal("completed"),
          Type.Literal("partial"),
          Type.Literal("needs_clarification"),
          Type.Literal("failed"),
        ]),
        draft_answer: Type.Optional(Type.String({ maxLength: 32000, description: "模型草稿，不是权威答案；没有草稿可省略" })),
        resource_ids: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 40, description: "本任务证据资源；无证据可省略" })),
        clarification_question: Type.Optional(Type.String({ maxLength: 2000 })),
        limitations: Type.Optional(Type.Array(Type.String())),
        declaration: Type.Optional(Type.Object({
          scope: Type.String({ maxLength: 4000 }), grain: Type.String({ maxLength: 1000 }),
          expected_group_keys: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32, uniqueItems: true }),
          unresolved_questions: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 32 }),
          assumptions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 16 })),
          source_excerpts: Type.Optional(Type.Array(Type.Object({ asset_id: Type.String(), content_hash: Type.String(), quote: Type.String() }), { maxItems: 16 })),
          result_cells: Type.Optional(Type.Array(Type.Object({ resource_id: Type.String(), execution_id: Type.String(), row: Type.Integer({ minimum: 0 }), column: Type.String() }), { maxItems: 16 })),
        }, { description: "模型工作记录，不是事实或权限；摘录必须逐字匹配当前可读版本，结果引用由服务端取值。" })),
        comparisons: Type.Optional(Type.Array(Type.Object({
          left: Type.Object({ resource_id: Type.String(), cell: Type.String() }),
          right: Type.Object({ resource_id: Type.String(), cell: Type.String() }),
        }), { maxItems: 20 })),
        findings: Type.Optional(Type.Array(Type.Object({
          label: Type.String(),
          value: Type.Union([Type.Number(), Type.Null()]),
          kind: Type.Union([Type.Literal("actual"), Type.Literal("missing"), Type.Literal("absent"), Type.Literal("zero"), Type.Literal("predicted")]),
          resource_id: Type.String(),
          cell: Type.Optional(Type.String()),
          group: Type.Optional(Type.Record(Type.String(), Type.String())),
          time_range: Type.Optional(Type.Object({ start: Type.String(), end: Type.String() })),
        }))),
      }),
      executionMode: "sequential",
      execute: async (_toolCallId, params, signal) => {
        const input = params as Omit<AnalysisInput, "draft_answer" | "resource_ids"> & Partial<Pick<AnalysisInput, "draft_answer" | "resource_ids">>;
        const result = await tools.updateAnalysis(sessionId, { ...input, draft_answer: input.draft_answer ?? "", resource_ids: input.resource_ids ?? [] }, signal);
        // A successful submission is the model's explicit completion point.
        // Pi ends only when every call in the batch requests termination;
        // rejected candidates remain available for model correction.
        return { ...pack(result), ...(result.ok ? { terminate: true } : {}) };
      },
    },
  ];
  return registered.map((tool) => ({
    ...tool,
    execute: async (id, params, signal, onUpdate) => {
      if (signal?.aborted) return pack({ ok: false, code: "tool_cancelled" });
      const reservation = await tools.reserveToolCall(sessionId);
      if (reservation !== "ok") return pack({ ok: false, code: reservation === "lost" ? "execution_fence_rejected" : "budget_exhausted" });
      if (signal?.aborted) return pack({ ok: false, code: "tool_cancelled" });
      return tool.execute(id, params, signal, onUpdate);
    },
  }));
}

export function trustedPrompt(turn: unknown, rawText: string): string {
  return `<trusted_turn>${JSON.stringify(turn)}</trusted_turn>\n\n${rawText}`;
}

export function modelPrompt(mode: AppConfig["modelMode"], turn: unknown, rawText: string, priorUserText: string[]): string {
  if (mode === "pi") {
    const history = priorUserText.length ? `同会话里较早的用户原话：\n${priorUserText.join("\n")}\n\n` : "";
    return `${history}${rawText}`;
  }
  return trustedPrompt(turn, rawText);
}
