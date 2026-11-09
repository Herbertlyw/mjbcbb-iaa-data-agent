import type { VerifiedAggregate } from "./aggregate-evidence.js";
import type { VerifiedDecimalCell } from "./decimal-cell-evidence.js";
import { decimalOperation } from "./decimal-kernel.js";

export interface AggregateComparison {
  left: VerifiedAggregate;
  right: VerifiedAggregate;
  difference: string;
  ratio: string | null;
  change_percent: string | null;
}

/** Exact base-10 comparison of two already verified decimal sums. The scope
 * restrictions deliberately mirror the existing integer comparison. */
export function compareDecimalAggregates(left: VerifiedAggregate, right: VerifiedAggregate): AggregateComparison | null {
  if (left.coverage_incomplete || right.coverage_incomplete || left.source_resource_id === right.source_resource_id || left.operation !== "sum" || right.operation !== "sum" || left.table !== right.table || left.column !== right.column || left.unit !== right.unit || left.prediction !== right.prediction || left.range.timezone !== right.range.timezone || left.scale < 0 || left.scale !== right.scale) return null;
  const entries = (value: Record<string, string>) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  if (entries(left.group) !== entries(right.group)) return null;
  const changed = [...new Set([...Object.keys(left.filters), ...Object.keys(right.filters)])].filter((key) => left.filters[key] !== right.filters[key]);
  if ([...new Set([...Object.keys(left.filters), ...Object.keys(right.filters)])].some((key) => !Object.hasOwn(left.filters, key) || !Object.hasOwn(right.filters, key))) return null;
  const sameRange = left.range.start === right.range.start && left.range.end === right.range.end;
  if (sameRange) {
    if (changed.length !== 1) return null;
  } else {
    if (changed.length || !(left.range.end < right.range.start || right.range.end < left.range.start)) return null;
    const duration = (start: string, end: string) => Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
    if (duration(left.range.start, left.range.end) !== duration(right.range.start, right.range.end)) return null;
  }
  const valid = (value: string): boolean => {
    const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(value);
    return Boolean(match && (match[3]?.length ?? 0) === left.scale && match[2]!.length + (match[3]?.length ?? 0) <= 38);
  };
  if (!valid(left.value) || !valid(right.value)) return null;
  const difference = decimalOperation("subtract", left.value, right.value, left.scale);
  if (typeof difference !== "string") return null;
  const numerator = decimalOperation("multiply", difference, "100", left.scale);
  if (typeof numerator !== "string") return null;
  const ratio = decimalOperation("divide", left.value, right.value, 4);
  const change_percent = decimalOperation("divide", numerator, right.value, 2);
  return ratio === undefined || change_percent === undefined ? null : { left, right, difference, ratio, change_percent };
}

/** A complete direct-column sum has the same provenance needed by an
 * aggregate comparison. It must already have been independently verified. */
export function compareVerifiedDecimalCells(left: VerifiedDecimalCell, right: VerifiedDecimalCell, leftName: string, rightName: string): AggregateComparison | null {
  const convert = (cell: VerifiedDecimalCell, output: string): VerifiedAggregate => ({
    source_resource_id: cell.source_resource_id, table: cell.table, column: cell.column,
    output_column: output, operation: "sum", value: cell.value, scale: cell.value.split(".")[1]?.length ?? 0,
    unit: cell.unit, description: cell.description, filters: cell.filters, group: {},
    range: cell.range, prediction: cell.prediction,
  });
  return compareDecimalAggregates(convert(left, leftName), convert(right, rightName));
}
