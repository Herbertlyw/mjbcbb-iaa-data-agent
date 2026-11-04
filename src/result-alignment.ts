import { fromAggregate, type ArithmeticOp, type ArithmeticValue } from "./exact-arithmetic.js";
import type { VerifiedAggregate } from "./aggregate-evidence.js";
import { fitsResultCalculationBytes, RESULT_CALCULATION_MAX_ROWS, transformResult, type ResultTable, type ResultValue } from "./result-transform.js";

export interface AlignmentRef { resource_id: string; cell: string }
export interface AlignmentSpec { op: ArithmeticOp; keys: string[]; left: AlignmentRef; right: AlignmentRef }
export interface AlignedRow {
  group: Record<string, string | null>;
  status: "matched" | "missing_left" | "missing_right" | "zero_divisor" | "partial_nulls" | "null_input" | "empty_inputs";
  left: ArithmeticValue | null;
  right: ArithmeticValue | null;
  result: ArithmeticValue | null;
  left_count?: number;
  left_null_count?: number;
  right_count?: number;
  right_null_count?: number;
}

/** Full outer alignment of already verified grouped outputs. Missing means the
 * group did not occur in that query result; it is never replaced by zero. */
export function alignAggregates(left: VerifiedAggregate[], right: VerifiedAggregate[], keys: string[], op: ArithmeticOp, calculate: (op: ArithmeticOp, a: ArithmeticValue, b: ArithmeticValue) => ArithmeticValue | null): AlignedRow[] | null {
  if (!Array.isArray(keys) || !keys.length || keys.length > 3 || new Set(keys).size !== keys.length || keys.some((key) => typeof key !== "string" || !/^[a-z_][a-z0-9_]{0,63}$/u.test(key)) || !["add", "subtract", "multiply", "divide"].includes(op)) return null;
  if (!Array.isArray(left) || !Array.isArray(right) || !left.length || !right.length || left.length > RESULT_CALCULATION_MAX_ROWS || right.length > RESULT_CALCULATION_MAX_ROWS || !fitsResultCalculationBytes(left) || !fitsResultCalculationBytes(right)) return null;
  const names = [...keys].sort();
  function collect(values: VerifiedAggregate[]): Map<string, VerifiedAggregate> | null {
    const map = new Map<string, VerifiedAggregate>();
    for (const value of values) {
      if (JSON.stringify(Object.keys(value.group).sort()) !== JSON.stringify(names) || names.some((name) => typeof value.group[name] !== "string")) return null;
      const key = JSON.stringify(names.map((name) => value.group[name]));
      if (map.has(key)) return null;
      map.set(key, value);
    }
    return map;
  }
  const a = collect(left); const b = collect(right);
  if (!a || !b) return null;
  const groups = [...new Set([...a.keys(), ...b.keys()])].sort();
  if (groups.length > RESULT_CALCULATION_MAX_ROWS) return null;
  const result: AlignedRow[] = [];
  for (const key of groups) {
    const values = JSON.parse(key) as string[];
    const group = Object.fromEntries(names.map((name, index) => [name, values[index]!]));
    const leftValue = a.get(key) ? fromAggregate(a.get(key)!) : null;
    const rightValue = b.get(key) ? fromAggregate(b.get(key)!) : null;
    if (!leftValue || !rightValue) {
      result.push({ group, left: leftValue, right: rightValue, result: null, status: leftValue ? "missing_right" : "missing_left" });
      continue;
    }
    const computed = calculate(op, leftValue, rightValue);
    if (!computed) return null;
    result.push({ group, left: leftValue, right: rightValue, result: computed, status: computed.value === null ? "zero_divisor" : "matched" });
  }
  return fitsResultCalculationBytes(result) ? result : null;
}

/** The host must first revalidate each complete input resource, authorize its
 * fields and establish compatible key semantics, grain, units, prediction and
 * periods. These types alone do not confer authority. Matching key columns
 * must carry the same host-generated type and unit; callers may normalize
 * them only after proving that the underlying contracts mean the same thing. */
export interface CompleteKeyedInput {
  table: ResultTable;
  valueColumn: string;
  keyColumns: string[];
  valueForGroup: (sum: string, keys: ReadonlyArray<ResultValue>) => ArithmeticValue | null;
}

export interface CompleteKeyedGroup {
  group: Record<string, ResultValue>;
  status: "matched" | "partial_nulls" | "null_input" | "missing_left" | "missing_right" | "zero_divisor" | "empty_inputs";
  left: { value: string | null; count: number; null_count: number } | null;
  right: { value: string | null; count: number; null_count: number } | null;
  result: ArithmeticValue | null;
}

/** Group the entire verified tables before full-outer key alignment. NULL keys
 * form one explicit group; missing groups, all-NULL sums, real zero and zero
 * divisors remain distinct. No floating-point conversion is used. */
