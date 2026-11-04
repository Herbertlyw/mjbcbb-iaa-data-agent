import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AnalysisRecord, ContractBinding, JobEvent, JobRecord, JobStatus, SessionResource, Slots, TurnResolution } from "./types.js";
import { isTerminal } from "./types.js";
import { cacheUsageFromMetadata } from "./provider-usage-metadata.mjs";

export interface StoredSession {
  session_id: string;
  title: string;
  role: string;
  actor_id?: string;
  created_at: string;
  slots: Slots | null;
  bindings: ContractBinding[];
}

export interface JobUsage {
  model_calls: number;
  model_attempts?: number;
  provider_not_dispatched?: number;
  provider_completed?: number;
  provider_outcome_unknown?: number;
  tool_calls: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_hit_tokens?: number | null;
  cache_miss_tokens?: number | null;
  cost: number | null;
  usage_source?: string;
}

export interface StoredMessage {
  message_id: string;
  session_id: string;
  job_id: string | null;
  role: "user";
  text: string;
  created_at: string;
}

export interface Claim {
  job: JobRecord;
  owner: string;
  fence: number;
}

export interface Heartbeat {
  ok: boolean;
  cancel_requested: boolean;
}

export interface ExecutionLease {
  jobId: string;
  owner: string;
  fence: number;
}

/**
 * 可替换的本地状态接口。默认实现是单机 SQLite。
 * 它不提供多机共识、跨主机时钟或分布式租约。
 */
export interface StateStore {
  createSession(session: StoredSession): StoredSession;
  getSession(sessionId: string): StoredSession | undefined;
  listSessions(): StoredSession[];
  saveSession(session: StoredSession, lease?: ExecutionLease): void;
  addMessage(message: StoredMessage): void;
  listMessages(sessionId: string): StoredMessage[];
  saveResource(resource: SessionResource, lease?: ExecutionLease): void;
  getResource(resourceId: string): SessionResource | undefined;
  countResources(): number;
  createJob(input: {
    job: JobRecord;
    session: StoredSession;
    message: StoredMessage;
  }): JobRecord;
  getJob(jobId: string): JobRecord | undefined;
  listJobs(sessionId: string): JobRecord[];
  claimNext(owner: string, now: number, leaseMs: number): Claim | null;
  heartbeat(jobId: string, owner: string, fence: number, now: number, leaseMs: number): Heartbeat;
  appendEvent(jobId: string, owner: string, fence: number, type: string, payload: Record<string, unknown>): JobEvent | null;
  finish(
    jobId: string,
    owner: string,
    fence: number,
    status: JobStatus,
    analysis: AnalysisRecord | null,
    error: { code: string; message: string } | null,
    usage?: JobUsage | null,
  ): boolean;
  requestCancel(jobId: string): JobRecord;
  expireLease(jobId: string): void;
  claimJob(jobId: string, owner: string, now: number, leaseMs: number): Claim | null;
  listPendingOutbox(limit: number): OutboxMessage[];
  markOutboxDispatched(outboxId: number): boolean;
  recordOutboxAttempt(outboxId: number): void;
  saveAgentSnapshot(input: AgentSnapshotWrite): boolean;
  loadAgentSnapshot(sessionId: string, selector: { jobId?: string; kind?: "progress" | "settled" }): AgentSnapshotRecord | null;
  beginProviderStep(input: ProviderStepBegin): ProviderStepDecision;
  settleProviderStep(input: ProviderStepSettle): ProviderStepDecision;
  listProviderSteps(jobId: string): ProviderStepRecord[];
  getTurnBudget(jobId: string): TurnBudgetRecord | null;
  reserveRevision(jobId: string, owner: string, fence: number): { ok: true; count: number } | { ok: false; count: number };
  reserveToolCall(sessionId: string, lease: ExecutionLease, maxCalls: number): "ok" | "budget_exhausted" | "lost";
  reserveAssetRead(sessionId: string, lease: ExecutionLease | undefined, bytes: number, maxBytes: number): "ok" | "budget_exhausted" | "lost";
  saveProviderPayload(input: ProviderPayloadWrite): boolean;
  listProviderPayloads(jobId: string, actorId: string): ProviderPayloadSummary[];
  readProviderPayload(input: ProviderPayloadRead): ProviderPayloadPage | null;
  close(): void;
}

export interface ProviderStepDecision {
  ok: boolean;
  code: string;
}

export interface ProviderStepBegin {
  stepId: string;
  sessionId: string;
  jobId: string;
  actorId: string;
  owner: string;
  fence: number;
  provider: string;
  model: string;
  estimatedInput: number;
  reservedOutput: number;
  estimateSource: "char_estimate" | "utf8_byte_estimate";
  contextWindow: number;
  maxTokens: number;
  maxModelCalls: number;
  maxToolCalls: number;
  wallClockMs: number;
  maxResourceBytes: number;
}

export interface ProviderStepSettle {
  stepId: string;
  jobId: string;
  owner: string;
  fence: number;
  status: "completed" | "error" | "outcome_unknown" | "not_dispatched";
  inputTokens: number | null;
  outputTokens: number | null;
  usageSource: "simulated" | "reported" | "unknown";
  durationMs: number | null;
  errorCode: string | null;
}

