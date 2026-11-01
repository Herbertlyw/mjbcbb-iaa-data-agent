import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory, type TranscriptContext } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  parseSessionEntries,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AppConfig } from "./config.js";
import { thinkingLevelMap } from "./model-catalog.js";
import { registerOpenAICompatible, type ProviderLedger } from "./openai-gateway.js";
import type { AnalysisRecord } from "./types.js";
import { domainTools } from "./agent.js";
import { planFromTranscript } from "./planner.js";
import type { ToolService } from "./tools.js";

export const SESSION_SNAPSHOT_FORMAT = "pi-coding-agent-session-jsonl-v3";
export const SDK_NAME = "@earendil-works/pi-coding-agent";
export const SDK_VERSION = "1.1.0";

export const DATA_ANALYSIS_SYSTEM_PROMPT = `你是本地只读数据分析代理。这里的数据和例子都是虚构的合成数据，不是任何公司的生产库。
先理解问题要的指标、时间范围、粒度、分组和筛选。范围不够时说明需要澄清什么，不要编造查询。
需要事实时先搜索已发布资产。正文一次读不完就分页阅读，并在查询前读取对应数据契约。
只有权限、封闭时间范围、粒度和已登记的连接键都成立时，才执行只读查询。不要使用编码、文件或 shell 工具。
把四件事分开：值为 NULL 的缺失、根本没有行的日期、观测到的真实零、以及预测值。预测不计入实际，缺失和缺行不要补成零。
通过会话资源回读和计算形成可溯源结论，并写明限制与覆盖。每个正式数字都要引用本次任务的查询或计算结果。
证据不足、契约失效、新鲜度不是已发布的新鲜状态、结果被截断或连接不成立时，明确说明不能得出结论。
完成状态只是建议。服务端会核对主体、会话、任务、契约哈希、新鲜度回执、截断和覆盖。模型草稿里的数字不会自动变成已验证事实。`;

const CODING_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"]);
const DOMAIN_TOOL_NAMES = [
  "search_assets",
  "read_asset",
  "read_assets",
  "read_data_contract_view",
  "query",
  "calculate_session_cells",
  "read_session_resource",
  "update_analysis",
];

const modelRequests = new Map<string, { knowledgeBodyChars: number; roles: string[] }>();

export function modelRequestEvidence(sessionId: string): { knowledgeBodyChars: number; roles: string[] } | undefined {
  return modelRequests.get(sessionId);
}

export class SessionSnapshotError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SessionSnapshotError";
  }
}

export interface PiSessionSnapshotBody {
  format: typeof SESSION_SNAPSHOT_FORMAT;
  sdk: typeof SDK_NAME;
  sdk_version: typeof SDK_VERSION;
  leaf_id: string | null;
  branch_entry_ids: string[];
  user_message_sha256: string;
  jsonl: string;
}

interface ContextMessage {
  role?: string;
  toolName?: string;
  isError?: boolean;
  content?: unknown;
}

export type ResumeDecision =
  | { action: "prompt"; decision: "new_turn" }
  | { action: "continue"; decision: "model_turn_redone" | "tool_result_reread" | "compaction_checkpoint_continued"; query_may_rerun: false }
  | { action: "reread"; decision: "reread_candidate"; query_may_rerun: false }
  | { action: "redo_tool_call"; decision: "redo_unfinished_tool_call"; branchFromId: string; query_may_rerun: true }
  | { action: "reject"; decision: "reject"; code: string; message: string; query_may_rerun: false };

