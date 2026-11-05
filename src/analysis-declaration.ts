/** Model-authored organisation only; none of these fields grants authority or
 * establishes a business fact. The host separately checks any references. */
export interface AnalysisDeclaration {
  scope: string;
  grain: string;
  expected_group_keys: string[];
  unresolved_questions: string[];
  assumptions?: string[];
  source_excerpts?: Array<{ asset_id: string; content_hash: string; quote: string }>;
  result_cells?: Array<{ resource_id: string; execution_id: string; row: number; column: string }>;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= maxLength);
}

/** This validator also protects direct tool callers that bypass Pi's schema. */
export function isAnalysisDeclaration(value: unknown): value is AnalysisDeclaration {
  if (!object(value) || Object.keys(value).some((key) => !["scope", "grain", "expected_group_keys", "unresolved_questions", "assumptions", "source_excerpts", "result_cells"].includes(key))) return false;
  if (typeof value.scope !== "string" || value.scope.length > 4000 || typeof value.grain !== "string" || value.grain.length > 1000 || !strings(value.expected_group_keys, 32, 128) || new Set(value.expected_group_keys).size !== value.expected_group_keys.length || !strings(value.unresolved_questions, 32, 1000)) return false;
  if (value.assumptions !== undefined && !strings(value.assumptions, 16, 1000)) return false;
  if (value.source_excerpts !== undefined && (!Array.isArray(value.source_excerpts) || value.source_excerpts.length > 16 || value.source_excerpts.some((item: unknown) => !object(item) || Object.keys(item).some((key) => !["asset_id", "content_hash", "quote"].includes(key)) || typeof item.asset_id !== "string" || !item.asset_id || item.asset_id.length > 512 || typeof item.content_hash !== "string" || !item.content_hash || item.content_hash.length > 128 || typeof item.quote !== "string" || !item.quote || item.quote.length > 2000))) return false;
  if (value.result_cells !== undefined && (!Array.isArray(value.result_cells) || value.result_cells.length > 16 || value.result_cells.some((item: unknown) => !object(item) || Object.keys(item).some((key) => !["resource_id", "execution_id", "row", "column"].includes(key)) || typeof item.resource_id !== "string" || !item.resource_id || item.resource_id.length > 128 || typeof item.execution_id !== "string" || !item.execution_id || item.execution_id.length > 128 || !Number.isSafeInteger(item.row) || Number(item.row) < 0 || Number(item.row) > 1_000_000 || typeof item.column !== "string" || !item.column || item.column.length > 128))) return false;
  try { return Buffer.byteLength(JSON.stringify(value)) <= 32_000; } catch { return false; }
}

export interface ModelAnalysisRecord {
  provenance: "model_declared";
  revision: number;
  declaration: AnalysisDeclaration;
}

/** A working note is recovered only from a matched successful native tool
 * receipt. It grants no authorization and does not represent delivery. */
export class SessionAnalysisRecords {
  private current?: ModelAnalysisRecord;

  update(next: AnalysisDeclaration): ModelAnalysisRecord {
    if (!isAnalysisDeclaration(next)) throw new Error("analysis_declaration_invalid");
    const declaration = structuredClone({
      ...next,
      ...(next.source_excerpts === undefined && this.current?.declaration.source_excerpts !== undefined ? { source_excerpts: this.current.declaration.source_excerpts } : {}),
      ...(next.result_cells === undefined && this.current?.declaration.result_cells !== undefined ? { result_cells: this.current.declaration.result_cells } : {}),
    });
    if (this.current && JSON.stringify(this.current.declaration) === JSON.stringify(declaration)) return this.currentProjection()!;
    this.current = { provenance: "model_declared", revision: (this.current?.revision ?? 0) + 1, declaration };
    return this.currentProjection()!;
  }

  currentProjection(): ModelAnalysisRecord | undefined { return this.current ? structuredClone(this.current) : undefined; }

  restoreFromPersistedMessages(messages: readonly unknown[]): void {
    this.current = undefined;
    const calls = new Map<string, string>();
    for (const raw of messages) {
      if (!object(raw)) continue;
      if (raw.role === "assistant" && Array.isArray(raw.content)) {
        for (const call of raw.content) if (object(call) && call.type === "toolCall" && typeof call.id === "string" && typeof call.name === "string") calls.set(call.id, call.name);
      }
      if (raw.role !== "toolResult" || typeof raw.toolCallId !== "string") continue;
      const name = calls.get(raw.toolCallId); calls.delete(raw.toolCallId);
      if (name !== "update_analysis" || raw.toolName !== name || raw.isError !== false || !object(raw.details) || !object(raw.details.analysis_record)) continue;
      const record = raw.details.analysis_record;
      if (record.provenance !== "model_declared" || !Number.isSafeInteger(record.revision) || Number(record.revision) <= 0 || !isAnalysisDeclaration(record.declaration)) continue;
      const content = Array.isArray(raw.content) && raw.content.length === 1 ? raw.content[0] : undefined;
      if (!object(content) || content.type !== "text" || typeof content.text !== "string") continue;
      try { const parsed: unknown = JSON.parse(content.text); if (!object(parsed) || JSON.stringify(parsed.analysis_record) !== JSON.stringify(record)) continue; } catch { continue; }
      if (this.current && Number(record.revision) <= this.current.revision) continue;
      this.current = { provenance: "model_declared", revision: Number(record.revision), declaration: structuredClone(record.declaration) };
    }
  }
}
