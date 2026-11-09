import type { TranscriptContext } from "@earendil-works/pi-ai";
import { DOMAIN_TOOL_NAMES } from "./domain-tool-names.js";

/** Only host-created active-branch entries can prove a prior delivery. */
export function trustedDeliveredToolCalls(entries: readonly unknown[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const raw of entries) {
    const e = raw as { type?: string; message?: { role?: string; toolCallId?: string } };
    const id = e.type === "message" && e.message?.role === "toolResult" ? e.message.toolCallId : undefined;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const calls = new Set<string>(); let delivered = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as { type?: string; customType?: string; details?: { job_id?: unknown }; message?: { role?: string; toolCallId?: string } };
    if (e.type === "custom_message" && e.customType === "lumenfox.historical_delivery" && typeof e.details?.job_id === "string" && e.details.job_id.length > 0) { delivered = true; continue; }
    if (e.type !== "message") continue;
    if (e.message?.role === "user") { delivered = false; continue; }
    const id = e.message?.role === "toolResult" ? e.message.toolCallId : undefined;
    if (delivered && id && counts.get(id) === 1) calls.add(id);
  }
  return calls;
}

/** Project settled prior analyses and their query previews for provider
 * transport. The native session and full receipts stay untouched. User text,
 * tool calls, current-turn results and unfinished/failed receipts remain
 * intact. A historical summary is never current authorization or evidence. */
export function compactPreviousAnalyses(context: TranscriptContext, trustedCalls: ReadonlySet<string> = new Set()): TranscriptContext {
  const currentUser = context.messages.findLastIndex((message) => message.role === "user");
  if (currentUser < 0 || trustedCalls.size === 0) return context;
  const occurrences = new Map<string, number>();
  for (const message of context.messages) if (message.role === "toolResult") occurrences.set(message.toolCallId, (occurrences.get(message.toolCallId) ?? 0) + 1);
  const auxiliary: ReadonlySet<string> = new Set(DOMAIN_TOOL_NAMES.filter(name => name !== "query" && name !== "update_analysis"));
  let changed = false;
  const messages = context.messages.map((message, index) => {
    if (index >= currentUser || message.role !== "toolResult" || (!trustedCalls.has(message.toolCallId) || occurrences.get(message.toolCallId) !== 1 || !DOMAIN_TOOL_NAMES.includes(message.toolName as typeof DOMAIN_TOOL_NAMES[number])) || message.isError || message.content.length !== 1 || message.content[0]?.type !== "text") return message;
    let receipt: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(message.content[0].text);
      if (!value || typeof value !== "object" || Array.isArray(value)) return message;
      receipt = value as Record<string, unknown>;
    } catch { return message; }
    if (auxiliary.has(message.toolName) && receipt.ok === true) {
      const { details: _details, nestedCalls: _nestedCalls, ...rest } = message;
      changed = true;
      return { ...rest, content: [{ type: "text" as const, text: JSON.stringify({ ok: true, history_summary: true, notice: "这是已结束的上一轮工具回执摘要，不是本次任务的授权或证据；需要时请重新读取并核验。" }) }] };
    }
    if (message.toolName === "query" && receipt.ok === true) {
      const range = receipt.time_range;
      const rangeRecord = range && typeof range === "object" && !Array.isArray(range) ? range as Record<string, unknown> : null;
      const safeRange = rangeRecord && ["start", "end", "timezone"].every((key) => typeof rangeRecord[key] === "string" && String(rangeRecord[key]).length <= 128) ? { start: rangeRecord.start, end: rangeRecord.end, timezone: rangeRecord.timezone } : null;
      const tables = Array.isArray(receipt.tables) && receipt.tables.length <= 8 && receipt.tables.every((item) => typeof item === "string" && item.length <= 128) ? receipt.tables : [];
      const summary = { ok: true, history_summary: true, tables, time_range: safeRange, notice: "这是上一轮查询的范围摘要，预览行已省略。之前的查询和资源不是本次任务证据；如需事实请重新核验授权、契约、新鲜度并查询。" };
      const { details: _details, nestedCalls: _nestedCalls, ...rest } = message;
      changed = true;
      return { ...rest, content: [{ type: "text" as const, text: JSON.stringify(summary) }] };
    }
    if (message.toolName !== "update_analysis" || receipt.ok !== true) return message;
    // update_analysis is a working record, not the committed delivery. The
    // separate host-created historical_delivery entry carries that outcome.
    const summary = { ok: true, history_summary: true, notice: "这是上一轮的工作记录摘要，不代表正式结论；请以宿主交付记录为准，当前任务须重新核验证据。" };
    const { details: _details, nestedCalls: _nestedCalls, ...rest } = message;
    changed = true;
    return { ...rest, content: [{ type: "text" as const, text: JSON.stringify(summary) }] };
  });
  return changed ? { ...context, messages } : context;
}
