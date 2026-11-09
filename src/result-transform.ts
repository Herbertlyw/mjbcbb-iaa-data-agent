/** Transform only complete, already verified rows. Values are decimal strings;
 * no calculation here converts a numeric input through JavaScript Number. */
import { arithmeticUnit, type ArithmeticOp } from "./exact-arithmetic.js";
import { parseDecimal as decimal, normalizeDecimal, compareDecimals, decimalOperation, sumDecimals } from "./decimal-kernel.js";
export type ResultValue = string | boolean | null;
export interface ResultColumn {
  name: string;
  type: "text" | "decimal" | "boolean";
  unit: string;
  label: string;
  scale?: number;
  /** Values are decimal renderings of a database Float observation, not exact monetary data. */
  approximate?: boolean;
  /** Host-generated lineage for a verified, observed JOIN SUM; aliases do not grant it. */
  metric?: { table: string; column: string; operation: "sum" };
  /** Host-generated physical key identity; model labels are not authority. */
  key_lineage?: { table: string; column: string; physical_type: string };
  key_lineages?: Array<{ table: string; column: string; physical_type: string }>;
  value_lineage?: { table: string; column: string };
  /** Host-derived dependencies survive arithmetic, so later grouping cannot
   * erase a measure's non-additive dimensions. */
  aggregation_lineage?: Array<{ table: string; column: string }>;
}
/** Host-derived classification of contributing rows; it is not a model label. */
export interface ResultTable { columns: ResultColumn[]; rows: Array<Record<string, ResultValue>>; prediction_scope?: "observed_only"; prediction?: { column: string; actual: string; predicted: string } }
export type ComparisonOp = "eq" | "ne" | "lt" | "le" | "gt" | "ge";
/** Limits apply to the complete input AND every intermediate result. They are
 * independent of preview-page size and of the query driver's storage cap. */
export const RESULT_CALCULATION_MAX_ROWS = 10_000;
export const RESULT_CALCULATION_MAX_BYTES = 2_000_000;
export const RESULT_TRANSFORM_MAX_STEPS = 10;

export function fitsResultCalculationBytes(value: unknown): boolean {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" && Buffer.byteLength(encoded) <= RESULT_CALCULATION_MAX_BYTES;
  } catch { return false; }
}
export type TransformStep =
  | ({ op: "filter"; column: string } & ({ comparison: ComparisonOp; value: string | boolean | null; other_column?: never } | { comparison: ComparisonOp; other_column: string; value?: never } | { comparison: "is_null" | "is_not_null"; value?: never; other_column?: never }))
  | { op: "compare"; left: string; right: string; comparison: ComparisonOp; as: string }
  | { op: ArithmeticOp; left: string; right: string; as: string }
  | { op: "sort"; keys: Array<{ column: string; direction: "asc" | "desc"; nulls: "first" | "last" }> }
  | { op: "group"; by: string[]; aggregates: Array<{ op: "count_all" | "count" | "sum" | "min" | "max"; column?: string; as: string }> };

const namePattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const comparisons = new Set<ComparisonOp>(["eq", "ne", "lt", "le", "gt", "ge"]);

