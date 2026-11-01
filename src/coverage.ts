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
    groups: [],
  });
  const series = contract?.series;
  if (!series || !timeRange?.start || !timeRange.end) return empty("unknown", "契约没有声明可核对的日期覆盖，覆盖情况未知");
  const dates = enumerateDates(timeRange.start, timeRange.end);
  if (!dates) return empty("unknown", "日期范围无法展开，覆盖情况未知");
  const pinned = series.dimensions.every((dimension) => equalities[dimension]);
  const overall = classify(rows, series.date_column, series.metrics, series.predicted_column ?? null, dates);
  const groups: CoverageGroup[] = [];
  if (!pinned) {
    for (const dimension of series.dimensions) {
      if (equalities[dimension]) continue;
      const values = [...new Set(rows.map((row) => row[dimension]).filter((value) => value !== undefined && value !== null).map(String))];
      if (values.length < 2) continue;
      for (const value of values) {
        const subset = classify(rows.filter((row) => String(row[dimension]) === value), series.date_column, series.metrics, series.predicted_column ?? null, dates);
        groups.push({ dimension, value, ...subset });
      }
    }
  }
  return {
    status: "known",
    reason: pinned
      ? "过滤条件钉住了契约声明的序列维度，并按自然日核对。"
      : "未过滤的维度只评估结果里出现的取值；没有出现的组合不算缺失。",
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
  dates: string[],
): Omit<CoverageGroup, "dimension" | "value"> {
  const absent: string[] = [];
  const nulls: string[] = [];
  const zeros: string[] = [];
  const predicted: string[] = [];
  const actual: string[] = [];
  for (const date of dates) {
    const matched = rows.filter((row) => String(row[dateColumn]) === date);
    if (matched.length === 0) {
      absent.push(date);
      continue;
    }
    const kinds = matched.flatMap((row) => metrics.map((metric) => kindOf(row, metric, predictedColumn)));
    if (kinds.includes("null")) nulls.push(date);
    else if (kinds.includes("predicted") && !kinds.includes("actual") && !kinds.includes("zero")) predicted.push(date);
    else if (kinds.every((kind) => kind === "zero")) zeros.push(date);
    else if (kinds.includes("predicted") || kinds.includes("null")) nulls.push(date);
    else actual.push(date);
  }
  return { absent_dates: absent, null_dates: nulls, zero_dates: zeros, predicted_dates: predicted, actual_dates: actual };
}

function kindOf(row: Record<string, unknown>, metric: string, predictedColumn: string | null): "null" | "zero" | "predicted" | "actual" {
  if (predictedColumn && Number(row[predictedColumn]) === 1) return "predicted";
  const value = row[metric];
  if (value === null || value === undefined) return "null";
  if (Number(value) === 0) return "zero";
  return "actual";
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
