import { randomUUID } from "node:crypto";
import { canContinueTranscript, captureTranscript, ensureAgent, modelPrompt, restoreAgent, withoutUnfinishedToolCall, type AgentTranscriptSnapshot } from "./agent.js";
import { safeProviderError, usageFromSteps } from "./openai-gateway.js";
import { resolveModelChoice } from "./model-catalog.js";
import {
  candidateFromContext,
  captureSessionSnapshot,
  decideResume,
  inspectCompaction,
  holdSync,
  messageCallId,
  messageToolName,
  openGovernedSession,
  SessionSnapshotError,
  type PiSessionSnapshotBody,
} from "./pi-session.js";
import type { AppConfig } from "./config.js";
import { newId, storedSession, type SessionStore } from "./session.js";
import type { StateStore } from "./state-store.js";
import { sessionAnalyses, type ToolService } from "./tools.js";
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
    },
  ) {
    host.sessions.setRevisionFn((jobId) => {
      const fence = this.boundFences.get(jobId);
      if (fence === undefined) return "memory";
      const reserved = host.state.reserveRevision(jobId, this.owner, fence);
      return reserved.ok ? reserved.count : "lost";
    });
  }

  start(): void {
    if (this.looping) return;
    this.running = true;
    this.looping = this.loop();
  }

  async stop(options: { cancel?: boolean } = {}): Promise<void> {
    this.running = false;
    if (options.cancel !== false) {
      for (const jobId of this.localAgents.keys()) this.host.state.requestCancel(jobId);
      for (const agent of this.localAgents.values()) agent.abort();
    }
    this.wake();
    await this.looping;
    this.looping = null;
  }

  get workerOwner(): string {
    return this.owner;
  }

  runClaimed(claim: { job: JobRecord; fence: number }): Promise<void> {
    return this.execute(claim.job, claim.fence);
  }

  async abandon(): Promise<void> {
    this.suppressHeartbeat = true;
    await this.stop({ cancel: false });
  }

  submit(sessionId: string, text: string, idempotencyKey: string, requested?: { modelId?: string; reasoning?: string }): JobRecord {
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
    const session = this.host.sessions.require(sessionId);
    const turn = this.host.config.modelMode === "pi" ? passthroughTurn(text.trim()) : resolveTurn(session.slots, text.trim(), this.host.config.knowledgeDir);
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
    try {
      const stored = this.host.state.createJob({
        job,
        session: { ...storedSession(session), slots: turn.slots, title: session.title === "新会话" ? text.trim().slice(0, 32) : session.title },
        message: { message_id: newId("msg"), session_id: sessionId, job_id: job.job_id, role: "user", text: text.trim(), created_at: createdAt },
      });
      this.wake();
      return stored;
    } catch (error) {
      if (error instanceof Error && error.name === "session_busy") {
        throw new RequestError("session_busy", "这个会话还有未结束的任务", 409);
      }
      if (error instanceof Error && error.name === "idempotency_conflict") {
        throw new RequestError("idempotency_conflict", "同一个幂等键对应了不同的问题内容", 409);
      }
      throw error;
    }
  }

  cancel(jobId: string): JobRecord {
    const job = this.host.state.requestCancel(jobId);
    this.localAgents.get(jobId)?.abort();
    this.publish(jobId);
    return job;
  }

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
      const claim = this.host.state.claimNext(this.owner, Date.now(), this.host.config.leaseMs);
      if (!claim) {
        if (this.running) await this.waitForWork();
        continue;
      }
      try {
        await this.execute(claim.job, claim.fence);
      } catch (error) {
        console.error("worker failed", error instanceof Error ? error.message : error);
      }
    }
  }

  private async execute(claimed: JobRecord, fence: number): Promise<void> {
    const jobId = claimed.job_id;
    this.boundFences.set(jobId, fence);
    const fresh = this.host.state.getJob(jobId);
    if (fresh?.cancel_requested) {
      this.host.state.finish(jobId, this.owner, fence, "cancelled", null, null);
      this.publish(jobId);
      return;
    }
    let lost = false;
    const lostFence = () => {
      lost = true;
      this.localAgents.get(jobId)?.abort();
    };
    if (!this.host.state.appendEvent(jobId, this.owner, fence, "job_started", { status: "running", fence, owner: this.owner })) {
      return;
    }
    this.host.state.appendEvent(jobId, this.owner, fence, "turn_resolved", { turn: claimed.turn });
    this.publish(jobId);
    const session = this.host.sessions.require(claimed.session_id);
    this.host.sessions.setActiveJob(session.session_id, jobId);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.localAgents.get(jobId)?.abort();
    }, this.host.config.jobTimeoutMs);
    const heartbeat = setInterval(() => {
      if (this.suppressHeartbeat) return;
      const beat = this.host.state.heartbeat(jobId, this.owner, fence, Date.now(), this.host.config.leaseMs);
      if (!beat.ok) lostFence();
      if (beat.cancel_requested) this.localAgents.get(jobId)?.abort();
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
      const progress = this.host.state.loadAgentSnapshot(session.session_id, { jobId, kind: "progress" });
      const settled = progress ? null : this.host.state.loadAgentSnapshot(session.session_id, { kind: "settled" });
      const snapshot = (progress ?? settled)?.body as unknown as AgentTranscriptSnapshot | undefined;
      const restoredMessages = snapshot ? withoutUnfinishedToolCall(snapshot.messages) : [];
      const resumeInterrupted = Boolean(progress && snapshot && canContinueTranscript(restoredMessages));
      const agent = snapshot && canContinueTranscript(restoredMessages)
        ? await restoreAgent(session, this.host.tools, this.host.config, { ...snapshot, messages: restoredMessages })
        : await ensureAgent(session, this.host.tools, this.host.config);
      this.host.sessions.rememberAgent(session.session_id, agent);
      this.localAgents.set(jobId, agent);
      unsubscribe = agent.subscribe((event) => {
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
        if (lost || this.host.sessions.require(session.session_id).active_job_id !== jobId) return;
        if (event.type === "message_end") {
          const saved = this.host.state.saveAgentSnapshot({
            sessionId: session.session_id,
            jobId,
            owner: this.owner,
            fence,
            kind: "progress",
            body: captureTranscript(agent, session.session_id) as unknown as Record<string, unknown>,
          });
          if (!saved) lostFence();
          else if (event.message.role === "toolResult") {
            this.host.state.appendEvent(jobId, this.owner, fence, "transcript_saved", {
              tool_name: event.message.toolName,
              continuable: true,
              format: "pi-agent-state-messages-v1",
            });
            this.publish(jobId);
          }
        }
        if (event.type === "tool_execution_start") {
          if (!this.host.state.appendEvent(jobId, this.owner, fence, "tool_started", { tool_name: event.toolName, args: sanitizeToolArgs(event.args) })) lostFence();
          this.publish(jobId);
        }
        if (event.type === "tool_execution_end") {
          const details = event.result && typeof event.result === "object" && "details" in event.result ? event.result.details : undefined;
          const record = details && typeof details === "object" ? (details as Record<string, unknown>) : {};
          if (
            !this.host.state.appendEvent(jobId, this.owner, fence, "tool_finished", {
              tool_name: event.toolName,
              is_error: event.isError,
              code: record.code ?? null,
              resource_id: record.resource_id ?? null,
              message: clipEventText(record.message ?? record.notice ?? null),
            })
          ) {
            lostFence();
          }
          this.publish(jobId);
        }
      });
      const prior = agent.state.messages.some((message) => message.role === "user")
        ? []
        : this.host.state.listMessages(session.session_id).filter((message) => message.job_id !== jobId).map((message) => message.text);
      if (JSON.stringify(agent.state.messages).length > this.host.config.maxContextChars) {
        agentError = { code: "budget_exhausted", message: "会话上下文超过上限。未知 token 不会被记成 0。" };
      } else if (resumeInterrupted) {
        this.host.state.appendEvent(jobId, this.owner, fence, "model_context", contextProof(agent.state.messages, true));
        await agent.continue();
      } else {
        if (snapshot) this.host.state.appendEvent(jobId, this.owner, fence, "model_context", contextProof(agent.state.messages, false));
        await agent.prompt(modelPrompt(this.host.config.modelMode, claimed.turn, claimed.user_text, prior));
      }
      if (!lost) {
        this.host.state.saveAgentSnapshot({
          sessionId: session.session_id,
          jobId,
          owner: this.owner,
          fence,
          kind: "settled",
          body: captureTranscript(agent, session.session_id) as unknown as Record<string, unknown>,
        });
      }
      }
    } catch (error) {
      if (!agentError) agentError = { code: "agent_failed", message: error instanceof Error ? error.message : "代理运行失败" };
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      unsubscribe();
      disposeSession?.();
      this.boundFences.delete(jobId);
      this.localAgents.delete(jobId);
      this.host.sessions.setActiveJob(session.session_id, undefined);
    }
    if (lost) return;
    const current = this.host.state.getJob(jobId);
    if (!current || current.fence !== fence || isTerminal(current.status)) return;
    let status: JobStatus;
    let analysis = sessionAnalyses(session).filter((item) => item.job_id === jobId).at(-1) ?? recoveredAnalysis;
    let error = agentError;
    if (current.cancel_requested || this.host.state.heartbeat(jobId, this.owner, fence, Date.now(), this.host.config.leaseMs).cancel_requested) {
      status = "cancelled";
      analysis = null;
      error = null;
    } else if (timedOut) {
      status = "timed_out";
      error = { code: "job_timed_out", message: "任务执行超时。终态不会被再次运行；只有租约过期且尚未终态的任务才会被回收。" };
    } else if (agentError && hardFailure(agentError.code)) {
      status = "failed";
      error = agentError;
    } else if (!analysis) {
      status = error?.code === "agent_failed" ? "failed" : "partial";
      error = error ?? { code: "model_stopped_without_authoritative_update", message: "模型停止时没有形成可引用的证据结论。" };
    } else {
      status = analysis.status;
    }
    const steps = this.host.config.piProvider === "openai-compatible" ? this.host.state.listProviderSteps(jobId) : [];
    this.host.state.finish(jobId, this.owner, fence, status, analysis, error, measuredUsage(this.host.config.modelMode, this.host.config.piProvider, modelCalls, toolCalls, steps));
    this.publish(jobId);
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
    if (this.host.config.piProvider === "openai-compatible") {
      const pending = this.host.state.listProviderSteps(input.jobId).filter((step) => step.status === "dispatched");
      for (const step of pending) {
        this.host.state.settleProviderStep({
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
        this.host.state.appendEvent(input.jobId, this.owner, input.fence, "provider_outcome_unknown", {
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
    const progress = this.host.state.loadAgentSnapshot(input.sessionId, { jobId: input.jobId, kind: "progress" });
    const settled = progress ? null : this.host.state.loadAgentSnapshot(input.sessionId, { kind: "settled" });
    const record = progress ?? settled;
    const snapshot = record?.body as unknown as PiSessionSnapshotBody | undefined;
    let governed;
    try {
      const storedJob = this.host.state.getJob(input.jobId);
      const selection = resolveModelChoice(this.host.config, {
        modelId: storedJob?.model_id ?? undefined,
        reasoning: storedJob?.reasoning ?? undefined,
      });
      governed = await openGovernedSession({
        config: this.host.config,
        appSessionId: input.sessionId,
        tools: this.host.tools,
        userText: input.userText,
        modelId: selection.modelId,
        reasoning: selection.reasoning,
        snapshot,
        requireUserText: Boolean(progress),
        ledger: this.host.config.piProvider === "openai-compatible"
          ? {
              sessionId: input.sessionId,
              jobId: input.jobId,
              actorId: this.host.sessions.require(input.sessionId).actor_id ?? "demo-analyst",
              owner: this.owner,
              fence: input.fence,
              state: this.host.state,
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
      input.onError({ code, message: error instanceof Error ? error.message : "会话快照无法打开" });
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
      session.subscribe((event) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          modelCalls += 1;
          input.onModelCall();
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
        if (event.type === "message_end") {
          const message = event.message;
          queueMicrotask(() => {
            if (lost || !session.sessionManager.getSessionFile()) return;
            try {
              const saved = this.host.state.saveAgentSnapshot({
                sessionId: input.sessionId,
                jobId: input.jobId,
                owner: this.owner,
                fence: input.fence,
                kind: "progress",
                body: captureSessionSnapshot(session, input.userText) as unknown as Record<string, unknown>,
              });
              if (!saved) {
                console.error("pi progress snapshot rejected");
                markLost();
              } else {
                const toolCallId = messageCallId(message);
                this.host.state.appendEvent(input.jobId, this.owner, input.fence, "snapshot_saved", {
                  role: message.role,
                  tool_name: "toolName" in message ? message.toolName : null,
                  tool_call_id: toolCallId,
                  leaf_id: session.sessionManager.getLeafId(),
                  format: "pi-coding-agent-session-jsonl-v3",
                });
                if (message.role === "toolResult") {
                  this.host.state.appendEvent(input.jobId, this.owner, input.fence, "transcript_saved", {
                    tool_name: message.toolName,
                    tool_call_id: message.toolCallId,
                    format: "pi-coding-agent-session-jsonl-v3",
                    leaf_id: session.sessionManager.getLeafId(),
                    branch_entry_ids: session.sessionManager.getBranch().map((entry) => entry.id),
                  });
                }
                this.publish(input.jobId);
                const holdNames = this.host.config.toolResultHoldNames;
                const holdThis = message.role === "toolResult" && (holdNames.length === 0 || holdNames.includes(message.toolName));
                if (holdThis) holdSync(this.host.config.toolResultHoldMs);
              }
            } catch (error) {
              if (error instanceof SessionSnapshotError && error.code === "session_snapshot_missing") return;
              console.error("pi progress snapshot failed", error instanceof Error ? error.message : error);
              fail({ code: "session_snapshot_write_failed", message: error instanceof Error ? error.message : "会话快照写入失败" });
            }
          });
        }
        if (event.type === "tool_execution_start") {
          if (!this.host.state.appendEvent(input.jobId, this.owner, input.fence, "tool_started", { tool_name: event.toolName, tool_call_id: event.toolCallId, args: sanitizeToolArgs(event.args) })) markLost();
          this.publish(input.jobId);
        }
        if (event.type === "tool_execution_end") {
          const details = event.result && typeof event.result === "object" && "details" in event.result ? event.result.details : undefined;
          const detailsRecord = details && typeof details === "object" ? (details as Record<string, unknown>) : {};
          if (
            !this.host.state.appendEvent(input.jobId, this.owner, input.fence, "tool_finished", {
              tool_name: event.toolName,
              tool_call_id: event.toolCallId,
              is_error: event.isError,
              code: detailsRecord.code ?? null,
              resource_id: detailsRecord.resource_id ?? null,
              message: clipEventText(detailsRecord.message ?? detailsRecord.notice ?? null),
            })
          ) {
            markLost();
          }
          this.publish(input.jobId);
        }
      }),
    );
    const context = session.sessionManager.buildSessionContext();
    const candidate = candidateFromContext(context.messages, input.jobId);
    if (candidate) input.rememberCandidate(candidate);
    const leaf = session.sessionManager.getLeafEntry();
    const leafMessage = leaf?.type === "message" ? leaf.message : undefined;
    const entries = session.sessionManager.getEntries();
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
    });
    this.host.state.appendEvent(input.jobId, this.owner, input.fence, "model_context", {
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
    this.publish(input.jobId);
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
        await session.prompt(input.userText, { expandPromptTemplates: false, source: "rpc" });
      }
      if (this.host.config.piProvider === "openai-compatible") {
        const failedStep = this.host.state.listProviderSteps(input.jobId).find((step) => step.status === "error");
        if (failedStep) {
          fail({ code: failedStep.error_code ?? "provider_error", message: "供应商请求失败。日志不包含密钥、请求头或用户原文。" });
        }
      }
      if (!lost && !failed) {
        session.sessionManager.appendCustomEntry("lumenfox.host_turn", {
          job_id: input.jobId,
          user_message_sha256: snapshot?.user_message_sha256,
          decision: decision.decision,
        });
        const saved = this.host.state.saveAgentSnapshot({
          sessionId: input.sessionId,
          jobId: input.jobId,
          owner: this.owner,
          fence: input.fence,
          kind: "settled",
          body: captureSessionSnapshot(session, input.userText) as unknown as Record<string, unknown>,
        });
        if (!saved) markLost();
      }
    } catch (error) {
      if (error instanceof SessionSnapshotError) fail({ code: error.code, message: error.message });
      else {
        const safe = safeProviderError(error);
        fail(safe.code === "provider_error" && !(error instanceof Error && /provider_|budget_|context_window|remote_dispatch|model_not_enabled|reasoning_not_enabled/.test(error.message))
          ? { code: "agent_failed", message: error instanceof Error ? error.message : "代理运行失败" }
          : safe);
      }
    }
    return lost ? "lost" : "ok";
  }

  private publish(jobId: string): void {
    const job = this.host.state.getJob(jobId);
    const latest = job?.events.at(-1);
    if (!latest) return;
    for (const listener of this.subscribers.get(jobId) ?? []) listener(latest);
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

function hardFailure(code: string): boolean {
  return [
    "budget_exhausted",
    "agent_failed",
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
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (/^(authorization|api[_-]?key|headers?|reasoning|thinking|body|sql)$/iu.test(key)) continue;
    if (typeof value === "string") copy[key] = value.length > 80 ? { redacted: true, bytes: Buffer.byteLength(value) } : value;
    else if (typeof value === "number" || typeof value === "boolean" || value === null) copy[key] = value;
  }
  return copy;
}

function clipEventText(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return value.length > 160 ? `${value.slice(0, 160)}…` : value;
}

function measuredUsage(
  modelMode: "deterministic" | "pi",
  piProvider: string,
  modelCalls: number,
  toolCalls: number,
  steps: ReturnType<StateStore["listProviderSteps"]> = [],
) {
  if (piProvider === "openai-compatible") {
    const usage = usageFromSteps(steps);
    return { model_calls: modelCalls, tool_calls: toolCalls, cost: null, ...usage };
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
