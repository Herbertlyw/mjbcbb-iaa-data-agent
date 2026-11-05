import { isCalendarDate } from "./config.js";
import { sumDecimalStrings } from "./exact-arithmetic.js";
import { fitsResultCalculationBytes, RESULT_CALCULATION_MAX_ROWS, type ResultColumn, type ResultTable, type ResultValue } from "./result-transform.js";
import type { QueryResource } from "./types.js";

/** Decimal rendering of the number delivered by the driver, not a recovery of
 * the binary Float's original precision. Extreme scales fail closed. */
function floatText(value: unknown): { text: string; scale: number } | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(value)) return null;
  const number = Number(value); if (!Number.isFinite(number)) return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/u.exec(String(number)); if (!match) return null;
  const digits = match[2]! + (match[3] ?? ""); const point = match[2]!.length + Number(match[4] ?? 0);
  const whole = point <= 0 ? "0" : point >= digits.length ? digits + "0".repeat(point - digits.length) : digits.slice(0, point);
  const fraction = point <= 0 ? "0".repeat(-point) + digits : point >= digits.length ? "" : digits.slice(point);
  if (fraction.length > 38 || whole.length + fraction.length > 76) return null;
  return { text: `${match[1]}${whole}${fraction ? `.${fraction}` : ""}`, scale: fraction.length };
}

/** Adapt a complete, already authorized database observation for mathematical
 * operations. SQL expressions and model aliases do not certify business
 * meaning or units. Callers must independently revalidate authority and SQL. */
export function typedObservation(source: QueryResource): ResultTable | null {
  if (source.engine !== "clickhouse-local" || !["clickhouse_ast_direct", "clickhouse_ast_scoped", "clickhouse_ast_scoped_observation"].includes(source.sql_review_engine ?? "") || !source.execution_id || source.truncated || source.sql_limited || !source.complete_population || source.total_rows_exact !== true || source.rows.length !== source.returned_rows || source.rows.length !== source.total_rows || source.rows.length > RESULT_CALCULATION_MAX_ROWS || !Array.isArray(source.columns) || !source.columns.length || source.columns.length > 40 || new Set(source.columns).size !== source.columns.length || !source.column_types) return null;
  const fields: Array<{ column: ResultColumn; nullable: boolean; kind: "integer" | "decimal" | "float" | "text" | "date"; signed?: boolean; bits?: number; precision?: number }> = [];
  for (const [index, name] of source.columns.entries()) {
    if (!/^[a-z_][a-z0-9_]{0,63}$/u.test(name) || ["__proto__", "prototype", "constructor"].includes(name)) return null;
    let type = source.column_types[name]?.replace(/\s/gu, "").toLowerCase(); if (!type) return null;
    const nullable = type.startsWith("nullable(") && type.endsWith(")"); if (nullable) type = type.slice(9, -1);
    if (type.startsWith("lowcardinality(") && type.endsWith(")")) type = type.slice(15, -1);
    const integer = /^(u?)int(8|16|32|64|128|256)$/u.exec(type);
    const decimal = /^decimal\((\d+),(\d+)\)$/u.exec(type);
    const kind = integer ? "integer" : decimal ? "decimal" : ["float32", "float64"].includes(type) ? "float" : type === "string" ? "text" : type === "date" ? "date" : null;
    let scale = decimal ? Number(decimal[2]) : 0; const precision = decimal ? Number(decimal[1]) : 0;
    if (!kind || decimal && (precision < 1 || precision > 76 || scale < 0 || scale > 38 || scale > precision)) return null;
    if (kind === "float") for (const row of source.rows) { if (row[name] === null) continue; const parsed = floatText(row[name]); if (!parsed) return null; scale = Math.max(scale, parsed.scale); }
    const column: ResultColumn = { name, type: kind === "text" || kind === "date" ? "text" : "decimal", unit: "未认证", label: `查询结果列 ${index + 1}（业务含义未认证）`, ...(kind === "integer" || kind === "decimal" || kind === "float" ? { scale } : {}), ...(kind === "float" ? { approximate: true } : {}) };
    fields.push({ column, nullable, kind, ...(integer ? { signed: integer[1] !== "u", bits: Number(integer[2]) } : {}), ...(decimal ? { precision } : {}) });
  }
  const rows: Array<Record<string, ResultValue>> = [];
  for (const input of source.rows) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== fields.length || fields.some(({ column }) => !Object.hasOwn(input, column.name))) return null;
    const row: Record<string, ResultValue> = Object.create(null) as Record<string, ResultValue>;
    for (const field of fields) {
      const value = input[field.column.name];
      if (value === null) { if (!field.nullable) return null; row[field.column.name] = null; continue; }
      if (field.kind === "text" || field.kind === "date") {
        if (typeof value !== "string" || value.length > 256 || field.kind === "date" && !isCalendarDate(value)) return null;
        row[field.column.name] = value; continue;
      }
      if (field.kind === "integer") {
        const text = typeof value === "string" ? value : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
        if (!/^-?\d{1,78}$/u.test(text)) return null;
        const number = BigInt(text); const bits = BigInt(field.bits!); const limit = 1n << (field.signed ? bits - 1n : bits);
        if (number < (field.signed ? -limit : 0n) || number >= limit) return null;
        row[field.column.name] = number.toString(); continue;
      }
      const float = field.kind === "float" ? floatText(value) : null;
      const text = sumDecimalStrings([float?.text ?? value], field.column.scale!);
      if (text === null || field.kind === "decimal" && text.replace(/^-?/u, "").replace(".", "").replace(/^0+/u, "").length > field.precision!) return null;
      row[field.column.name] = text;
    }
    rows.push(row);
  }
  const table = { columns: fields.map((field) => field.column), rows };
  return fitsResultCalculationBytes(table) ? table : null;
}
