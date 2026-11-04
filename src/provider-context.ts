import type { TranscriptContext } from "@earendil-works/pi-ai";

/** Only project an already-settled prior analysis for provider transport.
 * The native session and its full tool receipt stay untouched. User text,
 * tool call IDs, thinking blocks, current-turn results and failed receipts
 * remain exactly as they were. This is not a current authorization receipt. */
export function compactPreviousAnalyses(context: TranscriptContext): TranscriptContext {
  const currentUser = context.messages.findLastIndex((message) => message.role === "user");
  if (currentUser < 0) return context;
  let changed = false;
  const messages = context.messages.map((message, index) => {
    if (index >= currentUser || message.role !== "toolResult" || message.toolName !== "update_analysis" || message.isError || message.content.length !== 1 || message.content[0]?.type !== "text") return message;
    let receipt: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(message.content[0].text);
      if (!value || typeof value !== "object" || Array.isArray(value)) return message;
      receipt = value as Record<string, unknown>;
    } catch { return message; }
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
