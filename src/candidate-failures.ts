import { createHash } from "node:crypto";

/** Persist only a bounded error code. Pi schema validation failures have no
 * details object and their text can contain arguments, so recognize the fixed
 * prefix without storing or exposing the remainder. */
export function safeToolResultCode(tool: string, result: unknown, isError: boolean): string | null {
  if (!result || typeof result !== "object") return null;
  const record = result as { details?: unknown; content?: unknown };
  const details = record.details && typeof record.details === "object" ? record.details as Record<string, unknown> : {};
  if (typeof details.code === "string" && /^[a-z][a-z0-9_]{0,79}$/u.test(details.code)) return details.code;
  if (isError && tool === "calculate_session_cells" && Array.isArray(record.content) && record.content.some((item: unknown) => {
    const part = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return part.type === "text" && typeof part.text === "string" && part.text.startsWith('Validation failed for tool "calculate_session_cells":');
  })) return "invalid_calculation_shape";
  return null;
}

/** Hash only the query text, not model annotations or preview settings.
 * Events retain an opaque retry identity without storing SQL or user text. */
export function queryRetryKey(tool: string, args: unknown): string | undefined {
  if (
    tool !== "query" ||
    !args ||
    typeof args !== "object" ||
    Array.isArray(args)
  )
    return undefined;
  const sql = (args as { sql?: unknown }).sql;
  if (
    typeof sql !== "string" ||
    !sql.trim() ||
    Buffer.byteLength(sql, "utf8") > 64 * 1024
  )
    return undefined;
  return createHash("sha256").update(sql.trim()).digest("hex");
}

/** Event metadata contains no raw SQL or user text. A later successful tool
 * result can retire one earlier parameter/syntax failure only if that result
 * belongs to the selected dependency closure. This is evidence of a retry,
 * not proof that the model understood every part of the user's intent. */
export function unresolvedCandidateFailures(
  events: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>,
  selectedClosure: ReadonlySet<string>,
): number {
  const pending: Array<{
    tool: string;
    recoverable: boolean;
    retryKey?: string;
  }> = [];
  const attempts = new Map<string, string>();
  const recoverable = new Set([
    "invalid_sql",
    "unparseable_sql",
    "sql_parse_failed",
    "clickhouse_parse_failed",
    "invalid_calculation_shape",
    "invalid_calculation",
  ]);
  for (const event of events) {
    if (
      event.type === "tool_started" &&
      event.payload.tool_name === "query" &&
      typeof event.payload.tool_call_id === "string" &&
      typeof event.payload.retry_key === "string" &&
      /^[a-f0-9]{64}$/u.test(event.payload.retry_key)
    ) {
      attempts.set(event.payload.tool_call_id, event.payload.retry_key);
      continue;
    }
    if (
      event.type !== "tool_finished" ||
      !["query", "calculate_session_cells"].includes(
        String(event.payload.tool_name),
      )
    )
      continue;
    const tool = String(event.payload.tool_name);
    const retryKey =
      typeof event.payload.tool_call_id === "string"
        ? attempts.get(event.payload.tool_call_id)
        : undefined;
    if (event.payload.is_error === true) {
      const prerequisite =
        tool === "query" &&
        event.payload.code === "missing_data_contract_evidence" &&
        retryKey;
      pending.push({
        tool,
        recoverable:
          Boolean(prerequisite) || recoverable.has(String(event.payload.code)),
        ...(prerequisite ? { retryKey } : {}),
      });
      continue;
    }
    if (
      event.payload.is_error !== false ||
      typeof event.payload.resource_id !== "string" ||
      !selectedClosure.has(event.payload.resource_id)
    )
      continue;
    const index = pending.findIndex(
      (failure) =>
        failure.tool === tool &&
        failure.recoverable &&
        (!failure.retryKey || failure.retryKey === retryKey),
    );
    if (index >= 0) pending.splice(index, 1);
  }
  return pending.length;
}
