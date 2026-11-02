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
      // Decimal JSON numbers would be rounded by JSON.parse before evidence
      // validation. Keep their exact base-10 representation end to end.
      output_format_json_quote_decimals: 1,
    },
  });
}

export async function clickHouseQuery(client: ClickHouseClient, sql: string, signal?: AbortSignal): Promise<Array<Record<string, unknown>>> {
  const result = await client.query({ query: sql, format: "JSONEachRow", abort_signal: signal });
  const rows = await result.json<Record<string, unknown>>();
  return rows.map(normalizeRow);
}

/** Read a bounded complete result, or stop after observing the first row over
 * either limit. A truncated result's count is only a lower bound. */
export async function clickHouseQueryBounded(client: ClickHouseClient, sql: string, maxRows: number, maxBytes: number, signal?: AbortSignal): Promise<{ rows: Array<Record<string, unknown>>; column_types: Record<string, string>; observed_rows: number; truncated: boolean; query_id: string }> {
  const result = await client.query({ query: sql, format: "JSONCompactEachRowWithNamesAndTypes", abort_signal: signal, clickhouse_settings: { max_block_size: "1024" } });
  const rows: Array<Record<string, unknown>> = []; let names: string[] | null = null; let types: string[] | null = null; let bytes = 2; let observed = 0; let truncated = false;
  try {
    outer: for await (const chunk of result.stream<unknown[]>()) {
      for (const line of chunk) {
        const cells = line.json();
        if (!Array.isArray(cells)) throw new Error("invalid_clickhouse_result_shape");
        if (!names) {
          if (cells.some((value) => typeof value !== "string") || new Set(cells).size !== cells.length) throw new Error("duplicate_or_invalid_result_columns");
          names = cells as string[]; continue;
        }
        if (!types) {
          if (cells.length !== names.length || cells.some((value) => typeof value !== "string")) throw new Error("invalid_result_types");
          types = cells as string[]; continue;
        }
        if (cells.length !== names.length) throw new Error("invalid_clickhouse_result_shape");
        observed += 1;
        const row = Object.fromEntries(names.map((name, index) => [name, cells[index]]));
        const size = Buffer.byteLength(JSON.stringify(row)) + (rows.length ? 1 : 0);
        if (rows.length >= maxRows || bytes + size > maxBytes) { truncated = true; break outer; }
        rows.push(normalizeRow(row)); bytes += size;
      }
    }
    if (!names || !types) throw new Error("missing_result_types");
    return { rows, column_types: Object.fromEntries(names.map((name, index) => [name, types![index]!])), observed_rows: observed, truncated, query_id: result.query_id };
  } finally { result.close(); }
}

export async function clickHouseCommand(client: ClickHouseClient, sql: string): Promise<void> {
  await client.command({ query: sql });
}

export async function clickHouseInsert<T>(client: ClickHouseClient, table: string, rows: T[]): Promise<void> {
  if (rows.length === 0) return;
  await client.insert({ table, values: rows, format: "JSONEachRow" });
}

export async function clickHouseColumns(client: ClickHouseClient, table: string): Promise<string[]> {
  return Object.keys(await clickHouseColumnTypes(client, table));
}

export async function clickHouseColumnTypes(client: ClickHouseClient, table: string): Promise<Record<string, string>> {
  if (!/^[a-z_][a-z0-9_]*$/u.test(table)) throw new Error("unsafe table");
  const result = await client.query({ query: `DESCRIBE TABLE ${table}`, format: "JSONEachRow" });
  const rows = await result.json<{ name: string; type: string }>();
  return Object.fromEntries(rows.map((row) => [row.name, row.type]));
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) normalized[key] = value.toISOString().slice(0, 10);
    else normalized[key] = value;
  }
  return normalized;
}
