import { randomUUID } from "node:crypto";
import { streamSimple as openAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "./config.js";
import { GlobalBudget } from "./global-budget.js";
import { thinkingLevelMap } from "./model-catalog.js";
import { compactPreviousAnalyses } from "./provider-context.js";
import { DOMAIN_TOOL_NAMES } from "./domain-tool-names.js";
import { observeProviderUsage, waitForProviderUsage, type ProviderUsageObservation, type ProviderUsageReceipt } from "./provider-usage.js";
import type { ProviderStepRecord, StateStore } from "./state-store.js";

export interface ProviderLedger {
  sessionId: string;
  jobId: string;
  actorId: string;
  owner: string;
  fence: number;
  state: { [K in "beginProviderStep" | "saveProviderPayload" | "settleProviderStep"]: (...args: Parameters<StateStore[K]>) => Promise<ReturnType<StateStore[K]>> };
}

export function registerOpenAICompatible(runtime: ModelRuntime, config: AppConfig, ledger: ProviderLedger, deliveredCalls: () => ReadonlySet<string> = () => new Set()): void {
  const deepseek = config.piProvider === "deepseek";
  runtime.registerProvider(config.piProvider, {
    name: deepseek ? "DeepSeek" : "OpenAI-compatible",
    baseUrl: config.piBaseUrl,
    apiKey: config.piApiKey,
    api: "openai-completions",
    headers: config.protocolScript ? { "x-script": config.protocolScript } : undefined,
    models: [
      {
        id: config.piModel,
        name: config.piModel,
        api: "openai-completions",
        reasoning: deepseek || config.enabledReasoning.some((level) => level !== "off"),
        thinkingLevelMap: thinkingLevelMap(config.enabledReasoning),
        input: ["text"],
        contextWindow: config.piContextWindow,
        maxTokens: config.piMaxOutputTokens,
        baseUrl: config.piBaseUrl,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...(deepseek ? { compat: { thinkingFormat: "deepseek" as const, supportsReasoningEffort: true, requiresReasoningContentOnAssistantMessages: true, maxTokensField: "max_tokens" as const, supportsStore: false } } : {}),
      },
    ],
    streamSimple: (model, context, options) => {
      const outer = createAssistantMessageEventStream();
      const providerContext = compactPreviousAnalyses(context, deliveredCalls());
      const estimate = estimateContextTokens(providerContext);
      const stepId = `step_${randomUUID()}`;
      const started = Date.now();
      void (async () => {
      let globalBudget: GlobalBudget | undefined;
      let globalReserved = false;
      let globalSettled = false;
      const usageCapture: { observation?: ProviderUsageObservation } = {};
      let rejectedHttpStatus: number | undefined;
      try {
      assertDispatchTarget(config.piBaseUrl, deepseek && config.allowRemoteHttps);
      const began = await ledger.state.beginProviderStep({
        stepId,
        sessionId: ledger.sessionId,
        jobId: ledger.jobId,
        actorId: ledger.actorId,
        owner: ledger.owner,
        fence: ledger.fence,
        provider: config.piProvider,
        model: config.piModel,
        estimatedInput: estimate.tokens,
        reservedOutput: config.piMaxOutputTokens,
        estimateSource: estimate.source,
        contextWindow: config.piContextWindow,
        maxTokens: config.maxKnownTokens,
        maxModelCalls: config.maxModelCalls,
        maxToolCalls: config.maxToolCalls,
        wallClockMs: config.jobTimeoutMs,
        maxResourceBytes: config.maxResultBytes,
      });
      if (!began.ok) throw new Error(began.code);
      const recorded = await ledger.state.saveProviderPayload({
        payloadId: `req_${stepId}`,
        stepId,
        sessionId: ledger.sessionId,
        actorId: ledger.actorId,
        jobId: ledger.jobId,
        owner: ledger.owner,
        fence: ledger.fence,
        kind: "request",
        body: JSON.stringify({ format: "metadata-only", estimated_input: estimate.tokens, estimate_source: estimate.source, context_window: config.piContextWindow, reserved_output: config.piMaxOutputTokens, context_sizes: contextSizeStats(providerContext) }),
      });
      if (!recorded) throw new Error("provider_fence_rejected");
      const markNotDispatched = async (code: string) => {
        const rejected = await ledger.state.settleProviderStep({ stepId, jobId: ledger.jobId, owner: ledger.owner, fence: ledger.fence, status: "not_dispatched", inputTokens: null, outputTokens: null, usageSource: "unknown", durationMs: Date.now() - started, errorCode: code });
        if (!rejected.ok) throw new Error(rejected.code);
      };
      if (options?.signal?.aborted) {
        await markNotDispatched("provider_cancelled");
        throw new Error("provider_cancelled");
      }
      if (config.globalBudgetId) {
        try {
        globalBudget = await GlobalBudget.open({ path: config.globalBudgetPath, budgetId: config.globalBudgetId, maxRequests: config.globalBudgetMaxRequests, maxTokens: config.globalBudgetMaxTokens });
        const reservation = await globalBudget.reserve({ stepId, jobId: ledger.jobId, estimatedInput: estimate.tokens, reservedOutput: config.piMaxOutputTokens });
        if (!reservation.ok) throw new Error(reservation.code);
        globalReserved = true;
        if (options?.signal?.aborted) throw new Error("provider_cancelled");
        const dispatch = await globalBudget.markDispatched(stepId);
        if (!dispatch.ok) throw new Error(dispatch.code);
        } catch (error) {
          // No transport has been created yet: the task can distinguish a
          // definite non-dispatch even if the separate budget commit timed out.
          // The global reservation remains held whenever its outcome is unknown.
          await markNotDispatched(safeProviderError(error).code);
          throw error;
        }
      }
      const physical = { ...model, api: "openai-completions" as const, baseUrl: config.piBaseUrl, provider: config.piProvider };
      let stream;
      try {
        const transport = deepseek && config.allowRemoteHttps && new URL(config.piBaseUrl).origin === "https://api.deepseek.com" ? fetchDeepSeekOnly : fetchLoopbackOnly;
        let dispatched = false;
        const observedTransport: typeof fetch = async (request, init) => {
          // One durable reservation permits at most one transport invocation,
          // even if a future SDK version changes its retry behavior.
          if (dispatched) throw new Error("provider_outcome_unknown");
          dispatched = true;
          const response = await transport(request, init);
          // Persist only a bounded HTTP status category, never provider error
          // bodies or headers. The SDK may omit the status from its message.
          if (!response.ok && response.status >= 400 && response.status <= 599)
            rejectedHttpStatus = response.status;
          usageCapture.observation = observeProviderUsage(response);
          return response;
        };
        stream = openAICompletions(physical as Model<"openai-completions">, providerContext, { ...options, fetch: observedTransport, maxRetries: 0 });
      } catch (error) {
        const settled = await ledger.state.settleProviderStep({
          stepId,
          jobId: ledger.jobId,
          owner: ledger.owner,
          fence: ledger.fence,
          status: "error",
          inputTokens: null,
          outputTokens: null,
          usageSource: "unknown",
          durationMs: Date.now() - started,
          errorCode: safeProviderError(error).code,
        });
        if (!settled.ok) throw new Error(settled.code);
        throw error;
      }
      // Hold the terminal event until the response metadata and budget are
      // durably settled. Otherwise Pi could start the next tool/model call
      // while a failed or stale ledger write is still in flight.
      let terminal: AssistantMessageEvent | undefined;
      for await (const event of stream) {
        if (event.type === "done" || event.type === "error") terminal = event;
        else outer.push(event);
      }
      if (!terminal) throw new Error("provider_outcome_unknown");
      const message = await stream.result();
      if (message.stopReason === "error" && rejectedHttpStatus !== undefined) {
        message.errorMessage = `HTTP ${rejectedHttpStatus}`;
        if (terminal.type === "error") terminal = { ...terminal, error: message };
      }
      const reportedUsage = usageCapture.observation ? await waitForProviderUsage(usageCapture.observation) : null;
      if (globalBudget) {
        const settlement = await globalBudget.settle({ stepId, outcome: message.stopReason === "aborted" ? "cancelled" : message.stopReason === "error" ? "error" : "completed", inputTokens: reportedUsage?.inputTokens ?? null, outputTokens: reportedUsage?.outputTokens ?? null, cacheHitTokens: reportedUsage?.cacheHitTokens ?? null, cacheMissTokens: reportedUsage?.cacheMissTokens ?? null });
        if (!settlement.ok) throw new Error(settlement.code);
        globalSettled = true;
      }
      await settleFromMessage(ledger, stepId, started, message, config.protocolScript ? "simulated" : "reported", reportedUsage);
      outer.push(terminal);
      outer.end(message);
      } finally {
        usageCapture.observation?.cancel();
        if (globalBudget) {
          if (globalReserved && !globalSettled) {
            // Never infer rollback after a timeout, including before dispatch.
            await globalBudget.settle({ stepId, outcome: "outcome_unknown", inputTokens: null, outputTokens: null }).catch(() => undefined);
          }
          await globalBudget.close();
        }
      }
      })().catch((error: unknown) => {
        const code = error instanceof Error && /mysql_state_(?:outcome_unknown|closed|operation_failed)/u.test(error.message) ? "provider_outcome_unknown" : safeProviderError(error).code;
        const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: code, timestamp: started };
        outer.push({ type: "error", reason: "error", error: message });
        outer.end(message);
      });
      return outer;
    },
  });
}