export interface ProviderStepRecord {
  step_id: string;
  session_id: string;
  job_id: string;
  actor_id: string;
  fence: number;
  provider: string;
  model: string;
  status: "dispatched" | "completed" | "error" | "outcome_unknown" | "not_dispatched";
  input_tokens: number | null;
  output_tokens: number | null;
  cache_hit_tokens?: number | null;
  cache_miss_tokens?: number | null;
  usage_source: "simulated" | "reported" | "unknown";
  duration_ms: number | null;
  error_code: string | null;
  estimated_input: number;
  reserved_output: number;
  reserved_total: number;
  estimate_source: "char_estimate" | "utf8_byte_estimate";
  settlement: "pending" | "settled" | "held_unknown";
}

export interface TurnBudgetRecord {
  job_id: string;
  settled_input: number;
  settled_output: number;
  reserved_tokens: number;
  model_calls_settled: number;
  model_calls_reserved: number;
  max_tokens: number;
  context_window: number;
  max_output_tokens: number;
  max_model_calls: number;
  max_tool_calls: number;
  wall_clock_ms: number;
  max_resource_bytes: number;
}

export interface ProviderPayloadWrite {
  payloadId: string;
  stepId: string;
  sessionId: string;
  actorId: string;
  jobId: string;
  owner: string;
  fence: number;
  kind: "request" | "response";
  body: string;
}

export interface ProviderPayloadSummary {
  payload_id: string;
  step_id: string;
  job_id: string;
  session_id: string;
  kind: "request" | "response";
  bytes: number;
}

export interface ProviderPayloadRead {
  payloadId: string;
  actorId: string;
  sessionId: string;
  offset: number;
  limit: number;
}

export interface ProviderPayloadPage {
  payload_id: string;
  kind: "request" | "response";
  total_bytes: number;
  offset: number;
  limit: number;
  text: string;
}

export interface AgentSnapshotWrite {
  sessionId: string;
  jobId: string;
  owner: string;
  fence: number;
  kind: "progress" | "settled";
  body: Record<string, unknown>;
}

export interface AgentSnapshotRecord {
  session_id: string;
  job_id: string;
  fence: number;
  kind: "progress" | "settled";
  body: Record<string, unknown>;
}

