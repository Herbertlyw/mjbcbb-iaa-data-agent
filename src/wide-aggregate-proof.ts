// Host-only overflow evidence for direct, authorized ClickHouse aggregates.
// The visible SUM and wider SUM execute in the same SELECT and therefore see
// the same rows. This is not a proof of business completeness.
import { createHash } from "node:crypto";
import { format, parse } from "@clickhouse/parser";
import { clickHouseAggregateShape } from "./clickhouse-aggregate-shape.js";
import { permitsAggregation } from "./aggregation-policy.js";
import { provenCoverageScope } from "./coverage.js";
import type { DataContract, QueryResource } from "./types.js";

type Field = { output: string; proof: string; physical: string; signed: boolean; nonnull?: string };
export type WideAggregatePlan = { executionSql: string; fields: Field[]; rowCount?: string };
export type WideAggregateProof = { rows: Array<Record<string, unknown>>; column_types: Record<string, string>; capture_hash: string };
export type WideQueryResource = QueryResource & { wide_aggregate_proof?: WideAggregateProof };

const obj = (x: unknown): Record<string, any> | null => x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, any> : null;
const ident = (x: unknown): x is string => typeof x === "string" && /^[a-z_][a-z0-9_]{0,63}$/u.test(x) && !["__proto__", "constructor", "prototype"].includes(x);
const baseType = (value: string) => value.replace(/\s/gu, "").toLowerCase().replace(/^nullable\((.*)\)$/u, "$1");

/** Only direct SUM(column) projections are transformed. SQL authorization,
 * contract binding and freshness are checked by the caller independently. */
export function prepareWideAggregateProof(sql: string, contract: DataContract, range: QueryResource["time_range"]): WideAggregatePlan | null {
  const shape = clickHouseAggregateShape(sql, contract.table);
  const scope = provenCoverageScope(sql, contract, range);
  if (!shape || !scope || !contract.series || !Array.isArray(shape.columns)) return null;
  const grouped = (obj(shape.groupby)?.columns ?? []).map((x: unknown) => obj(x)?.column);
  if (!Array.isArray(grouped) || grouped.some((x: unknown) => !ident(x))) return null;
  // Sparse scopes may only be used as partial observations grouped by the
  // physical day. A same-query non-NULL count is required for every SUM.
  if (scope.selectedDates && (!grouped.includes(contract.series.date_column) ||
      JSON.stringify(scope.selectedDates) !== JSON.stringify(range.selected_dates))) return null;
  let tree: unknown[];
  try { tree = parse(sql, { locations: false }); } catch { return null; }
  const root = obj(tree[0]); const select = obj(root?.selects?.[0]);
  if (tree.length !== 1 || !select || !Array.isArray(select.select) || select.select.length !== shape.columns.length) return null;
  const relation = obj(obj(obj(select.from)?.children?.[0])?.table_expression)?.database_and_table_name;
  const qualifier = obj(relation)?.alias ?? contract.table;
  if (!ident(qualifier)) return null;
  // Reserved names cannot come from the model or a table schema, including
  // aliases used in ORDER BY or expressions anywhere in the parsed query.
  const occupied = new Set(contract.columns.map((column) => column.name.toLowerCase()));
  const collect = (x: unknown): void => {
    if (Array.isArray(x)) { x.forEach(collect); return; }
    const n = obj(x); if (!n) return;
    if (typeof n.alias === "string") occupied.add(n.alias.toLowerCase());
    if (n.type === "Identifier" && typeof n.name === "string") for (const part of n.name.split(".")) occupied.add(part.toLowerCase());
    Object.values(n).forEach(collect);
  };
  collect(select);
  const fields: Field[] = [];
  for (let i = 0; i < shape.columns.length; i++) {
    const item = obj(shape.columns[i]); const expr = obj(item?.expr); const arg = obj(obj(expr?.args)?.expr);
    if (expr?.type !== "aggr_func" || String(expr.name).toLowerCase() !== "sum" || arg?.type !== "column_ref" || !ident(arg.column)) continue;
    const declared = contract.columns.find((column) => column.name === arg.column);
    const kind = declared && baseType(declared.type);
    if (kind !== "uint64" && kind !== "int64") {
      if (scope.selectedDates) return null;
      continue;
    }
    const original = obj(select.select[i]); const output = item?.as;
    if (!ident(output) || !contract.series.metrics.includes(arg.column) || contract.sensitive_columns.includes(arg.column) || !permitsAggregation(contract, arg.column, scope.equalities, grouped, range) || original?.type !== "Function" || !Array.isArray(original.arguments) || original.arguments.length !== 1) return null;
    const proof = `__da_wide_${fields.length}`;
    if (occupied.has(proof)) return null;
    const signed = kind === "int64";
    // Qualify the physical field: ClickHouse may otherwise substitute a
    // same-named SUM alias into this expression as a nested aggregate.
    const physical = { type: "Identifier", name: `${qualifier}.${arg.column}`, name_parts: [qualifier, arg.column] };
    select.select.push({ type: "Function", name: "sum", arguments: [{ type: "Function", name: signed ? "toInt128" : "toUInt128", arguments: [physical] }], alias: proof });
    const nonnull = scope.selectedDates ? `__da_nonnull_${fields.length}` : undefined;
    if (nonnull) {
      if (occupied.has(nonnull)) return null;
      select.select.push({ type: "Function", name: "count", arguments: [physical], alias: nonnull });
    }
    fields.push({ output, proof, physical: arg.column, signed, ...(nonnull ? { nonnull } : {}) });
  }
  if (!fields.length || fields.length > 16) return null;
  const rowCount = scope.selectedDates ? "__da_row_count" : undefined;
  if (rowCount) {
    if (occupied.has(rowCount)) return null;
    select.select.push({ type: "Function", name: "count", arguments: [], alias: rowCount });
  }
  try { return { executionSql: format(tree as Parameters<typeof format>[0]), fields, ...(rowCount ? { rowCount } : {}) }; } catch { return null; }
}

