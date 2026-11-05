import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { createModels, fauxProvider, type FauxResponseFactory, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AppConfig } from "./config.js";
import { planFromTranscript } from "./planner.js";
import { calculationSchema } from "./calculation-protocol.js";
import { isAnalysisDeclaration, SessionAnalysisRecords } from "./analysis-declaration.js";
import type { SessionRecord } from "./session.js";
import { ToolService } from "./tools.js";

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

export function domainTools(sessionId: string, tools: ToolService, records = new SessionAnalysisRecords()): AgentTool[] {
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
      description: "通过 operation 选择 cells、add、subtract、multiply、divide、align 或 transform。每个输入均使用回执中的 resource_id 和 execution_id；四则引用 column 加 row 或 aggregate=sum，divide 明确 numerator 和 denominator；对齐按 keys 进行。变换或对齐输出也可参与后续运算，数学结果不自动认证业务名称。正式交付可只引用最终结果；缺组、NULL、预测或截断不可补零。",
      parameters: calculationSchema,
      execute: async (_toolCallId, params, signal) => pack(await tools.calculateFromProtocol(sessionId, params, signal)),
    },
    {
      name: "read_session_resource",
      label: "读取会话资源",
      description: "按行分页读取当前会话资源；format=result_view 将查询、计算、变换和对齐适配成同一结果视图，含执行 ID、列类型、来源及完整行数。续页使用 resource_hash。读取检查权限，正式交付仍须重算和复核新鲜度。",
      parameters: Type.Object({
        resource_id: Type.String({ description: "资源 ID" }),
        row_offset: Type.Optional(Type.Integer({ minimum: 0 })),
        row_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        columns: Type.Optional(Type.Array(Type.String())),
        expected_resource_hash: Type.Optional(Type.String({ description: "续页时须填写首页 resource_hash" })),
        format: Type.Optional(Type.Literal("result_view", { description: "统一的查询和计算结果视图，旧资源缺少执行身份时需要重新执行" })),
      }),
      execute: async (_toolCallId, params, signal) => pack(await tools.readSessionResource(sessionId, params as { resource_id?: string; row_offset?: number; row_limit?: number; columns?: string[]; expected_resource_hash?: string; format?: "result_view" }, signal)),
    },
    {
      name: "update_analysis",
      label: "更新分析工作记录",
      description: "记录模型对范围、粒度、未解决问题和假设的理解，可以反复调用；这不是最终答案、授权或已验证事实。之后继续查询和计算，最终自然回答时明确选择本次任务结果。",
      parameters: Type.Object({
        scope: Type.String({ maxLength: 4000 }), grain: Type.String({ maxLength: 1000 }),
        expected_group_keys: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32, uniqueItems: true }),
        unresolved_questions: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 32 }),
        assumptions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 16 })),
        source_excerpts: Type.Optional(Type.Array(Type.Object({ asset_id: Type.String(), content_hash: Type.String(), quote: Type.String() }), { maxItems: 16 })),
        result_cells: Type.Optional(Type.Array(Type.Object({ resource_id: Type.String(), execution_id: Type.String(), row: Type.Integer({ minimum: 0 }), column: Type.String() }), { maxItems: 16 })),
      }, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async (_toolCallId, params) => {
        if (!isAnalysisDeclaration(params)) return pack({ ok: false, code: "invalid_analysis_declaration" });
        return pack({ ok: true, analysis_record: records.update(params), notice: "工作记录是模型自报，不是授权或证据；可继续调用工具。" });
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
