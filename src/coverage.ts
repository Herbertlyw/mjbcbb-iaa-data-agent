import type { CoverageGroup, CoverageReport, DataContract } from "./types.js";

export function assessCoverage(
  contract: DataContract | undefined,
  equalities: Record<string, string>,
  timeRange: { start: string; end: string } | undefined,
  rows: Array<Record<string, unknown>>,
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
  const pinned = series.dimensions.every((dimension) => equalities[dimension]);
  const overall = classify(rows, series.date_column, series.metrics, series.predicted_column ?? null, series.prediction_values, series.prediction_mode, dates);
  const groups: CoverageGroup[] = [];
  if (!pinned) {
    for (const dimension of series.dimensions) {
      if (equalities[dimension]) continue;
      const values = [...new Set(rows.map((row) => row[dimension]).filter((value) => value !== undefined && value !== null).map(String))];
      if (values.length < 2) continue;
      for (const value of values) {
        const subset = classify(rows.filter((row) => String(row[dimension]) === value), series.date_column, series.metrics, series.predicted_column ?? null, series.prediction_values, series.prediction_mode, dates);
        groups.push({ dimension, value, ...subset });
      }
    }
  }
  return {
    status: "known",
    reason: pinned
      ? "过滤条件钉住了契约声明的序列维度，并按自然日核对。同一天可同时包含 NULL、零和不同预测标记；实际与预测日期表示标记，不保证值非空。"
      : "未过滤的维度只评估结果里出现的取值；没有出现的组合不算缺失。同一天的状态可以重叠，实际与预测日期表示标记，不保证值非空。",
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
        else if (Number(value) === 0) hasZero = true;
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
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(start) || !/^\d{4}-\d{2}-\d{2}$/u.test(end) || start > end) return null;
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