export function wideCaptureHash(sql: string, executionSql: string, executionId: string, rows: Array<Record<string, unknown>>, types: Record<string, string>): string {
  return createHash("sha256").update(JSON.stringify([sql, executionSql, executionId, rows, types])).digest("hex");
}

/** Reject overflow, forged/missing proof columns and changes to visible rows.
 * 2e9 input rows times an Int64/UInt64 maximum fits in Int128/UInt128. */
export function verifyWideAggregateProof(source: WideQueryResource, contract: DataContract): Set<string> | null {
  const proof = source.wide_aggregate_proof;
  if (!proof || !source.execution_id || source.engine !== "clickhouse-local" || source.sql_review_engine !== "clickhouse_ast_direct" || source.truncated || source.sql_limited || !source.complete_population || source.total_rows_exact !== true || source.rows.length !== source.returned_rows || source.rows.length !== source.total_rows || !Number.isSafeInteger(source.scan_limit) || source.scan_limit! < 1 || source.scan_limit! > 2_000_000_000 || !Array.isArray(proof.rows) || proof.rows.length !== source.rows.length || !proof.column_types || typeof proof.column_types !== "object") return null;
  const plan = prepareWideAggregateProof(source.sql, contract, source.time_range);
  if (!plan || source.executed_sql !== plan.executionSql || proof.capture_hash !== wideCaptureHash(source.sql, plan.executionSql, source.execution_id, proof.rows, proof.column_types)) return null;
  const hidden = new Set([...plan.fields.flatMap((field) => [field.proof, ...(field.nonnull ? [field.nonnull] : [])]), ...(plan.rowCount ? [plan.rowCount] : [])]);
  if (Object.keys(proof.column_types).length !== source.columns.length + hidden.size || source.columns.some((column) => proof.column_types[column] !== source.column_types?.[column])) return null;
  for (const field of plan.fields) {
    if (baseType(proof.column_types[field.proof] ?? "") !== (field.signed ? "int128" : "uint128") || baseType(proof.column_types[field.output] ?? "") !== (field.signed ? "int64" : "uint64")) return null;
    if (field.nonnull && baseType(proof.column_types[field.nonnull] ?? "") !== "uint64") return null;
  }
  if (plan.rowCount && baseType(proof.column_types[plan.rowCount] ?? "") !== "uint64") return null;
  for (let i = 0; i < proof.rows.length; i++) {
    const row = proof.rows[i]; if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const clean = Object.fromEntries(Object.entries(row).filter(([key]) => !hidden.has(key)));
    if (JSON.stringify(clean) !== JSON.stringify(source.rows[i]) || Object.keys(row).length !== source.columns.length + hidden.size) return null;
    const count = plan.rowCount ? exactCount(row[plan.rowCount], source.scan_limit!) : null;
    if (plan.rowCount && (count === null || count === 0n)) return null;
    for (const field of plan.fields) {
      if (field.nonnull && exactCount(row[field.nonnull], source.scan_limit!) !== count) return null;
      const value = row[field.output], wide = row[field.proof];
      if (value === null || wide === null) { if (value !== null || wide !== null) return null; continue; }
      if ((typeof value !== "string" && typeof value !== "number") || (typeof wide !== "string" && typeof wide !== "number") || typeof value === "number" && !Number.isSafeInteger(value) || typeof wide === "number" && !Number.isSafeInteger(wide) || !/^-?\d+$/u.test(String(value)) || !/^-?\d+$/u.test(String(wide)) || BigInt(value) !== BigInt(wide)) return null;
    }
  }
  return new Set(plan.fields.map((field) => field.output));
}

function exactCount(value: unknown, limit: number): bigint | null {
  if ((typeof value !== "string" && typeof value !== "number") || typeof value === "number" && !Number.isSafeInteger(value) || !/^\d{1,20}$/u.test(String(value))) return null;
  const count = BigInt(value);
  return count <= BigInt(limit) ? count : null;
}
