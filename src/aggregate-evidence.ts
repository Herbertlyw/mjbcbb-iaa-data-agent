import { coverageHasGap, provenCoverageScope } from "./coverage.js";
import { isCalendarDate } from "./config.js";
import { completeObservedGroups } from "./aggregate-group-coverage.js";
import { queryEvidenceShape } from "./evidence-shape.js";
import type { DataContract, QueryResource } from "./types.js";

export interface VerifiedAggregate {
  source_resource_id: string;
  table: string;
  column: string;
  output_column: string;
  operation: "sum" | "count_nonnull" | "count_rows";
  value: string;
  scale: number;
  unit: string;
  description: string;
  filters: Record<string, string>;
  group: Record<string, string>;
  range: QueryResource["time_range"];
  prediction: "actual_observed_only";
  /** The returned individual group is observable, but the requested set or
   * calendar combinations were not all present in this query response. */
  coverage_incomplete?: boolean;
}

/** A deliberately narrow, database-computed aggregate. The SQL is already
 * authorized, but we independently prove the output shape and population.
 * String integers preserve ClickHouse Int64 results without Number conversion. */
export function verifyDatabaseAggregates(source: QueryResource, contract: DataContract): VerifiedAggregate[] | null {
  const series = contract.series;
  if (!series || series.predicted_column || series.prediction_mode !== "observed_only" || source.tables.length !== 1 || source.tables[0] !== contract.table || source.truncated || source.sql_limited || !source.complete_population || !source.rows.length || coverageHasGap(source.coverage) || source.coverage.unknown_prediction_dates.length) return null;
  const scope = provenCoverageScope(source.sql, contract, source.time_range);
  if (!scope) return null;
  const filters = scope.equalities;
  const ast = queryEvidenceShape(source, contract); if (!ast) return null;
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
  if (groupColumns.some((column) => !column || column !== series.date_column && !series.dimensions.includes(column) || Object.hasOwn(filters, column)) || new Set(groupColumns).size !== groupColumns.length) return null;
  if (!series.dimensions.every((dimension) => groupColumns.includes(dimension) || Object.hasOwn(filters, dimension))) return null;
  // Each requested member must remain a distinct, contract-labelled result
  // group. A SUM across multiple IN values needs a richer set-valued lineage
  // and is not automatically promoted to a verified fact here.
  if (Object.keys(scope.inSets).some((dimension) => !groupColumns.includes(dimension))) return null;
  const names = new Set<string>();
  const groupOutputs = new Map<string, string>();
  const metrics: Array<{ output: string; field: string; operation: "sum" | "count_nonnull"; scale: number }> = [];
  // Auxiliary counts may accompany proven aggregates, but are never turned
  // into model-labelled facts. They must have a narrow, independently known
  // shape and are cross-checked against other counts when available.
  const auxiliary: Array<{ output: string; field: string | null; operation: "all" | "null" | "nonnull" | "zero" }> = [];
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
    const aux = auxiliaryProjection(expr, col);
    if (aux) {
      const output = item.as;
      if (source.engine !== "clickhouse-local" || !Number.isSafeInteger(source.scan_limit) || source.scan_limit! < 1 || source.scan_limit! > 2_000_000_000 || typeof output !== "string" || !safeAlias(output, aux.field ?? "", contract) || names.has(output) || source.column_types?.[output]?.replace(/\s/gu, "").toLowerCase() !== "uint64" || (aux.field !== null && (!series.metrics.includes(aux.field) || contract.sensitive_columns.includes(aux.field)))) return null;
      names.add(output); auxiliary.push({ output, ...aux }); continue;
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
  const standaloneRows = !metrics.length && auxiliary.some((item) => item.operation === "all");
  if (!metrics.length && !standaloneRows || groupOutputs.size !== groupColumns.length || (!groupColumns.length && source.rows.length !== 1)) return null;
  const verified: VerifiedAggregate[] = [];
  const seenGroups = new Set<string>();
  const observedGroups: Array<Record<string, string>> = [];
  for (const row of source.rows) {
    if (Object.keys(row).length !== names.size || Object.keys(row).some((key) => !names.has(key))) return null;
    const group: Record<string, string> = {};
    for (const column of groupColumns) {
      if (!column) return null;
      const value = row[groupOutputs.get(column)!];
      if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(value)) return null;
      if (scope.inSets[column] && !scope.inSets[column]!.includes(value)) return null;
      // The query-wide date receipt bounds each observed grouped business day.
      // A model-controlled alias cannot change the physical date field.
      if (column === series.date_column && (!isCalendarDate(value) || value < source.time_range.start || value > source.time_range.end)) return null;
      group[column] = value;
    }
    const groupKey = JSON.stringify(group);
    if (seenGroups.has(groupKey)) return null;
    seenGroups.add(groupKey);
    observedGroups.push(group);
    const counts: Array<{ field: string | null; operation: string; value: bigint }> = [];
    for (const item of auxiliary) {
      const value = integerString(row[item.output]);
      if (value === null || value.startsWith("-") || BigInt(value) > BigInt(source.scan_limit!)) return null;
      // A returned GROUP BY bucket cannot have zero source rows. For an
      // ungrouped result, complete date coverage also requires observations;
      // zero would contradict the independent coverage receipt.
      if (item.operation === "all" && BigInt(value) === 0n) return null;
      counts.push({ field: item.field, operation: item.operation, value: BigInt(value) });
      if (standaloneRows && item.operation === "all") verified.push({ source_resource_id: source.resource_id, table: contract.table, column: "*", output_column: item.output, operation: "count_rows", value, scale: 0, unit: "行", description: "查询观测行数", filters, group, range: source.time_range, prediction: "actual_observed_only" });
    }
    for (const metric of metrics) {
      const value = metric.scale ? decimalString(row[metric.output], metric.scale) : integerString(row[metric.output]);
      if (value === null || (metric.operation === "count_nonnull" && value.startsWith("-"))) return null;
      if (metric.operation === "count_nonnull") {
        if (source.engine === "clickhouse-local" && (!Number.isSafeInteger(source.scan_limit) || BigInt(value) > BigInt(source.scan_limit!))) return null;
        counts.push({ field: metric.field, operation: "nonnull", value: BigInt(value) });
      }
      const declared = contract.columns.find((column) => column.name === metric.field)!;
      verified.push({ source_resource_id: source.resource_id, table: contract.table, column: metric.field, output_column: metric.output, operation: metric.operation, value, scale: metric.scale, unit: metric.operation === "sum" ? declared.unit! : "行", description: declared.description, filters, group, range: source.time_range, prediction: "actual_observed_only" });
    }
    const all = counts.filter((item) => item.operation === "all");
    if (all.some((item) => item.value !== all[0]!.value)) return null;
    for (const field of new Set(counts.map((item) => item.field).filter((item): item is string => item !== null))) {
      const forField = counts.filter((item) => item.field === field);
      const get = (op: string) => forField.filter((item) => item.operation === op).map((item) => item.value);
      const known = get("nonnull"), missing = get("null"), zero = get("zero");
      if ([known, missing, zero].some((values) => values.some((value) => value !== values[0])) || all.length && forField.some((item) => item.value > all[0]!.value) || all.length && known.length && missing.length && known[0]! + missing[0]! !== all[0]!.value || known.length && zero.length && zero[0]! > known[0]!) return null;
    }
  }
  return completeObservedGroups(observedGroups, groupColumns as string[], scope.inSets, series.date_column, source.time_range) ? verified : verified.map((item) => ({ ...item, coverage_incomplete: true }));
}

