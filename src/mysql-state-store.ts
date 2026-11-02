import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";
import type { AnalysisRecord, JobRecord, JobStatus, SessionResource } from "./types.js";
import type { AgentSnapshotRecord, AgentSnapshotWrite, Claim, ExecutionLease, Heartbeat, JobUsage, OutboxMessage, ProviderPayloadPage, ProviderPayloadRead, ProviderPayloadSummary, ProviderPayloadWrite, ProviderStepBegin, ProviderStepDecision, ProviderStepRecord, ProviderStepSettle, StateStore, StoredMessage, StoredSession, TurnBudgetRecord } from "./state-store.js";
import type { JobEvent } from "./types.js";

export interface MysqlConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/**
 * MySQL 是任务状态权威。调用保持同步，是因为现有执行循环按同步状态接口编写。
 * SQL 在独立 worker 线程执行，但同步等待响应仍会阻塞主线程；慢查询可能延迟心跳和取消。
 * Redis 不在这里。队列消息不能改变租约、围栏或终态。
 */
export class MysqlStateStore implements StateStore {
  private readonly worker: Worker;
  private readonly sleep = new Int32Array(new SharedArrayBuffer(4));
  private closed = false;

  constructor(connection: MysqlConnection) {
    if (connection.host !== "127.0.0.1") throw new Error("MySQL 状态库只接受 127.0.0.1 上的隔离实例");
    this.worker = new Worker(new URL("./mysql-bridge-worker.mjs", import.meta.url), { workerData: connection });
    this.worker.unref();
    this.call("ping", []);
  }

  createSession(session: StoredSession): StoredSession {
    return this.call("createSession", [session]);
  }

  getSession(sessionId: string): StoredSession | undefined {
    return this.call("getSession", [sessionId]) ?? undefined;
  }

  listSessions(): StoredSession[] {
    return this.call("listSessions", []);
  }

  saveSession(session: StoredSession, lease?: ExecutionLease): void {
    this.call("saveSession", [session, lease]);
  }

  addMessage(message: StoredMessage): void {
    this.call("addMessage", [message]);
  }

  listMessages(sessionId: string): StoredMessage[] {
    return this.call("listMessages", [sessionId]);
  }

  saveResource(resource: SessionResource, lease?: ExecutionLease): void {
    this.call("saveResource", [resource, lease]);
  }

  getResource(resourceId: string): SessionResource | undefined {
    return this.call("getResource", [resourceId]) ?? undefined;
  }

  countResources(): number {
    return this.call("countResources", []);
  }

  createJob(input: { job: JobRecord; session: StoredSession; message: StoredMessage }): JobRecord {
    return this.call("createJob", [input]);
  }

  getJob(jobId: string): JobRecord | undefined {
    return this.call("getJob", [jobId]) ?? undefined;
  }

  listJobs(sessionId: string): JobRecord[] {
    return this.call("listJobs", [sessionId]);
  }

  claimNext(owner: string, now: number, leaseMs: number): Claim | null {
    return this.call("claimNext", [owner, now, leaseMs]);
  }

  claimJob(jobId: string, owner: string, now: number, leaseMs: number): Claim | null {
    return this.call("claimJob", [jobId, owner, now, leaseMs]);
  }

  heartbeat(jobId: string, owner: string, fence: number, now: number, leaseMs: number): Heartbeat {
    return this.call("heartbeat", [jobId, owner, fence, now, leaseMs]);
  }

  appendEvent(jobId: string, owner: string, fence: number, type: string, payload: Record<string, unknown>): JobEvent | null {
    return this.call<JobEvent | null>("appendEvent", [jobId, owner, fence, type, payload]);
  }

  finish(
    jobId: string,
    owner: string,
    fence: number,
    status: JobStatus,
    analysis: AnalysisRecord | null,
    error: { code: string; message: string } | null,
    usage?: JobUsage | null,
  ): boolean {
    return this.call("finish", [jobId, owner, fence, status, analysis, error, usage ?? null]);
  }

  requestCancel(jobId: string): JobRecord {
    return this.call("requestCancel", [jobId]);
  }

  expireLease(jobId: string): void {
    this.call("expireLease", [jobId]);
  }

  listPendingOutbox(limit: number): OutboxMessage[] {
    return this.call("listPendingOutbox", [limit]);
  }

  markOutboxDispatched(outboxId: number): boolean {
    return this.call("markOutboxDispatched", [outboxId]);
  }

  recordOutboxAttempt(outboxId: number): void {
    this.call("recordOutboxAttempt", [outboxId]);
  }

  saveAgentSnapshot(input: AgentSnapshotWrite): boolean {
    return this.call("saveAgentSnapshot", [input]);
  }

  loadAgentSnapshot(sessionId: string, selector: { jobId?: string; kind?: "progress" | "settled" }): AgentSnapshotRecord | null {
    return this.call("loadAgentSnapshot", [sessionId, selector]);
  }

  beginProviderStep(input: ProviderStepBegin): ProviderStepDecision {
    return this.call("beginProviderStep", [input]);
  }

  settleProviderStep(input: ProviderStepSettle): ProviderStepDecision {
    return this.call("settleProviderStep", [input]);
  }

  listProviderSteps(jobId: string): ProviderStepRecord[] {
    return this.call("listProviderSteps", [jobId]);
  }

  getTurnBudget(jobId: string): TurnBudgetRecord | null {
    return this.call("getTurnBudget", [jobId]);
  }

  reserveRevision(jobId: string, owner: string, fence: number): { ok: true; count: number } | { ok: false; count: number } {
    return this.call("reserveRevision", [jobId, owner, fence]);
  }

  reserveToolCall(sessionId: string, lease: ExecutionLease, maxCalls: number): "ok" | "budget_exhausted" | "lost" {
    return this.call("reserveToolCall", [sessionId, lease, maxCalls]);
  }

  saveProviderPayload(input: ProviderPayloadWrite): boolean {
    return this.call("saveProviderPayload", [input]);
  }

  listProviderPayloads(jobId: string, actorId: string): ProviderPayloadSummary[] {
    return this.call("listProviderPayloads", [jobId, actorId]);
  }

  readProviderPayload(input: ProviderPayloadRead): ProviderPayloadPage | null {
    return this.call("readProviderPayload", [input]);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.call("close", []);
    } catch {
      // 连接已经断开时仍然结束线程。
    }
    void this.worker.terminate();
  }

  private call<T>(op: string, args: unknown[]): T {
    if (this.closed && op !== "close") throw new Error("mysql state store closed");
    const channel = new MessageChannel();
    this.worker.postMessage({ op, args, port: channel.port2 }, [channel.port2]);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const received = receiveMessageOnPort(channel.port1);
      if (received) {
        const body = received.message as { ok: true; result: T } | { ok: false; name: string; message: string };
        if (!body.ok) {
          const error = new Error(body.message);
          error.name = body.name;
          throw error;
        }
        return body.result;
      }
      Atomics.wait(this.sleep, 0, 0, 1);
    }
    throw new Error(`MySQL 状态调用超时：${op}`);
  }
}