export function estimateContextTokens(context: unknown): { tokens: number; source: "utf8_byte_estimate" } {
  const text = JSON.stringify(context);
  // A deliberately conservative UTF-8 heuristic, not measured provider usage
  // or a guaranteed upper bound for an unknown provider tokenizer.
  return { tokens: Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 2)), source: "utf8_byte_estimate" };
}

/** Size diagnostics only: never persist text, arguments, IDs or arbitrary tool names. */
export function contextSizeStats(context: { messages: ReadonlyArray<{ role: string; toolName?: string }> }): Record<string, { messages: number; utf8_bytes: number }> {
  const buckets: Record<string, { messages: number; utf8_bytes: number }> = Object.create(null);
  const tools: ReadonlySet<string> = new Set(DOMAIN_TOOL_NAMES);
  for (const message of context.messages) {
    const role = ["user", "assistant", "toolResult"].includes(message.role) ? message.role : "other";
    const key = role === "toolResult" ? `tool:${tools.has(message.toolName ?? "") ? message.toolName : "other"}` : role;
    const bucket = buckets[key] ??= { messages: 0, utf8_bytes: 0 };
    bucket.messages++;
    bucket.utf8_bytes += Buffer.byteLength(JSON.stringify(message), "utf8");
  }
  return buckets;
}

