/** Parse only the final assistant message for the current turn. Result
 * selections are hints, never authority: the host must separately verify the
 * selected resources and their ancestry at delivery time. */
export type NaturalCandidate =
  | { kind: "answer"; text: string; resourceIds: string[]; suggestedStatus?: "partial"; comparisons?: Array<{ left: { resource_id: string; cell: string }; right: { resource_id: string; cell: string } }> }
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
    // unverified numeric finding or a hidden selection. Numeric literals
    // already present in user messages may be repeated as clarifying scope.
    const userNumbers = new Set(messages.filter((item) => item.role === "user").flatMap((item) => {
      const content = typeof item.content === "string" ? item.content : Array.isArray(item.content) ? item.content.map((block) => block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : "").join("") : "";
      return content.match(/\d+(?:\.\d+)?/g) ?? [];
    }));
    const lastQuestion = Math.max(question.lastIndexOf("?"), question.lastIndexOf("？"));
    const trailingRequest = lastQuestion < 0 ? "" : question.slice(lastQuestion + 1).trim();
    // A model may append a request for further scope after its question.
    // Allow that request, but not an arbitrary declarative answer after it.
    const safeTrailingRequest = !trailingRequest || /^(?:(?:另外|同时|此外|并且|以及|also|and)[，,\s]*)?(?:请|还请|也请|需要|please\b|could\b|would\b)[\s\S]*[。.!！]$/iu.test(trailingRequest);
    if (question.length > 2000 || (question.match(/\d+(?:\.\d+)?/g) ?? []).some((value) => !userNumbers.has(value)) || /\[\[/.test(question) || lastQuestion < 0 || !safeTrailingRequest) return null;
    return { kind: "clarification", question };
  }
  if (text === "[[failed]]") return { kind: "failed", text: "未能形成可验证的结论。" };
  // This marker can only reduce a candidate's status. It is not proof of
  // coverage, user intent or the accuracy of any explanation in the draft.
  const partial = text.startsWith("[[partial]]");
  if ((text.match(/\[\[partial\]\]/g)?.length ?? 0) !== Number(partial)) return null;
  const ids = [...text.matchAll(/\[\[result:(res_[A-Za-z0-9-]{1,128})\]\]/g)].map((match) => match[1]!);
  if ((text.match(/\[\[result:/g)?.length ?? 0) !== ids.length || ids.length > 40 || ids.some((id) => !successfulResources.has(id))) return null;
  // No-result prose is appropriate for knowledge or hypothetical answers;
  // it cannot silently omit already produced current-task data resources.
  if (!ids.length && (successfulResources.size > 0 || !text.replace(/\[\[partial\]\]/gu, "").trim())) return null;
  const selected = new Set(ids);
  const comparisons = [...text.matchAll(/\[\[compare:(res_[A-Za-z0-9-]{1,128})\.([A-Za-z_][A-Za-z0-9_]{0,127}),(res_[A-Za-z0-9-]{1,128})\.([A-Za-z_][A-Za-z0-9_]{0,127})\]\]/g)].map((match) => ({ left: { resource_id: match[1]!, cell: match[2]! }, right: { resource_id: match[3]!, cell: match[4]! } }));
  if (comparisons.length > 20 || comparisons.some((item) => !selected.has(item.left.resource_id) || !selected.has(item.right.resource_id)) || (text.match(/\[\[compare:/g)?.length ?? 0) !== comparisons.length) return null;
  return { kind: "answer", text, resourceIds: [...selected], ...(partial ? { suggestedStatus: "partial" as const } : {}), ...(comparisons.length ? { comparisons } : {}) };
}