export interface OutboxMessage {
  outbox_id: number;
  job_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

const TERMINAL_SQL = "('completed','needs_clarification','partial','failed','cancelled','timed_out')";

export class SqliteStateStore implements StateStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        role TEXT NOT NULL,
        slots_json TEXT,
        bindings_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_asset_budgets (
        session_id TEXT PRIMARY KEY,
        used_bytes INTEGER NOT NULL,
        max_bytes INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        job_id TEXT,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resources (
        resource_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        body_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        user_text TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        turn_json TEXT NOT NULL,
        analysis_json TEXT,
        error_json TEXT,
        version INTEGER NOT NULL,
        next_seq INTEGER NOT NULL,
        fence INTEGER NOT NULL,
        lease_owner TEXT,
        lease_until INTEGER,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        model_id TEXT,
        reasoning TEXT,
        revision_count INTEGER NOT NULL DEFAULT 0,
        tool_call_count INTEGER NOT NULL DEFAULT 0,
        tool_call_limit INTEGER,
        UNIQUE (session_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS job_events (
        job_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (job_id, seq)
      );
      CREATE TABLE IF NOT EXISTS agent_snapshots (
        snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        fence INTEGER NOT NULL,
        kind TEXT NOT NULL,
        body_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_steps (
        step_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        fence INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        usage_source TEXT NOT NULL,
        duration_ms INTEGER,
        error_code TEXT,
        created_at TEXT NOT NULL,
        estimated_input INTEGER NOT NULL DEFAULT 0,
        reserved_output INTEGER NOT NULL DEFAULT 0,
        reserved_total INTEGER NOT NULL DEFAULT 0,
        estimate_source TEXT NOT NULL DEFAULT 'char_estimate',
        settlement TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE IF NOT EXISTS turn_budgets (
        job_id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        max_tokens INTEGER NOT NULL,
        context_window INTEGER NOT NULL,
        max_output_tokens INTEGER NOT NULL,
        max_model_calls INTEGER NOT NULL,
        max_tool_calls INTEGER NOT NULL,
        wall_clock_ms INTEGER NOT NULL,
        max_resource_bytes INTEGER NOT NULL,
        settled_input INTEGER NOT NULL DEFAULT 0,
        settled_output INTEGER NOT NULL DEFAULT 0,
        reserved_tokens INTEGER NOT NULL DEFAULT 0,
        model_calls_settled INTEGER NOT NULL DEFAULT 0,
        model_calls_reserved INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS provider_payloads (
        payload_id TEXT PRIMARY KEY,
        step_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        bytes INTEGER NOT NULL
      );
    `);
    this.ensureColumn("sessions", "actor_id", "TEXT NOT NULL DEFAULT 'demo-analyst'");
    this.ensureColumn("jobs", "usage_json", "TEXT");
    this.ensureColumn("jobs", "model_id", "TEXT");
    this.ensureColumn("jobs", "reasoning", "TEXT");
    this.ensureColumn("jobs", "revision_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("jobs", "tool_call_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("jobs", "tool_call_limit", "INTEGER");
  }

  createSession(session: StoredSession): StoredSession {
    this.db.prepare(
      "INSERT INTO sessions (session_id, title, role, actor_id, slots_json, bindings_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(session.session_id, session.title, session.role, session.actor_id || "demo-analyst", JSON.stringify(session.slots), "[]", session.created_at);
    return session;
  }

  getSession(sessionId: string): StoredSession | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as Record<string, unknown> | undefined;
    return row ? this.sessionFromRow(row) : undefined;
  }

  listSessions(): StoredSession[] {
    return (this.db.prepare("SELECT * FROM sessions ORDER BY created_at").all() as Array<Record<string, unknown>>).map((row) => this.sessionFromRow(row));
  }

  saveSession(session: StoredSession, lease?: ExecutionLease): void {
    this.transaction(() => {
      if (lease) this.assertExecutionLease(session.session_id, lease);
      this.db.prepare("UPDATE sessions SET title = ?, slots_json = ?, bindings_json = ? WHERE session_id = ?").run(
        session.title, JSON.stringify(session.slots), JSON.stringify(session.bindings), session.session_id,
      );
    });
  }

  addMessage(message: StoredMessage): void {
    this.db.prepare("INSERT INTO messages (message_id, session_id, job_id, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      message.message_id,
      message.session_id,
      message.job_id,
      message.role,
      message.text,
      message.created_at,
    );
  }

  listMessages(sessionId: string): StoredMessage[] {
    return (this.db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at").all(sessionId) as Array<Record<string, unknown>>).map((row) => ({
      message_id: String(row.message_id),
      session_id: String(row.session_id),
      job_id: row.job_id ? String(row.job_id) : null,
      role: "user",
      text: String(row.text),
      created_at: String(row.created_at),
    }));
  }

  saveResource(resource: SessionResource, lease?: ExecutionLease): void {
    this.transaction(() => {
      if (lease) {
        if (resource.job_id !== lease.jobId) throw new Error("execution_fence_rejected");
        this.assertExecutionLease(resource.session_id, lease);
      }
      this.db.prepare("INSERT OR REPLACE INTO resources (resource_id, session_id, body_json) VALUES (?, ?, ?)").run(
        resource.resource_id, resource.session_id, JSON.stringify(resource),
      );
    });
  }

  private assertExecutionLease(sessionId: string, lease: ExecutionLease): void {
    const row = this.db.prepare("SELECT job_id FROM jobs WHERE job_id = ? AND session_id = ? AND lease_owner = ? AND fence = ? AND status = 'running' AND lease_until > ? AND cancel_requested = 0")
      .get(lease.jobId, sessionId, lease.owner, lease.fence, Date.now());
    if (!row) throw new Error("execution_fence_rejected");
  }

  getResource(resourceId: string): SessionResource | undefined {
    const row = this.db.prepare("SELECT body_json FROM resources WHERE resource_id = ?").get(resourceId) as { body_json: string } | undefined;
    return row ? (JSON.parse(row.body_json) as SessionResource) : undefined;
  }

  countResources(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM resources").get() as { n: number };
    return Number(row.n);
  }

  createJob(input: { job: JobRecord; session: StoredSession; message: StoredMessage }): JobRecord {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT job_id FROM jobs WHERE session_id = ? AND idempotency_key = ?").get(
        input.job.session_id,
        input.job.idempotency_key,
      ) as { job_id: string } | undefined;
      if (existing) {
        const stored = this.requireJob(existing.job_id);
        if (stored.user_text !== input.job.user_text) {
          const error = new Error("idempotency_conflict");
          error.name = "idempotency_conflict";
          throw error;
        }
        return stored;
      }
      const active = this.db.prepare(`SELECT job_id FROM jobs WHERE session_id = ? AND status NOT IN ${TERMINAL_SQL}`).get(input.job.session_id) as
        | { job_id: string }
        | undefined;
      if (active) {
        const error = new Error("session_busy");
        error.name = "session_busy";
        throw error;
      }
      this.db.prepare("UPDATE sessions SET title = ?, slots_json = ? WHERE session_id = ?").run(
        input.session.title,
        JSON.stringify(input.session.slots),
        input.session.session_id,
      );
      this.db.prepare(
        `INSERT INTO jobs (
          job_id, session_id, status, user_text, idempotency_key, turn_json, analysis_json, error_json,
          version, next_seq, fence, lease_owner, lease_until, cancel_requested, created_at, started_at, finished_at,
          model_id, reasoning
        ) VALUES (?, ?, 'queued', ?, ?, ?, NULL, NULL, 1, 2, 0, NULL, NULL, 0, ?, NULL, NULL, ?, ?)`,
      ).run(
        input.job.job_id,
        input.job.session_id,
        input.job.user_text,
        input.job.idempotency_key,
        JSON.stringify(input.job.turn),
        input.job.created_at,
        input.job.model_id ?? null,
        input.job.reasoning ?? null,
      );
      this.insertEvent(input.job.job_id, 1, "job_queued", { status: "queued" });
      this.db.prepare("INSERT INTO messages (message_id, session_id, job_id, role, text, created_at) VALUES (?, ?, ?, 'user', ?, ?)").run(
        input.message.message_id,
        input.message.session_id,
        input.job.job_id,
        input.message.text,
        input.message.created_at,
      );
      return this.requireJob(input.job.job_id);
    });
  }

  getJob(jobId: string): JobRecord | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as Record<string, unknown> | undefined;
    return row ? this.jobFromRow(row) : undefined;
  }

  listJobs(sessionId: string): JobRecord[] {
    return (this.db.prepare("SELECT * FROM jobs WHERE session_id = ? ORDER BY created_at").all(sessionId) as Array<Record<string, unknown>>).map((row) =>
      this.jobFromRow(row),
    );
  }

  claimNext(owner: string, now: number, leaseMs: number): Claim | null {
    return this.transaction(() => {
      const candidate = this.db.prepare(
        `SELECT job_id FROM jobs
         WHERE status = 'queued' OR (status = 'running' AND lease_until IS NOT NULL AND lease_until < ?)
         ORDER BY created_at LIMIT 1`,
      ).get(now) as { job_id: string } | undefined;
      if (!candidate) return null;
      const updated = this.db.prepare(
        `UPDATE jobs
         SET status = 'running', lease_owner = ?, lease_until = ?, fence = fence + 1, version = version + 1,
             started_at = COALESCE(started_at, ?)
         WHERE job_id = ? AND (status = 'queued' OR (status = 'running' AND lease_until IS NOT NULL AND lease_until < ?))`,
      ).run(owner, now + leaseMs, new Date(now).toISOString(), candidate.job_id, now);
      if (updated.changes !== 1) return null;
      const job = this.requireJob(candidate.job_id);
      return { job, owner, fence: job.fence };
    });
  }

  heartbeat(jobId: string, owner: string, fence: number, now: number, leaseMs: number): Heartbeat {
    const updated = this.db.prepare(
      `UPDATE jobs SET lease_until = ?
       WHERE job_id = ? AND lease_owner = ? AND fence = ? AND status = 'running' AND lease_until > ?`,
    ).run(now + leaseMs, jobId, owner, fence, now);
    const row = this.db.prepare("SELECT cancel_requested FROM jobs WHERE job_id = ? AND lease_owner = ? AND fence = ? AND status = 'running' AND lease_until > ?").get(
      jobId,
      owner,
      fence,
      now,
    ) as { cancel_requested: number } | undefined;
    return { ok: updated.changes === 1 && row !== undefined, cancel_requested: row?.cancel_requested === 1 };
  }

  appendEvent(jobId: string, owner: string, fence: number, type: string, payload: Record<string, unknown>): JobEvent | null {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT fence, lease_owner, lease_until, status, next_seq FROM jobs WHERE job_id = ?").get(jobId) as
        | { fence: number; lease_owner: string | null; lease_until: number | null; status: string; next_seq: number }
        | undefined;
      if (!row || row.fence !== fence || row.lease_owner !== owner || row.status !== "running" || !row.lease_until || row.lease_until <= Date.now()) return null;
      const event = this.insertEvent(jobId, Number(row.next_seq), type, payload);
      const bumped = this.db.prepare("UPDATE jobs SET next_seq = next_seq + 1 WHERE job_id = ? AND fence = ? AND lease_owner = ?").run(jobId, fence, owner);
      if (bumped.changes !== 1) return null;
      return event;
    });
  }

  finish(
    jobId: string,
    owner: string,
    fence: number,
    status: JobStatus,
    analysis: AnalysisRecord | null,
    error: { code: string; message: string } | null,
    usage: JobUsage | null = null,
  ): boolean {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT fence, lease_owner, lease_until, status, next_seq, cancel_requested FROM jobs WHERE job_id = ?").get(jobId) as
        | { fence: number; lease_owner: string | null; lease_until: number | null; status: string; next_seq: number; cancel_requested: number }
        | undefined;
      if (!row || row.fence !== fence || row.lease_owner !== owner || row.status !== "running" || !row.lease_until || row.lease_until <= Date.now()) return false;
      const terminal = row.cancel_requested === 1 && status !== "timed_out" && status !== "failed" ? "cancelled" : status;
      const type = terminal === "cancelled" ? "job_cancelled" : terminal === "timed_out" ? "job_timed_out" : terminal === "failed" ? "job_failed" : "job_finished";
      this.insertEvent(jobId, Number(row.next_seq), type, { status: terminal, error_code: error?.code ?? null });
      const updated = this.db.prepare(
        `UPDATE jobs
         SET status = ?, analysis_json = ?, error_json = ?, usage_json = ?, finished_at = ?, lease_owner = NULL, lease_until = NULL,
             version = version + 1, next_seq = next_seq + 1
         WHERE job_id = ? AND fence = ? AND lease_owner = ? AND status = 'running'`,
      ).run(
        terminal,
        ["cancelled", "failed", "timed_out"].includes(terminal) ? null : analysis ? JSON.stringify(analysis) : null,
        error ? JSON.stringify(error) : null,
        usage ? JSON.stringify(usage) : null,
        new Date().toISOString(),
        jobId,
        fence,
        owner,
      );
      return updated.changes === 1;
    });
  }

  requestCancel(jobId: string): JobRecord {
    return this.transaction(() => {
      const queued = this.db.prepare(
        `UPDATE jobs SET status = 'cancelled', cancel_requested = 1, finished_at = ?, version = version + 1
         WHERE job_id = ? AND status = 'queued'`,
      ).run(new Date().toISOString(), jobId);
      if (queued.changes === 1) {
        const row = this.db.prepare("SELECT next_seq FROM jobs WHERE job_id = ?").get(jobId) as { next_seq: number };
        this.insertEvent(jobId, Number(row.next_seq), "job_cancelled", { status: "cancelled" });
        this.db.prepare("UPDATE jobs SET next_seq = next_seq + 1 WHERE job_id = ?").run(jobId);
        return this.requireJob(jobId);
      }
      this.db.prepare(`UPDATE jobs SET cancel_requested = 1 WHERE job_id = ? AND status NOT IN ${TERMINAL_SQL}`).run(jobId);
      return this.requireJob(jobId);
    });
  }

  expireLease(jobId: string): void {
    this.db.prepare("UPDATE jobs SET lease_until = 0 WHERE job_id = ? AND status = 'running'").run(jobId);
  }

  claimJob(jobId: string, owner: string, now: number, leaseMs: number): Claim | null {
    return this.transaction(() => {
      const updated = this.db.prepare(
        `UPDATE jobs
         SET status = 'running', lease_owner = ?, lease_until = ?, fence = fence + 1, version = version + 1,
             started_at = COALESCE(started_at, ?)
         WHERE job_id = ? AND (status = 'queued' OR (status = 'running' AND lease_until IS NOT NULL AND lease_until < ?))`,
      ).run(owner, now + leaseMs, new Date(now).toISOString(), jobId, now);
      if (updated.changes !== 1) return null;
      const job = this.requireJob(jobId);
      return { job, owner, fence: job.fence };
    });
  }

  listPendingOutbox(): OutboxMessage[] {
    return [];
  }

  markOutboxDispatched(): boolean {
    return false;
  }

  recordOutboxAttempt(): void {}

  saveAgentSnapshot(input: AgentSnapshotWrite): boolean {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT fence, lease_owner, lease_until, status, session_id FROM jobs WHERE job_id = ?").get(input.jobId) as
        | { fence: number; lease_owner: string | null; lease_until: number | null; status: string; session_id: string }
        | undefined;
      if (!row || row.fence !== input.fence || row.lease_owner !== input.owner || row.status !== "running" || row.session_id !== input.sessionId || !row.lease_until || row.lease_until <= Date.now()) return false;
      this.db.prepare(
        "INSERT INTO agent_snapshots (session_id, job_id, fence, kind, body_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(input.sessionId, input.jobId, input.fence, input.kind, JSON.stringify(input.body), new Date().toISOString());
      return true;
    });
  }

  beginProviderStep(input: ProviderStepBegin): ProviderStepDecision {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT fence, lease_owner, lease_until, status, session_id FROM jobs WHERE job_id = ?").get(input.jobId) as
        | { fence: number; lease_owner: string | null; lease_until: number | null; status: string; session_id: string }
        | undefined;
      if (!row || row.fence !== input.fence || row.lease_owner !== input.owner || row.status !== "running" || row.session_id !== input.sessionId || !row.lease_until || row.lease_until <= Date.now()) {
        return { ok: false, code: "provider_fence_rejected" };
      }
      const reserve = input.estimatedInput + input.reservedOutput;
      if (!Number.isInteger(input.estimatedInput) || input.estimatedInput < 1 || !Number.isInteger(input.reservedOutput) || input.reservedOutput < 1) {
        return { ok: false, code: "budget_exhausted" };
      }
      this.db.prepare(
        `INSERT INTO turn_budgets (
          job_id, actor_id, session_id, max_tokens, context_window, max_output_tokens, max_model_calls,
          max_tool_calls, wall_clock_ms, max_resource_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO NOTHING`,
      ).run(
        input.jobId,
        input.actorId,
        input.sessionId,
        input.maxTokens,
        input.contextWindow,
        input.reservedOutput,
        input.maxModelCalls,
        input.maxToolCalls,
        input.wallClockMs,
        input.maxResourceBytes,
      );
      const budget = this.db.prepare("SELECT * FROM turn_budgets WHERE job_id = ?").get(input.jobId) as Record<string, number>;
      const held = this.db.prepare("SELECT status FROM provider_steps WHERE job_id = ? AND settlement = 'held_unknown'").all(input.jobId) as Array<{ status: string }>;
      if (held.length > 0) {
        return { ok: false, code: held.some((step) => step.status === "outcome_unknown") ? "provider_outcome_unknown" : "token_budget_unknown" };
      }
      if (reserve > Number(budget.context_window)) return { ok: false, code: "context_window_exceeded" };
      const committed = Number(budget.settled_input) + Number(budget.settled_output) + Number(budget.reserved_tokens);
      if (committed + reserve > Number(budget.max_tokens)) return { ok: false, code: "budget_exhausted" };
      if (Number(budget.model_calls_settled) + Number(budget.model_calls_reserved) >= Number(budget.max_model_calls)) {
        return { ok: false, code: "budget_exhausted" };
      }
      this.db.prepare(
        `INSERT INTO provider_steps (
          step_id, session_id, job_id, actor_id, fence, provider, model, status, usage_source, created_at,
          estimated_input, reserved_output, reserved_total, estimate_source, settlement
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'dispatched', 'unknown', ?, ?, ?, ?, ?, 'pending')`,
      ).run(
        input.stepId,
        input.sessionId,
        input.jobId,
        input.actorId,
        input.fence,
        input.provider,
        input.model,
        new Date().toISOString(),
        input.estimatedInput,
        input.reservedOutput,
        reserve,
        input.estimateSource,
      );
      this.db.prepare(
        "UPDATE turn_budgets SET reserved_tokens = reserved_tokens + ?, model_calls_reserved = model_calls_reserved + 1 WHERE job_id = ?",
      ).run(reserve, input.jobId);
      return { ok: true, code: "reserved" };
    });
  }

  settleProviderStep(input: ProviderStepSettle): ProviderStepDecision {
    return this.transaction(() => {
      const job = this.db.prepare("SELECT fence, lease_owner, lease_until, status FROM jobs WHERE job_id = ?").get(input.jobId) as
        | { fence: number; lease_owner: string | null; lease_until: number | null; status: string }
        | undefined;
      const step = this.db.prepare("SELECT * FROM provider_steps WHERE step_id = ?").get(input.stepId) as Record<string, unknown> | undefined;
      if (!step) return { ok: false, code: "step_missing" };
      if (String(step.job_id) !== input.jobId) return { ok: false, code: "provider_fence_rejected" };
      if (!job || job.lease_owner !== input.owner || job.status !== "running" || job.fence !== input.fence || !job.lease_until || job.lease_until <= Date.now()) {
        return { ok: false, code: "provider_fence_rejected" };
      }
      const settlement = String(step.settlement ?? "pending");
      const sameTokens = nullableNumber(step.input_tokens) === input.inputTokens && nullableNumber(step.output_tokens) === input.outputTokens;
      if (settlement === "settled") {
        return sameTokens && String(step.status) === input.status && String(step.usage_source) === input.usageSource && (input.status !== "not_dispatched" || (step.error_code ?? null) === input.errorCode)
          ? { ok: true, code: "idempotent" }
          : { ok: false, code: "settlement_conflict" };
      }
      if (settlement === "held_unknown") {
        const sameHold = String(step.status) === input.status && (step.error_code ?? null) === input.errorCode && input.inputTokens === null && input.outputTokens === null;
        return sameHold ? { ok: true, code: "idempotent" } : { ok: false, code: "settlement_conflict" };
      }
      if (input.status === "outcome_unknown") {
        if (input.inputTokens !== null || input.outputTokens !== null || input.usageSource !== "unknown") {
          return { ok: false, code: "settlement_conflict" };
        }
        this.db.prepare(
          `UPDATE provider_steps
           SET status = 'outcome_unknown', settlement = 'held_unknown', input_tokens = NULL, output_tokens = NULL,
               usage_source = 'unknown', duration_ms = ?, error_code = ?
           WHERE step_id = ? AND settlement = 'pending'`,
        ).run(input.durationMs, input.errorCode, input.stepId);
        return { ok: true, code: "held" };
      }
      if (Number(step.fence) !== input.fence || String(step.status) !== "dispatched") {
        return { ok: false, code: "provider_fence_rejected" };
      }
      if (input.status === "not_dispatched") {
        if (input.inputTokens !== null || input.outputTokens !== null || input.usageSource !== "unknown" || !(input.errorCode === "provider_cancelled" || input.errorCode?.startsWith("global_budget_"))) return { ok: false, code: "settlement_conflict" };
        this.db.prepare("UPDATE turn_budgets SET reserved_tokens = reserved_tokens - ?, model_calls_reserved = model_calls_reserved - 1 WHERE job_id = ?").run(Number(step.reserved_total), input.jobId);
        this.db.prepare("UPDATE provider_steps SET status = 'not_dispatched', settlement = 'settled', input_tokens = NULL, output_tokens = NULL, usage_source = 'unknown', duration_ms = ?, error_code = ? WHERE step_id = ? AND settlement = 'pending'").run(input.durationMs, input.errorCode, input.stepId);
        return { ok: true, code: "not_dispatched" };
      }
      const known = input.status === "completed"
        && (input.usageSource === "simulated" || input.usageSource === "reported")
        && input.inputTokens !== null
        && input.outputTokens !== null
        && input.inputTokens + input.outputTokens > 0;
      if (known) {
        this.db.prepare(
          `UPDATE turn_budgets
           SET reserved_tokens = reserved_tokens - ?, settled_input = settled_input + ?, settled_output = settled_output + ?,
               model_calls_reserved = model_calls_reserved - 1, model_calls_settled = model_calls_settled + 1
           WHERE job_id = ?`,
        ).run(Number(step.reserved_total), input.inputTokens, input.outputTokens, input.jobId);
        this.db.prepare(
          `UPDATE provider_steps
           SET status = 'completed', settlement = 'settled', input_tokens = ?, output_tokens = ?, usage_source = ?,
               duration_ms = ?, error_code = NULL
           WHERE step_id = ? AND settlement = 'pending'`,
        ).run(input.inputTokens, input.outputTokens, input.usageSource, input.durationMs, input.stepId);
        return { ok: true, code: "settled" };
      }
      this.db.prepare(
        `UPDATE provider_steps
         SET status = ?, settlement = 'held_unknown', input_tokens = NULL, output_tokens = NULL, usage_source = 'unknown',
             duration_ms = ?, error_code = ?
         WHERE step_id = ? AND settlement = 'pending'`,
      ).run(input.status === "completed" ? "completed" : "error", input.durationMs, input.errorCode, input.stepId);
      return { ok: true, code: "held" };
    });
  }

  listProviderSteps(jobId: string): ProviderStepRecord[] {
    return (this.db.prepare("SELECT s.*, p.body AS response_metadata FROM provider_steps s LEFT JOIN provider_payloads p ON p.payload_id = 'res_' || s.step_id AND p.step_id = s.step_id AND p.job_id = s.job_id AND p.session_id = s.session_id AND p.actor_id = s.actor_id AND p.kind = 'response' WHERE s.job_id = ? ORDER BY s.created_at").all(jobId) as Array<Record<string, unknown>>).map(stepFromSqlite);
  }

  reserveRevision(jobId: string, owner: string, fence: number): { ok: true; count: number } | { ok: false; count: number } {
    return this.transaction(() => {
      const updated = this.db.prepare(
        `UPDATE jobs SET revision_count = revision_count + 1
         WHERE job_id = ? AND fence = ? AND lease_owner = ? AND status = 'running' AND lease_until > ?`,
      ).run(jobId, fence, owner, Date.now());
      const row = this.db.prepare("SELECT revision_count FROM jobs WHERE job_id = ?").get(jobId) as { revision_count?: number } | undefined;
      const count = Number(row?.revision_count ?? 0);
      return updated.changes === 1 ? { ok: true, count } : { ok: false, count };
    });
  }

  reserveToolCall(sessionId: string, lease: ExecutionLease, maxCalls: number): "ok" | "budget_exhausted" | "lost" {
    return this.transaction(() => {
      try { this.assertExecutionLease(sessionId, lease); } catch { return "lost"; }
      this.db.prepare("UPDATE jobs SET tool_call_limit = COALESCE(tool_call_limit, ?) WHERE job_id = ?").run(maxCalls, lease.jobId);
      const updated = this.db.prepare(`UPDATE jobs SET tool_call_count = tool_call_count + 1
        WHERE job_id = ? AND tool_call_count < MIN(tool_call_limit, ?)`).run(lease.jobId, maxCalls);
      return updated.changes === 1 ? "ok" : "budget_exhausted";
    });
  }

  reserveAssetRead(sessionId: string, lease: ExecutionLease | undefined, bytes: number, maxBytes: number): "ok" | "budget_exhausted" | "lost" {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0) return "lost";
    return this.transaction(() => {
      if (lease) { try { this.assertExecutionLease(sessionId, lease); } catch { return "lost"; } }
      if (!this.db.prepare("SELECT session_id FROM sessions WHERE session_id = ?").get(sessionId)) return "lost";
      this.db.prepare("INSERT OR IGNORE INTO session_asset_budgets (session_id, used_bytes, max_bytes) VALUES (?, 0, ?)").run(sessionId, maxBytes);
      const updated = this.db.prepare("UPDATE session_asset_budgets SET used_bytes = used_bytes + ? WHERE session_id = ? AND used_bytes + ? <= MIN(max_bytes, ?)").run(bytes, sessionId, bytes, maxBytes);
      return updated.changes === 1 ? "ok" : "budget_exhausted";
    });
  }

  getTurnBudget(jobId: string): TurnBudgetRecord | null {
    const row = this.db.prepare("SELECT * FROM turn_budgets WHERE job_id = ?").get(jobId) as Record<string, unknown> | undefined;
    return row ? budgetFromRow(row) : null;
  }

  saveProviderPayload(input: ProviderPayloadWrite): boolean {
    return this.transaction(() => {
      try { this.assertExecutionLease(input.sessionId, { jobId: input.jobId, owner: input.owner, fence: input.fence }); } catch { return false; }
      const step = this.db.prepare("SELECT step_id FROM provider_steps WHERE step_id = ? AND job_id = ? AND session_id = ? AND actor_id = ? AND fence = ?")
        .get(input.stepId, input.jobId, input.sessionId, input.actorId, input.fence);
      if (!step) return false;
      this.db.prepare(`INSERT INTO provider_payloads (payload_id, step_id, session_id, actor_id, job_id, kind, body, bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(input.payloadId, input.stepId, input.sessionId, input.actorId, input.jobId, input.kind, input.body, Buffer.byteLength(input.body));
      return true;
    });
  }

  listProviderPayloads(jobId: string, actorId: string): ProviderPayloadSummary[] {
    return (this.db.prepare(
      "SELECT payload_id, step_id, job_id, session_id, kind, bytes FROM provider_payloads WHERE job_id = ? AND actor_id = ? ORDER BY payload_id",
    ).all(jobId, actorId) as Array<Record<string, unknown>>).map(payloadSummary);
  }

  readProviderPayload(input: ProviderPayloadRead): ProviderPayloadPage | null {
    const row = this.db.prepare("SELECT * FROM provider_payloads WHERE payload_id = ?").get(input.payloadId) as Record<string, unknown> | undefined;
    if (!row || String(row.actor_id) !== input.actorId || String(row.session_id) !== input.sessionId) return null;
    const body = String(row.body);
    const offset = Math.max(0, input.offset);
    const limit = Math.max(0, input.limit);
    return {
      payload_id: String(row.payload_id),
      kind: String(row.kind) as "request" | "response",
      total_bytes: Number(row.bytes),
      offset,
      limit,
      text: body.slice(offset, offset + limit),
    };
  }

  loadAgentSnapshot(sessionId: string, selector: { jobId?: string; kind?: "progress" | "settled" }): AgentSnapshotRecord | null {
    const clauses = ["session_id = ?"];
    const params: Array<string> = [sessionId];
    if (selector.jobId) {
      clauses.push("job_id = ?");
      params.push(selector.jobId);
    }
    if (selector.kind) {
      clauses.push("kind = ?");
      params.push(selector.kind);
    }
    const row = this.db.prepare(`SELECT * FROM agent_snapshots WHERE ${clauses.join(" AND ")} ORDER BY snapshot_id DESC LIMIT 1`).get(...params) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      session_id: String(row.session_id),
      job_id: String(row.job_id),
      fence: Number(row.fence),
      kind: String(row.kind) as "progress" | "settled",
      body: JSON.parse(String(row.body_json)) as Record<string, unknown>,
    };
  }

  close(): void {
    this.db.close();
  }

  private requireJob(jobId: string): JobRecord {
    const job = this.getJob(jobId);
    if (!job) throw new Error("job_not_found");
    return job;
  }

  private insertEvent(jobId: string, seq: number, type: string, payload: Record<string, unknown>): JobEvent {
    const at = new Date().toISOString();
    this.db.prepare("INSERT INTO job_events (job_id, seq, type, at, payload_json) VALUES (?, ?, ?, ?, ?)").run(jobId, seq, type, at, JSON.stringify(payload));
    return { seq, type, at, payload };
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!rows.some((row) => row.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private sessionFromRow(row: Record<string, unknown>): StoredSession {
    return {
      session_id: String(row.session_id),
      title: String(row.title),
      role: String(row.role),
      actor_id: row.actor_id ? String(row.actor_id) : "demo-analyst",
      created_at: String(row.created_at),
      slots: row.slots_json ? (JSON.parse(String(row.slots_json)) as Slots | null) : null,
      bindings: JSON.parse(String(row.bindings_json)) as ContractBinding[],
    };
  }

  private jobFromRow(row: Record<string, unknown>): JobRecord {
    const jobId = String(row.job_id);
    const events = (this.db.prepare("SELECT * FROM job_events WHERE job_id = ? ORDER BY seq").all(jobId) as Array<Record<string, unknown>>).map((event) => ({
      seq: Number(event.seq),
      type: String(event.type),
      at: String(event.at),
      payload: JSON.parse(String(event.payload_json)) as Record<string, unknown>,
    }));
    return {
      job_id: jobId,
      session_id: String(row.session_id),
      status: String(row.status) as JobStatus,
      user_text: String(row.user_text),
      idempotency_key: String(row.idempotency_key),
      turn: JSON.parse(String(row.turn_json)) as TurnResolution,
      events,
      next_seq: Number(row.next_seq),
      version: Number(row.version),
      analysis: row.analysis_json ? (JSON.parse(String(row.analysis_json)) as AnalysisRecord) : null,
      error: row.error_json ? (JSON.parse(String(row.error_json)) as { code: string; message: string }) : null,
      abort_reason: null,
      fence: Number(row.fence),
      lease_owner: row.lease_owner ? String(row.lease_owner) : null,
      lease_until: row.lease_until === null || row.lease_until === undefined ? null : Number(row.lease_until),
      cancel_requested: Number(row.cancel_requested) === 1,
      simulated: true,
      usage: row.usage_json ? (JSON.parse(String(row.usage_json)) as JobUsage) : null,
      model_id: row.model_id ? String(row.model_id) : null,
      reasoning: row.reasoning ? String(row.reasoning) : null,
      created_at: String(row.created_at),
      ...(row.started_at ? { started_at: String(row.started_at) } : {}),
      ...(row.finished_at ? { finished_at: String(row.finished_at) } : {}),
    };
  }
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function stepFromSqlite(row: Record<string, unknown>): ProviderStepRecord {
  return {
    ...cacheUsageFromMetadata(row.response_metadata, { status: row.status, settlement: row.settlement, usage_source: row.usage_source, input_tokens: row.input_tokens, output_tokens: row.output_tokens }),
    step_id: String(row.step_id),
    session_id: String(row.session_id),
    job_id: String(row.job_id),
    actor_id: String(row.actor_id),
    fence: Number(row.fence),
    provider: String(row.provider),
    model: String(row.model),
    status: String(row.status) as ProviderStepRecord["status"],
    input_tokens: nullableNumber(row.input_tokens),
    output_tokens: nullableNumber(row.output_tokens),
    usage_source: String(row.usage_source) as ProviderStepRecord["usage_source"],
    duration_ms: nullableNumber(row.duration_ms),
    error_code: row.error_code === null || row.error_code === undefined ? null : String(row.error_code),
    estimated_input: Number(row.estimated_input ?? 0),
    reserved_output: Number(row.reserved_output ?? 0),
    reserved_total: Number(row.reserved_total ?? 0),
    estimate_source: row.estimate_source === "utf8_byte_estimate" ? "utf8_byte_estimate" : "char_estimate",
    settlement: String(row.settlement ?? "pending") as ProviderStepRecord["settlement"],
  };
}

function budgetFromRow(row: Record<string, unknown>): TurnBudgetRecord {
  return {
    job_id: String(row.job_id),
    settled_input: Number(row.settled_input),
    settled_output: Number(row.settled_output),
    reserved_tokens: Number(row.reserved_tokens),
    model_calls_settled: Number(row.model_calls_settled),
    model_calls_reserved: Number(row.model_calls_reserved),
    max_tokens: Number(row.max_tokens),
    context_window: Number(row.context_window),
    max_output_tokens: Number(row.max_output_tokens),
    max_model_calls: Number(row.max_model_calls),
    max_tool_calls: Number(row.max_tool_calls),
    wall_clock_ms: Number(row.wall_clock_ms),
    max_resource_bytes: Number(row.max_resource_bytes),
  };
}

function payloadSummary(row: Record<string, unknown>): ProviderPayloadSummary {
  return {
    payload_id: String(row.payload_id),
    step_id: String(row.step_id),
    job_id: String(row.job_id),
    session_id: String(row.session_id),
    kind: String(row.kind) as ProviderPayloadSummary["kind"],
    bytes: Number(row.bytes),
  };
}