/** Returns null for malformed instructions, incompatible units or overflow. */
export function transformResult(input: ResultTable, steps: TransformStep[], authorizeArithmetic?: (left: ResultColumn, right: ResultColumn, op: ArithmeticOp) => boolean): ResultTable | null {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > RESULT_TRANSFORM_MAX_STEPS || !validTable(input)) return null;
  let table: ResultTable = { ...input, columns: input.columns.map((c) => ({ ...c })), rows: input.rows.map((r) => ({ ...r })) };
  for (const step of steps) {
    if (!step || typeof step !== "object") return null;
    const column = (name: string) => table.columns.find((c) => c.name === name);
    if (step.op === "filter") {
      const field = column(step.column);
      if (!field) return null;
      if (step.comparison === "is_null" || step.comparison === "is_not_null") {
        if (Object.hasOwn(step, "value") || Object.hasOwn(step, "other_column")) return null;
        table.rows = table.rows.filter((row) => step.comparison === "is_null" ? row[field.name] === null : row[field.name] !== null);
      } else {
        if (!comparisons.has(step.comparison)) return null;
        const hasValue = Object.hasOwn(step, "value"), hasColumn = Object.hasOwn(step, "other_column");
        if (hasValue === hasColumn) return null;
        const other = hasColumn ? column(step.other_column!) : undefined;
        if (hasColumn ? !other || other.type !== field.type || other.unit !== field.unit : !validValue(step.value, field)) return null;
        const comparison = step.comparison as ComparisonOp;
        table.rows = table.rows.filter((row) => compare(row[field.name]!, other ? row[other.name]! : step.value!, field, comparison) === true);
      }
    } else if (step.op === "compare") {
      const left = column(step.left); const right = column(step.right);
      if (!left || !right || !validName(step.as, table.columns) || !comparisons.has(step.comparison) || left.type !== right.type || left.unit !== right.unit) return null;
      const output: ResultColumn = { name: step.as, type: "boolean", unit: "布尔值", label: `比较（${left.label} ${step.comparison} ${right.label}）` };
      table.columns.push(output);
      table.rows = table.rows.map((row) => ({ ...row, [step.as]: compare(row[left.name]!, row[right.name]!, left, step.comparison) }));
    } else if (["add", "subtract", "multiply", "divide"].includes(step.op)) {
      // Narrow explicitly for direct callers that bypass the Pi schema.
      if (!(step.op === "add" || step.op === "subtract" || step.op === "multiply" || step.op === "divide")) return null;
      const left = column(step.left); const right = column(step.right);
      if (!left || !right || left.type !== "decimal" || right.type !== "decimal" || !validName(step.as, table.columns) || !authorizeArithmetic?.(left, right, step.op)) return null;
      const unit = arithmeticUnit(step.op, left.unit, right.unit);
      const scale = step.op === "divide" ? 18 : step.op === "multiply" ? left.scale! + right.scale! : Math.max(left.scale!, right.scale!);
      if (!unit || scale > 38) return null;
      const symbol = { add: "+", subtract: "−", multiply: "×", divide: "/" }[step.op];
      const dependencies = [left, right].flatMap((item) => item.aggregation_lineage ?? (item.value_lineage ? [item.value_lineage] : item.metric ? [{ table: item.metric.table, column: item.metric.column }] : []));
      const output: ResultColumn = { name: step.as, type: "decimal", scale, unit, label: `（${left.label} ${symbol} ${right.label}）`, ...(left.approximate || right.approximate ? { approximate: true } : {}), ...(dependencies.length ? { aggregation_lineage: dependencies } : {}) };
      const rows: Array<Record<string, ResultValue>> = [];
      for (const row of table.rows) {
        const x = row[left.name]; const y = row[right.name];
        const value = x === null || y === null ? null : decimalOperation(step.op, x as string, y as string, scale);
        if (value === undefined) return null;
        rows.push({ ...row, [step.as]: value });
      }
      table.columns.push(output); table.rows = rows;
    } else if (step.op === "sort") {
      if (!Array.isArray(step.keys) || !step.keys.length || step.keys.length > 8 || step.keys.some((key) => !column(key.column) || !["asc", "desc"].includes(key.direction) || !["first", "last"].includes(key.nulls))) return null;
      table.rows = table.rows.map((row, index) => ({ row, index })).sort((a, b) => {
        for (const key of step.keys) {
          const field = column(key.column)!; const x = a.row[key.column]!; const y = b.row[key.column]!;
          if (x === null || y === null) { if (x !== y) return x === null ? (key.nulls === "first" ? -1 : 1) : (key.nulls === "first" ? 1 : -1); continue; }
          const n = order(x, y, field);
          if (n) return key.direction === "asc" ? n : -n;
        }
        return a.index - b.index;
      }).map(({ row }) => row);
    } else if (step.op === "group") {
      if (!Array.isArray(step.by) || step.by.length > 8 || new Set(step.by).size !== step.by.length || step.by.some((name) => !column(name)) || !Array.isArray(step.aggregates) || !step.aggregates.length || step.aggregates.length > 20) return null;
      const outputs: ResultColumn[] = step.by.map((name) => ({ ...column(name)! }));
      for (const agg of step.aggregates) {
        if (!agg || !["count_all", "count", "sum", "min", "max"].includes(agg.op) || !validName(agg.as, outputs)) return null;
        const field = agg.column ? column(agg.column) : undefined;
        if (agg.op === "count_all" ? agg.column !== undefined : !field) return null;
        if (agg.op === "sum" && field?.type !== "decimal") return null;
        if ((agg.op === "min" || agg.op === "max") && field?.type === "boolean") return null;
        outputs.push(agg.op === "count" || agg.op === "count_all"
          ? { name: agg.as, type: "decimal", unit: "结果行", label: agg.op === "count_all" ? "输入结果行数" : `${field!.label} 的非 NULL 结果行数`, scale: 0 }
          : { ...field!, metric: undefined, key_lineage: undefined, key_lineages: undefined, ...(agg.op === "sum" ? {} : { value_lineage: undefined }), ...(!field!.aggregation_lineage && field!.value_lineage ? { aggregation_lineage: [field!.value_lineage] } : {}), name: agg.as, label: `${field!.label} 的${{ sum: "合计", min: "最小值", max: "最大值" }[agg.op as "sum" | "min" | "max"]}` });
      }
      const groups = new Map<string, Array<Record<string, ResultValue>>>();
      for (const row of table.rows) {
        // Numeric keys compare by value, so 1.0 and 1.00 are the same group.
        const key = JSON.stringify(step.by.map((name) => {
          const value = row[name]; const field = column(name)!;
          return value !== null && field.type === "decimal" ? normalizeDecimal(value as string)! : value;
        }));
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(row);
      }
      if (!step.by.length && !groups.size) groups.set("[]", []);
      const rows: Array<Record<string, ResultValue>> = [];
      for (const [key, group] of groups) {
        const values = JSON.parse(key) as ResultValue[];
        const output: Record<string, ResultValue> = Object.create(null) as Record<string, ResultValue>;
        step.by.forEach((name, index) => { output[name] = values[index]!; });
        for (const agg of step.aggregates) {
          if (agg.op === "count_all") { output[agg.as] = String(group.length); continue; }
          const field = column(agg.column!)!;
          const present = group.map((row) => row[field.name]!).filter((value): value is string | boolean => value !== null);
          if (agg.op === "count") { output[agg.as] = String(present.length); continue; }
          if (!present.length) { output[agg.as] = null; continue; }
          if (agg.op === "sum") {
            const total = sumDecimals(present as string[], field.scale!);
            if (total === null) return null;
            output[agg.as] = total;
          } else {
            output[agg.as] = present.reduce((a, b) => (agg.op === "min" ? order(a, b, field) <= 0 : order(a, b, field) >= 0) ? a : b);
          }
        }
        rows.push(output);
      }
      table = { columns: outputs, rows, ...(table.prediction_scope ? { prediction_scope: table.prediction_scope } : {}), ...(table.prediction && step.by.includes(table.prediction.column) ? { prediction: table.prediction } : {}) };
    } else return null;
    if (table.prediction && table.rows.length && table.rows.every(row => row[table.prediction!.column] === table.prediction!.actual)) table.prediction_scope = "observed_only";
    if (!validTable(table)) return null;
  }
  return table;
}