function auxiliaryProjection(expr: Record<string, unknown>, column: (value: unknown) => string | null): { field: string | null; operation: "all" | "null" | "nonnull" | "zero" } | null {
  if (expr.over) return null;
  const args = object(expr.args);
  if (expr.type === "aggr_func" && typeof expr.name === "string" && expr.name.toLowerCase() === "count" && !args?.distinct && !args?.orderby && object(args?.expr)?.type === "star") return { field: null, operation: "all" };
  const pieces = object(expr.name)?.name;
  if (expr.type !== "function" || !Array.isArray(pieces) || pieces.length !== 1 || args?.type !== "expr_list" || !Array.isArray(args.value)) return null;
  const functionName = String(object(pieces[0])?.value).toLowerCase();
  // ClickHouse COUNT() is COUNT(*) and returns the number of observed rows.
  // The caller accepts auxiliary counts only for clickhouse-local results.
  if (functionName === "count" && args.value.length === 0) return { field: null, operation: "all" };
  if (functionName !== "countif" || args.value.length !== 1) return null;
  const condition = object(args.value[0]);
  if (!condition) return null;
  const nested = object(condition.name)?.name;
  if (condition.type === "function" && !condition.over && Array.isArray(nested) && nested.length === 1) {
    const name = String(object(nested[0])?.value).toLowerCase(); const callArgs = object(condition.args);
    const field = callArgs?.type === "expr_list" && Array.isArray(callArgs.value) && callArgs.value.length === 1 ? column(callArgs.value[0]) : null;
    if (field && (name === "isnull" || name === "isnotnull")) return { field, operation: name === "isnull" ? "null" : "nonnull" };
  }
  const field = column(condition.left), right = object(condition.right), op = String(condition.operator).toUpperCase();
  if (condition.type !== "binary_expr" || !field) return null;
  if (right?.type === "null" && op === "IS") return { field, operation: "null" };
  if (right?.type === "null" && op === "IS NOT") return { field, operation: "nonnull" };
  if (right?.type === "number" && right.value === 0 && op === "=") return { field, operation: "zero" };
  return null;
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
