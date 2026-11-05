import { randomUUID } from "node:crypto";
import { canContinueTranscript, captureTranscript, ensureAgent, modelPrompt, restoreAgent, withoutUnfinishedToolCall, type AgentTranscriptSnapshot } from "./agent.js";
import { safeProviderError, usageFromSteps } from "./openai-gateway.js";
import { resolveModelChoice } from "./model-catalog.js";
import {
  candidateFromContext,
  captureSessionSnapshot,
  decideResume,
  inspectCompaction,
  messageCallId,
  messageToolName,
  openGovernedSession,
  SessionSnapshotError,
  type PiSessionSnapshotBody,
} from "./pi-session.js";
import type { AppConfig } from "./config.js";
import { newId, storedSession, type SessionStore } from "./session.js";
import type { StateStore, StoredSession } from "./state-store.js";
import type { AsyncMysqlStateStore } from "./async-mysql-state-store.js";
import { sessionAnalyses, type ToolService } from "./tools.js";
import { naturalCandidate } from "./natural-candidate.js";
import type { AnalysisDeclaration } from "./analysis-declaration.js";
import { passthroughTurn, resolveTurn } from "./turn.js";
import { isTerminal, type AnalysisRecord, type JobRecord, type JobStatus } from "./types.js";

export class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

function submissionError(error: unknown): unknown {
  if (error instanceof Error && error.name === "session_busy") return new RequestError("session_busy", "这个会话还有未结束的任务", 409);
  if (error instanceof Error && error.name === "idempotency_conflict") return new RequestError("idempotency_conflict", "同一个幂等键对应了不同的问题内容", 409);
  return error;
}

export class JobService {
  private readonly owner = `worker_${randomUUID()}`;
  private readonly subscribers = new Map<string, Set<(event: { seq: number; type: string }) => void>>();
  private readonly localAgents = new Map<string, { abort: () => void }>();
  private running = false;
  private looping: Promise<void> | null = null;
  private notify: (() => void) | null = null;
  private suppressHeartbeat = false;
  private readonly boundFences = new Map<string, number>();

  constructor(
    private readonly host: {
      config: AppConfig;
      sessions: SessionStore;
      tools: ToolService;
      state: StateStore;
      mysqlAsyncState: () => Promise<AsyncMysqlStateStore>;
    },
  ) {
    host.sessions.setRevisionFn(async (jobId) => {
      const fence = this.boundFences.get(jobId);
      if (fence === undefined) return "memory";
      const reserved = await this.stateCall("reserveRevision", jobId, this.owner, fence);
      return reserved.ok ? reserved.count : "lost";
    });
  }

  private async stateCall<K extends Exclude<keyof StateStore, "close">>(op: K, ...args: Parameters<StateStore[K]>): Promise<ReturnType<StateStore[K]>> {
    if (this.host.config.stateMode === "mysql") return await (await this.host.mysqlAsyncState()).call(op, ...args) as ReturnType<StateStore[K]>;
    const method = this.host.state[op] as (...values: Parameters<StateStore[K]>) => ReturnType<StateStore[K]>;
    return method.apply(this.host.state, args);
  }

  start(): void {
    if (this.looping) return;
    this.running = true;
    this.looping = this.loop();
  }

  async stop(options: { cancel?: boolean } = {}): Promise<void> {
    this.running = false;
    if (options.cancel !== false) {
      for (const jobId of this.localAgents.keys()) await this.stateCall("requestCancel", jobId);
      for (const agent of this.localAgents.values()) agent.abort();
    }
    this.wake();
    await this.looping;
    this.looping = null;
  }

  get workerOwner(): string {
    return this.owner;
  }

  async runClaimed(claim: { job: JobRecord; fence: number }): Promise<void> {
    try { await this.execute(claim.job, claim.fence); }
    finally {
      if (this.boundFences.get(claim.job.job_id) === claim.fence) this.boundFences.delete(claim.job.job_id);
    }
  }

  async abandon(): Promise<void> {
    this.suppressHeartbeat = true;
    await this.stop({ cancel: false });
  }

  submit(sessionId: string, text: string, idempotencyKey: string, requested?: { modelId?: string; reasoning?: string }): JobRecord {
    const session = this.host.sessions.require(sessionId);
    const input = this.prepareSubmission(session, text, idempotencyKey, requested);
    try {
      const stored = this.host.state.createJob(input);
      this.wake();
      return stored;
    } catch (error) { throw submissionError(error); }
  }

  async submitAsync(state: AsyncMysqlStateStore, session: StoredSession, text: string, idempotencyKey: string, requested?: { modelId?: string; reasoning?: string }): Promise<JobRecord> {
    const input = this.prepareSubmission(session, text, idempotencyKey, requested);
    try {
      const stored = await state.call("createJob", input);
      this.wake();
      return stored;
    } catch (error) { throw submissionError(error); }
  }

  async submitForSessionAsync(sessionId: string, text: string, idempotencyKey: string, requested?: { modelId?: string; reasoning?: string }): Promise<JobRecord> {
    const session = await this.host.sessions.requireAsync(sessionId);
    const input = this.prepareSubmission(session, text, idempotencyKey, requested);
    try {
      const stored = await this.stateCall("createJob", input);
      this.wake();
      return stored;
    } catch (error) { throw submissionError(error); }
  }

