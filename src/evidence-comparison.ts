import { coverageHasGap } from "./coverage.js";
import type { VerifiedCell } from "./evidence.js";
import type { DataContract, QueryResource } from "./types.js";

export interface VerifiedComparison {
  left: { calculation_id: string; cell: string; source: VerifiedCell };
  right: { calculation_id: string; cell: string; source: VerifiedCell };
  difference: number;
  change_percent: string | null;
}

/** A deliberately narrow comparison: fully covered, integer-valued sources,
 * identical metric and prediction semantics, with just one scope difference. */
export function compareVerifiedIntegers(
  left: VerifiedComparison["left"], right: VerifiedComparison["right"],
  leftSource: QueryResource, rightSource: QueryResource, contract: DataContract,
): VerifiedComparison | null {
  const a = left.source; const b = right.source; const series = contract.series;
  if (!series || !a.column || a.precision !== "exact_integer" || b.precision !== "exact_integer" || a.operation !== "sum" || b.operation !== "sum" || a.table !== b.table || a.table !== contract.table || a.column !== b.column || a.unit !== b.unit || a.unit === "契约未声明" || a.prediction !== b.prediction || a.predictionFilter !== b.predictionFilter || a.excludedNulls || b.excludedNulls || a.range.timezone !== b.range.timezone) return null;
  const column = contract.columns.find((item) => item.name === a.column);
  if (!column || !/^(?:nullable\()?\s*(?:u?int\d*|integer)\s*\)?$/iu.test(column.type)) return null;
  if (!Number.isSafeInteger(a.value) || !Number.isSafeInteger(b.value) || !Number.isSafeInteger(a.value - b.value)) return null;
  for (const source of [leftSource, rightSource]) {
    if (source.truncated || !source.complete_population || coverageHasGap(source.coverage) || source.coverage.unknown_prediction_dates.length) return null;
    let magnitude = 0n;
    for (const row of source.rows) {
      const value = row[a.column];
      if (!Number.isSafeInteger(value)) return null;
      const n = BigInt(value as number);
      magnitude += n < 0n ? -n : n;
      if (magnitude > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    }
  }
  if (!series.dimensions.every((dimension) => Object.hasOwn(a.filters, dimension) && Object.hasOwn(b.filters, dimension))) return null;
  const keys = new Set([...Object.keys(a.filters), ...Object.keys(b.filters)]);
  const changed = [...keys].filter((key) => a.filters[key] !== b.filters[key]);
  const sameRange = a.range.start === b.range.start && a.range.end === b.range.end;
  if (sameRange) {
    if (changed.length !== 1 || !series.dimensions.includes(changed[0]!)) return null;
  } else {
    if (changed.length || !(a.range.end < b.range.start || b.range.end < a.range.start)) return null;
    const days = (start: string, end: string) => Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
    if (days(a.range.start, a.range.end) !== days(b.range.start, b.range.end)) return null;
  }
  const difference = a.value - b.value;
  return { left, right, difference, change_percent: b.value === 0 ? null : percent(difference, b.value) };
}

// Integer arithmetic; two decimal places, ties away from zero.
function percent(difference: number, baseline: number): string {
  const numerator = BigInt(difference) * 10000n;
  const denominator = BigInt(baseline);
  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const rounded = (n * 2n + d) / (2n * d);
  const sign = negative && rounded !== 0n ? "-" : "";
  return `${sign}${rounded / 100n}.${String(rounded % 100n).padStart(2, "0")}`;
}
