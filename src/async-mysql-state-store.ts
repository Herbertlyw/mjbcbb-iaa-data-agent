import { MessageChannel, Worker } from "node:worker_threads";
import type { MysqlConnection } from "./mysql-state-store.js";
import type { StateStore } from "./state-store.js";

/** Promise-based view of every existing state operation. A timeout means the
 * database outcome is unknown; callers must not infer rollback or retry writes. */
export type AsyncStateStore = {
  [K in keyof StateStore]: StateStore[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

type StateOperation = Exclude<keyof StateStore, "close">;
type Pending = { reject: (reason: Error) => void };

export class AsyncMysqlStateStore {
  private readonly worker: Worker;
  private readonly pending = new Set<Pending>();
  private closing = false;
  private failed = false;

  private constructor(connection: MysqlConnection, private readonly timeoutMs: number) {
    if (connection.host !== "127.0.0.1") throw new Error("MySQL 状态库只接受 127.0.0.1 上的隔离实例");
    this.worker = new Worker(new URL("./mysql-bridge-worker.mjs", import.meta.url), { workerData: connection });
    // A worker can fail after MySQL commits and before it returns a response.
    this.worker.on("error", () => this.failPending("mysql_state_outcome_unknown"));
    this.worker.on("exit", () => this.failPending("mysql_state_outcome_unknown"));
  }

  get available(): boolean { return !this.closing && !this.failed; }

  static async open(connection: MysqlConnection, timeoutMs = 20_000, initializationTimeoutMs = timeoutMs): Promise<AsyncMysqlStateStore> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(initializationTimeoutMs) || initializationTimeoutMs < 1) throw new Error("invalid_mysql_timeout");
    const state = new AsyncMysqlStateStore(connection, timeoutMs);
    try {
      await state.request("ping", [], initializationTimeoutMs);
      return state;
    } catch (error) {
      await state.close();
      throw error;
    }
  }

  /** All operations use the same bridge transactions as the existing store.
   * Callers should await dependent operations to preserve their ordering. */
  call<K extends StateOperation>(op: K, ...args: Parameters<StateStore[K]>): Promise<Awaited<ReturnType<StateStore[K]>>> {
    return this.request(op, args);
  }

  private request<T>(op: string, args: unknown[], timeoutMs = this.timeoutMs): Promise<T> {
    if (this.closing || this.failed) return Promise.reject(new Error("mysql_state_closed"));
    // Fail before dispatch rather than allowing an unbounded worker/pool queue.
    if (this.pending.size >= 64) return Promise.reject(new Error("mysql_state_overloaded"));
    const channel = new MessageChannel();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(item);
        channel.port1.close();
        if (error) reject(error); else resolve(value as T);
      };
      const item: Pending = { reject: (error) => finish(error) };
      const timer = setTimeout(() => {
        // The transaction might still commit. Poison this bridge instance and
        // fail all pending callers; do not dispatch further work to it.
        this.failPending("mysql_state_outcome_unknown");
      }, timeoutMs);
      this.pending.add(item);
      channel.port1.once("message", (body: { ok: true; result: T } | { ok: false; name: string }) => {
        if (body.ok) finish(undefined, body.result);
        else {
          // Do not expose database messages, which can contain query data.
          const error = new Error(body.name === "execution_fence_rejected" ? body.name : "mysql_state_operation_failed");
          error.name = body.name;
          finish(error);
        }
      });
      try { this.worker.postMessage({ op, args, port: channel.port2 }, [channel.port2]); }
      catch { channel.port2.close(); finish(new Error("mysql_state_outcome_unknown")); }
    });
  }

  private failPending(code: string): void {
    this.failed = true;
    for (const item of this.pending) item.reject(new Error(code));
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    // Closing a worker with in-flight calls leaves their transaction outcomes unknown.
    this.failPending("mysql_state_outcome_unknown");
    await this.worker.terminate();
  }
}
