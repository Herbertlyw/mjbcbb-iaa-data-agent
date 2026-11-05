import type { CoverageGroup, CoverageReport, DataContract } from "./types.js";
import { exactCalendarDatePredicate, parseReadonlySql } from "./sql.js";
import { isCalendarDate } from "./config.js";
import { clickHouseCoverageScope } from "./clickhouse-coverage-scope.js";

export interface CoverageScope { equalities: Record<string, string>; inSets: Record<string, string[]> }

/** Keep legacy callers conservative: a multi-value set is never represented as
 * a single equality or passed to old evidence/lineage code as one value. */
export function provenCoverageFilters(sql: string, contract: DataContract, timeRange: { start: string; end: string }): Record<string, string> | null {
  const scope = provenCoverageScope(sql, contract, timeRange);
  return scope && !Object.keys(scope.inSets).length ? scope.equalities : null;
}

/** Describe the same input population as the guarded single-table WHERE.
 * Only bounded literal sets can establish expected groups; NOT IN, NULL,
 * expressions, disjunctions and ambiguous predicates cannot. */
export function provenCoverageScope(sql: string, contract: DataContract, timeRange: { start: string; end: string }): CoverageScope | null {
  const series = contract.series;
  if (!series) return null;
  if (contract.engine === "clickhouse-local") {
    const native = clickHouseCoverageScope(sql, contract, timeRange);
    if (native !== undefined) return native;
  }
  let ast: Record<string, unknown>;
  try { ast = parseReadonlySql(sql).ast; } catch { return null; }
  // Coverage describes the input population before grouping; HAVING, LIMIT,
  // unions and nested inputs remain unknown because they change that scope.
  if (ast.with || ast._next || ast.limit || ast.having || ast.distinct || ast.options) return null;
  const from = Array.isArray(ast.from) ? ast.from : [];
  const relation = object(from[0]);
  if (from.length !== 1 || !relation || relation.table !== contract.table || relation.db || relation.expr || relation.join) return null;
  const qualifier = typeof relation.as === "string" ? relation.as : contract.table;
  const dimensions = new Set(series.dimensions);
  const equalities: Record<string, string> = {};
  const inSets: Record<string, string[]> = {};
  let start = "";
  let end = "";
  function visit(value: unknown): boolean {
    const expr = object(value);
    if (!expr || expr.type !== "binary_expr") return false;
    if (expr.operator === "AND") return visit(expr.left) && visit(expr.right);
    const left = object(expr.left);
    const right = object(expr.right);
    if (!left || left.type !== "column_ref" || typeof left.column !== "string" || (left.table && left.table !== qualifier)) return false;
    if (left.column === series!.date_column) {
      const bounds = exactCalendarDatePredicate(expr, series!.date_column, qualifier);
      if (!bounds || (bounds.start && start) || (bounds.end && end)) return false;
      if (bounds.start) start = bounds.start;
      if (bounds.end) end = bounds.end;
      return true;
    }
    if (!right || !/^[a-z_][a-z0-9_]*$/u.test(left.column) || ["__proto__", "prototype", "constructor"].includes(left.column) || !dimensions.has(left.column) || Object.hasOwn(equalities, left.column) || Object.hasOwn(inSets, left.column)) return false;
    if (expr.operator === "=" && right.type === "single_quote_string" && typeof right.value === "string" && /^[A-Za-z0-9_-]+$/u.test(right.value)) {
      equalities[left.column] = right.value;
      return true;
    }
    if (expr.operator !== "IN" || right.type !== "expr_list" || !Array.isArray(right.value) || right.value.length < 1 || right.value.length > 32) return false;
    const values = right.value.map(object);
    if (values.some((item) => item?.type !== "single_quote_string" || typeof item.value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(item.value))) return false;
    const literals = values.map((item) => item!.value as string);
    if (new Set(literals).size !== literals.length) return false;
    if (literals.length === 1) equalities[left.column] = literals[0]!;
    else inSets[left.column] = literals.sort();
    return true;
  }
  return visit(ast.where) && start === timeRange.start && end === timeRange.end && Boolean(start && end) ? { equalities, inSets } : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function assessCoverage(
  contract: DataContract | undefined,
  equalities: Record<string, string>,
  timeRange: { start: string; end: string } | undefined,
  rows: Array<Record<string, unknown>>,
  inSets: Record<string, string[]> = {},
): CoverageReport {
  const empty = (status: CoverageReport["status"], reason: string): CoverageReport => ({
    status,
    reason,
    expected_days: null,
    absent_dates: [],
    null_dates: [],
    zero_dates: [],
    predicted_dates: [],
    actual_dates: [],
    unknown_prediction_dates: [],
    groups: [],
  });
  const series = contract?.series;
  if (!series || !timeRange?.start || !timeRange.end) return empty("unknown", "契约没有声明可核对的日期覆盖，覆盖情况未知");
  const dates = enumerateDates(timeRange.start, timeRange.end);
  if (!dates) return empty("unknown", "日期范围无法展开，覆盖情况未知");
  const setEntries = Object.entries(inSets).sort(([a], [b]) => a.localeCompare(b));
  if (setEntries.some(([name, values]) => !/^[a-z_][a-z0-9_]*$/u.test(name) || ["__proto__", "prototype", "constructor"].includes(name) || !series.dimensions.includes(name) || Object.hasOwn(equalities, name) || !Array.isArray(values) || values.length < 2 || values.length > 32 || new Set(values).size !== values.length || values.some((value) => typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(value)))) return empty("unknown", "IN 覆盖集合不合法。");
  if (setEntries.length && rows.some((row) => Object.entries(equalities).some(([key, value]) => row[key] !== value) || setEntries.some(([key, values]) => typeof row[key] !== "string" || !values.includes(row[key] as string)))) return empty("unknown", "覆盖观测与查询筛选不一致。");
  const pinned = series.dimensions.every((dimension) => equalities[dimension]);
  const overall = classify(rows, series.date_column, series.metrics, series.predicted_column ?? null, series.prediction_values, series.prediction_mode, dates);
  const groups: CoverageGroup[] = [];
  let groupDays = 0;
  if (setEntries.length) {
    let combinations: Array<Record<string, string>> = [{}];
    for (const [name, values] of setEntries) {
      if (combinations.length * values.length > 200 || combinations.length * values.length * dates.length > 100_000) return { ...empty("unknown", "IN 预期组合超过覆盖预算。"), ...overall };
      combinations = combinations.flatMap((entry) => values.map((value) => ({ ...entry, [name]: value })));
    }
    groupDays += combinations.length * dates.length;
    const dimension = setEntries.map(([name]) => name).join(",");
    for (const combination of combinations) {
      const subset = rows.filter((row) => Object.entries(combination).every(([key, value]) => row[key] === value));
      groups.push({ dimension, value: JSON.stringify(combination), ...classify(subset, series.date_column, series.metrics, series.predicted_column ?? null, series.prediction_values, series.prediction_mode, dates) });
    }
  }
  if (!pinned) {
    for (const dimension of series.dimensions) {
      if (equalities[dimension]) continue;
      const values = new Map<string, Array<Record<string, unknown>>>();
      for (const row of rows) {
        const raw = row[dimension]; if (raw === undefined || raw === null) continue;
        const value = String(raw); const subset = values.get(value) ?? [];
        subset.push(row); values.set(value, subset);
      }
      if (values.size < 2) continue;
      groupDays += values.size * dates.length;
      if (groupDays > 100_000) return { ...empty("unknown", "覆盖分组和日期组合超过预算，未证明完整覆盖。"), ...overall };
      for (const [value, subset] of values) {
        groups.push({ dimension, value, ...classify(subset, series.date_column, series.metrics, series.predicted_column ?? null, series.prediction_values, series.prediction_mode, dates) });
      }
    }
    // Marginal coverage can look complete while each combination is missing
    // different days. Verify each observed tuple before proving multi-group SQL.
    const free = series.dimensions.filter((dimension) => !equalities[dimension]);
    if (free.length > 1) {
      const combinations = new Map<string, Array<Record<string, unknown>>>();
      for (const row of rows) {
        if (free.some((dimension) => typeof row[dimension] !== "string")) return { ...empty("unknown", "组合维度不完整，不能证明覆盖。"), ...overall };
        const key = JSON.stringify(free.map((dimension) => row[dimension]));
        const group = combinations.get(key) ?? [];
        group.push(row); combinations.set(key, group);
        if (combinations.size > 200) return { ...empty("unknown", "组合过多，未证明覆盖。"), ...overall };
      }
      groupDays += combinations.size * dates.length;
      if (groupDays > 100_000) return { ...empty("unknown", "覆盖分组和日期组合超过预算，未证明完整覆盖。"), ...overall };
      for (const [value, subset] of combinations) {
        groups.push({ dimension: free.join(","), value, ...classify(subset, series.date_column, series.metrics, series.predicted_column ?? null, series.prediction_values, series.prediction_mode, dates) });
      }
    }
  }
  return {
    status: "known",
    reason: pinned
      ? "过滤条件钉住了契约声明的序列维度，并按自然日核对。同一天可同时包含 NULL、零和不同预测标记；实际与预测日期表示标记，不保证值非空。"
      : setEntries.length ? "IN 指定的维度组合按自然日逐一核对；其他未指定维度只评估已观察取值，未出现的对象不补零。" : "未过滤的维度只评估结果里出现的取值；没有出现的组合不算缺失。同一天的状态可以重叠，实际与预测日期表示标记，不保证值非空。",
    expected_days: dates.length,
    ...overall,
    groups,
  };
}

export function unknownCoverage(reason: string): CoverageReport {
  return {
    status: "unknown",
    reason,
    expected_days: null,
    absent_dates: [],
    null_dates: [],
    zero_dates: [],
    predicted_dates: [],
    actual_dates: [],
    unknown_prediction_dates: [],
    groups: [],
  };
}

export function combineCoverage(parts: Array<{ table: string; report: CoverageReport }>): CoverageReport {
  const per_table = parts.map(({ table, report }) => ({ ...report, table, per_table: undefined }));
  if (per_table.length === 1) return { ...per_table[0]!, per_table };
  if (per_table.some((item) => item.status === "unknown")) {
    return { ...unknownCoverage("有的表无法按契约确定覆盖，这些范围标为未知。已确定的表仍逐表列出。"), per_table };
  }
  const incomplete = per_table.some((item) => coverageHasGap(item));
  return {
    status: "known",
    reason: incomplete ? "至少一张相关表的预期日期不完整，整体不能当成完整结果。" : "每张相关表都按自己的粒度和过滤条件核对过。",
    expected_days: null,
    absent_dates: [],
    null_dates: [],
    zero_dates: [],
    predicted_dates: [],
    actual_dates: [],
    unknown_prediction_dates: [],
    groups: [],
    per_table,
  };
}

export function coverageHasGap(report: CoverageReport): boolean {
  if (report.per_table?.length) return report.per_table.some((item) => coverageHasGap({ ...item, per_table: undefined }));
  if (report.status === "unknown") return true;
  const buckets = [report, ...report.groups];
  return buckets.some((bucket) => bucket.absent_dates.length > 0 || bucket.null_dates.length > 0 || bucket.predicted_dates.length > 0);
}

function classify(
  rows: Array<Record<string, unknown>>,
  dateColumn: string,
  metrics: string[],
  predictedColumn: string | null,
  mapping: { actual: number; predicted: number } | undefined,
  predictionMode: "observed_only" | undefined,
  dates: string[],
): Omit<CoverageGroup, "dimension" | "value"> {
  const absent: string[] = [];
  const nulls: string[] = [];
  const zeros: string[] = [];
  const predicted: string[] = [];
  const actual: string[] = [];
  const unknown: string[] = [];
  for (const date of dates) {
    const matched = rows.filter((row) => String(row[dateColumn]) === date);
    if (!matched.length) { absent.push(date); continue; }
    let hasNull = false; let hasZero = false; let hasActual = false; let hasPredicted = false; let hasUnknown = false;
    for (const row of matched) {
      for (const metric of metrics) {
        const value = row[metric];
        if (value === null || value === undefined) hasNull = true;
        else if ((typeof value === "number" && value === 0) || (typeof value === "string" && /^-?0+(?:\.0+)?$/u.test(value))) hasZero = true;
        const flag = predictedColumn ? row[predictedColumn] : undefined;
        const validFlag = (typeof flag === "number" || typeof flag === "string" && /^-?\d+(?:\.\d+)?$/u.test(flag)) && mapping && mapping.actual !== mapping.predicted;
        if (!predictedColumn && predictionMode === "observed_only") hasActual = true;
        else if (!validFlag) hasUnknown = true;
        else if (Number(flag) === mapping!.actual) hasActual = true;
        else if (Number(flag) === mapping!.predicted) hasPredicted = true;
        else hasUnknown = true;
      }
    }
    if (hasNull) nulls.push(date);
    if (hasZero) zeros.push(date);
    if (hasPredicted) predicted.push(date);
    if (hasActual) actual.push(date);
    if (hasUnknown) unknown.push(date);
  }
  return { absent_dates: absent, null_dates: nulls, zero_dates: zeros, predicted_dates: predicted, actual_dates: actual, unknown_prediction_dates: unknown };
}

function enumerateDates(start: string, end: string): string[] | null {
  if (!isCalendarDate(start) || !isCalendarDate(end) || start > end) return null;
  const dates: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor.getTime() <= last.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (dates.length > 400) return null;
  }
  return dates;
}
