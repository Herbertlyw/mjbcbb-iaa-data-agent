import { MessageChannel, Worker } from "node:worker_threads";

export interface GlobalBudgetOptions {
  path: string;
  budgetId: string;
  maxRequests: number;
  maxTokens: number;
  timeoutMs?: number;
}
export type GlobalBudgetDecision = { ok: boolean; code: string };
export interface GlobalBudgetStats {
  budget_id: string; status: "active" | "closed"; max_requests: number; max_tokens: number;
  requests_reserved: number; dispatched_count: number; accounted_tokens: number; reported_input: number | null; reported_output: number | null;
  cache_hit_tokens: number | null; cache_miss_tokens: number | null;
  usage_incomplete_count: number; unknown_count: number; pending_count: number;
}
export interface GlobalBudgetStep {
  step_id: string; budget_id: string; job_id: string; state: "reserved" | "dispatched" | "settled" | "held_unknown";
  reserved_input: number; reserved_output: number; input_tokens: number | null; output_tokens: number | null;
  cache_read_tokens: number | null; cache_write_tokens: number | null; outcome: string | null;
  cache_hit_tokens: number | null; cache_miss_tokens: number | null;
}
export interface GlobalBudgetSettlement {
  stepId: string;
  outcome: "completed" | "error" | "cancelled" | "outcome_unknown";
  /** Total provider-reported prompt tokens, including cache hits. */
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Reported cache components when actually available; null means unknown. */
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  cacheHitTokens?: number | null;
  cacheMissTokens?: number | null;
}

type Pending = { reject: (error: Error) => void };

/** SQLite WAL is a transaction coordinator shared by local processes. Its
 * synchronous I/O occurs only in a worker thread. It is separate from MySQL:
 * a failure between two independent commits is uncertain and may hold both
 * reservations; the caller must never infer rollback or retry a dispatch. */
export class GlobalBudget {
  private readonly worker: Worker;
  private readonly pending = new Set<Pending>();
  private failed = false;
  private closed = false;
  private readonly timeoutMs: number;
  private readonly scope: Pick<GlobalBudgetOptions, "budgetId" | "maxRequests" | "maxTokens">;

  private constructor(options: GlobalBudgetOptions, mode: "activate" | "open" | "inspect") {
    this.scope = { budgetId: options.budgetId, maxRequests: options.maxRequests, maxTokens: options.maxTokens };
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!options.path || !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) throw new Error("global_budget_invalid");
    this.worker = new Worker(new URL("./global-budget-worker.mjs", import.meta.url), { workerData: { path: options.path, mode } });
    this.worker.on("error", () => this.failAll());
    this.worker.on("exit", () => this.failAll());
  }

  /** Explicit, idempotent initial activation; cannot switch an active scope or
   * reopen a previously used ID. Closing a scope is a separate user action. */
  static async activate(options: GlobalBudgetOptions): Promise<GlobalBudget> {
    const store = new GlobalBudget(options, "activate");
    try { const decision = await store.request<GlobalBudgetDecision>("activate", store.scope); if (!decision.ok) throw new Error(decision.code); return store; }
    catch (error) { await store.close(); throw error; }
  }

  /** Request paths use open, never activation or automatic limit creation. */
  static async open(options: GlobalBudgetOptions): Promise<GlobalBudget> {
    const store = new GlobalBudget(options, "open");
    try { const decision = await store.request<GlobalBudgetDecision>("verify", store.scope); if (!decision.ok) throw new Error(decision.code); return store; }
    catch (error) { await store.close(); throw error; }
  }

  /** Audit an existing scope without activating it, including after closure. */
  static async inspect(options: GlobalBudgetOptions): Promise<GlobalBudget> {
    const store = new GlobalBudget(options, "inspect");
    try { const decision = await store.request<GlobalBudgetDecision>("verifyInspection", store.scope); if (!decision.ok) throw new Error(decision.code); return store; }
    catch (error) { await store.close(); throw error; }
  }

  reserve(input: { stepId: string; jobId: string; estimatedInput: number; reservedOutput: number }): Promise<GlobalBudgetDecision> {
    return this.request("reserve", { ...this.scope, ...input });
  }
  markDispatched(stepId: string): Promise<GlobalBudgetDecision> { return this.request("dispatched", { budgetId: this.scope.budgetId, stepId }); }
  settle(input: GlobalBudgetSettlement): Promise<GlobalBudgetDecision> { return this.request("settle", { budgetId: this.scope.budgetId, ...input }); }
  stats(): Promise<GlobalBudgetStats | null> { return this.request("stats", { budgetId: this.scope.budgetId }); }
  step(stepId: string): Promise<GlobalBudgetStep | null> { return this.request("step", { budgetId: this.scope.budgetId, stepId }); }
  /** Stable step-ID pagination for operator review of interrupted reservations. */
  pendingSteps(afterStepId = "", limit = 100): Promise<GlobalBudgetStep[]> { return this.request("pendingSteps", { budgetId: this.scope.budgetId, afterStepId, limit }); }
  /** For an explicitly requested transition only. Old rows, including unknown
   * reservations, remain auditable and are never deleted or silently refunded. */
  closeScope(acknowledgeUnknown = false): Promise<GlobalBudgetDecision> { return this.request("closeScope", { budgetId: this.scope.budgetId, confirm: "close-budget-scope", acknowledgeUnknown }); }
  /** Explicit operator reconciliation after the relevant process is stopped;
   * preserves the full reservation and never authorizes a retry. */
  acknowledgeInterrupted(stepId: string): Promise<GlobalBudgetDecision> { return this.request("acknowledgeInterrupted", { budgetId: this.scope.budgetId, stepId, confirm: "retain-interrupted-as-unknown" }); }

  private request<T>(op: string, input: object): Promise<T> {
    if (this.failed || this.closed) return Promise.reject(new Error("global_budget_closed"));
    if (this.pending.size >= 64) return Promise.reject(new Error("global_budget_overloaded"));
    const channel = new MessageChannel();
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (error?: Error, result?: T) => {
        if (done) return;
        done = true; clearTimeout(timer); this.pending.delete(item); channel.port1.close();
        if (error) reject(error); else resolve(result as T);
      };
      const item: Pending = { reject: (error) => finish(error) };
      const timer = setTimeout(() => this.failAll(), this.timeoutMs);
      this.pending.add(item);
      channel.port1.once("message", (message: { ok: true; result: T } | { ok: false; code?: string }) => {
        if (message.ok) finish(undefined, message.result);
        else finish(new Error(`global_budget_operation_failed:${op}:${message.code ?? "operation_error"}`));
      });
      try { this.worker.postMessage({ op, input, port: channel.port2 }, [channel.port2]); }
      catch { channel.port2.close(); finish(new Error("global_budget_outcome_unknown")); }
    });
  }
  private failAll(): void {
    this.failed = true;
    for (const pending of this.pending) pending.reject(new Error("global_budget_outcome_unknown"));
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.failAll();
    await this.worker.terminate();
  }
}
