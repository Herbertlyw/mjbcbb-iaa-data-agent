import type { SessionResource } from "./types.js";

/** Stored shape only; authorization and re-evaluation are the caller's job. */
export interface SavedResultView {
  resource_id: string;
  execution_id: string;
  session_id: string;
  job_id: string | null;
  source_kind: SessionResource["kind"];
  columns: Array<{ name: string; type: string; unit: string | null }>;
  rows: Array<Record<string, unknown>>;
  saved_rows: number;
  source_truncated: boolean;
  sql_limited: boolean;
  complete_population: boolean;
  verification: "stored_only";
  coverage_status: "not_revalidated";
  source: Record<string, unknown>;
}

/** Adapt legacy storage without inventing an execution ID or treating a
 * model-chosen alias as a certified business label. Callers page the returned
 * rows and bind each page to a hash of the complete stored resource. */
export function savedResultView(resource: SessionResource): SavedResultView | null {
  if (!resource.execution_id) return null;
  const common = { resource_id: resource.resource_id, execution_id: resource.execution_id, session_id: resource.session_id, job_id: resource.job_id ?? null, source_kind: resource.kind, verification: "stored_only" as const, coverage_status: "not_revalidated" as const };
  if (resource.kind === "query_result") return {
    ...common,
    columns: resource.columns.map((name) => ({ name, type: resource.column_types?.[name] ?? "Unknown", unit: null })),
    rows: resource.rows, saved_rows: resource.rows.length, source_truncated: resource.truncated,
    sql_limited: resource.sql_limited === true, complete_population: resource.complete_population,
    source: { engine: resource.engine, sql_review_engine: resource.sql_review_engine ?? "legacy_unknown", sql: resource.sql, executed_sql: resource.executed_sql ?? resource.sql, execution_settings: resource.execution_settings ?? null, tables: resource.tables, contract_revisions: resource.contract_revisions, asset_hashes: resource.asset_hashes, freshness_receipts: resource.freshness_receipts },
  };
  if (resource.kind === "transform") return {
    ...common, columns: resource.result.columns.map((column) => ({ name: column.name, type: column.type === "decimal" ? `Decimal(scale=${column.scale})` : column.type, unit: column.unit || null })),
    rows: resource.result.rows, saved_rows: resource.result.rows.length, source_truncated: resource.input_truncated, sql_limited: false, complete_population: resource.complete_population,
    source: { input: resource.source_resource_id, input_hashes: resource.input_hashes, steps: resource.steps },
  };
  if (resource.kind === "alignment") {
    const left = resource.rows.find((row) => row.left)?.left;
    const right = resource.rows.find((row) => row.right)?.right;
    const result = resource.rows.find((row) => row.result)?.result;
    const numeric = (name: string, value: typeof left) => ({ name, type: value ? `Decimal(scale=${value.scale})` : "Unknown", unit: value?.unit ?? null });
    return { ...common, columns: [...resource.spec.keys.map((name) => ({ name, type: "Unknown", unit: null })), numeric("left_value", left), numeric("right_value", right), numeric("result_value", result), { name: "alignment_status", type: "text", unit: null }],
      rows: resource.rows.map((row) => ({ ...row.group, left_value: row.left?.value ?? null, right_value: row.right?.value ?? null, result_value: row.result?.value ?? null, alignment_status: row.status })),
      saved_rows: resource.rows.length, source_truncated: resource.input_truncated, sql_limited: false, complete_population: resource.complete_population,
      source: { spec: resource.spec, input_hashes: resource.input_hashes, coverage_incomplete: resource.coverage_incomplete ?? false },
    };
  }
  if (resource.kind === "calculation") {
    const columns = Object.entries(resource.cells).map(([name, value]) => ({ name, type: value === null ? "Unknown" : typeof value === "string" ? "DecimalText" : Number.isSafeInteger(value) ? "SafeInteger" : "Float64", unit: null }));
    return { ...common, columns, rows: [{ ...resource.cells }], saved_rows: 1, source_truncated: resource.input_truncated, sql_limited: false, complete_population: resource.complete_population,
      source: { input: resource.source_resource_id, input_hash: resource.source_resource_hash ?? null, operations: resource.operations ?? null } };
  }
  const value = resource.result;
  return { ...common, columns: [{ name: "result", type: `Decimal(scale=${value.scale})`, unit: value.unit || null }], rows: [{ result: value.value }], saved_rows: 1,
    source_truncated: resource.input_truncated, sql_limited: false, complete_population: resource.complete_population,
    source: { operation: resource.operation, inputs: [resource.left, resource.right], input_hashes: resource.input_hashes, precision: { scale: value.scale, rounding: resource.operation === "divide" ? "half_away_from_zero" : "exact" }, interpretation: value.interpretation ?? "contracted" },
  };
}