  private prepareSubmission(session: StoredSession, text: string, idempotencyKey: string, requested?: { modelId?: string; reasoning?: string }) {
    if (!idempotencyKey.trim()) throw new RequestError("invalid_request", "缺少幂等键", 400);
    if (!text.trim()) throw new RequestError("invalid_request", "问题不能为空", 400);
    let choice;
    try {
      choice = resolveModelChoice(this.host.config, requested);
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "model_not_enabled" || name === "reasoning_not_enabled") {
        throw new RequestError(name, safeProviderError(error).message, 400);
      }
      throw error;
    }
    const turn = this.host.config.modelMode === "pi" ? passthroughTurn(text.trim()) : resolveTurn(session.slots, text.trim(), this.host.config.knowledgeDir);
    const sessionId = session.session_id;
    const createdAt = new Date().toISOString();
    const job: JobRecord = {
      job_id: `job_${randomUUID()}`,
      session_id: sessionId,
      status: "queued",
      user_text: text.trim(),
      idempotency_key: idempotencyKey,
      turn,
      events: [],
      next_seq: 2,
      version: 1,
      analysis: null,
      error: null,
      abort_reason: null,
      fence: 0,
      lease_owner: null,
      lease_until: null,
      cancel_requested: false,
      simulated: true,
      model_id: choice.modelId,
      reasoning: choice.reasoning,
      created_at: createdAt,
    };
    return {
      job,
      session: { ...storedSession(session), slots: turn.slots, title: session.title === "新会话" ? text.trim().slice(0, 32) : session.title },
      message: { message_id: newId("msg"), session_id: sessionId, job_id: job.job_id, role: "user" as const, text: text.trim(), created_at: createdAt },
    };
  }

  cancel(jobId: string): JobRecord {
    const job = this.host.state.requestCancel(jobId);
    this.localAgents.get(jobId)?.abort();
    const event = job.events.at(-1);
    if (event) this.publishEvent(jobId, event);
    return job;
  }

  async cancelAsync(jobId: string): Promise<JobRecord> {
    const job = await this.stateCall("requestCancel", jobId);
    this.localAgents.get(jobId)?.abort();
    const event = job.events.at(-1);
    if (event) this.publishEvent(jobId, event);
    return job;
  }

  async requireAsync(jobId: string): Promise<JobRecord> {
    const job = await this.stateCall("getJob", jobId);
    if (!job) throw new RequestError("job_not_found", "没有这个任务", 404);
    return job;
  }

  async listAsync(sessionId: string): Promise<JobRecord[]> { return this.stateCall("listJobs", sessionId); }
  async expireLeaseAsync(jobId: string): Promise<void> { await this.stateCall("expireLease", jobId); }

  abortLocal(jobId: string): void { this.localAgents.get(jobId)?.abort(); }

  require(jobId: string): JobRecord {
    const job = this.host.state.getJob(jobId);
    if (!job) throw new RequestError("job_not_found", "没有这个任务", 404);
    return job;
  }

  list(sessionId: string): JobRecord[] {
    return this.host.state.listJobs(sessionId);
  }

  requeue(_jobId: string): void {
    this.wake();
  }

  pauseHeartbeats(): void {
    this.suppressHeartbeat = true;
  }

  expireLease(jobId: string): void {
    this.host.state.expireLease(jobId);
  }

  subscribe(jobId: string, listener: (event: { seq: number; type: string }) => void): () => void {
    this.require(jobId);
    return this.registerSubscriber(jobId, listener);
  }

  async subscribeAsync(jobId: string, listener: (event: { seq: number; type: string }) => void): Promise<() => void> {
    await this.requireAsync(jobId);
    return this.registerSubscriber(jobId, listener);
  }

  private registerSubscriber(jobId: string, listener: (event: { seq: number; type: string }) => void): () => void {
    let set = this.subscribers.get(jobId);
    if (!set) {
      set = new Set();
      this.subscribers.set(jobId, set);
    }
    set.add(listener);
    return () => set?.delete(listener);
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const claim = await this.stateCall("claimNext", this.owner, Date.now(), this.host.config.leaseMs);
        if (!claim) {
          if (this.running) await this.waitForWork();
          continue;
        }
        await this.runClaimed(claim);
      } catch {
        console.error("worker state unavailable; execution details omitted");
        if (this.running) await this.waitForWork();
      }
    }
  }

  private async execute(claimed: JobRecord, fence: number): Promise<void> {
    const jobId = claimed.job_id;
    this.boundFences.set(jobId, fence);
    const fresh = await this.stateCall("getJob", jobId);
    if (fresh?.cancel_requested) {
      if (await this.stateCall("finish", jobId, this.owner, fence, "cancelled", null, null)) await this.publish(jobId);
      return;
    }
    let lost = false;
    const lostFence = () => {
      lost = true;
      this.localAgents.get(jobId)?.abort();
    };
    const started = await this.stateCall("appendEvent", jobId, this.owner, fence, "job_started", { status: "running", fence, owner: this.owner });
    if (!started) return;
    this.publishEvent(jobId, started);
    const turnResolved = await this.stateCall("appendEvent", jobId, this.owner, fence, "turn_resolved", { kind: claimed.turn.kind });
    if (!turnResolved) return;
    this.publishEvent(jobId, turnResolved);
    // started_at survives lease takeover; recovery does not receive a fresh wall-clock budget.
    const startedAt = claimed.started_at ? Date.parse(claimed.started_at) : Date.now();
    const remainingMs = this.host.config.jobTimeoutMs - Math.max(0, Date.now() - startedAt);
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      const finished = await this.stateCall("finish", jobId, this.owner, fence, "timed_out", null, { code: "job_timed_out", message: "任务的墙钟预算已耗尽，恢复后不会重新开始计时。" });
      this.boundFences.delete(jobId);
      if (finished) await this.publish(jobId);
      return;
    }
    const session = await this.host.sessions.requireAsync(claimed.session_id);
    this.host.sessions.setActiveJob(session.session_id, jobId, { owner: this.owner, fence });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.localAgents.get(jobId)?.abort();
    }, remainingMs);
    let beating: Promise<void> | null = null;
    const heartbeat = setInterval(() => {
      if (this.suppressHeartbeat || beating || lost) return;
      beating = (async () => {
        try {
          const beat = await this.stateCall("heartbeat", jobId, this.owner, fence, Date.now(), this.host.config.leaseMs);
          if (!beat.ok) lostFence();
          if (beat.cancel_requested) this.localAgents.get(jobId)?.abort();
        } catch { lostFence(); }
      })().finally(() => { beating = null; });
    }, this.host.config.heartbeatMs);
    let unsubscribe: () => void = () => undefined;
    let agentError: { code: string; message: string } | null = null;
    let modelCalls = 0;
    let toolCalls = 0;
    let disposeSession: (() => void) | undefined;
    let recoveredAnalysis: AnalysisRecord | null = null;
    try {
      if (this.host.config.modelMode === "pi") {
        const outcome = await this.runPiSession({
          jobId,
          fence,
          sessionId: session.session_id,
          userText: claimed.user_text,
          lostFence,
          onUnsubscribe: (release) => {
            unsubscribe = release;
          },
          onDispose: (dispose) => {
            disposeSession = dispose;
          },
          onError: (error) => {
            agentError = error;
          },
          onModelCall: () => {
            modelCalls += 1;
          },
          onToolCall: () => {
            toolCalls += 1;
          },
          hasAnalysis: () => sessionAnalyses(session).some((item) => item.job_id === jobId),
          rememberCandidate: (analysis) => {
            recoveredAnalysis = analysis;
          },
        });
        if (outcome === "lost") lost = true;
      } else {
      const progress = await this.stateCall("loadAgentSnapshot", session.session_id, { jobId, kind: "progress" });
      const settled = progress ? null : await this.stateCall("loadAgentSnapshot", session.session_id, { kind: "settled" });
      const snapshot = (progress ?? settled)?.body as unknown as AgentTranscriptSnapshot | undefined;
      const restoredMessages = snapshot ? withoutUnfinishedToolCall(snapshot.messages) : [];
      const resumeInterrupted = Boolean(progress && snapshot && canContinueTranscript(restoredMessages));
      const agent = snapshot && canContinueTranscript(restoredMessages)
        ? await restoreAgent(session, this.host.tools, this.host.config, { ...snapshot, messages: restoredMessages })
        : await ensureAgent(session, this.host.tools, this.host.config);
      this.host.sessions.rememberAgent(session.session_id, agent);
      this.localAgents.set(jobId, agent);
      unsubscribe = agent.subscribe(async (event) => {
        if (event.type === "message_end" && event.message.role === "assistant") modelCalls += 1;
        if (event.type === "tool_execution_start") toolCalls += 1;
        if (event.type === "message_end" || event.type === "tool_execution_end") {
          const transcript = JSON.stringify(agent.state.messages);
          if (transcript.length > this.host.config.maxContextChars) {
            agentError = { code: "budget_exhausted", message: "会话上下文超过上限。未知 token 不会被记成 0。" };
            agent.abort();
          }
        }
        if (!agentError && (modelCalls > this.host.config.maxModelCalls || toolCalls > this.host.config.maxToolCalls)) {
          agentError = { code: "budget_exhausted", message: "模型调用或工具调用超过预算。未知 token 和费用不会被记成 0。受影响的结论不能当成已验证事实。" };
          agent.abort();
        }
        if (lost || this.localAgents.get(jobId) !== agent) return;
        try {
        if (event.type === "message_end") {
          const body = captureTranscript(agent, session.session_id) as unknown as Record<string, unknown>;
          const saved = await this.stateCall("saveAgentSnapshot", {
            sessionId: session.session_id,
            jobId,
            owner: this.owner,
            fence,
            kind: "progress",
            body,
          });
          if (!saved) lostFence();
          else if (event.message.role === "toolResult") {
            const receipt = await this.stateCall("appendEvent", jobId, this.owner, fence, "transcript_saved", {
              tool_name: event.message.toolName,
              continuable: true,
              format: "pi-agent-state-messages-v1",
            });
            if (!receipt) lostFence(); else this.publishEvent(jobId, receipt);
          }
        }
        if (event.type === "tool_execution_start") {
          const started = await this.stateCall("appendEvent", jobId, this.owner, fence, "tool_started", { tool_name: event.toolName, args: sanitizeToolArgs(event.args) });
          if (!started) lostFence(); else this.publishEvent(jobId, started);
        }
        if (event.type === "tool_execution_end") {
          const details = event.result && typeof event.result === "object" && "details" in event.result ? event.result.details : undefined;
          const record = details && typeof details === "object" ? (details as Record<string, unknown>) : {};
          const finished = await this.stateCall("appendEvent", jobId, this.owner, fence, "tool_finished", {
              tool_name: event.toolName,
              is_error: event.isError,
              code: record.code ?? null,
              resource_id: record.resource_id ?? null,
            });
          if (!finished) lostFence(); else this.publishEvent(jobId, finished);
        }
        } catch { lostFence(); }
      });
      const prior = agent.state.messages.some((message) => message.role === "user")
        ? []
        : (await this.stateCall("listMessages", session.session_id)).filter((message) => message.job_id !== jobId).map((message) => message.text);
      if (JSON.stringify(agent.state.messages).length > this.host.config.maxContextChars) {
        agentError = { code: "budget_exhausted", message: "会话上下文超过上限。未知 token 不会被记成 0。" };
      } else if (resumeInterrupted) {
        const context = await this.stateCall("appendEvent", jobId, this.owner, fence, "model_context", contextProof(agent.state.messages, true));
        if (!context) lostFence(); else await agent.continue();
      } else {
        if (snapshot && !await this.stateCall("appendEvent", jobId, this.owner, fence, "model_context", contextProof(agent.state.messages, false))) lostFence();
        if (!lost) await agent.prompt(modelPrompt(this.host.config.modelMode, claimed.turn, claimed.user_text, prior));
      }
      if (!lost && !agentError && !timedOut && !sessionAnalyses(session).some((item) => item.job_id === jobId)) {
        const delivered = await this.deliverNaturalCandidate(jobId, fence, session.session_id, agent.state.messages);
        if (delivered.error) agentError = delivered.error;
      }
      if (!lost) {
        const saved = await this.stateCall("saveAgentSnapshot", {
          sessionId: session.session_id,
          jobId,
          owner: this.owner,
          fence,
          kind: "settled",
          body: captureTranscript(agent, session.session_id) as unknown as Record<string, unknown>,
        });
        if (!saved) lostFence();
      }
      }
    } catch {
      if (!agentError) agentError = { code: "agent_failed", message: "代理运行失败，原始错误未写入通用事件。" };
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (beating) await beating;
      unsubscribe();
      disposeSession?.();
      this.boundFences.delete(jobId);
      this.localAgents.delete(jobId);
      this.host.sessions.setActiveJob(session.session_id, undefined);
    }
    if (lost) return;
    const current = await this.stateCall("getJob", jobId);
    if (!current || current.fence !== fence || isTerminal(current.status)) return;
    let status: JobStatus;
    let analysis = sessionAnalyses(session).filter((item) => item.job_id === jobId).at(-1) ?? recoveredAnalysis;
    let error = agentError;
    const finalBeat = await this.stateCall("heartbeat", jobId, this.owner, fence, Date.now(), this.host.config.leaseMs);
    if (!finalBeat.ok) return;
    // Restored tool receipts are history, not current authorization. Recheck
    // the exact saved resources, knowledge and publication before committing.
    if (analysis && !current.cancel_requested && !finalBeat.cancel_requested && !timedOut && !(agentError && hardFailure(agentError.code))) {
      let valid = false;
      try { valid = await this.host.tools.revalidateAnalysis(session.session_id, jobId, analysis); } catch { valid = false; }
      if (!valid) {
        analysis = null;
        error = { code: "analysis_authority_changed", message: "候选证据、授权或来源已变化，未提交旧结论。" };
      }
    }
    if (current.cancel_requested || finalBeat.cancel_requested) {
      status = "cancelled";
      analysis = null;
      error = null;
    } else if (timedOut) {
      status = "timed_out";
      error = { code: "job_timed_out", message: "任务执行超时。终态不会被再次运行；只有租约过期且尚未终态的任务才会被回收。" };
    } else if (error?.code === "analysis_authority_changed") {
      status = "failed";
    } else if (agentError && hardFailure(agentError.code)) {
      status = "failed";
      error = agentError;
    } else if (!analysis) {
      status = error ? "failed" : "partial";
      error = error ?? { code: "model_stopped_without_authoritative_update", message: "模型停止时没有形成可引用的证据结论。" };
    } else {
      status = analysis.status;
    }
    const steps = (this.host.config.piProvider === "openai-compatible" || this.host.config.piProvider === "deepseek") ? await this.stateCall("listProviderSteps", jobId) : [];
    if (await this.stateCall("finish", jobId, this.owner, fence, status, analysis, error, measuredUsage(this.host.config.modelMode, this.host.config.piProvider, modelCalls, toolCalls, steps))) await this.publish(jobId);
  }

  private async deliverNaturalCandidate(jobId: string, fence: number, sessionId: string, messages: Parameters<typeof naturalCandidate>[0], declaration?: AnalysisDeclaration, candidateEntryId?: string | null): Promise<{ error?: { code: string; message: string } }> {
    const job = await this.stateCall("getJob", jobId);
    if (!job || job.status !== "running" || job.fence !== fence || job.cancel_requested) return {};
    const allowed = new Set(job.events.filter((event) => event.type === "tool_finished" && event.payload.is_error === false && typeof event.payload.resource_id === "string").map((event) => String(event.payload.resource_id)));
    const candidate = naturalCandidate(messages, allowed);
    if (!candidate) return { error: { code: "model_stopped_without_candidate", message: "模型未明确选择本次结果，也没有形成可交付的澄清。" } };
    const beat = await this.stateCall("heartbeat", jobId, this.owner, fence, Date.now(), this.host.config.leaseMs);
    if (!beat.ok || beat.cancel_requested) return {};
    const failedExecution = job.events.some((event) => event.type === "tool_finished" && event.payload.is_error === true && ["query", "calculate_session_cells"].includes(String(event.payload.tool_name)));
    const input = candidate.kind === "answer"
      ? { suggested_status: failedExecution ? "partial" as const : "completed" as const, draft_answer: candidate.text, resource_ids: candidate.resourceIds, ...(failedExecution ? { limitations: ["本任务有查询或计算失败；已选证据不能证明所有请求都已完成。"] } : {}), ...(candidate.comparisons ? { comparisons: candidate.comparisons } : {}), ...(declaration ? { declaration } : {}) }
      : candidate.kind === "clarification"
      ? { suggested_status: "needs_clarification" as const, draft_answer: "", resource_ids: [], clarification_question: candidate.question }
      : { suggested_status: "failed" as const, draft_answer: "", resource_ids: [] };
    const result = await this.host.tools.updateAnalysis(sessionId, input);
    if (!result.ok) return { error: { code: String(result.code ?? "candidate_delivery_failed"), message: "候选答案未通过服务端证据检查。" } };
    if (!candidateEntryId || !job.events.some((event) => event.type === "candidate_reviewed" && event.payload.candidate_entry_id === candidateEntryId)) {
      const event = await this.stateCall("appendEvent", jobId, this.owner, fence, "candidate_reviewed", { candidate_entry_id: candidateEntryId ?? null, status: result.status, selected_count: candidate.kind === "answer" ? candidate.resourceIds.length : 0 });
      if (!event) return { error: { code: "execution_fence_rejected", message: "候选审查的任务围栏已失效。" } };
      this.publishEvent(jobId, event);
    }
    return {};
  }

  private async runPiSession(input: {
    jobId: string;
    fence: number;
    sessionId: string;
    userText: string;
    lostFence: () => void;
    onUnsubscribe: (release: () => void) => void;
    onDispose: (dispose: () => void) => void;
    onError: (error: { code: string; message: string }) => void;
    onModelCall: () => void;
    onToolCall: () => void;
    hasAnalysis: () => boolean;
    rememberCandidate: (analysis: AnalysisRecord) => void;
  }): Promise<"ok" | "lost"> {
    if ((this.host.config.piProvider === "openai-compatible" || this.host.config.piProvider === "deepseek")) {
      const pending = (await this.stateCall("listProviderSteps", input.jobId)).filter((step) => step.status === "dispatched");
      for (const step of pending) {
        await this.stateCall("settleProviderStep", {
          stepId: step.step_id,
          jobId: input.jobId,
          owner: this.owner,
          fence: input.fence,
          status: "outcome_unknown",
          inputTokens: null,
          outputTokens: null,
          usageSource: "unknown",
          durationMs: null,
          errorCode: "provider_outcome_unknown",
        });
      }
      if (pending.length > 0) {
        await this.stateCall("appendEvent", input.jobId, this.owner, input.fence, "provider_outcome_unknown", {
          step_ids: pending.map((step) => step.step_id),
          usage_source: "unknown",
        });
        input.onError({
          code: "provider_outcome_unknown",
          message: "模型请求已经派发，但进程在收到响应前停止。不能把这次请求当成未发生，也不能用未知用量重试或记成 0。",
        });
        return "ok";
      }
    }
    const progress = await this.stateCall("loadAgentSnapshot", input.sessionId, { jobId: input.jobId, kind: "progress" });
    const settled = progress ? null : await this.stateCall("loadAgentSnapshot", input.sessionId, { kind: "settled" });
    const record = progress ?? settled;
    const snapshot = record?.body as unknown as PiSessionSnapshotBody | undefined;
    let governed;
    try {
      const storedJob = await this.stateCall("getJob", input.jobId);
      const selection = resolveModelChoice(this.host.config, {
        modelId: storedJob?.model_id ?? undefined,
        reasoning: storedJob?.reasoning ?? undefined,
      });
      governed = await openGovernedSession({
        config: this.host.config,
        appSessionId: input.sessionId,
        jobId: input.jobId,
        tools: this.host.tools,
        userText: input.userText,
        modelId: selection.modelId,
        reasoning: selection.reasoning,
        snapshot,
        requireUserText: Boolean(progress),
        ledger: (this.host.config.piProvider === "openai-compatible" || this.host.config.piProvider === "deepseek")
          ? {
              sessionId: input.sessionId,
              jobId: input.jobId,
              actorId: (await this.host.sessions.requireAsync(input.sessionId)).actor_id ?? "demo-analyst",
              owner: this.owner,
              fence: input.fence,
              state: {
                beginProviderStep: (value) => this.stateCall("beginProviderStep", value),
                saveProviderPayload: (value) => this.stateCall("saveProviderPayload", value),
                settleProviderStep: (value) => this.stateCall("settleProviderStep", value),
              },
            }
          : undefined,
      });
    } catch (error) {
      const named = error instanceof Error ? error.name : "";
      if (named === "model_not_enabled" || named === "reasoning_not_enabled") {
        input.onError(safeProviderError(error));
        return "ok";
      }
      const code = error instanceof SessionSnapshotError ? error.code : "session_snapshot_corrupt";
      input.onError({ code, message: error instanceof SessionSnapshotError ? error.message : "会话快照无法打开。" });
      return "ok";
    }
    input.onDispose(governed.dispose);
    const session = governed.session;
    this.localAgents.set(input.jobId, { abort: () => void session.abort() });
    let lost = false;
    let failed = false;
    const fail = (error: { code: string; message: string }) => {
      if (failed) return;
      failed = true;
      input.onError(error);
    };
    const markLost = () => {
      lost = true;
      input.lostFence();
    };
    let modelCalls = 0;
    let toolCalls = 0;
    input.onUnsubscribe(
      // AgentSession's public listeners run before its JSONL append and are not
      // awaited. Agent listeners are awaited in registration order; the session
      // registered its own listener first, so this sees the just-appended leaf
      // and prevents the next tool/model step until the checkpoint is durable.
      session.agent.subscribe(async (event, signal) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          modelCalls += 1;
          input.onModelCall();
          if (event.message.stopReason === "error") {
            fail(safeProviderError(new Error(event.message.errorMessage ?? "provider_error")));
          }
        }
        if (event.type === "tool_execution_start") {
          toolCalls += 1;
          input.onToolCall();
        }
        if (event.type === "message_end" || event.type === "tool_execution_end") {
          const transcript = JSON.stringify(session.messages);
          if (transcript.length > this.host.config.maxContextChars) {
            fail({ code: "budget_exhausted", message: "会话上下文超过上限。未知 token 不会被记成 0。" });
            void session.abort();
          }
        }
        if (modelCalls > this.host.config.maxModelCalls || toolCalls > this.host.config.maxToolCalls) {
          fail({ code: "budget_exhausted", message: "模型调用或工具调用超过预算。未知 token 和费用不会被记成 0。" });
          void session.abort();
        }
        if (lost) return;
        try {
          if (event.type === "message_end") {
            const message = event.message;
            // Pi keeps setup-only entries in memory until a user/assistant
            // message exists; there is no JSONL file to snapshot yet.
            if (message.role === "system") return;
            // Capture before the first await so later branches cannot replace it.
            const snapshot = captureSessionSnapshot(session, input.userText, input.jobId);
            const saved = await this.stateCall("saveAgentSnapshot", {
              sessionId: input.sessionId, jobId: input.jobId, owner: this.owner,
              fence: input.fence, kind: "progress", body: snapshot as unknown as Record<string, unknown>,
            });
            if (!saved) { markLost(); return; }
            const snapshotEvent = await this.stateCall("appendEvent", input.jobId, this.owner, input.fence, "snapshot_saved", {
              role: message.role,
              tool_name: "toolName" in message ? message.toolName : null,
              tool_call_id: messageCallId(message),
              leaf_id: snapshot.leaf_id,
              format: "pi-coding-agent-session-jsonl-v3",
            });
            if (!snapshotEvent) { markLost(); return; }
            this.publishEvent(input.jobId, snapshotEvent);
            if (message.role === "toolResult") {
              const transcriptEvent = await this.stateCall("appendEvent", input.jobId, this.owner, input.fence, "transcript_saved", {
                tool_name: message.toolName, tool_call_id: message.toolCallId,
                format: "pi-coding-agent-session-jsonl-v3", leaf_id: snapshot.leaf_id,
                branch_entry_ids: snapshot.branch_entry_ids,
              });
              if (!transcriptEvent) { markLost(); return; }
              this.publishEvent(input.jobId, transcriptEvent);
              const names = this.host.config.toolResultHoldNames;
              if (!names.length || names.includes(message.toolName)) await pauseForTest(this.host.config.toolResultHoldMs, signal);
            }
          }
          if (event.type === "tool_execution_start") {
            const started = await this.stateCall("appendEvent", input.jobId, this.owner, input.fence, "tool_started", { tool_name: event.toolName, tool_call_id: event.toolCallId, args: sanitizeToolArgs(event.args) });
            if (!started) markLost(); else this.publishEvent(input.jobId, started);
          }
          if (event.type === "tool_execution_end") {
            const details = event.result && typeof event.result === "object" && "details" in event.result ? event.result.details : undefined;
            const detailsRecord = details && typeof details === "object" ? (details as Record<string, unknown>) : {};
            const finished = await this.stateCall("appendEvent", input.jobId, this.owner, input.fence, "tool_finished", {
              tool_name: event.toolName,
              tool_call_id: event.toolCallId,
              is_error: event.isError,
              code: detailsRecord.code ?? null,
              resource_id: detailsRecord.resource_id ?? null,
            });
            if (!finished) markLost(); else this.publishEvent(input.jobId, finished);
          }
        } catch (error) {
          // An asynchronous timeout/bridge failure can have committed. Stop the
          // agent; recovery must re-read authority and never assume rollback.
          console.error(`pi event persistence failed: ${error instanceof SessionSnapshotError ? error.code : "state_error"}`);
          fail({ code: "session_snapshot_write_failed", message: "会话进度无法确认，任务已停止等待恢复。" });
          markLost();
        }
      }),
    );
    const context = session.sessionManager.buildSessionContext();
    const candidate = candidateFromContext(context.messages, input.jobId);
    if (candidate) input.rememberCandidate(candidate);
    const leaf = session.sessionManager.getLeafEntry();
    const leafMessage = leaf?.type === "message" ? leaf.message : undefined;
    const entries = session.sessionManager.getBranch();
    const inspection = inspectCompaction(entries, context.messages, input.userText);
    const decision = decideResume({
      contextMessages: context.messages,
      leafParentId: leaf?.parentId ?? null,
      jobUserText: input.userText,
      hasAnalysis: input.hasAnalysis() || candidate !== null,
      resumingProgress: Boolean(progress),
      compactionInspected: true,
      compactionHidesToolResults: inspection.hidesToolResults,
      userTextPersisted: inspection.userTextPersisted,
      jobId: input.jobId,
    });
    const contextEvent = await this.stateCall("appendEvent", input.jobId, this.owner, input.fence, "model_context", {
      restored: Boolean(record),
      decision: decision.decision,
      query_may_rerun: "query_may_rerun" in decision ? decision.query_may_rerun : false,
      roles: context.messages.map((message) => message.role),
      tool_results: context.messages.filter((message) => message.role === "toolResult").map((message) => message.toolName),
      tool_call_ids: context.messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
      format: "pi-coding-agent-session-jsonl-v3",
      leaf_id: session.sessionManager.getLeafId(),
      parent_entry_id: leaf?.parentId ?? null,
      leaf_role: leafMessage && "role" in leafMessage ? leafMessage.role : leaf?.type ?? null,
      leaf_tool_call_id: leafMessage ? messageCallId(leafMessage) : null,
      leaf_tool_name: leafMessage ? messageToolName(leafMessage) : null,
      branch_entry_ids: session.sessionManager.getBranch().map((entry) => entry.id),
    });
    if (!contextEvent) { markLost(); return "lost"; }
    await this.publish(input.jobId);
    if (decision.action === "reject") {
      fail({ code: decision.code, message: decision.message });
      return lost ? "lost" : "ok";
    }
    try {
      if (decision.action === "continue") await session.agent.continue();
      else if (decision.action === "redo_tool_call") {
        session.sessionManager.branch(decision.branchFromId);
        session.refreshContext();
        await session.agent.continue();
      } else if (decision.action === "prompt") {
        // Only a previously committed terminal job may be projected into the
        // next turn. A settled JSONL snapshot alone does not prove commit.
        const priorMessages = (await this.stateCall("listMessages", input.sessionId)).filter((message) => message.job_id !== input.jobId);
        const previousId = priorMessages.at(-1)?.job_id;
        const previous = previousId ? await this.stateCall("getJob", previousId) : null;
        if (previous?.analysis && ["completed", "partial", "needs_clarification"].includes(previous.status)) {
          await session.sendCustomMessage({ customType: "lumenfox.historical_delivery", display: false, content: JSON.stringify({ history_summary: true, status: previous.status, answer: previous.analysis.answer.slice(0, 4000), clarification_question: previous.analysis.clarification_question, notice: "这是上一轮已提交结果，仅供理解对话；当前任务必须重新核验授权、契约、新鲜度并生成自己的证据。" }), details: { job_id: previous.job_id } }, { triggerTurn: false });
        }
        await session.prompt(input.userText, { expandPromptTemplates: false, source: "rpc" });
      }
      if ((this.host.config.piProvider === "openai-compatible" || this.host.config.piProvider === "deepseek")) {
        const failedStep = (await this.stateCall("listProviderSteps", input.jobId)).find((step) => step.status === "error");
        if (failedStep) {
          fail({ code: failedStep.error_code ?? "provider_error", message: "供应商请求失败。日志不包含密钥、请求头或用户原文。" });
        }
      }
      if (!lost && !failed && !input.hasAnalysis() && !candidate) {
        let delivered = await this.deliverNaturalCandidate(input.jobId, input.fence, input.sessionId, session.sessionManager.buildSessionContext().messages, governed.analysisRecords.currentProjection()?.declaration, session.sessionManager.getLeafId());
        if (delivered.error && ["model_stopped_without_candidate", "evidence_feedback"].includes(delivered.error.code)) {
          const state = await this.stateCall("getJob", input.jobId);
          if (state && !state.cancel_requested && state.fence === input.fence && !state.events.some((event) => event.type === "candidate_feedback")) {
            const candidateEntry = session.sessionManager.getLeafId();
            const recorded = await this.stateCall("appendEvent", input.jobId, this.owner, input.fence, "candidate_feedback", { candidate_entry_id: candidateEntry, code: delivered.error.code });
            if (!recorded) markLost();
            else {
              await session.sendCustomMessage({ customType: "lumenfox.candidate_feedback", display: false, content: "宿主反馈：候选没有可核验的本次结果。请引用已成功生成的本次结果，或以 [[clarify]] 开头提出明确问题；不要编造数据。", details: { job_id: input.jobId, candidate_entry_id: candidateEntry } }, { triggerTurn: false });
              const saved = await this.stateCall("saveAgentSnapshot", { sessionId: input.sessionId, jobId: input.jobId, owner: this.owner, fence: input.fence, kind: "progress", body: captureSessionSnapshot(session, input.userText, input.jobId) as unknown as Record<string, unknown> });
              if (!saved) markLost();
              else {
                await session.agent.continue();
                if (!lost && !failed) delivered = await this.deliverNaturalCandidate(input.jobId, input.fence, input.sessionId, session.sessionManager.buildSessionContext().messages, governed.analysisRecords.currentProjection()?.declaration, session.sessionManager.getLeafId());
              }
            }
          }
        }
        if (delivered.error && !lost) fail(delivered.error);
      }
      if (!lost && !failed) {
        session.sessionManager.appendCustomEntry("lumenfox.host_turn", {
          job_id: input.jobId,
          user_message_sha256: snapshot?.user_message_sha256,
          decision: decision.decision,
        });
        const saved = await this.stateCall("saveAgentSnapshot", {
          sessionId: input.sessionId,
          jobId: input.jobId,
          owner: this.owner,
          fence: input.fence,
          kind: "settled",
          body: captureSessionSnapshot(session, input.userText, input.jobId) as unknown as Record<string, unknown>,
        });
        if (!saved) markLost();
      }
    } catch (error) {
      if (error instanceof SessionSnapshotError) fail({ code: error.code, message: error.message });
      else {
        const safe = safeProviderError(error);
        fail(safe.code === "provider_error" && !(error instanceof Error && /provider_|budget_|context_window|remote_dispatch|model_not_enabled|reasoning_not_enabled/.test(error.message))
          ? { code: "agent_failed", message: "代理运行失败，原始错误未写入通用事件。" }
          : safe);
      }
    }
    return lost ? "lost" : "ok";
  }

  private async publish(jobId: string): Promise<void> {
    if (!this.subscribers.get(jobId)?.size) return;
    const job = await this.stateCall("getJob", jobId);
    const latest = job?.events.at(-1);
    if (!latest) return;
    this.publishEvent(jobId, latest);
  }

  private publishEvent(jobId: string, event: { seq: number; type: string }): void {
    for (const listener of this.subscribers.get(jobId) ?? []) {
      try { listener(event); }
      catch { console.error("任务事件订阅回调失败，未输出事件内容。"); }
    }
  }

  private waitForWork(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.notify = null;
        resolve();
      }, this.host.config.pollMs);
      this.notify = () => {
        clearTimeout(timer);
        this.notify = null;
        resolve();
      };
    });
  }

  private wake(): void {
    this.notify?.();
  }
}

