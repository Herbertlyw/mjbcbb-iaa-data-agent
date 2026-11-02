import { ClickHouseLogLevel, createClient, type ClickHouseClient } from "@clickhouse/client";

export interface ClickHouseConfig {
  url: string;
  username: string;
  password: string;
  database: string;
  maxRowsToRead: number;
  timeoutSeconds: number;
}

export function assertLocalClickHouse(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
    throw new Error("ClickHouse 只允许 http://127.0.0.1 上的隔离实例");
  }
}

export function createClickHouseClient(config: ClickHouseConfig, readonly: boolean): ClickHouseClient {
  assertLocalClickHouse(config.url);
  return createClient({
    url: config.url,
    username: config.username,
    password: config.password,
    database: config.database,
    // Driver error logs can include database-provided text and query details.
    // The tool layer maps failures to safe error codes instead.
    log: { level: ClickHouseLogLevel.OFF },
    request_timeout: Math.max(config.timeoutSeconds, 1) * 1000,
    clickhouse_settings: {
      readonly: readonly ? "1" : "0",
      max_execution_time: Math.max(config.timeoutSeconds, 1),
      max_rows_to_read: String(config.maxRowsToRead),
      read_overflow_mode: "throw",
    },
  });
}

export async function clickHouseQuery(client: ClickHouseClient, sql: string, signal?: AbortSignal): Promise<Array<Record<string, unknown>>> {
  const result = await client.query({ query: sql, format: "JSONEachRow", abort_signal: signal });
  const rows = await result.json<Record<string, unknown>>();
  return rows.map(normalizeRow);
}

export async function clickHouseCommand(client: ClickHouseClient, sql: string): Promise<void> {
  await client.command({ query: sql });
}

export async function clickHouseInsert<T>(client: ClickHouseClient, table: string, rows: T[]): Promise<void> {
  if (rows.length === 0) return;
  await client.insert({ table, values: rows, format: "JSONEachRow" });
}

export async function clickHouseColumns(client: ClickHouseClient, table: string): Promise<string[]> {
  if (!/^[a-z_][a-z0-9_]*$/u.test(table)) throw new Error("unsafe table");
  const result = await client.query({ query: `DESCRIBE TABLE ${table}`, format: "JSONEachRow" });
  const rows = await result.json<{ name: string }>();
  return rows.map((row) => row.name);
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) normalized[key] = value.toISOString().slice(0, 10);
    else normalized[key] = value;
  }
  return normalized;
}
