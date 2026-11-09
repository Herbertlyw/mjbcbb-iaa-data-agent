import { JOIN_ROW_COUNT_DESCRIPTION, type JoinEvidencePlan, type VerifiedJoinValue } from "./join-evidence.js";
import { fitsResultCalculationBytes, RESULT_CALCULATION_MAX_ROWS, type ResultColumn, type ResultTable, type ResultValue } from "./result-transform.js";
import type { DataContract } from "./types.js";
import { isCalendarDate } from "./config.js";
import { sumDecimalStrings } from "./exact-arithmetic.js";
import { joinIntegerType } from "./join-integer.js";

const identifier = /^[a-z_][a-z0-9_]{0,63}$/u;
const dangerous = new Set(["__proto__", "prototype", "constructor"]);
const safeName = (value: string) => identifier.test(value) && !dangerous.has(value);
const sortedEntries = (value: Record<string, string>) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));

/** Convert only values already revalidated by the host against the complete
 * captured JOIN, current contracts, authorization and freshness publication.
 * This is not a verification of the underlying source or a substitute for
 * verifyJoinResource. Output aliases are identifiers, never semantic labels. */
export function joinResultTable(plan: JoinEvidencePlan, values: VerifiedJoinValue[], fact: DataContract, dimension: DataContract): ResultTable | null {
  if (!plan || fact.table !== plan.fact || dimension.table !== plan.dimension || !fact.series || fact.series.prediction_mode !== "observed_only" || fact.series.predicted_column || dimension.series || !Array.isArray(values) || !values.length || !Array.isArray(plan.groups) || !Array.isArray(plan.metrics) || !plan.metrics.length || plan.groups.length + plan.metrics.length > 40 || !fitsResultCalculationBytes(values)) return null;
  const names = new Set<string>(); const groupNames = new Set<string>(); const dateGroups = new Set<string>();
  const columns: ResultColumn[] = [];
  for (const group of plan.groups) {
    if (!group || !safeName(group.output) || names.has(group.output) || !safeName(group.column) || !["fact", "dimension"].includes(group.table)) return null;
    const contract = group.table === "fact" ? fact : dimension;
    const column = contract.columns.find((item) => item.name === group.column);
    const type = column?.type.replace(/\s/gu, "") ?? "";
    const isDate = /^(?:nullable\()?date\)?$/iu.test(type);
    if (!column || contract.sensitive_columns.includes(group.column) || !isDate && !/^(?:nullable\()?(?:lowcardinality\()?string\)?\)?$/iu.test(type)) return null;
    const key = `${contract.table}.${group.column}`;
    if (groupNames.has(key)) return null;
    if (isDate) dateGroups.add(key);
    groupNames.add(key); names.add(group.output);
    columns.push({ name: group.output, type: "text", unit: `维度 ${key}`, label: key });
  }
  const metrics = new Map<string, JoinEvidencePlan["metrics"][number]>();
  for (const metric of plan.metrics) {
    if (!metric || !safeName(metric.output) || names.has(metric.output) || !["sum", "count_nonnull", "count_null", "count_zero", "count_rows"].includes(metric.operation)) return null;
    const rowCount = metric.operation === "count_rows";
    if (rowCount ? metric.column !== "*" || metric.description !== JOIN_ROW_COUNT_DESCRIPTION || metric.precision !== undefined || metric.scale !== undefined || metric.integer_type !== undefined : !safeName(metric.column) || !fact.series.metrics.includes(metric.column)) return null;
    const declared = fact.columns.find((item) => item.name === metric.column);
    const unit = metric.operation === "sum" ? declared?.unit : "行";
    const type = declared?.type.replace(/\s/gu, "") ?? "";
    const integer = joinIntegerType(type);
    if (metric.integer_type !== undefined && metric.integer_type !== integer) return null;
    const decimal = /^(?:nullable\()?decimal\((\d+),(\d+)\)\)?$/iu.exec(type);
    if (!unit || metric.unit !== unit || !rowCount && (!declared || fact.sensitive_columns.includes(metric.column) || metric.description !== declared.description || !integer && !(decimal && metric.precision === Number(decimal[1]) && metric.scale === Number(decimal[2]) && Number(decimal[1]) <= 28))) return null;
    const scale = metric.operation === "sum" ? metric.scale ?? 0 : 0;
    const key = JSON.stringify([metric.column, metric.operation]);
    // Two aliases for the same expression cannot be unambiguously identified
    // in VerifiedJoinValue, so fail closed rather than guessing a mapping.
    if (metrics.has(key)) return null;
    metrics.set(key, metric); names.add(metric.output);
    const label = rowCount ? `${fact.table}（${JOIN_ROW_COUNT_DESCRIPTION}）` : `${fact.table}.${metric.column}（${declared!.description}）的${metric.operation === "sum" ? "合计" : metric.operation === "count_null" ? "NULL 计数" : metric.operation === "count_zero" ? "零值计数" : "非 NULL 计数"}`;
    columns.push({ name: metric.output, type: "decimal", unit, label, scale,
      ...(metric.operation === "sum" ? { metric: { table: fact.table, column: metric.column, operation: "sum" as const } } : {}) });
  }
  const rows = new Map<string, { row: Record<string, ResultValue>; cells: Set<string>; unmatched: number }>();
  const expectedGroups = [...groupNames].sort();
  for (const value of values) {
    if (!value || value.fact !== plan.fact || value.dimension !== plan.dimension || !value.group || JSON.stringify(Object.keys(value.group).sort()) !== JSON.stringify(expectedGroups) || !value.factFilters || !value.dimensionFilters || sortedEntries(value.factFilters) !== sortedEntries(plan.factFilters) || sortedEntries(value.dimensionFilters) !== sortedEntries(plan.dimensionFilters) || !value.range || value.range.start !== plan.range.start || value.range.end !== plan.range.end || value.range.timezone !== plan.range.timezone || !Number.isSafeInteger(value.unmatched_rows) || value.unmatched_rows < 0) return null;
    const metric = metrics.get(JSON.stringify([value.column, value.operation]));
    if (!metric || value.unit !== metric.unit || value.description !== metric.description || typeof value.value !== "string") return null;
    const canonical = sumDecimalStrings([value.value], value.operation === "sum" ? metric.scale ?? 0 : 0);
    if (canonical === null || value.operation !== "sum" && BigInt(canonical) < 0n) return null;
    const parts: Array<string | null> = [];
    for (const group of plan.groups) {
      const table = group.table === "fact" ? fact.table : dimension.table;
      const groupKey = `${table}.${group.column}`;
      const part = value.group[groupKey];
      if (!(typeof part === "string" && part.length > 0 && part.length <= 200) && !(part === null && group.table === "dimension" && plan.joinType === "left")) return null;
      if (dateGroups.has(groupKey) && part !== null && (typeof part !== "string" || !isCalendarDate(part) || group.table === "fact" && (part < plan.range.start || part > plan.range.end))) return null;
      parts.push(part);
    }
    if (plan.joinType === "inner" && value.unmatched_rows !== 0 || parts.some((part) => part === null) && value.unmatched_rows === 0) return null;
    const key = JSON.stringify(parts);
    let item = rows.get(key);
    if (!item) {
      if (rows.size >= RESULT_CALCULATION_MAX_ROWS) return null;
      const row: Record<string, ResultValue> = Object.create(null) as Record<string, ResultValue>;
      for (const [index, group] of plan.groups.entries()) row[group.output] = parts[index]!;
      item = { row, cells: new Set(), unmatched: value.unmatched_rows }; rows.set(key, item);
    }
    if (item.unmatched !== value.unmatched_rows || item.cells.has(metric.output)) return null;
    item.cells.add(metric.output); item.row[metric.output] = canonical;
  }
  if ([...rows.values()].some((item) => item.cells.size !== plan.metrics.length)) return null;
  const table = { columns, rows: [...rows.values()].map((item) => item.row) };
  return fitsResultCalculationBytes(table) ? table : null;
}
