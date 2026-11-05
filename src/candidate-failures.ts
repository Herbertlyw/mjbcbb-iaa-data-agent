/** Event metadata contains no raw SQL or user text. A later successful tool
 * result can retire one earlier parameter/syntax failure only if that result
 * belongs to the selected dependency closure. This is evidence of a retry,
 * not proof that the model understood every part of the user's intent. */
export function unresolvedCandidateFailures(events: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>, selectedClosure: ReadonlySet<string>): number {
  const pending: Array<{ tool: string; recoverable: boolean }> = [];
  const recoverable = new Set(["invalid_sql", "unparseable_sql", "sql_parse_failed", "clickhouse_parse_failed", "invalid_calculation_shape", "invalid_calculation"]);
  for (const event of events) {
    if (event.type !== "tool_finished" || !["query", "calculate_session_cells"].includes(String(event.payload.tool_name))) continue;
    const tool = String(event.payload.tool_name);
    if (event.payload.is_error === true) { pending.push({ tool, recoverable: recoverable.has(String(event.payload.code)) }); continue; }
    if (event.payload.is_error !== false || typeof event.payload.resource_id !== "string" || !selectedClosure.has(event.payload.resource_id)) continue;
    const index = pending.findIndex((failure) => failure.tool === tool && failure.recoverable);
    if (index >= 0) pending.splice(index, 1);
  }
  return pending.length;
}
