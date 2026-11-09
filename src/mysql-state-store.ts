import type { StateStore } from "./state-store.js";

export interface MysqlConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  authority?: { mode: "local_mock" | "controlled_visitor"; policy?: import("./state-store.js").AuthorityPolicy };
}

/** A fail-fast guard for legacy synchronous callers. MySQL state I/O is
 * exclusively available through AsyncMysqlStateStore; silently falling back
 * to a synchronous wait would block heartbeats, cancellation and SSE. */
export class MysqlStateStore {
  constructor(connection: MysqlConnection) {
    if (connection.host !== "127.0.0.1") throw new Error("MySQL 状态库只接受 127.0.0.1 上的隔离实例");
    return new Proxy(this, {
      get(target, key, receiver) {
        if (key in target || typeof key === "symbol") return Reflect.get(target, key, receiver);
        return () => { throw new Error("mysql_sync_api_unavailable: 请使用异步状态接口"); };
      },
    });
  }
  close(): void {}
  async closeAsync(): Promise<void> {}
}

// Runtime retains synchronous StateStore methods for SQLite. In MySQL mode
// these compatibility methods explicitly fail instead of blocking the thread.
export interface MysqlStateStore extends StateStore {}