export function alignCompleteTables(
  left: CompleteKeyedInput,
  right: CompleteKeyedInput,
  op: ArithmeticOp,
  calculate: (op: ArithmeticOp, a: ArithmeticValue, b: ArithmeticValue) => ArithmeticValue | null,
): CompleteKeyedGroup[] | null {
  if (!left || !right || !["add", "subtract", "multiply", "divide"].includes(op) || typeof calculate !== "function" || typeof left.valueForGroup !== "function" || typeof right.valueForGroup !== "function" || !Array.isArray(left.keyColumns) || !Array.isArray(right.keyColumns) || left.keyColumns.length !== right.keyColumns.length || left.keyColumns.length > 8 || new Set(left.keyColumns).size !== left.keyColumns.length || new Set(right.keyColumns).size !== right.keyColumns.length) return null;
  if (!left.table || !right.table || !Array.isArray(left.table.columns) || !Array.isArray(right.table.columns)) return null;
  const leftValue = left.table.columns.find((column) => column.name === left.valueColumn);
  const rightValue = right.table.columns.find((column) => column.name === right.valueColumn);
  if (!leftValue || !rightValue || leftValue.type !== "decimal" || rightValue.type !== "decimal") return null;
  for (let i = 0; i < left.keyColumns.length; i += 1) {
    const a = left.table.columns.find((column) => column.name === left.keyColumns[i]);
    const b = right.table.columns.find((column) => column.name === right.keyColumns[i]);
    if (!a || !b || a.type !== b.type || a.unit !== b.unit) return null;
  }
  type Summary = { keys: ResultValue[]; value: string | null; count: number; null_count: number };
  const summarize = (input: CompleteKeyedInput): Map<string, Summary> | null => {
    // Internal names are distinct from every projected key, including when a
    // caller's otherwise valid query uses one of these common names.
    const names = new Set(input.keyColumns);
    const allocate = (base: string) => { let name = base; while (names.has(name)) name += "_"; names.add(name); return name; };
    const valueName = allocate("_keyed_value"); const countName = allocate("_keyed_count"); const nonnullName = allocate("_keyed_nonnull");
    const grouped = transformResult(input.table, [{ op: "group", by: input.keyColumns, aggregates: [
      { op: "sum", column: input.valueColumn, as: valueName },
      { op: "count_all", as: countName },
      { op: "count", column: input.valueColumn, as: nonnullName },
    ] }]);
    if (!grouped) return null;
    const map = new Map<string, Summary>();
    for (const row of grouped.rows) {
      const keys = input.keyColumns.map((name) => row[name]!);
      const count = Number(row[countName]); const nonnull = Number(row[nonnullName]); const value = row[valueName];
      if (!Number.isSafeInteger(count) || !Number.isSafeInteger(nonnull) || count < 0 || nonnull < 0 || nonnull > count || (value !== null && typeof value !== "string")) return null;
      const key = JSON.stringify(keys);
      if (map.has(key)) return null;
      map.set(key, { keys, value, count, null_count: count - nonnull });
    }
    return map;
  };
  const a = summarize(left); const b = summarize(right);
  if (!a || !b) return null;
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  if (keys.length > RESULT_CALCULATION_MAX_ROWS) return null;
  const output: CompleteKeyedGroup[] = [];
  for (const key of keys) {
    const x = a.get(key); const y = b.get(key); const values = (x ?? y)!.keys;
    const group = Object.fromEntries(left.keyColumns.map((name, index) => [name, values[index]!])) as Record<string, ResultValue>;
    const leftSummary = x ? { value: x.value, count: x.count, null_count: x.null_count } : null;
    const rightSummary = y ? { value: y.value, count: y.count, null_count: y.null_count } : null;
    let status: CompleteKeyedGroup["status"]; let result: ArithmeticValue | null = null;
    if ((!x || x.count === 0) && (!y || y.count === 0)) status = "empty_inputs";
    else if (!x || x.count === 0) status = "missing_left";
    else if (!y || y.count === 0) status = "missing_right";
    else if (x.value === null || y.value === null) status = "null_input";
    else {
      try {
        const lv = left.valueForGroup(x.value, values); const rv = right.valueForGroup(y.value, values);
        if (!lv || !rv || lv.value !== x.value || rv.value !== y.value) return null;
        result = calculate(op, lv, rv);
      } catch { return null; }
      if (!result) return null;
      const zeroDenominator = op === "divide" && /^-?0+(?:\.0+)?$/u.test(y.value);
      if ((result.value === null) !== zeroDenominator) return null;
      status = result.value === null ? "zero_divisor" : x.null_count || y.null_count ? "partial_nulls" : "matched";
    }
    output.push({ group, status, left: leftSummary, right: rightSummary, result });
  }
  return fitsResultCalculationBytes(output) ? output : null;
}
