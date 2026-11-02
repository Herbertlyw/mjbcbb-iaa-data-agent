import { coverageHasGap } from "./coverage.js";
import { verifyCell, type CellOperation } from "./evidence.js";
import { sumDecimalStrings } from "./exact-arithmetic.js";
import { parseReadonlySql } from "./sql.js";
import type { DataContract, QueryResource } from "./types.js";

export interface VerifiedDecimalCell {
  value: string;
  table: string;
  column: string;
  unit: string;
  description: string;
  filters: Record<string, string>;
  range: QueryResource["time_range"];
  source_resource_id: string;
  prediction: "actual_observed_only";
}

/** Verify a complete Decimal column sum independently from the stored cell. */
export function verifyDecimalCell(source: QueryResource, contract: DataContract, operation: CellOperation, stored: string): VerifiedDecimalCell | null {
  if (source.engine !== "clickhouse-local" || operation.op !== "sum" || !operation.column || operation.predicted === "predicted_only" || contract.series?.prediction_mode !== "observed_only" || contract.series.predicted_column || coverageHasGap(source.coverage) || source.coverage.unknown_prediction_dates.length) return null;
  const shape = verifyCell(source, contract, { op: "count_rows", as: "shape" }, source.rows.length);
  if (!shape) return null;
  const columns = parseReadonlySql(source.sql).ast.columns;
  if (!Array.isArray(columns)) return null;
  const projection = columns.find((item) => item && typeof item === "object" && ((item as { as?: string; expr?: { column?: string } }).as ?? (item as { expr?: { column?: string } }).expr?.column) === operation.column) as { expr?: { type?: string; column?: string } } | undefined;
  const field = projection?.expr?.type === "column_ref" ? projection.expr.column : undefined;
  if (!field || !contract.series.metrics.includes(field)) return null;
  const declared = contract.columns.find((column) => column.name === field);
  if (!declared?.unit) return null;
  const decimal = /^(?:nullable\()?\s*decimal\(\s*(\d+)\s*,\s*(\d+)\s*\)\s*\)?$/iu.exec(declared.type);
  const normalize = (value: string) => value.replace(/\s/gu, "").toLowerCase();
  if (!decimal || Number(decimal[1]) > 28 || source.decimal_types?.[`${contract.table}.${field}`] === undefined || normalize(source.decimal_types[`${contract.table}.${field}`]!) !== normalize(declared.type) || !source.column_types?.[operation.column] || normalize(source.column_types[operation.column]!) !== normalize(declared.type)) return null;
  const values = source.rows.map((row) => row[operation.column!]);
  if (values.some((value) => value === null || value === undefined)) return null;
  const value = sumDecimalStrings(values, Number(decimal[2]));
  if (value === null || value !== stored) return null;
  return { value, table: contract.table, column: field, unit: declared.unit, description: declared.description, filters: shape.filters, range: source.time_range, source_resource_id: source.resource_id, prediction: "actual_observed_only" };
}
