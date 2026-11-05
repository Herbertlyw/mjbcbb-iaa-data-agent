/** Parse only the final assistant message for the current turn. Result
 * selections are hints, never authority: the host must separately verify the
 * selected resources and their ancestry at delivery time. */
export type NaturalCandidate =
  | { kind: "answer"; text: string; resourceIds: string[]; comparisons?: Array<{ left: { resource_id: string; cell: string }; right: { resource_id: string; cell: string } }> }
  | { kind: "clarification"; question: string }
  | { kind: "failed"; text: string };

interface Message { role?: string; content?: unknown; stopReason?: string }

export function naturalCandidate(messages: Message[], successfulResources: ReadonlySet<string>): NaturalCandidate | null {
  const message = messages.at(-1);
  if (!message || message.role !== "assistant" || message.stopReason !== "stop" || !Array.isArray(message.content)) return null;
  if (message.content.some((block) => !block || typeof block !== "object" || !["text", "thinking"].includes(String((block as { type?: string }).type)))) return null;
  const text = message.content.filter((block) => (block as { type?: string }).type === "text").map((block) => (block as { text?: unknown }).text).filter((item): item is string => typeof item === "string").join("").trim();
  if (!text || Buffer.byteLength(text, "utf8") > 32_000) return null;
  const clarify = /^\[\[clarify\]\]\s*([\s\S]+)$/.exec(text);
  if (clarify) {
    const question = clarify[1]!.trim();
    // A clarification is a question, not a vehicle for delivering an
    // unverified numeric finding or a hidden selection.
    if (question.length > 2000 || /\d|\[\[result:/.test(question) || !/[?？]$/.test(question)) return null;
    return { kind: "clarification", question };
  }
  if (text === "[[failed]]") return { kind: "failed", text: "未能形成可验证的结论。" };
  const ids = [...text.matchAll(/\[\[result:(res_[A-Za-z0-9-]{1,128})\]\]/g)].map((match) => match[1]!);
  if (!ids.length || ids.length > 40 || ids.some((id) => !successfulResources.has(id))) return null;
  const selected = new Set(ids);
  const comparisons = [...text.matchAll(/\[\[compare:(res_[A-Za-z0-9-]{1,128})\.([A-Za-z_][A-Za-z0-9_]{0,127}),(res_[A-Za-z0-9-]{1,128})\.([A-Za-z_][A-Za-z0-9_]{0,127})\]\]/g)].map((match) => ({ left: { resource_id: match[1]!, cell: match[2]! }, right: { resource_id: match[3]!, cell: match[4]! } }));
  if (comparisons.length > 20 || comparisons.some((item) => !selected.has(item.left.resource_id) || !selected.has(item.right.resource_id)) || (text.match(/\[\[compare:/g)?.length ?? 0) !== comparisons.length) return null;
  return { kind: "answer", text, resourceIds: [...selected], ...(comparisons.length ? { comparisons } : {}) };
}
