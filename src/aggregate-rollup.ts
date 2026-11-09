import { verifyDatabaseAggregates } from "./aggregate-evidence.js";
import { permitsAggregation } from "./aggregation-policy.js";
import { coverageHasGap, provenCoverageScope } from "./coverage.js";
import { isCalendarDate } from "./config.js";
import { completeObservedGroups } from "./aggregate-group-coverage.js";
import type { CellOperation } from "./evidence.js";
import { isExactZero, sumDecimalStrings } from "./exact-arithmetic.js";
import type { DataContract, QueryResource } from "./types.js";

/** A cell over the saved GROUP BY result. Counts describe result groups, not
 * the number or NULL/zero state of underlying business rows. */
export interface VerifiedGroupRollup {
  value: string;
  operation: CellOperation["op"];
  input_operation: "sum" | "count_nonnull" | "count_rows";
  table: string;
  column: string;
  description: string;
  unit: string;
  filters: Record<string, string>;
  in_sets: Record<string, string[]>;
  grouped_by: string[];
  range: QueryResource["time_range"];
  source_resource_id: string;
  prediction: "actual_observed_only";
}

/** Recompute from every row of an independently verified grouped resource.
 * This does not assert an immutable ClickHouse snapshot or enumerate unknown
 * business dimension values that the query did not return. */
export function verifyGroupRollup(source: QueryResource, contract: DataContract, operation: CellOperation, stored: number | string | null): VerifiedGroupRollup | null {
  if (!Array.isArray(source.tables) || !Array.isArray(source.rows) || source.rows.some((row) => !row || typeof row !== "object" || Array.isArray(row)) || !source.time_range || source.time_range.timezone !== contract.timezone || !validCoverage(source.coverage) || source.truncated || source.sql_limited || !source.complete_population || source.total_rows_exact !== true || source.rows.length !== source.returned_rows || source.rows.length !== source.total_rows || source.rows.length < 1 || source.rows.length > 100_000 || coverageHasGap(source.coverage) || source.coverage.unknown_prediction_dates.length || operation.predicted === "predicted_only") return null;
  const aggregates = verifyDatabaseAggregates(source, contract);
  const scope = provenCoverageScope(source.sql, contract, source.time_range);
  if (!aggregates?.length || !scope || scope.selectedDates) return null;
  const groupedBy = Object.keys(aggregates[0]!.group).sort();
  if (!groupedBy.length) return null;
  const selected = operation.op === "count_rows" ? aggregates.filter((item) => item.output_column === aggregates[0]!.output_column) : aggregates.filter((item) => item.output_column === operation.column);
  if (!selected.length || selected.length !== source.rows.length || selected.some((item) => item.table !== aggregates[0]!.table || item.column !== selected[0]!.column || item.operation !== selected[0]!.operation || item.unit !== selected[0]!.unit || item.scale !== selected[0]!.scale || JSON.stringify(Object.keys(item.group).sort()) !== JSON.stringify(groupedBy))) return null;
  if (operation.op === "sum" && selected[0]!.operation === "sum" && !permitsAggregation(contract, selected[0]!.column, scope.equalities, [], source.time_range)) return null;
  if (!completeObservedGroups(selected.map((item) => item.group), groupedBy, scope.inSets, contract.series?.date_column, source.time_range)) return null;
  let value: string | null;
  switch (operation.op) {
    case "sum": value = sumDecimalStrings(selected.map((item) => item.value), selected[0]!.scale); break;
    case "count_rows": value = String(selected.length); break;
    case "count_null": value = "0"; break; // NULL aggregate inputs are rejected by the verifier.
    case "count_zero": value = String(selected.filter((item) => isExactZero(item.value)).length); break;
    default: return null;
  }
  if (value === null || stored === null || typeof stored === "number" && !Number.isSafeInteger(stored)) return null;
  // Exact decimal formatting is part of the stored recipe and cannot be
  // normalized through a JS Number or model-provided text.
  if (String(stored) !== value) return null;
  const first = selected[0]!;
  return { value, operation: operation.op, input_operation: first.operation, table: first.table, column: first.column, description: first.description, unit: operation.op === "sum" ? first.unit : "结果分组", filters: scope.equalities, in_sets: scope.inSets, grouped_by: groupedBy, range: source.time_range, source_resource_id: source.resource_id, prediction: "actual_observed_only" };
}

function validCoverage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  if (!Array.isArray(report.groups) || report.groups_has_more === true || (typeof report.groups_total === "number" && report.groups_total !== report.groups.length)) return false;
  const fields = ["absent_dates", "null_dates", "zero_dates", "predicted_dates", "unknown_prediction_dates"];
  const bucket = (item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const entry = item as Record<string, unknown>;
    return fields.every((field) => Array.isArray(entry[field]) && (entry[field] as unknown[]).every((date) => typeof date === "string" && isCalendarDate(date)));
  };
  return bucket(report) && report.groups.every(bucket) && (report.per_table === undefined || Array.isArray(report.per_table) && report.per_table.every(validCoverage));
}
