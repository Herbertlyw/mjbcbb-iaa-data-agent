// Convert saved database values to the same typed table used by derived results.
import { queryEvidenceShape } from "./evidence-shape.js";
import { verifiedNullMarkerPreview } from "./evidence.js";
import { sumDecimalStrings } from "./exact-arithmetic.js";
import { normalizeDecimal } from "./decimal-kernel.js";
import type { DataContract, QueryResource } from "./types.js";
import type { ResultColumn, ResultTable, ResultValue } from "./result-transform.js";

/** Conversion is not authorization. The host must revalidate the query,
 * ownership, contract and freshness before treating this table as evidence. */
export function queryCellInput(source: QueryResource, contract?: DataContract): ResultTable | null {
  if (!source.columns.length || source.columns.length > 40 || new Set(source.columns).size !== source.columns.length) return null;
  const shape = contract ? queryEvidenceShape(source, contract) : null;
  let projections = Array.isArray(shape?.columns) ? shape.columns as Array<{ as?: string | null; expr?: { type?: string; column?: string } }> : [];
  // Unaliased ClickHouse helper expressions contain parentheses and cannot be
  // result-table identifiers. Drop them only after checking every marker
  // against the directly projected value; the original query remains intact.
  if (contract && projections.some(item => item.expr?.type === "function" && !item.as)) {
    const preview = verifiedNullMarkerPreview(source, contract);
    if (!preview) return null;
    const keep = projections.map((item, index) => item.expr?.type === "function" ? -1 : index).filter(index => index >= 0);
    source = { ...source, columns: keep.map(index => source.columns[index]!), rows: preview };
    projections = keep.map(index => projections[index]!);
  }
  const physical = new Map(projections.filter(item => item.expr?.type === "column_ref").map(item => [item.as ?? item.expr!.column, item.expr!.column!]));
  const columns: ResultColumn[] = [];
  for (const [index, name] of source.columns.entries()) {
    const type = source.column_types?.[name]?.replace(/\s/gu, "").toLowerCase() ?? "";
    const decimal = /^(?:nullable\()?decimal\(\d+,(\d+)\)\)?$/u.exec(type);
    const wireInteger = /^(?:nullable\()?u?int(?:8|16|32|64|128|256)\)?$/u.test(type);
    const wireFloat = /^(?:nullable\()?float(?:32|64)\)?$/u.test(type);
    const values = source.rows.map(row => row[name]).filter(value => value !== null);
    if (source.rows.some(row => !Object.hasOwn(row, name))) return null;
    const field = physical.get(name); const declared = contract?.columns.find(column => column.name === field);
    const declaredNumeric = declared && /^(?:nullable\()?\s*(?:u?int|integer|real|float|double|decimal|numeric)/iu.test(declared.type);
    const numeric = Boolean(decimal || wireInteger || wireFloat || values.length && values.every(value => typeof value === "number") || !values.length && declaredNumeric);
    if (decimal && values.some(value => typeof value !== "string")) return null;
    if (numeric && values.some(value => typeof value === "number" && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)))) return null;
    const approximate = numeric && !decimal && !wireInteger && (wireFloat || Boolean(declared && /(?:real|float|double)/iu.test(declared.type)) || values.some(value => typeof value === "number" && !Number.isInteger(value)));
    const scale = decimal ? Number(decimal[1]) : approximate ? Math.max(0, ...values.map(value => {
      const [mantissa, exponent = "0"] = String(value).toLowerCase().split("e");
      return Math.max(0, (mantissa!.split(".")[1]?.length ?? 0) - Number(exponent));
    })) : 0;
    if (scale > 38) return null;
    columns.push({ name, type: numeric ? "decimal" : "text", unit: declared?.unit ?? "未认证", label: field && contract ? `${contract.table}.${field}` : `查询结果列 ${index + 1}（业务含义未认证）`, ...(numeric ? { scale } : {}), ...(approximate ? { approximate: true } : {}), ...(field && contract?.series && (contract.series.date_column === field || contract.series.dimensions.includes(field)) ? { key_lineage: { table: contract.table, column: field, physical_type: declared!.type.replace(/\s/gu, "").toLowerCase() } } : {}), ...(field && contract?.series?.metrics.includes(field) ? { value_lineage: { table: contract.table, column: field } } : {}) });
  }
  const rows: Array<Record<string, ResultValue>> = [];
  for (const input of source.rows) {
    const row: Record<string, ResultValue> = Object.create(null) as Record<string, ResultValue>;
    for (const column of columns) {
      const value = input[column.name];
      if (value === null) { row[column.name] = null; continue; }
      if (column.type === "decimal") {
        const parsed = sumDecimalStrings([typeof value === "number" || column.approximate ? normalizeDecimal(String(value)) : value], column.scale!);
        if (parsed === null) return null;
        row[column.name] = parsed;
      } else {
        if (typeof value !== "string") return null;
        row[column.name] = value;
      }
    }
    rows.push(row);
  }
  const table: ResultTable = { columns, rows };
  const series = contract?.series;
  if (series?.prediction_mode === "observed_only" && !series.predicted_column && source.result_semantics_version === 2) table.prediction_scope = "observed_only";
  const predictionOutput = series?.predicted_column ? [...physical].find(([, field]) => field === series.predicted_column)?.[0] : undefined;
  if (predictionOutput && series?.prediction_values) {
    table.prediction = { column: predictionOutput, actual: String(series.prediction_values.actual), predicted: String(series.prediction_values.predicted) };
  }
  return table;
}
