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

async function createLiveStream(config: AppConfig): Promise<ModelStream> {
  if (!config.piApiKey) {
    throw new Error("MODEL_MODE=pi 需要 PI_API_KEY。本地演示请使用 MODEL_MODE=deterministic，它不会访问外部模型。");
  }
  const { createModels: createLiveModels } = await import("@earendil-works/pi-ai");
  const models = createLiveModels();
  if (config.piProvider !== "anthropic") {
    throw new Error(`当前适配层只接了 anthropic，收到 ${config.piProvider}。`);
  }
  const { anthropicProvider } = await import("@earendil-works/pi-ai/providers/anthropic");
  models.setProvider(anthropicProvider());
  const model = models.getModel(config.piProvider, config.piModel);
  if (!model) throw new Error(`找不到模型 ${config.piProvider}/${config.piModel}`);
  return {
    model: model as Model<string>,
    streamFn: models.streamSimple.bind(models) as StreamFn,
    getApiKey: () => config.piApiKey,
  };
}

export function domainTools(sessionId: string, tools: ToolService): AgentTool[] {
  const pack = (result: { ok: boolean }) => ({
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    details: result,
    isError: result.ok === false,
  });
  return [
    {
      name: "search_assets",
      label: "搜索资产",
      description: "按关键词发现资产卡片。结果不含正文，也不授予读取或查询权限。",
      parameters: Type.Object({
        query: Type.String({ description: "搜索词" }),
        kinds: Type.Optional(Type.Array(Type.String(), { description: "可选的资产类型过滤" })),
      }),
      execute: async (_toolCallId, params, signal) => pack(await tools.searchAssets(sessionId, params as { query?: string; kinds?: string[] }, signal)),
    },
    {
      name: "read_asset",
      label: "读取资产",
      description: "读取一个已授权资产的正文。这不会创建查询绑定。",
      parameters: Type.Object({ asset_id: Type.String({ description: "资产 ID" }) }),
      execute: async (_toolCallId, params, signal) => pack(await tools.readAsset(sessionId, params as { asset_id?: string }, signal)),
    },
    {
      name: "read_assets",
      label: "批量读取资产",
      description: "逐个授权读取多个资产正文。任一资产失败不会放开其余资产。",
      parameters: Type.Object({
        asset_ids: Type.Array(Type.String(), { description: "资产 ID 列表" }),
        offset: Type.Optional(Type.Number({ description: "分页起点" })),
        limit: Type.Optional(Type.Number({ description: "本页条数" })),
      }),
      execute: async (_toolCallId, params, signal) =>
        pack(await tools.readAssets(sessionId, params as { asset_ids?: string[]; offset?: number; limit?: number }, signal)),
    },
    {
      name: "read_data_contract_view",
      label: "读取数据契约",
      description: "读取表契约的受控视图。只有服务端判定可查询时才会写下当前绑定。",
      parameters: Type.Object({ asset_id: Type.String({ description: "契约资产 ID" }) }),
      execute: async (_toolCallId, params, signal) => pack(await tools.readDataContractView(sessionId, params as { asset_id?: string }, signal)),
    },
    {
      name: "query",
      label: "受控查询",
      description: "执行一条受治理的只读 SQL。必须先有当前契约绑定。",
      parameters: Type.Object({
        sql: Type.String({ description: "单条只读 SQL" }),
        purpose: Type.Optional(Type.String({ description: "查询用途" })),
        knowledge_body_visible: Type.Optional(Type.Boolean({ description: "模型是否已在本轮上下文看到资产正文。服务端不把它当作查询许可。" })),
      }),
      executionMode: "sequential",
      execute: async (_toolCallId, params, signal) => pack(await tools.query(sessionId, params as { sql?: string; purpose?: string }, signal)),
    },
    {
      name: "calculate_session_cells",
      label: "计算会话单元格",
      description: "只对当前会话中的查询资源做汇总。缺失值不会被当成零，预测值不会并入实际值。",
      parameters: Type.Object({
        resource_id: Type.String({ description: "当前会话的查询资源 ID" }),
        operations: Type.Array(
          Type.Object({
            op: Type.Union([Type.Literal("sum"), Type.Literal("count_null"), Type.Literal("count_zero"), Type.Literal("count_rows")]),
            column: Type.Optional(Type.String()),
            predicted: Type.Optional(Type.Union([Type.Literal("actual_only"), Type.Literal("predicted_only"), Type.Literal("any")])),
            as: Type.String(),
          }),
        ),
      }),
      execute: async (_toolCallId, params, signal) =>
        pack(await tools.calculateSessionCells(sessionId, params as { resource_id?: string; operations?: CellOperation[] }, signal)),
    },
    {
      name: "read_session_resource",
      label: "读取会话资源",
      description: "读取当前会话已经生成的查询或计算结果。不能跨会话读取。",
      parameters: Type.Object({ resource_id: Type.String({ description: "资源 ID" }) }),
      execute: async (_toolCallId, params, signal) => pack(await tools.readSessionResource(sessionId, params as { resource_id?: string }, signal)),
    },
    {
      name: "update_analysis",
      label: "更新分析",
      description: "提交分析建议。服务端会按证据决定完成、部分完成、澄清或失败，模型建议不是终态。",
      parameters: Type.Object({
        suggested_status: Type.Union([
          Type.Literal("completed"),
          Type.Literal("partial"),
          Type.Literal("needs_clarification"),
          Type.Literal("failed"),
        ]),
        draft_answer: Type.String({ description: "模型草稿，不是权威答案" }),
        resource_ids: Type.Array(Type.String(), { description: "本会话证据资源" }),
        clarification_question: Type.Optional(Type.String()),
        limitations: Type.Optional(Type.Array(Type.String())),
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
      execute: async (_toolCallId, params, signal) => pack(await tools.updateAnalysis(sessionId, params as AnalysisInput, signal)),
    },
  ];
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
