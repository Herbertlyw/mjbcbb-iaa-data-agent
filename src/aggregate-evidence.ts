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
  scale: number;
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
  if (groupNode && (groupList.length < 1 || groupList.length > 3)) return null;
  const groupColumns = groupList.map(col);
  if (groupColumns.some((column) => !column || !series.dimensions.includes(column) || Object.hasOwn(filters, column)) || new Set(groupColumns).size !== groupColumns.length) return null;
  if (!series.dimensions.every((dimension) => groupColumns.includes(dimension) || Object.hasOwn(filters, dimension))) return null;
  const names = new Set<string>();
  const groupOutputs = new Map<string, string>();
  const metrics: Array<{ output: string; field: string; operation: "sum" | "count_nonnull"; scale: number }> = [];
  for (const projection of Array.isArray(ast.columns) ? ast.columns : []) {
    const item = object(projection); const expr = object(item?.expr);
    if (!item || !expr) return null;
    const field = col(expr);
    if (field) {
      if (!groupColumns.includes(field) || groupOutputs.has(field)) return null;
      const output = item.as ?? field;
      if (typeof output !== "string" || !safeAlias(output, field, contract) || names.has(output)) return null;
      names.add(output); groupOutputs.set(field, output);
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
    let scale = 0;
    if (fn === "sum") {
      const integer = source.engine === "clickhouse-local" ? /^(?:nullable\()?\s*(?:u?int(?:8|16|32))\s*\)?$/iu : /^(?:integer|int|int32)$/iu;
      const decimal = source.engine === "clickhouse-local" ? /^(?:nullable\()?\s*decimal\(\s*(\d+)\s*,\s*(\d+)\s*\)\s*\)?$/iu.exec(declared.type) : null;
      if (decimal) {
        const precision = Number(decimal[1]); scale = Number(decimal[2]);
        // SUM uses Decimal128. The scan bound and input precision together
        // keep its worst-case magnitude below 10^38.
        if (precision < 1 || precision > 28 || scale < 0 || scale > precision || source.decimal_types?.[`${contract.table}.${input}`]?.replace(/\s/gu, "").toLowerCase() !== declared.type.replace(/\s/gu, "").toLowerCase()) return null;
      } else if (!integer.test(declared.type)) return null;
      if (source.engine === "clickhouse-local" && (!Number.isSafeInteger(source.scan_limit) || source.scan_limit! < 1 || source.scan_limit! > 2_000_000_000)) return null;
    }
    names.add(output);
    metrics.push({ output, field: input, operation: fn === "sum" ? "sum" : "count_nonnull", scale });
  }
  if (!metrics.length || groupOutputs.size !== groupColumns.length || (!groupColumns.length && source.rows.length !== 1)) return null;
  const verified: VerifiedAggregate[] = [];
  const seenGroups = new Set<string>();
  for (const row of source.rows) {
    if (Object.keys(row).length !== names.size || Object.keys(row).some((key) => !names.has(key))) return null;
    const group: Record<string, string> = {};
    for (const column of groupColumns) {
      if (!column) return null;
      const value = row[groupOutputs.get(column)!];
      if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(value)) return null;
      group[column] = value;
    }
    const groupKey = JSON.stringify(group);
    if (seenGroups.has(groupKey)) return null;
    seenGroups.add(groupKey);
    for (const metric of metrics) {
      const value = metric.scale ? decimalString(row[metric.output], metric.scale) : integerString(row[metric.output]);
      if (value === null || (metric.operation === "count_nonnull" && value.startsWith("-"))) return null;
      const declared = contract.columns.find((column) => column.name === metric.field)!;
      verified.push({ source_resource_id: source.resource_id, table: contract.table, column: metric.field, output_column: metric.output, operation: metric.operation, value, scale: metric.scale, unit: metric.operation === "sum" ? declared.unit! : "行", description: declared.description, filters, group, range: source.time_range, prediction: "actual_observed_only" });
    }
  }
  return verified;
}

function decimalString(value: unknown, scale: number): string | null {
  // A JS Number may already have lost precision; never convert it back.
  if (typeof value !== "string") return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(value);
  if (!match || (match[3]?.length ?? 0) > scale) return null;
  const whole = match[2]!.replace(/^0+(?=\d)/u, "");
  const fractional = (match[3] ?? "").padEnd(scale, "0");
  if ((whole + fractional).replace(/^0+/u, "").length > 38) return null;
  const sign = match[1] && /[1-9]/u.test(whole + fractional) ? "-" : "";
  return `${sign}${whole}.${fractional}`;
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
