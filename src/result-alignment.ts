import { fromAggregate, type ArithmeticOp, type ArithmeticValue } from "./exact-arithmetic.js";
import type { VerifiedAggregate } from "./aggregate-evidence.js";

export interface AlignmentRef { resource_id: string; cell: string }
export interface AlignmentSpec { op: ArithmeticOp; keys: string[]; left: AlignmentRef; right: AlignmentRef }
export interface AlignedRow {
  group: Record<string, string>;
  status: "matched" | "missing_left" | "missing_right" | "zero_divisor";
  left: ArithmeticValue | null;
  right: ArithmeticValue | null;
  result: ArithmeticValue | null;
}

/** Full outer alignment of already verified grouped outputs. Missing means the
 * group did not occur in that query result; it is never replaced by zero. */
export function alignAggregates(left: VerifiedAggregate[], right: VerifiedAggregate[], keys: string[], op: ArithmeticOp, calculate: (op: ArithmeticOp, a: ArithmeticValue, b: ArithmeticValue) => ArithmeticValue | null): AlignedRow[] | null {
  if (!Array.isArray(keys) || !keys.length || keys.length > 3 || new Set(keys).size !== keys.length || keys.some((key) => typeof key !== "string" || !/^[a-z_][a-z0-9_]{0,63}$/u.test(key)) || !["add", "subtract", "multiply", "divide"].includes(op)) return null;
  if (!left.length || !right.length || left.length > 200 || right.length > 200) return null;
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
  if (groups.length > 200) return null;
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
  return result;
}
