import type { VerifiedAggregate } from "./aggregate-evidence.js";

export type ArithmeticOp = "add" | "subtract" | "multiply" | "divide";
export interface ArithmeticValue {
  value: string | null;
  scale: number;
  unit: string;
  basis: { table: string; column: string; operation: string; unit: string; prediction: string; timezone: string };
  scopes: Array<{ filters: Record<string, string>; start: string; end: string }>;
}

export function sumDecimalStrings(values: unknown[], scale: number): string | null {
  if (!values.length) return null;
  let total = 0n;
  for (const value of values) {
    if (typeof value !== "string") return null;
    const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(value);
    if (!match || !Number.isInteger(scale) || scale < 0 || scale > 38 || (match[3]?.length ?? 0) > scale || match[2]!.length + scale > 76) return null;
    const amount = BigInt(match[2]! + (match[3] ?? "").padEnd(scale, "0"));
    total += match[1] ? -amount : amount;
  }
  if ((total < 0n ? -total : total).toString().length > 76) return null;
  return fixed(total, scale);
}

export function fromAggregate(item: VerifiedAggregate): ArithmeticValue {
  return { value: item.value, scale: item.scale, unit: item.unit, basis: { table: item.table, column: item.column, operation: item.operation, unit: item.unit, prediction: item.prediction, timezone: item.range.timezone }, scopes: [{ filters: { ...item.filters, ...item.group }, start: item.range.start, end: item.range.end }] };
}

/** Arithmetic is deliberately limited to one contracted metric and compatible
 * scopes. No missing group or NULL is silently converted into zero. */
export function computeArithmetic(op: ArithmeticOp, left: ArithmeticValue, right: ArithmeticValue): ArithmeticValue | null {
  if (JSON.stringify(left.basis) !== JSON.stringify(right.basis) || !left.scopes.every((a) => right.scopes.every((b) => compatible(a, b)))) return null;
  if ((op === "add" || op === "subtract") && left.unit !== right.unit) return null;
  if (left.value === null || right.value === null) return null;
  const a = parse(left.value, left.scale); const b = parse(right.value, right.scale);
  if (a === null || b === null) return null;
  let result: bigint | null; let scale: number; let unit: string;
  if (op === "add" || op === "subtract") {
    scale = Math.max(left.scale, right.scale);
    const x = a * 10n ** BigInt(scale - left.scale); const y = b * 10n ** BigInt(scale - right.scale);
    result = op === "add" ? x + y : x - y; unit = left.unit;
  } else if (op === "multiply") {
    scale = left.scale + right.scale;
    if (scale > 38) return null;
    result = a * b; unit = `(${left.unit})×(${right.unit})`;
  } else if (op === "divide") {
    scale = 18; unit = left.unit === right.unit ? "比值" : `(${left.unit})/(${right.unit})`;
    if (b === 0n) result = null;
    else result = roundDivide(a * 10n ** BigInt(scale + right.scale), b * 10n ** BigInt(left.scale));
  } else return null;
  if (result !== null && (result < 0n ? -result : result).toString().length > 76) return null;
  const scopes = [...left.scopes, ...right.scopes];
  if (scopes.length > 32) return null;
  return { value: result === null ? null : fixed(result, scale), scale, unit, basis: left.basis, scopes };
}

function compatible(a: ArithmeticValue["scopes"][number], b: ArithmeticValue["scopes"][number]): boolean {
  const keys = new Set([...Object.keys(a.filters), ...Object.keys(b.filters)]);
  const changed = [...keys].filter((key) => a.filters[key] !== b.filters[key]);
  if (a.start === b.start && a.end === b.end) return changed.length <= 1 && [...keys].every((key) => Object.hasOwn(a.filters, key) && Object.hasOwn(b.filters, key));
  if (changed.length || !(a.end < b.start || b.end < a.start)) return false;
  const span = (start: string, end: string) => Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  return Number.isFinite(span(a.start, a.end)) && span(a.start, a.end) === span(b.start, b.end);
}

function parse(value: string, scale: number): bigint | null {
  if (!Number.isInteger(scale) || scale < 0 || scale > 38) return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(value);
  if (!match || (match[3]?.length ?? 0) !== scale || match[2]!.length + scale > 76) return null;
  const result = BigInt(match[2]! + (match[3] ?? ""));
  return match[1] ? -result : result;
}

function fixed(value: bigint, scale: number): string {
  const sign = value < 0n ? "-" : ""; const digits = (value < 0n ? -value : value).toString().padStart(scale + 1, "0");
  return scale ? `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}` : `${sign}${digits}`;
}

function roundDivide(numerator: bigint, denominator: bigint): bigint {
  const negative = (numerator < 0n) !== (denominator < 0n);
  const a = numerator < 0n ? -numerator : numerator; const b = denominator < 0n ? -denominator : denominator;
  const rounded = (a * 2n + b) / (2n * b);
  return negative ? -rounded : rounded;
}
