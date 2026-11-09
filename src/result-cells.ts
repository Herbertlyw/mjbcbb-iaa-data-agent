import type { CellOperation } from "./evidence.js";
import { isExactZero } from "./exact-arithmetic.js";
import { transformResult, type ResultColumn, type ResultTable, type ResultValue } from "./result-transform.js";

/** Evaluate cell operations over an already verified complete table. This
 * function has no access to authority and does not certify business labels. */
export function calculateResultCells(input: ResultTable, operations: CellOperation[]): { table: ResultTable; incomplete: boolean } | null {
  if (!Array.isArray(operations) || !operations.length || operations.length > 40 || !input || !Array.isArray(input.columns) || !input.columns.length || !Array.isArray(input.rows)) return null;
  if (!transformResult(input, [{ op: "sort", keys: [{ column: input.columns[0]!.name, direction: "asc", nulls: "last" }] }])) return null;
  const columns: ResultColumn[] = []; const row: Record<string, ResultValue> = Object.create(null) as Record<string, ResultValue>;
  let incomplete = false;
  let observedOnly = true;
  for (const operation of operations) {
    if (!operation || !["sum", "count_null", "count_zero", "count_rows"].includes(operation.op) || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(operation.as) || ["__proto__", "constructor", "prototype"].includes(operation.as.toLowerCase()) || Object.hasOwn(row, operation.as)) return null;
    // Only host-derived source semantics can establish that every input row
    // is an actual observation. Unknown and forecast filtering fail closed.
    let rows = input.rows;
    let mixedPrediction = false;
    if (input.prediction) {
      const { column, actual, predicted } = input.prediction;
      if (rows.some(row => row[column] !== actual && row[column] !== predicted)) return null;
      if (operation.predicted === "actual_only" || operation.predicted === "predicted_only") rows = rows.filter(row => row[column] === (operation.predicted === "actual_only" ? actual : predicted));
      else if (operation.op === "sum") mixedPrediction = new Set(rows.map(row => row[column])).size > 1;
    } else if (operation.predicted !== undefined && operation.predicted !== "any" && !(operation.predicted === "actual_only" && input.prediction_scope === "observed_only")) return null;
    observedOnly &&= input.prediction_scope === "observed_only" || Boolean(input.prediction && rows.length && rows.every(row => row[input.prediction!.column] === input.prediction!.actual));
    const field = operation.column ? input.columns.find((column) => column.name === operation.column) : undefined;
    // A redundant existing column does not change COUNT's result-row semantics.
    if (operation.op === "count_rows" ? operation.column !== undefined && !field : !field) return null;
    if ((operation.op === "sum" || operation.op === "count_zero") && field?.type !== "decimal") return null;
    let value: string | null;
    if (operation.op === "sum" && mixedPrediction) {
      value = null;
      incomplete = true;
    } else if (operation.op === "sum") {
      const grouped = transformResult({ ...input, rows }, [{ op: "group", by: [], aggregates: [{ op: "sum", column: field!.name, as: operation.as }] }]);
      const item = grouped?.rows[0]?.[operation.as];
      if (item !== null && typeof item !== "string") return null;
      value = item;
      if (!rows.length || rows.some((item) => item[field!.name] === null)) incomplete = true;
    } else if (operation.op === "count_rows") value = String(rows.length);
    else if (operation.op === "count_null") value = String(rows.filter((item) => item[field!.name] === null).length);
    else value = String(rows.filter((item) => isExactZero(item[field!.name])).length);
    row[operation.as] = value;
    columns.push(operation.op === "sum"
      ? { name: operation.as, type: "decimal", unit: field!.unit, label: `${field!.label} 的非 NULL 合计`, scale: field!.scale, ...(field!.approximate ? { approximate: true } : {}) }
      : { name: operation.as, type: "decimal", unit: "结果行", label: operation.op === "count_rows" ? "输入结果行数" : `${field!.label} 的${operation.op === "count_null" ? "NULL" : "零"}结果行数`, scale: 0 });
  }
  const table: ResultTable = { columns, rows: [row], ...(observedOnly ? { prediction_scope: "observed_only" as const } : {}) };
  // Reuse the same bounds and value validation as transform operations.
  return transformResult(table, [{ op: "sort", keys: [{ column: columns[0]!.name, direction: "asc", nulls: "last" }] }]) ? { table, incomplete } : null;
}
