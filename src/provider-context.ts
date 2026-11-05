import type { TranscriptContext } from "@earendil-works/pi-ai";

/** Project settled prior analyses and their query previews for provider
 * transport. The native session and full receipts stay untouched. User text,
 * tool calls, current-turn results and unfinished/failed receipts remain
 * intact. A historical summary is never current authorization or evidence. */
export function compactPreviousAnalyses(context: TranscriptContext): TranscriptContext {
  const currentUser = context.messages.findLastIndex((message) => message.role === "user");
  if (currentUser < 0) return context;
  // Only a settled analysis closes a turn. If it failed or was interrupted,
  // keep its preceding query receipts intact for recovery and diagnosis.
  const settledQueries = new Set<number>();
  let settled = false;
  for (let i = currentUser - 1; i >= 0; i -= 1) {
    const message = context.messages[i];
    if (message?.role === "user") {
      // Pi projects host custom messages as user-role transport content. This
      // marker affects only compaction, never authorization or delivery.
      const text = typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
      try { const value: unknown = JSON.parse(text); if (value && typeof value === "object" && (value as { history_summary?: unknown }).history_summary === true) { settled = true; continue; } } catch { /* ordinary user text */ }
      settled = false; continue;
    }
    if (message?.role !== "toolResult" || message.isError || message.content.length !== 1 || message.content[0]?.type !== "text") continue;
    let receipt: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(message.content[0].text);
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      receipt = value as Record<string, unknown>;
    } catch { continue; }
    if (message.toolName === "update_analysis" && receipt.ok === true && typeof receipt.answer === "string" && ["completed", "partial", "needs_clarification"].includes(String(receipt.status))) settled = true;
    if (message.toolName === "query" && settled && receipt.ok === true) settledQueries.add(i);
  }
  let changed = false;
  const messages = context.messages.map((message, index) => {
    if (index >= currentUser || message.role !== "toolResult" || (message.toolName !== "update_analysis" && !settledQueries.has(index)) || message.isError || message.content.length !== 1 || message.content[0]?.type !== "text") return message;
    let receipt: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(message.content[0].text);
      if (!value || typeof value !== "object" || Array.isArray(value)) return message;
      receipt = value as Record<string, unknown>;
    } catch { return message; }
    if (settledQueries.has(index)) {
      const range = receipt.time_range;
      const rangeRecord = range && typeof range === "object" && !Array.isArray(range) ? range as Record<string, unknown> : null;
      const safeRange = rangeRecord && ["start", "end", "timezone"].every((key) => typeof rangeRecord[key] === "string" && String(rangeRecord[key]).length <= 128) ? { start: rangeRecord.start, end: rangeRecord.end, timezone: rangeRecord.timezone } : null;
      const tables = Array.isArray(receipt.tables) && receipt.tables.length <= 8 && receipt.tables.every((item) => typeof item === "string" && item.length <= 128) ? receipt.tables : [];
      const summary = { ok: true, history_summary: true, tables, time_range: safeRange, notice: "这是上一轮查询的范围摘要，预览行已省略。之前的查询和资源不是本次任务证据；如需事实请重新核验授权、契约、新鲜度并查询。" };
      const { details: _details, nestedCalls: _nestedCalls, ...rest } = message;
      changed = true;
      return { ...rest, content: [{ type: "text" as const, text: JSON.stringify(summary) }] };
    }
    if (receipt.ok !== true || typeof receipt.answer !== "string" || !["completed", "partial", "needs_clarification", "failed"].includes(String(receipt.status))) return message;
    const answerFits = Array.from(receipt.answer).length <= 8000;
    const summary = {
      ok: true,
      history_summary: true,
      status: receipt.status,
      answer: answerFits ? receipt.answer : null,
      answer_omitted: !answerFits,
      clarification_question: typeof receipt.clarification_question === "string" && receipt.clarification_question.length <= 2000 ? receipt.clarification_question : null,
      notice: "这是上一轮当时的服务端结果摘要，仅供理解对话；当前任务必须重新核验授权、契约、新鲜度并生成自己的证据。",
    };
    const { details: _details, nestedCalls: _nestedCalls, ...rest } = message;
    changed = true;
    return { ...rest, content: [{ type: "text" as const, text: JSON.stringify(summary) }] };
  });
  return changed ? { ...context, messages } : context;
}