export function decideResume(input: {
  contextMessages: ContextMessage[];
  leafParentId: string | null;
  jobUserText: string;
  hasAnalysis: boolean;
  resumingProgress: boolean;
  compactionInspected?: boolean;
  compactionHidesToolResults?: boolean;
  userTextPersisted?: boolean;
}): ResumeDecision {
  if (!input.resumingProgress) return { action: "prompt", decision: "new_turn" };
  const last = input.contextMessages.at(-1);
  if (last?.role === "compactionSummary") {
    if (input.compactionInspected !== true) {
      return {
        action: "reject",
        decision: "reject",
        code: "session_not_continuable",
        message: "压缩摘要不是用户原话，也不能当作可继续的回合。",
        query_may_rerun: false,
      };
    }
    if (input.compactionHidesToolResults) {
      return {
        action: "reject",
        decision: "reject",
        code: "compaction_hides_tool_results",
        message: "压缩摘要不在活动分支上保留已执行的工具回执。不会重放查询，也不会把摘要当成用户原话。",
        query_may_rerun: false,
      };
    }
    if (input.userTextPersisted !== true) {
      return {
        action: "reject",
        decision: "reject",
        code: "session_message_mismatch",
        message: "会话文件里找不到当前用户原话。压缩摘要不能代替它。",
        query_may_rerun: false,
      };
    }
    return { action: "continue", decision: "compaction_checkpoint_continued", query_may_rerun: false };
  }
  const userTexts = input.contextMessages.filter((message) => message.role === "user").map(messageText);
  if (!userTexts.includes(input.jobUserText)) {
    return { action: "reject", decision: "reject", code: "session_message_mismatch", message: "进度快照的活动分支没有当前用户原话。", query_may_rerun: false };
  }
  if (!last) return { action: "reject", decision: "reject", code: "session_not_continuable", message: "活动分支没有可继续的消息。", query_may_rerun: false };
  if (last.role === "user") {
    return { action: "continue", decision: "model_turn_redone", query_may_rerun: false };
  }
  if (last.role === "toolResult") {
    if (last.toolName === "update_analysis" && last.isError !== true) {
      if (!input.hasAnalysis) {
        return {
          action: "reject",
          decision: "reject",
          code: "tool_receipt_missing",
          message: "会话分支有分析工具回执，权威状态里没有对应结果。不会补写答案。",
          query_may_rerun: false,
        };
      }
      return { action: "reread", decision: "reread_candidate", query_may_rerun: false };
    }
    return { action: "continue", decision: "tool_result_reread", query_may_rerun: false };
  }
  if (last.role === "assistant" && !hasToolCall(last)) {
    return { action: "reread", decision: "reread_candidate", query_may_rerun: false };
  }
  if (last.role === "assistant" && hasToolCall(last)) {
    if (!input.leafParentId) {
      return { action: "reject", decision: "reject", code: "session_not_continuable", message: "未完成的工具调用没有可回退的父记录。", query_may_rerun: false };
    }
    return { action: "redo_tool_call", decision: "redo_unfinished_tool_call", branchFromId: input.leafParentId, query_may_rerun: true };
  }
  return {
    action: "reject",
    decision: "reject",
    code: "session_not_continuable",
    message: "活动分支停在无法继续的位置。不会用消息数组凑一份上下文。",
    query_may_rerun: false,
  };
}

