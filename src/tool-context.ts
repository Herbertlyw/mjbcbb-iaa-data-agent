// Shared context and result contract for domain tools.
import type { ClickHouseClient } from "@clickhouse/client";
import type { DatabaseSync } from "node:sqlite";
import { type AppConfig } from "./config.js";
import type { MysqlFreshnessStore } from "./mysql-freshness.js";
import { type SessionStore } from "./session.js";
import type { KnowledgeBase, ToolFailure } from "./types.js";

export interface ToolContext {
  config: AppConfig;
  knowledge: KnowledgeBase;
  db: DatabaseSync;
  sessions: SessionStore;
  businessEngine: "sqlite" | "clickhouse";
  clickhouse: ClickHouseClient | null;
  mysqlFreshness?: () => Promise<MysqlFreshnessStore | null>;
}

export type ToolResult = ToolFailure | { ok: true; [key: string]: unknown };

export function fail(code: string, message: string, extra: Record<string, unknown> = {}): ToolFailure {
  return { ok: false, code, message, ...extra };
}

export function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