function validName(name: unknown, columns: ResultColumn[]): name is string { return typeof name === "string" && namePattern.test(name) && !["__proto__", "constructor", "prototype"].includes(name.toLowerCase()) && !columns.some((c) => c.name === name); }
function validTable(table: ResultTable): boolean {
  if (!table || table.prediction_scope !== undefined && table.prediction_scope !== "observed_only" || !Array.isArray(table.columns) || !table.columns.length || table.columns.length > 40 || !Array.isArray(table.rows) || table.rows.length > RESULT_CALCULATION_MAX_ROWS || !fitsResultCalculationBytes(table)) return false;
  const names: ResultColumn[] = [];
  if (table.prediction && (!table.columns.some(column => column.name === table.prediction!.column) || table.prediction.actual === table.prediction.predicted)) return false;
  for (const field of table.columns) {
    if (!field || !validName(field.name, names) || !["text", "decimal", "boolean"].includes(field.type) || typeof field.label !== "string" || typeof field.unit !== "string" || (field.type === "decimal" && (!Number.isInteger(field.scale) || field.scale! < 0 || field.scale! > 76))) return false;
    names.push(field);
  }
  return table.rows.every((row) => row && typeof row === "object" && Object.keys(row).length === names.length && names.every((field) => Object.hasOwn(row, field.name) && validValue(row[field.name], field)));
}
function validValue(value: unknown, field: ResultColumn): value is ResultValue {
  if (value === null) return true;
  if (field.type === "boolean") return typeof value === "boolean";
  if (typeof value !== "string" || value.length > 256) return false;
  return field.type === "text" || decimal(value) !== null;
}
function order(a: Exclude<ResultValue, null>, b: Exclude<ResultValue, null>, field: ResultColumn): number {
  if (field.type === "decimal") {
    return compareDecimals(decimal(a as string)!, decimal(b as string)!);
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
function compare(a: ResultValue, b: ResultValue, field: ResultColumn, op: ComparisonOp): boolean | null {
  if (a === null || b === null) return null;
  const result = order(a, b, field);
  return { eq: result === 0, ne: result !== 0, lt: result < 0, le: result <= 0, gt: result > 0, ge: result >= 0 }[op];
}
