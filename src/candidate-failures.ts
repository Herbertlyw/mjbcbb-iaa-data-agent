import { createHash } from "node:crypto";
import { parse } from "@clickhouse/parser";

const PARTIAL_REPAIR_REASONS: Readonly<Record<string, string>> = Object.freeze({
  request_coverage_review_incomplete: "必须逐项复核当前用户原话和已确认上下文，对照本轮已验证结果指出已答、已解释的未知、缺失和有歧义的事项。",
  model_declared_unresolved: "工作记录仍列有未解决事项；核对其是否属于本轮用户的必答项，不要简单清空记录。",
  arithmetic_lineage_unsupported: "所选算术结果的来源或计算无法复核，请检查其输入资源、执行身份和可支持的计算形状。",
  calculation_lineage_unsupported: "所选计算结果的来源无法复核，请检查对应查询和计算资源。",
  transform_lineage_unsupported: "所选变换结果的来源或步骤无法复核。",
  alignment_lineage_unsupported: "所选对齐结果的输入或分组无法复核。",
  comparison_unverifiable: "所选比较的范围、单位或来源无法复核。",
  unresolved_tool_failure: "存在尚未消解的工具失败；检查它是否影响本轮要求，不能仅因另一次成功就忽略。",
});

/** Only actionable server-produced reasons trigger one bounded repair. Normal
 * partial results (e.g. unavailable coverage) do not trigger automatic retry. */
export function partialCandidateFeedback(reasons: unknown): { codes: string[]; message: string } | null {
  if (!Array.isArray(reasons)) return null;
  const codes = [...new Set(reasons.filter((reason): reason is string => typeof reason === "string" && Object.hasOwn(PARTIAL_REPAIR_REASONS, reason)))].slice(0, 8);
  if (!codes.length) return null;
  const instructions = codes.map((code) => PARTIAL_REPAIR_REASONS[code]);
  return { codes, message: `宿主反馈：候选结果尚有以下可检查的限制：${instructions.join(" ")} 请对照当前用户原话，优先复用本任务已有结果；有缺口且能安全补证时继续，否则以 [[partial]] 和有效资源交付。不要把模型工作记录当成权威事实。` };
}

const REPEATED_FAILURE_CODES: ReadonlySet<string> = new Set([
  "asset_not_authorized", "table_not_authorized", "missing_data_contract_evidence", "function_not_allowed",
  "join_structure_unsupported", "arithmetic_lineage_unsupported", "invalid_calculation_shape",
]);

/** An opaque identity only: never write arguments, SQL or user text to events. */
export function toolAttemptKey(tool: string, args: unknown, authority = ""): string | undefined {
  if (!["query", "calculate_session_cells", "read_data_contract_view"].includes(tool) || !args || typeof args !== "object" || Array.isArray(args)) return undefined;
  if (tool === "query" && typeof (args as { sql?: unknown }).sql !== "string") return undefined;
  try {
    const normalize = (value: unknown, depth: number): unknown => {
      if (depth > 16) throw new Error("depth");
      if (Array.isArray(value)) return value.map((item) => normalize(item, depth + 1));
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item, depth + 1)]));
      return value;
    };
    const material = tool === "query" ? { sql: (args as { sql?: unknown }).sql } : args;
    const encoded = JSON.stringify(normalize(material, 0));
    if (!encoded || Buffer.byteLength(encoded, "utf8") > 64 * 1024) return undefined;
    return createHash("sha256").update(`${tool}\0${authority}\0${encoded}`).digest("hex");
  } catch { return undefined; }
}

/** Stable contract receipt identity; omits receipt IDs, timestamps, model
 * text and user inputs. Only a repeated identical observation is non-progress. */
export function contractProgressKey(tool: string, result: unknown): string | undefined {
  if (tool !== "read_data_contract_view" || !result || typeof result !== "object") return undefined;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const d = details as Record<string, unknown>;
  if (d.ok !== true || typeof d.asset_id !== "string" || typeof d.content_hash !== "string" || typeof d.registry_revision !== "string" || typeof d.queryable !== "boolean") return undefined;
  const freshness = d.published_freshness && typeof d.published_freshness === "object" ? d.published_freshness as Record<string, unknown> : {};
  return createHash("sha256").update(JSON.stringify({ asset_id: d.asset_id, content_hash: d.content_hash, registry_revision: d.registry_revision, queryable: d.queryable, reason: d.reason, columns_offset: d.columns_offset, columns_next_offset: d.columns_next_offset, publication_id: freshness.publication_id, publication_version: freshness.version, publication_status: freshness.status })).digest("hex");
}

/** Stop a repeated identical failure or short cycle of stable failures only
 * after three repetitions without new evidence. This does not certify that a
 * candidate answered the user's question. */