export function assertDispatchTarget(baseUrl: string, allowDeepSeek = false): void {
  const url = new URL(baseUrl);
  if (allowDeepSeek && url.origin === "https://api.deepseek.com" && (url.pathname === "/" || url.pathname === "/v1" || url.pathname === "/chat/completions" || url.pathname === "/v1/chat/completions") && !url.username && !url.password && !url.search && !url.hash) return;
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.search || url.hash) {
    throw new Error("remote_dispatch_disabled");
  }
}

// Validate every actual HTTP request as well as the configured base URL. In
// particular, an otherwise valid local service must not redirect a request
// (and its authorization header) to an uncontrolled destination.
export const fetchLoopbackOnly: typeof fetch = async (input, init) => {
  const address = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  assertDispatchTarget(address);
  return globalThis.fetch(input, { ...init, redirect: "error" });
};

export const fetchDeepSeekOnly: typeof fetch = async (input, init) => {
  const address = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(address);
  if (url.origin !== "https://api.deepseek.com") throw new Error("remote_dispatch_disabled");
  assertDispatchTarget(address, true);
  return globalThis.fetch(input, { ...init, redirect: "error" });
};

export function usageFromSteps(steps: ProviderStepRecord[]): {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_hit_tokens: number | null;
  cache_miss_tokens: number | null;
  usage_source: "simulated" | "reported" | "unknown" | "not_dispatched";
} {
  const sent = steps.filter((step) => step.status !== "not_dispatched");
  if (!sent.length && steps.length) return { input_tokens: null, output_tokens: null, cache_hit_tokens: null, cache_miss_tokens: null, usage_source: "not_dispatched" };
  const source = sent[0]?.usage_source;
  if (source === undefined || source === "unknown" || sent.some((step) => step.usage_source !== source || step.input_tokens === null || step.output_tokens === null)) {
    return { input_tokens: null, output_tokens: null, cache_hit_tokens: null, cache_miss_tokens: null, usage_source: "unknown" };
  }
  return {
    input_tokens: sent.reduce((sum, step) => sum + (step.input_tokens ?? 0), 0),
    output_tokens: sent.reduce((sum, step) => sum + (step.output_tokens ?? 0), 0),
    cache_hit_tokens: sent.every((step) => step.cache_hit_tokens != null) ? sent.reduce((sum, step) => sum + (step.cache_hit_tokens ?? 0), 0) : null,
    cache_miss_tokens: sent.every((step) => step.cache_miss_tokens != null) ? sent.reduce((sum, step) => sum + (step.cache_miss_tokens ?? 0), 0) : null,
    usage_source: source,
  };
}