export function captureSessionSnapshot(session: AgentSession, userText: string): PiSessionSnapshotBody {
  const file = session.sessionManager.getSessionFile();
  if (!file) throw new SessionSnapshotError("session_snapshot_missing", "SessionManager 还没有会话文件，不能保存空快照。");
  let jsonl: string;
  try {
    jsonl = readFileSync(file, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") throw new SessionSnapshotError("session_snapshot_missing", "会话文件尚未落盘。");
    throw error;
  }
  parseSessionEntries(jsonl);
  const branch = session.sessionManager.getBranch();
  return {
    format: SESSION_SNAPSHOT_FORMAT,
    sdk: SDK_NAME,
    sdk_version: SDK_VERSION,
    leaf_id: session.sessionManager.getLeafId(),
    branch_entry_ids: branch.map((entry) => entry.id),
    user_message_sha256: createHash("sha256").update(userText).digest("hex"),
    jsonl,
  };
}

export interface GovernedSession {
  session: AgentSession;
  root: string;
  dispose: () => void;
}

export async function openGovernedSession(input: {
  config: AppConfig;
  appSessionId: string;
  tools: ToolService;
  userText: string;
  snapshot?: PiSessionSnapshotBody;
  requireUserText?: boolean;
  ledger?: ProviderLedger;
  modelId?: string;
  reasoning?: string;
}): Promise<GovernedSession> {
  if (input.config.modelMode === "pi" && input.config.piProvider !== "faux" && !input.config.piApiKey) {
    throw new SessionSnapshotError("provider_unavailable", "MODEL_MODE=pi 需要 PI_API_KEY，或显式 PI_PROVIDER=faux。不会改用消息数组。");
  }
  if (input.snapshot) assertSnapshot(input.snapshot, input.userText, input.requireUserText === true);
  const root = path.join(tmpdir(), `lumenfox-pi-${process.pid}-${Date.now()}`);
  const cwd = path.join(root, "cwd");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(root, "sessions");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      compaction: {
        enabled: true,
        reserveTokens: input.config.compactionReserveTokens,
        keepRecentTokens: input.config.compactionKeepRecentTokens,
      },
      retry: { enabled: false },
      defaultTools: [],
    }),
  );
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  let model;
  const selectedModel = input.modelId ?? input.config.piModel;
  const selectedReasoning = input.reasoning ?? input.config.piReasoning;
  if (input.config.piProvider === "openai-compatible") {
    if (!input.ledger) throw new SessionSnapshotError("provider_unavailable", "OpenAI 兼容供应商缺少任务账本。不会改用 faux。");
    registerOpenAICompatible(runtime, { ...input.config, piModel: selectedModel, piReasoning: selectedReasoning }, input.ledger);
    model = runtime.getModel("openai-compatible", selectedModel);
  } else if (input.config.piProvider === "faux") {
    const faux = fauxProvider({
      provider: "lumenfox-local",
      api: "faux",
      models: [
        {
          id: "deterministic-analyst",
          name: "Deterministic local analyst",
          reasoning: false,
          input: ["text"],
          contextWindow: input.config.fauxContextWindow,
          maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    const step: FauxResponseFactory = async (context, options) => {
      faux.appendResponses([step]);
      rememberRequest(input.appSessionId, context);
      if (input.config.modelHoldMs > 0) await delay(input.config.modelHoldMs, options?.signal);
      if (isSummarization(context)) return compactionSummary(context);
      return planFromTranscript(context, input.config.knowledgeDir);
    };
    faux.setResponses([step]);
    runtime.registerNativeProvider(faux.provider);
    model = runtime.getModel("lumenfox-local", "deterministic-analyst");
  } else {
    if (input.config.piProvider !== "anthropic") {
      throw new SessionSnapshotError("provider_unavailable", `当前只接了 anthropic 或显式 faux，收到 ${input.config.piProvider}。`);
    }
    await runtime.setRuntimeApiKey(input.config.piProvider, input.config.piApiKey);
    model = runtime.getModel(input.config.piProvider, selectedModel);
  }
  if (!model) throw new SessionSnapshotError("provider_unavailable", "ModelRuntime 没有返回可用模型。");
  const sessionManager = input.snapshot ? openSnapshot(input.snapshot.jsonl, sessionDir, cwd) : SessionManager.create(cwd, sessionDir);
  if (input.snapshot) {
    const leafId = sessionManager.getLeafId();
    const branchIds = sessionManager.getBranch().map((entry) => entry.id);
    if (leafId !== input.snapshot.leaf_id || !sameIds(branchIds, input.snapshot.branch_entry_ids)) {
      throw new SessionSnapshotError("session_branch_mismatch", "打开后的活动分支或 leaf 与已保存快照不一致。");
    }
  }
  const settings = SettingsManager.create(cwd, agentDir);
  settings.setRetryEnabled(false);
  settings.setCompactionEnabled(true);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    noThemes: true,
    disabledBuiltinExtensions: ["mcp"],
    systemPrompt: DATA_ANALYSIS_SYSTEM_PROMPT,
  });
  await resourceLoader.reload();
  const requestedLevel = selectedReasoning as ThinkingLevel;
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    thinkingLevel: requestedLevel,
    modelRuntime: runtime,
    settingsManager: settings,
    sessionManager,
    resourceLoader,
    noTools: "all",
    tools: DOMAIN_TOOL_NAMES,
    excludeTools: [...CODING_TOOLS],
    customTools: domainTools(input.appSessionId, input.tools).map(asDefinition),
  });
  if (session.thinkingLevel !== requestedLevel) {
    session.dispose();
    rmSync(root, { recursive: true, force: true });
    throw new SessionSnapshotError(
      "reasoning_not_enabled",
      `AgentSession 的思考档位是 ${session.thinkingLevel}，任务要求 ${requestedLevel}。不会静默改档。`,
    );
  }
  const registered = session.getAllTools().map((tool) => tool.name);
  if (registered.some((name) => CODING_TOOLS.has(name) || name.startsWith("mcp__")) || registered.length !== DOMAIN_TOOL_NAMES.length) {
    session.dispose();
    throw new SessionSnapshotError("session_tooling_unsafe", `会话工具不是受治理的领域工具：${registered.join(",")}`);
  }
  return {
    session,
    root,
    dispose: () => {
      session.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function openSnapshot(jsonl: string, sessionDir: string, cwd: string): SessionManager {
  let entries;
  try {
    entries = parseSessionEntries(jsonl);
  } catch (error) {
    throw new SessionSnapshotError("session_snapshot_corrupt", `会话 JSONL 无法解析：${error instanceof Error ? error.message : "未知错误"}`);
  }
  if (!entries.some((entry) => entry.type === "session")) {
    throw new SessionSnapshotError("session_snapshot_corrupt", "会话 JSONL 缺少 session 头。");
  }
  const file = path.join(sessionDir, "restored.jsonl");
  writeFileSync(file, jsonl);
  try {
    return SessionManager.open(file, sessionDir, cwd);
  } catch (error) {
    throw new SessionSnapshotError("session_snapshot_corrupt", `SessionManager 拒绝该快照：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

function assertSnapshot(snapshot: PiSessionSnapshotBody, userText: string, requireUserText: boolean): void {
  if (snapshot.format !== SESSION_SNAPSHOT_FORMAT || snapshot.sdk !== SDK_NAME || snapshot.sdk_version !== SDK_VERSION) {
    throw new SessionSnapshotError("session_snapshot_corrupt", "快照格式不是 pi-coding-agent 1.1.0 的 JSONL。不会回退到消息数组。");
  }
  if (!Array.isArray(snapshot.branch_entry_ids) || snapshot.leaf_id === undefined || typeof snapshot.jsonl !== "string") {
    throw new SessionSnapshotError("session_snapshot_corrupt", "快照缺少活动分支 entry id 或 JSONL。");
  }
  const digest = createHash("sha256").update(userText).digest("hex");
  if (requireUserText && (snapshot.user_message_sha256 !== digest || !snapshot.jsonl.includes(userText))) {
    throw new SessionSnapshotError("session_message_mismatch", "进度快照的用户消息哈希或原文与当前任务不一致。");
  }
}

function asDefinition(tool: ReturnType<typeof domainTools>[number]): ToolDefinition {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
    execute: (toolCallId, params, signal) => tool.execute(toolCallId, params, signal),
  };
}

function rememberRequest(sessionId: string, context: TranscriptContext): void {
  let knowledgeBodyChars = 0;
  for (const message of context.messages) {
    if (!message || message.role !== "toolResult") continue;
    const text = messageText(message);
    if (text.includes("\"body\"")) knowledgeBodyChars += text.length;
  }
  modelRequests.set(sessionId, { knowledgeBodyChars, roles: context.messages.map((message) => message.role) });
}

function isSummarization(context: TranscriptContext): boolean {
  return context.messages.some((message) => {
    if (!message || message.role !== "user") return false;
    const text = messageText(message);
    return text.includes("The messages above are") || text.includes("Create a concise checkpoint of the user's request");
  });
}

function compactionSummary(context: TranscriptContext): ReturnType<typeof fauxAssistantMessage> {
  const users = context.messages
    .filter((message) => message?.role === "user")
    .map(messageText)
    .filter((text) => !text.startsWith("The messages above are"));
  return fauxAssistantMessage(
    `## Goal\n继续已保存的分析。\n\n## Constraints & Preferences\n- 原始用户约束仍以会话中的 user 记录为准：${users.join(" | ") || "(none)"}\n\n这是压缩摘要，不是新的用户原话，也不是已提交答案。`,
    { stopReason: "stop" },
  );
}

export function candidateFromContext(messages: ContextMessage[], jobId: string): AnalysisRecord | null {
  const last = messages.at(-1);
  if (!last || last.role !== "toolResult" || last.toolName !== "update_analysis" || last.isError === true) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(messageText(last)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (payload.ok !== true || payload.job_id !== jobId || typeof payload.analysis_id !== "string" || typeof payload.answer !== "string") return null;
  return payload as unknown as AnalysisRecord;
}

export function messageCallId(message: { role?: string; toolCallId?: string; toolName?: string; content?: unknown }): string | null {
  if (message.role === "toolResult" && message.toolCallId) return message.toolCallId;
  const block = toolCallBlock(message);
  return block?.id ?? null;
}

export function messageToolName(message: { role?: string; toolName?: string; content?: unknown }): string | null {
  if (message.role === "toolResult" && message.toolName) return message.toolName;
  return toolCallBlock(message)?.name ?? null;
}

function toolCallBlock(message: { content?: unknown }): { id?: string; name?: string } | undefined {
  if (!Array.isArray(message.content)) return undefined;
  return message.content.find((item) => item && typeof item === "object" && (item as { type?: string }).type === "toolCall") as { id?: string; name?: string } | undefined;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

function holdSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export { holdSync };

export function inspectCompaction(
  entries: readonly { type: string; message?: { role?: string; content?: unknown; toolCallId?: string } }[],
  contextMessages: readonly { role?: string; toolCallId?: string }[],
  userText: string,
): { hidesToolResults: boolean; userTextPersisted: boolean } {
  const visible = new Set(contextMessages.filter((message) => message.role === "toolResult" && message.toolCallId).map((message) => message.toolCallId));
  const hidesToolResults = entries.some((entry) => entry.type === "message" && entry.message?.role === "toolResult" && !visible.has(entry.message.toolCallId));
  const userTextPersisted = entries.some((entry) => entry.type === "message" && entry.message?.role === "user" && messageText(entry.message).includes(userText));
  return { hidesToolResults, userTextPersisted };
}

function messageText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && "text" in block ? String((block as { text?: unknown }).text ?? "") : ""))
    .join("");
}

function hasToolCall(message: ContextMessage): boolean {
  return Array.isArray(message.content) && message.content.some((block) => block && typeof block === "object" && (block as { type?: string }).type === "toolCall");
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