/** Test-only recovery barrier. It never blocks the event loop and aborts promptly. */
function pauseForTest(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function hardFailure(code: string): boolean {
  if (code.startsWith("global_budget_")) return true;
  return [
    "budget_exhausted",
    "agent_failed",
    "model_stopped_without_candidate",
    "candidate_delivery_failed",
    "evidence_feedback",
    "execution_fence_rejected",
    "session_snapshot_corrupt",
    "session_branch_mismatch",
    "session_message_mismatch",
    "session_not_continuable",
    "compaction_hides_tool_results",
    "session_snapshot_write_failed",
    "session_snapshot_missing",
    "tool_receipt_missing",
    "provider_unavailable",
    "provider_outcome_unknown",
    "provider_error",
    "provider_timeout",
    "provider_auth_rejected",
    "provider_rate_limited",
    "provider_balance_insufficient",
    "provider_invalid_request",
    "provider_cancelled",
    "provider_fence_rejected",
    "token_budget_unknown",
    "context_window_exceeded",
    "remote_dispatch_disabled",
    "settlement_conflict",
    "model_not_enabled",
    "reasoning_not_enabled",
    "session_tooling_unsafe",
  ].includes(code);
}

function contextProof(messages: ReadonlyArray<{ role?: string; toolName?: string }>, restored: boolean): Record<string, unknown> {
  const toolNames = messages.filter((message) => message.role === "toolResult").map((message) => message.toolName).filter((name): name is string => Boolean(name));
  return { restored, roles: messages.map((message) => message.role), tool_results: toolNames, format: "pi-agent-state-messages-v1" };
}

function sanitizeToolArgs(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  const visible = (args as Record<string, unknown>).knowledge_body_visible;
  return typeof visible === "boolean" ? { knowledge_body_visible: visible } : {};
}

function measuredUsage(
  modelMode: "deterministic" | "pi",
  piProvider: string,
  modelCalls: number,
  toolCalls: number,
  steps: ReturnType<StateStore["listProviderSteps"]> = [],
) {
  if (piProvider === "openai-compatible" || piProvider === "deepseek") {
    const usage = usageFromSteps(steps);
    const possibleDispatches = steps.filter((step) => step.status !== "not_dispatched");
    return {
      model_calls: possibleDispatches.length,
      // Recovery can start a new listener after a prior persisted attempt.
      // Failed reservations have no row, so the combined value is a lower
      // bound across an interrupted process rather than an invented total.
      model_attempts: Math.max(modelCalls, steps.length),
      provider_not_dispatched: steps.length - possibleDispatches.length,
      provider_completed: possibleDispatches.filter((step) => step.status === "completed" && step.settlement === "settled").length,
      provider_outcome_unknown: possibleDispatches.filter((step) => step.status === "dispatched" || step.status === "outcome_unknown" || step.settlement === "held_unknown").length,
      tool_calls: toolCalls, cost: null, ...usage,
    };
  }
  return {
    model_calls: modelCalls,
    tool_calls: toolCalls,
    input_tokens: null,
    output_tokens: null,
    cost: null,
    usage_source: modelMode === "pi" && piProvider !== "faux" ? "provider_unavailable_in_this_run" : "faux_unmeasured",
  };
}
