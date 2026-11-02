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
