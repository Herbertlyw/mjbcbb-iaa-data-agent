import { coverageHasGap, provenCoverageScope } from "./coverage.js";
import { isCalendarDate } from "./config.js";
import { guardSql, parseReadonlySql } from "./sql.js";
import type { DataContract, QueryResource } from "./types.js";

/** Verified semantics only. The caller must independently recheck the current
 * principal, job/session, exact stored resource hash, contract and freshness. */
export interface VerifiedConditionalAggregate {
  source_resource_id: string;
  table: string;
  column: string;
  output_column: string;
  operation: "count_null" | "count_nonnull" | "count_zero";
  value: string;
  unit: "行";
  filters: Record<string, string>;
  group: Record<string, string>;
  range: QueryResource["time_range"];
  prediction: "actual_observed_only";
  coverage_incomplete: boolean;
}

/** Verify only direct-metric countIf NULL/non-NULL/zero predicates. SQL that
 * is safe to execute can still be wider than this trustworthy evidence subset. */
export function verifyConditionalAggregates(source: QueryResource, contract: DataContract): VerifiedConditionalAggregate[] | null {
  const series = contract.series;
  if (!series || series.predicted_column || series.prediction_mode !== "observed_only" || source.engine !== "clickhouse-local" || !source.session_id || !source.job_id || !source.execution_id || !Array.isArray(source.tables) || source.tables.length !== 1 || source.tables[0] !== contract.table || source.truncated || source.sql_limited || !source.complete_population || source.total_rows_exact !== true || !Array.isArray(source.rows) || !Array.isArray(source.columns) || source.rows.length !== source.returned_rows || source.rows.length !== source.total_rows || !source.rows.length || !source.time_range || source.time_range.timezone !== contract.timezone || !validCoverage(source.coverage) || source.coverage.status !== "known" || source.coverage.unknown_prediction_dates.length || !Number.isSafeInteger(source.scan_limit) || source.scan_limit! < 1 || source.scan_limit! > 2_000_000_000) return null;
  const scope = provenCoverageScope(source.sql, contract, source.time_range);
  if (!scope) return null;
  let ast: Record<string, unknown>;
  try {
    const guarded = guardSql(source.sql, [{ table: contract.table, allowed_columns: contract.columns.map((c) => c.name).filter((name) => !contract.sensitive_columns.includes(name)), sensitive_columns: contract.sensitive_columns, must_filter: contract.must_filter }], "clickhouse");
    if (guarded.time_range.start !== source.time_range.start || guarded.time_range.end !== source.time_range.end) return null;
    ast = parseReadonlySql(source.sql).ast;
  } catch { return null; }
  if (ast.with || ast._next || ast.having || ast.limit || ast.distinct || ast.options) return null;
  const from = Array.isArray(ast.from) ? ast.from : [];
  const relation = object(from[0]);
  if (from.length !== 1 || !relation || relation.table !== contract.table || relation.db || relation.expr || relation.join) return null;
  const qualifier = typeof relation.as === "string" ? relation.as : contract.table;
  const column = (value: unknown): string | null => {
    const node = object(value);
    return node?.type === "column_ref" && typeof node.column === "string" && (!node.table || node.table === qualifier) ? node.column : null;
  };
  const groupNode = object(ast.groupby);
  const groups = groupNode && Array.isArray(groupNode.columns) ? groupNode.columns.map(column) : [];
  if (groupNode && (!groups.length || groups.length > 3) || groups.some((name) => !name || name !== series.date_column && !series.dimensions.includes(name) || Object.hasOwn(scope.equalities, name)) || new Set(groups).size !== groups.length) return null;
  if (!series.dimensions.every((name) => groups.includes(name) || Object.hasOwn(scope.equalities, name)) || Object.keys(scope.inSets).some((name) => !groups.includes(name))) return null;
  const names = new Set<string>(); const groupOutputs = new Map<string, string>();
  const metrics: Array<{ field: string; output: string; operation: VerifiedConditionalAggregate["operation"] }> = [];
  for (const item of Array.isArray(ast.columns) ? ast.columns : []) {
    const projection = object(item); const expr = object(projection?.expr);
    if (!projection || !expr) return null;
    const group = column(expr);
    if (group) {
      if (!groups.includes(group) || groupOutputs.has(group)) return null;
      const output = projection.as ?? group;
      if (!safeAlias(output, group, contract) || names.has(output)) return null;
      names.add(output); groupOutputs.set(group, output); continue;
    }
    if (fn(expr) !== "countif" || expr.over) return null;
    const args = object(expr.args); const list = args?.type === "expr_list" && Array.isArray(args.value) ? args.value : [];
    if (list.length !== 1) return null;
    const condition = object(list[0]); if (!condition) return null;
    let field: string | null = null; let operation: VerifiedConditionalAggregate["operation"] | null = null;
    const nullFn = fn(condition);
    if (nullFn === "isnull" || nullFn === "isnotnull") {
      const nullArgs = object(condition.args); const inputs = nullArgs?.type === "expr_list" && Array.isArray(nullArgs.value) ? nullArgs.value : [];
      if (inputs.length === 1) field = column(inputs[0]);
      operation = nullFn === "isnull" ? "count_null" : "count_nonnull";
    } else if (condition.type === "binary_expr") {
      field = column(condition.left);
      const right = object(condition.right); const op = String(condition.operator).toUpperCase();
      if (right?.type === "null" && op === "IS") operation = "count_null";
      else if (right?.type === "null" && op === "IS NOT") operation = "count_nonnull";
      else if (right?.type === "number" && right.value === 0 && op === "=") operation = "count_zero";
    }
    const declared = contract.columns.find((c) => c.name === field);
    if (!field || !operation || !declared || !series.metrics.includes(field) || contract.sensitive_columns.includes(field) || !/^(?:nullable\()?\s*(?:u?int\d+|decimal\(\s*\d+\s*,\s*\d+\s*\))\s*\)?$/iu.test(declared.type)) return null;
    const output = projection.as;
    if (!safeAlias(output, field, contract) || names.has(output) || source.column_types?.[output]?.replace(/\s/gu, "").toLowerCase() !== "uint64") return null;
    names.add(output); metrics.push({ field, output, operation });
  }
  if (!metrics.length || groupOutputs.size !== groups.length || !groups.length && source.rows.length !== 1 || source.columns.length !== names.size || source.columns.some((name) => !names.has(name)) || new Set(source.columns).size !== source.columns.length) return null;
  const result: VerifiedConditionalAggregate[] = []; const seen = new Set<string>();
  for (const row of source.rows) {
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== names.size || Object.keys(row).some((name) => !names.has(name))) return null;
    const group: Record<string, string> = {};
    for (const name of groups) {
      if (!name) return null;
      const value = row[groupOutputs.get(name)!];
      if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(value) || scope.inSets[name] && !scope.inSets[name]!.includes(value) || name === series.date_column && (!isCalendarDate(value) || value < source.time_range.start || value > source.time_range.end)) return null;
      group[name] = value;
    }
    const key = JSON.stringify(group); if (seen.has(key)) return null; seen.add(key);
    for (const metric of metrics) {
      const raw = row[metric.output];
      if (typeof raw !== "string" && (typeof raw !== "number" || !Number.isSafeInteger(raw))) return null;
      const text = String(raw); if (!/^\d{1,19}$/u.test(text)) return null;
      const value = BigInt(text); if (value > BigInt(source.scan_limit!)) return null;
      result.push({ source_resource_id: source.resource_id, table: contract.table, column: metric.field, output_column: metric.output, operation: metric.operation, value: value.toString(), unit: "行", filters: scope.equalities, group, range: source.time_range, prediction: "actual_observed_only", coverage_incomplete: coverageHasGap(source.coverage) });
    }
  }
  if (!coverageHasGap(source.coverage) && Object.keys(scope.inSets).length) {
    let expected: Array<Record<string, string>> = [{}];
    for (const [name, values] of Object.entries(scope.inSets)) {
      if (expected.length * values.length > 200) return null;
      expected = expected.flatMap((entry) => values.map((value) => ({ ...entry, [name]: value })));
    }
    if (expected.some((combination) => !result.some((item) => Object.entries(combination).every(([name, value]) => item.group[name] === value)))) return null;
  }
  return result;
}

function object(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function fn(value: Record<string, unknown>): string {
  if (value.type !== "function") return "";
  const parts = object(value.name)?.name;
  return Array.isArray(parts) ? parts.map((part) => object(part)?.value ?? "").join(".").toLowerCase() : "";
}
function safeAlias(value: unknown, field: string, contract: DataContract): value is string {
  return typeof value === "string" && /^[a-z_][a-z0-9_]*$/u.test(value) && (value === field || !contract.columns.some((column) => column.name === value));
}
function validCoverage(value: unknown): boolean {
  const report = object(value); if (!report || !Array.isArray(report.groups) || report.groups_has_more === true || (typeof report.groups_total === "number" && report.groups_total !== report.groups.length)) return false;
  const fields = ["absent_dates", "null_dates", "zero_dates", "predicted_dates", "unknown_prediction_dates"];
  const bucket = (item: unknown) => {
    const row = object(item);
    return Boolean(row && fields.every((field) => Array.isArray(row[field]) && (row[field] as unknown[]).every((date) => typeof date === "string" && isCalendarDate(date))));
  };
  return bucket(report) && report.groups.every(bucket) && (report.per_table === undefined || Array.isArray(report.per_table) && report.per_table.every(validCoverage));
}
