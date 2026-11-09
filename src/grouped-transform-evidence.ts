// Reconstruct a single grouped result cell from the current query's physical
// columns. Authority and recursive resource hashes are checked by the caller.
import { permitsAggregation } from "./aggregation-policy.js";
import { isCalendarDate } from "./config.js";
import { verifyCell } from "./evidence.js";
import type { ArithmeticValue } from "./exact-arithmetic.js";
import { rawResultTable } from "./result-adapters.js";
import type { ResultTable } from "./result-transform.js";
import type { ArithmeticRef, DataContract, QueryResource, TransformResource } from "./types.js";

export function groupedTransformObservation(source: QueryResource, contract: DataContract, transform: TransformResource, table: ResultTable, ref: ArithmeticRef): ArithmeticValue | null {
  if (source.result_semantics_version !== 2 || source.key_lineage_version !== 1 || source.tables.length !== 1 || source.tables[0] !== contract.table || !contract.series || contract.series.prediction_mode !== "observed_only" || contract.series.predicted_column || source.coverage.status !== "known" || source.coverage.unknown_prediction_dates.length || transform.source_resource_id !== source.resource_id || !Array.isArray(transform.steps) || transform.steps.length !== 1 || ref.row === undefined || !Number.isSafeInteger(ref.row) || ref.row < 0 || ref.execution_id !== transform.execution_id) return null;
  const step = transform.steps[0];
  if (!step || step.op !== "group" || !Array.isArray(step.by) || !step.by.length || !Array.isArray(step.aggregates)) return null;
  const aggregate = step.aggregates.find((item) => item.as === ref.cell);
  if (!aggregate || aggregate.op !== "sum" || !aggregate.column) return null;
  const input = rawResultTable(source, contract);
  const shape = verifyCell(source, contract, { op: "count_rows", as: "shape" }, source.rows.length);
  const row = table.rows[ref.row];
  const sourceColumn = input?.columns.find((item) => item.name === aggregate.column);
  const outputColumn = table.columns.find((item) => item.name === ref.cell);
  const lineage = sourceColumn?.value_lineage;
  const declared = lineage && contract.columns.find((item) => item.name === lineage.column);
  if (!input || !shape || !row || !sourceColumn || !outputColumn || !lineage || lineage.table !== contract.table || !contract.series.metrics.includes(lineage.column) || contract.sensitive_columns.includes(lineage.column) || outputColumn.value_lineage?.table !== lineage.table || outputColumn.value_lineage.column !== lineage.column || !declared?.unit || outputColumn.unit !== declared.unit || outputColumn.type !== "decimal" || !Number.isInteger(outputColumn.scale) || (row[ref.cell] !== null && typeof row[ref.cell] !== "string")) return null;
  const filters: Record<string, string | null> = { ...shape.filters };
  let start = source.time_range.start; let end = source.time_range.end;
  const grouped: string[] = [];
  for (const name of step.by) {
    const key = input.columns.find((item) => item.name === name)?.key_lineage;
    const value = row[name];
    if (!key || key.table !== contract.table || !(key.column === contract.series.date_column || contract.series.dimensions.includes(key.column)) || (value !== null && typeof value !== "string")) return null;
    if (key.column === contract.series.date_column) {
      if (typeof value !== "string" || !isCalendarDate(value) || value < start || value > end) return null;
      start = end = value;
    } else {
      if (Object.hasOwn(filters, key.column) && filters[key.column] !== value) return null;
      filters[key.column] = value;
    }
    grouped.push(key.column);
  }
  if (!permitsAggregation(contract, lineage.column, shape.filters, grouped, source.time_range)) return null;
  const value = row[ref.cell] as string | null;
  return {
    value, scale: outputColumn.scale!, unit: outputColumn.unit,
    basis: { table: contract.table, column: lineage.column, operation: "sum", unit: outputColumn.unit, prediction: "actual_observed_only", timezone: source.time_range.timezone },
    scopes: [{ filters, start, end }],
    // Even a correct group from a complete saved result does not prove that
    // all expected business groups or missing source data have appeared.
    partial: true, scope_unverified: true,
    row_identity: { resource_id: transform.resource_id, execution_id: transform.execution_id!, row: ref.row },
    ...(value === null ? { undefined_reason: "null_input" as const } : {}),
  };
}
