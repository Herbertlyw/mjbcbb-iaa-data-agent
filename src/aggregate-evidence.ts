import { coverageHasGap, provenCoverageFilters } from "./coverage.js";
import { parseReadonlySql } from "./sql.js";
import type { DataContract, QueryResource } from "./types.js";

export interface VerifiedAggregate {
  source_resource_id: string;
  table: string;
  column: string;
  output_column: string;
  operation: "sum" | "count_nonnull";
  value: string;
  unit: string;
  description: string;
  filters: Record<string, string>;
  group: Record<string, string>;
  range: QueryResource["time_range"];
  prediction: "actual_observed_only";
}

/** A deliberately narrow, database-computed aggregate. The SQL is already
 * authorized, but we independently prove the output shape and population.
 * String integers preserve ClickHouse Int64 results without Number conversion. */
export function verifyDatabaseAggregates(source: QueryResource, contract: DataContract): VerifiedAggregate[] | null {
  const series = contract.series;
  if (!series || series.predicted_column || series.prediction_mode !== "observed_only" || source.tables.length !== 1 || source.tables[0] !== contract.table || source.truncated || !source.complete_population || !source.rows.length || coverageHasGap(source.coverage) || source.coverage.unknown_prediction_dates.length) return null;
  const filters = provenCoverageFilters(source.sql, contract, source.time_range);
  if (!filters) return null;
  let ast: Record<string, unknown>;
  try { ast = parseReadonlySql(source.sql).ast; } catch { return null; }
  if (ast.with || ast._next || ast.having || ast.limit || ast.distinct || ast.options) return null;
  const from = Array.isArray(ast.from) ? ast.from : [];
  const relation = object(from[0]);
  if (from.length !== 1 || !relation || relation.table !== contract.table || relation.db || relation.expr || relation.join) return null;
  const qualifier = typeof relation.as === "string" ? relation.as : contract.table;
  const col = (value: unknown): string | null => {
    const entry = object(value);
    return entry?.type === "column_ref" && typeof entry.column === "string" && (!entry.table || entry.table === qualifier) ? entry.column : null;
  };
  const groupNode = object(ast.groupby);
  const groupList = groupNode && Array.isArray(groupNode.columns) ? groupNode.columns : [];
  if (groupNode && groupList.length !== 1) return null;
  const groupColumn = groupList.length ? col(groupList[0]) : null;
  if (groupList.length && (!groupColumn || !series.dimensions.includes(groupColumn) || Object.hasOwn(filters, groupColumn))) return null;
  if (!series.dimensions.every((dimension) => dimension === groupColumn || Object.hasOwn(filters, dimension))) return null;
  const names = new Set<string>();
  let groupOutput: string | null = null;
  const metrics: Array<{ output: string; field: string; operation: "sum" | "count_nonnull" }> = [];
  for (const projection of Array.isArray(ast.columns) ? ast.columns : []) {
    const item = object(projection); const expr = object(item?.expr);
    if (!item || !expr) return null;
    const field = col(expr);
    if (field) {
      if (!groupColumn || field !== groupColumn || groupOutput) return null;
      const output = item.as ?? field;
      if (typeof output !== "string" || !safeAlias(output, field, contract) || names.has(output)) return null;
      names.add(output); groupOutput = output;
      continue;
    }
    if (expr.type !== "aggr_func" || expr.over || typeof expr.name !== "string") return null;
    const fn = expr.name.toLowerCase();
    const args = object(expr.args);
    const input = col(args?.expr);
    if (!args || args.distinct || args.orderby || !input || !series.metrics.includes(input) || !["sum", "count"].includes(fn)) return null;
    const output = item.as;
    if (typeof output !== "string" || !safeAlias(output, input, contract) || names.has(output)) return null;
    const declared = contract.columns.find((column) => column.name === input);
    if (!declared?.unit) return null;
    // ClickHouse SUM of wider integer types can overflow before it is returned.
    if (fn === "sum") {
      const integer = source.engine === "clickhouse-local" ? /^(?:nullable\()?\s*(?:u?int(?:8|16|32))\s*\)?$/iu : /^(?:integer|int|int32)$/iu;
      if (!integer.test(declared.type)) return null;
      if (source.engine === "clickhouse-local" && (!Number.isSafeInteger(source.scan_limit) || source.scan_limit! < 1 || source.scan_limit! > 2_000_000_000)) return null;
    }
    names.add(output);
    metrics.push({ output, field: input, operation: fn === "sum" ? "sum" : "count_nonnull" });
  }
  if (!metrics.length || Boolean(groupColumn) !== Boolean(groupOutput) || (!groupColumn && source.rows.length !== 1)) return null;
  const verified: VerifiedAggregate[] = [];
  const seenGroups = new Set<string>();
  for (const row of source.rows) {
    if (Object.keys(row).length !== names.size || Object.keys(row).some((key) => !names.has(key))) return null;
    const group: Record<string, string> = {};
    if (groupColumn && groupOutput) {
      const value = row[groupOutput];
      if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(value) || seenGroups.has(value)) return null;
      seenGroups.add(value); group[groupColumn] = value;
    }
    for (const metric of metrics) {
      const value = integerString(row[metric.output]);
      if (value === null || (metric.operation === "count_nonnull" && value.startsWith("-"))) return null;
      const declared = contract.columns.find((column) => column.name === metric.field)!;
      verified.push({ source_resource_id: source.resource_id, table: contract.table, column: metric.field, output_column: metric.output, operation: metric.operation, value, unit: metric.operation === "sum" ? declared.unit! : "行", description: declared.description, filters, group, range: source.time_range, prediction: "actual_observed_only" });
    }
  }
  return verified;
}

function safeAlias(output: string, field: string, contract: DataContract): boolean {
  return /^[a-z_][a-z0-9_]*$/u.test(output) && (output === field || !contract.columns.some((column) => column.name === output));
}

function integerString(value: unknown): string | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? String(value) : null;
  if (typeof value !== "string" || !/^-?\d{1,19}$/u.test(value)) return null;
  try {
    const number = BigInt(value);
    if (number < -(2n ** 63n) || number > 2n ** 63n - 1n) return null;
    return number.toString();
  } catch { return null; }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