export function repeatedIdenticalToolFailure(events: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>): { tool: string; code: string } | null {
  const starts = new Map<string, string>();
  let streak: Array<{ tool: string; code: string; key: string }> = [];
  const observations = new Set<string>();
  let authority: string | undefined;
  for (const event of events) {
    const p = event.payload;
    if (event.type === "tool_started" && typeof p.tool_call_id === "string" && typeof p.attempt_key === "string" && /^[a-f0-9]{64}$/u.test(p.attempt_key)) {
      if (typeof p.authority_key === "string" && /^[a-f0-9]{64}$/u.test(p.authority_key)) {
        if (authority && authority !== p.authority_key) { streak = []; observations.clear(); }
        authority = p.authority_key;
      }
      starts.set(p.tool_call_id, p.attempt_key);
    }
    if (event.type !== "tool_finished") continue;
    const key = typeof p.tool_call_id === "string" ? starts.get(p.tool_call_id) : undefined;
    if (p.is_error === false && p.tool_name === "read_data_contract_view" && typeof p.progress_key === "string" && /^[a-f0-9]{64}$/u.test(p.progress_key)) {
      if (!observations.has(p.progress_key)) { observations.add(p.progress_key); streak = []; }
      continue;
    }
    if (p.is_error !== true || typeof p.tool_name !== "string" || typeof p.code !== "string" || !REPEATED_FAILURE_CODES.has(p.code) || !key) { streak = []; continue; }
    streak.push({ tool: p.tool_name, code: p.code, key });
    if (streak.length > 12) streak.shift();
  }
  for (let period = 1; period <= 4 && period * 3 <= streak.length; period++) {
    const tail = streak.slice(-period * 3);
    if (tail.every((item, i) => item.tool === tail[i % period]!.tool && item.code === tail[i % period]!.code && item.key === tail[i % period]!.key)) return { tool: tail.at(-1)!.tool, code: tail.at(-1)!.code };
  }
  return null;
}

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

/** A narrowly proven equivalence: the same single SELECT AST, with only
 * COUNT(*) and COUNT() normalized. Scope, projections, JOIN keys, filters,
 * grouping and ordering remain in the digest; subqueries and limits do not
 * participate. Invalid or unrecognized shapes are never considered equal. */
export function queryEquivalentKey(tool: string, args: unknown): string | undefined {
  if (tool !== "query" || !args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const sql = (args as { sql?: unknown }).sql;
  if (typeof sql !== "string" || !sql.trim() || Buffer.byteLength(sql, "utf8") > 64 * 1024) return undefined;
  try {
    const statements = parse(sql, { locations: false }) as unknown[];
    if (statements.length !== 1) return undefined;
    const root = statements[0] as Record<string, unknown>;
    if (root?.type !== "SelectWithUnionQuery" || Object.keys(root).some((key) => !["type", "selects"].includes(key)) || !Array.isArray(root.selects) || root.selects.length !== 1) return undefined;
    const select = root.selects[0] as Record<string, unknown>;
    if (select?.type !== "SelectQuery" || Object.keys(select).some((key) => !["type", "select", "from", "where", "group_by", "order_by"].includes(key))) return undefined;
    let selectCount = 0;
    const normalize = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(normalize);
      if (!value || typeof value !== "object") return value;
      const item = value as Record<string, unknown>;
      if (item.type === "SelectQuery") selectCount++;
      const normalized = Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, part]) => [key, normalize(part)]));
      if (item.type === "Function" && typeof item.name === "string" && item.name.toLowerCase() === "count" && Array.isArray(item.arguments) && (item.arguments.length === 0 || item.arguments.length === 1 && (item.arguments[0] as { type?: unknown })?.type === "Asterisk")) {
        normalized.name = "count"; normalized.arguments = [];
      }
      return normalized;
    };
    const canonical = JSON.stringify(normalize(root));
    return selectCount === 1 ? createHash("sha256").update(canonical).digest("hex") : undefined;
  } catch { return undefined; }
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
    code: string;
    recoverable: boolean;
    retryKey?: string;
    equivalentKey?: string;
    attemptKey?: string;
    exactOnly?: boolean;
  }> = [];
  const attempts = new Map<string, { retryKey?: string; equivalentKey?: string; attemptKey?: string }>();
  const recoverable = new Set([
    "invalid_sql",
    "unparseable_sql",
    "sql_parse_failed",
    "clickhouse_parse_failed",
    "invalid_calculation_shape",
    "invalid_calculation",
    "join_structure_unsupported",
    "function_not_allowed",
    "arithmetic_lineage_unsupported",
  ]);
  for (const event of events) {
    if (
      event.type === "tool_started" &&
      ["query", "calculate_session_cells"].includes(String(event.payload.tool_name)) &&
      typeof event.payload.tool_call_id === "string"
    ) {
      const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : undefined;
      attempts.set(event.payload.tool_call_id, { retryKey: digest(event.payload.retry_key), equivalentKey: digest(event.payload.equivalent_key), attemptKey: digest(event.payload.attempt_key) });
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
    const attempt =
      typeof event.payload.tool_call_id === "string"
        ? attempts.get(event.payload.tool_call_id)
        : undefined;
    if (event.payload.is_error === true) {
      const prerequisite =
        tool === "query" &&
        event.payload.code === "missing_data_contract_evidence" &&
        attempt?.retryKey;
      pending.push({
        tool,
        code: String(event.payload.code ?? "unknown"),
        recoverable:
          Boolean(prerequisite) || recoverable.has(String(event.payload.code)),
        ...(attempt ?? {}),
        ...(prerequisite ? { exactOnly: true } : {}),
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
        ((Boolean(failure.retryKey) && failure.retryKey === attempt?.retryKey) ||
          (!failure.exactOnly && Boolean(failure.equivalentKey) && failure.equivalentKey === attempt?.equivalentKey) ||
          (!failure.exactOnly && Boolean(failure.attemptKey) && failure.attemptKey === attempt?.attemptKey)),
    );
    if (index >= 0) {
      const repaired = pending[index]!;
      // Repeated failures of the same request and error describe one
      // unresolved condition. Different requests or error categories remain.
      for (let i = pending.length - 1; i >= 0; i--) {
        const item = pending[i]!;
        if (item.tool === repaired.tool && item.code === repaired.code && item.retryKey === repaired.retryKey && item.equivalentKey === repaired.equivalentKey && item.attemptKey === repaired.attemptKey) pending.splice(i, 1);
      }
    }
  }
  return pending.length;
}