export function safeProviderError(error: unknown): { code: string; message: string } {
  const raw = error instanceof Error ? error.message : "供应商请求失败";
  const redacted = raw.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/api[_-]?key[^,\s]*/gi, "[redacted]");
  if (/timeout|timed out/i.test(redacted)) return { code: "provider_timeout", message: "供应商请求超时。用量未知，不会记成 0。" };
  if (/401|403|api key|unauthorized/i.test(redacted)) return { code: "provider_auth_rejected", message: "供应商拒绝了认证。密钥不会写入日志。" };
  if (/\b429\b|rate.limit/i.test(redacted)) return { code: "provider_rate_limited", message: "供应商限流；未自动重试，用量按未知处理。" };
  if (/\b402\b|insufficient.balance/i.test(redacted)) return { code: "provider_balance_insufficient", message: "供应商报告余额不足；未自动重试。" };
  if (/\b400\b|bad.request/i.test(redacted)) return { code: "provider_invalid_request", message: "供应商拒绝了请求格式；未记录原始请求或错误正文。" };
  if (/aborted|cancel/i.test(redacted)) return { code: "provider_cancelled", message: "供应商请求已取消。" };
  if (/\bconnection error\b|\bfetch failed\b|\bE(?:CONNRESET|CONNREFUSED|NOTFOUND|AI_AGAIN)\b|provider_connection_error/i.test(redacted)) {
    return { code: "provider_connection_error", message: "连接供应商时发生网络错误。请求是否已送达及用量未知，不会自动重试。" };
  }
  const known = redacted.match(/global_budget_[a-z_]+|provider_outcome_unknown|provider_fence_rejected|token_budget_unknown|budget_exhausted|context_window_exceeded|remote_dispatch_disabled|settlement_conflict|model_not_enabled|reasoning_not_enabled/);
  if (known) {
    const messages: Record<string, string> = {
      global_budget_exhausted: "跨任务供应商预算已用尽，请求没有派发。",
      global_budget_active_mismatch: "跨任务预算未启用或配置不一致，请求没有派发。",
      global_budget_outcome_unknown: "跨任务预算状态未知，请求不会自动重试。",
      budget_exhausted: "本回合的 token 预算或调用次数不够，请求没有派发。费用没有估算。",
      context_window_exceeded: "按完整上下文估算的输入加上授予的输出上限超过了窗口，请求没有派发。",
      token_budget_unknown: "已有一次用量不明的调用，预留仍被占用。不会把它记成 0，也不会继续派发。",
      provider_outcome_unknown: "已有一次派发结果不明。不会重试，也不会把用量记成 0。",
      provider_fence_rejected: "调用记录和当前任务围栏不一致，没有改写权威状态。",
      remote_dispatch_disabled: "模型请求目标未获允许；只允许本机回环地址或显式启用的 DeepSeek 官方 HTTPS 地址。",
      settlement_conflict: "结算和已记录的用量冲突，权威记录没有被覆盖。",
      model_not_enabled: "这个模型没有在服务端启用。",
      reasoning_not_enabled: "这个推理档位没有启用。",
    };
    return { code: known[0], message: messages[known[0]] ?? known[0] };
  }
  return { code: "provider_error", message: "供应商请求失败。日志不包含密钥、请求头或用户原文。" };
}

async function settleFromMessage(ledger: ProviderLedger, stepId: string, started: number, message: AssistantMessage, source: "simulated" | "reported", usage: ProviderUsageReceipt | null): Promise<void> {
  const sawUsage = usage?.inputTokens != null && usage.outputTokens != null && usage.inputTokens + usage.outputTokens > 0;
  const failed = message.stopReason === "error" || message.stopReason === "aborted";
  const recorded = await ledger.state.saveProviderPayload({
    payloadId: `res_${stepId}`,
    stepId,
    sessionId: ledger.sessionId,
    actorId: ledger.actorId,
    jobId: ledger.jobId,
    owner: ledger.owner,
    fence: ledger.fence,
    kind: "response",
    body: JSON.stringify({ format: "metadata-only", failed, usage_source: sawUsage ? source : "unknown", input_tokens: usage?.inputTokens ?? null, output_tokens: usage?.outputTokens ?? null, cache_hit_tokens: usage?.cacheHitTokens ?? null, cache_miss_tokens: usage?.cacheMissTokens ?? null }),
  });
  if (!recorded) throw new Error("provider_fence_rejected");
  const settled = await ledger.state.settleProviderStep({
    stepId,
    jobId: ledger.jobId,
    owner: ledger.owner,
    fence: ledger.fence,
    status: failed ? "error" : "completed",
    // Use the provider's explicit full prompt count, including cache hits.
    // Missing usage cannot be inferred from pi-ai's zero-initialized fields.
    inputTokens: sawUsage ? usage!.inputTokens : null,
    outputTokens: sawUsage ? usage!.outputTokens : null,
    usageSource: sawUsage ? source : "unknown",
    durationMs: Date.now() - started,
    errorCode: failed ? safeProviderError(new Error(message.errorMessage || message.stopReason)).code : null,
  });
  if (!settled.ok) throw new Error(settled.code);
}
