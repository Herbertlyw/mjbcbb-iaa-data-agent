// Prove individual saved metric cells without claiming a complete business total.
import { isCalendarDate } from "./config.js";
import { coverageHasGap, provenCoverageScope } from "./coverage.js";
import { queryEvidenceShape } from "./evidence-shape.js";
import { verifyCell } from "./evidence.js";
import { queryCellInput } from "./query-cell-input.js";
import { aggregateObservationInput } from "./aggregate-observation.js";
import type { DataContract, QueryResource } from "./types.js";

export interface VerifiedQueryObservation {
  resource_id: string;
  execution_id: string;
  row: number;
  output_column: string;
  table: string;
  column: string;
  description: string;
  value: string | null;
  unit: string;
  scale: number;
  approximate: boolean;
  prediction: "actual" | "predicted" | "unknown";
  filters: Record<string, string>;
  range: QueryResource["time_range"];
  scope_complete: boolean;
  coverage_incomplete: boolean;
  aggregation?: "sum";
}

/** A mathematical fallback must not hide rows that contradict a provable
 * literal SQL scope. Expressions without direct lineage make no such claim. */
export function queryRowsMatchScope(
  source: QueryResource,
  contract: DataContract,
): boolean {
  const scope = provenCoverageScope(source.sql, contract, source.time_range);
  const projections = queryEvidenceShape(source, contract)?.columns;
  if (!scope || !Array.isArray(projections)) return true;
  for (const item of projections as Array<{
    as?: string | null;
    expr?: { type?: string; column?: string };
  }>) {
    if (item.expr?.type !== "column_ref" || !item.expr.column) continue;
    const field = item.expr.column;
    const output = item.as ?? field;
    for (const row of source.rows) {
      if (!Object.hasOwn(row, output)) return false;
      const value = row[output];
      if (
        field === contract.series?.date_column &&
        (typeof value !== "string" ||
          !isCalendarDate(value) ||
          value < source.time_range.start ||
          value > source.time_range.end ||
          (scope.selectedDates !== undefined && !scope.selectedDates.includes(value)))
      )
        return false;
      if (
        Object.hasOwn(scope.equalities, field) &&
        (value === null || String(value) !== scope.equalities[field])
      )
        return false;
      if (
        Object.hasOwn(scope.inSets, field) &&
        (value === null || !scope.inSets[field]!.includes(String(value)))
      )
        return false;
    }
  }
  return true;
}

/** Reconstruct a direct metric observation from SQL, types and saved values.
 * The caller separately checks ownership, authorization and current freshness.
 * NULL is a verified missing value, not an absent or unverifiable resource. */
export function verifyQueryObservation(
  source: QueryResource,
  contract: DataContract,
  rowIndex: number,
  output: string,
): VerifiedQueryObservation | null {
  if (
    !source.execution_id ||
    source.result_semantics_version !== 2 ||
    source.truncated ||
    source.sql_limited ||
    !source.complete_population ||
    source.total_rows_exact !== true ||
    source.rows.length !== source.returned_rows ||
    source.rows.length !== source.total_rows ||
    !queryRowsMatchScope(source, contract) ||
    !Number.isSafeInteger(rowIndex) ||
    rowIndex < 0 ||
    !source.rows[rowIndex] ||
    !contract.series
  )
    return null;
  const aggregate = aggregateObservationInput(source, contract);
  if (aggregate)
    return (
      aggregate.observations.find(
        (item) => item.row === rowIndex && item.output_column === output,
      ) ?? null
    );
  const shape = verifyCell(
    source,
    contract,
    { op: "count_rows", as: "observation" },
    source.rows.length,
  );
  const projections = queryEvidenceShape(source, contract)?.columns;
  if (!shape || !Array.isArray(projections)) return null;
  const fields = new Map<string, string>();
  for (const projection of projections as Array<{
    as?: string | null;
    expr?: { type?: string; column?: string };
  }>) {
    if (projection.expr?.type === "column_ref" && projection.expr.column)
      fields.set(
        projection.expr.column,
        projection.as ?? projection.expr.column,
      );
  }
  const field = [...fields].find(([, name]) => name === output)?.[0];
  const declared = contract.columns.find((item) => item.name === field);
  if (
    !field ||
    !declared?.unit ||
    !contract.series.metrics.includes(field) ||
    contract.sensitive_columns.includes(field)
  )
    return null;
  const physicalType = declared.type.replace(/\s/gu, "").toLowerCase();
  if (source.engine === "clickhouse-local") {
    if (
      source.column_types?.[output]?.replace(/\s/gu, "").toLowerCase() !==
      physicalType
    )
      return null;
    if (
      physicalType.includes("decimal(") &&
      source.decimal_types?.[`${contract.table}.${field}`]
        ?.replace(/\s/gu, "")
        .toLowerCase() !== physicalType
    )
      return null;
  }
  const table = queryCellInput(source, contract);
  const column = table?.columns.find((item) => item.name === output);
  const row = table?.rows[rowIndex];
  if (
    !column ||
    column.type !== "decimal" ||
    !Number.isInteger(column.scale) ||
    !row ||
    !Object.hasOwn(row, output)
  )
    return null;
  const value = row[output];
  if (value !== null && typeof value !== "string") return null;
  if (
    value === null &&
    !declared.nullable &&
    !physicalType.startsWith("nullable(")
  )
    return null;
  const filters = { ...shape.filters };
  let scopeComplete = true;
  for (const dimension of contract.series.dimensions) {
    if (Object.hasOwn(filters, dimension)) continue;
    const name = fields.get(dimension);
    const observed = name ? row[name] : undefined;
    if (typeof observed === "string") filters[dimension] = observed;
    else scopeComplete = false;
  }
  let { start, end } = source.time_range;
  const dateOutput = fields.get(contract.series.date_column);
  if (dateOutput) {
    const date = row[dateOutput];
    if (
      typeof date !== "string" ||
      !isCalendarDate(date) ||
      date < start ||
      date > end
    )
      return null;
    start = end = date;
  } else if (start !== end) scopeComplete = false;
  let prediction: VerifiedQueryObservation["prediction"] = "unknown";
  if (table.prediction_scope === "observed_only") prediction = "actual";
  else if (table.prediction) {
    const flag = row[table.prediction.column];
    if (flag === table.prediction.actual) prediction = "actual";
    else if (flag === table.prediction.predicted) prediction = "predicted";
    else return null;
  }
  return {
    resource_id: source.resource_id,
    execution_id: source.execution_id,
    row: rowIndex,
    output_column: output,
    table: contract.table,
    column: field,
    description: declared.description,
    value,
    unit: declared.unit,
    scale: column.scale!,
    approximate: column.approximate === true,
    prediction,
    filters,
    range: { start, end, timezone: source.time_range.timezone },
    scope_complete: scopeComplete,
    coverage_incomplete:
      source.coverage.status !== "known" ||
      coverageHasGap(source.coverage) ||
      source.coverage.unknown_prediction_dates.length > 0,
  };
}
