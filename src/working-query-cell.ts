import { verifyQueryObservation, type VerifiedQueryObservation } from "./query-observation.js";
import { rawResultTable } from "./result-adapters.js";
import type { DataContract, QueryResource } from "./types.js";

export type WorkingQueryCell = {
  field: string;
  unit: string;
  value: string | boolean | null;
  observation?: VerifiedQueryObservation;
};

/** The caller checks task ownership, authorization and freshness separately. */
export function workingQueryCell(source: QueryResource, contract: DataContract, rowIndex: number, output: string): WorkingQueryCell | null {
  if (!Number.isSafeInteger(rowIndex) || rowIndex < 0) return null;
  // Sparse raw rows do not carry a proven single-day observation. A grouped
  // aggregate can be used only after its same-query proof is reconstructed.
  const sparseDates = source.time_range.selected_dates;
  const raw = sparseDates ? null : rawResultTable(source, contract);
  const column = raw?.columns.find((item) => item.name === output);
  const row = raw?.rows[rowIndex];
  if (column && row && Object.hasOwn(row, output)) return { field: column.label, unit: column.unit, value: row[output]! };
  // The observation verifier checks the executed SQL, field types, complete
  // saved rows, scope and any wide-integer overflow proof. Do not grant this
  // path to other expression shapes or to an unverified SQL dialect.
  if (source.engine !== "clickhouse-local" || source.sql_review_engine !== "clickhouse_ast_direct") return null;
  const observation = verifyQueryObservation(source, contract, rowIndex, output);
  if (!observation || observation.aggregation !== "sum") return null;
  if (sparseDates && (observation.range.start !== observation.range.end ||
      !sparseDates.includes(observation.range.start) || !observation.coverage_incomplete)) return null;
  return { field: `${observation.table}.${observation.column}（数据库分组求和）`, unit: observation.unit, value: observation.value, observation };
}
