import type { VerifiedAggregate } from "./aggregate-evidence.js";
import { decimalOperation, sumDecimals } from "./decimal-kernel.js";

export type ArithmeticOp = "add" | "subtract" | "multiply" | "divide";

/** Units are host-derived, never supplied by a model. Directed operations
 * still require a matching contract declaration for different metrics. */
export function arithmeticUnit(op: ArithmeticOp, left: string, right: string): string | null {
  if (!left || !right || left === "契约未声明" || right === "契约未声明") return null;
  if (op === "add" || op === "subtract") return left === right ? left : null;
  if (op === "multiply") return `(${left})×(${right})`;
  if (op === "divide") return left === right ? "比值" : `(${left})/(${right})`;
  return null;
}

/** A real observed zero can be encoded as an integer or exact Decimal. */
export function isExactZero(value: unknown): boolean {
  return value === 0 || typeof value === "string" && /^-?0+(?:\.0+)?$/u.test(value);
}
export interface ArithmeticValue {
  value: string | null;
  scale: number;
  unit: string;
  basis: { table: string; column: string; operation: string; unit: string; prediction: string; timezone: string };
  /** Ordered, server-generated source identities, not model labels. */
  bases?: Array<ArithmeticValue["basis"]>;
  formula?: string;
  /** Result of arithmetic on verified cells, without certifying a business metric. */
  interpretation?: "mathematical_only";
  approximate?: boolean;
  partial?: boolean;
  /** Only an observed folded group, not proof of the complete business domain. */
  scope_unverified?: true;
  undefined_reason?: "null_input" | "zero_divisor";
  /** Bound only for a directly verified row, never supplied by the model. */
  row_identity?: { resource_id: string; execution_id: string; row: number };
  scopes: Array<{ filters: Record<string, string | null>; start: string; end: string }>;
}

export function sumDecimalStrings(values: unknown[], scale: number): string | null {
  if (!values.length || !Number.isInteger(scale) || scale < 0 || scale > 38) return null;
  const checked: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") return null;
    const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(value);
    if (!match || (match[3]?.length ?? 0) > scale || match[2]!.length + scale > 76) return null;
    checked.push(value);
  }
  return sumDecimals(checked, scale);
}

export function fromAggregate(item: VerifiedAggregate): ArithmeticValue {
  return { value: item.value, scale: item.scale, unit: item.unit, basis: { table: item.table, column: item.column, operation: item.operation, unit: item.unit, prediction: item.prediction, timezone: item.range.timezone }, scopes: [{ filters: { ...item.filters, ...item.group }, start: item.range.start, end: item.range.end }], ...(item.coverage_incomplete ? { partial: true } : {}) };
}

/** Arithmetic is deliberately limited to one contracted metric and compatible
 * scopes. No missing group or NULL is silently converted into zero. */
export function computeArithmetic(op: ArithmeticOp, left: ArithmeticValue, right: ArithmeticValue, declaredCrossMetric = false, mathematicalOnly = false): ArithmeticValue | null {
  const leftBases = left.bases ?? [left.basis]; const rightBases = right.bases ?? [right.basis];
  const identity = (bases: ArithmeticValue["basis"][]) => JSON.stringify([...new Set(bases.map((base) => JSON.stringify(base)))].sort());
  const sameBasis = identity(leftBases) === identity(rightBases);
  if (!mathematicalOnly && !sameBasis && (!declaredCrossMetric || leftBases.length !== 1 || rightBases.length !== 1)) return null;
  if (!mathematicalOnly && (sameBasis ? !left.scopes.every((a) => right.scopes.every((b) => compatible(a, b))) : !left.scopes.every((a) => right.scopes.every((b) => identicalScope(a, b))))) return null;
  if (!mathematicalOnly && (op === "add" || op === "subtract") && left.unit !== right.unit) return null;
  if (left.value === null || right.value === null) {
    const nullScale = op === "divide" ? 18 : op === "multiply" ? left.scale + right.scale : Math.max(left.scale, right.scale);
    if (nullScale > 38 || left.scopes.length + right.scopes.length > 32) return null;
    const unit = left.unit === right.unit && (op === "add" || op === "subtract") ? left.unit : "未认证";
    return { value: null, scale: nullScale, unit, basis: left.basis, scopes: [...left.scopes, ...right.scopes], ...(mathematicalOnly ? { interpretation: "mathematical_only" as const } : {}), ...(left.scope_unverified || right.scope_unverified ? { scope_unverified: true as const } : {}), partial: true, undefined_reason: "null_input", ...(left.approximate || right.approximate ? { approximate: true } : {}), formula: `(${left.formula ?? `${left.basis.table}.${left.basis.column}`} ${op} ${right.formula ?? `${right.basis.table}.${right.basis.column}`})` };
  }
  const scale = op === "divide" ? 18 : op === "multiply" ? left.scale + right.scale : Math.max(left.scale, right.scale);
  if (scale > 38 || !validStoredDecimal(left.value, left.scale) || !validStoredDecimal(right.value, right.scale)) return null;
  const result = decimalOperation(op, left.value, right.value, scale);
  if (result === undefined) return null;
  const unit = op === "add" || op === "subtract" ? left.unit === right.unit ? left.unit : "未认证" : arithmeticUnit(op, left.unit, right.unit) ?? "未认证";
  const scopes = [...left.scopes, ...right.scopes];
  if (scopes.length > 32) return null;
  const bases = [...new Map([...leftBases, ...rightBases].map((base) => [JSON.stringify(base), base])).values()];
  const label = (value: ArithmeticValue) => value.formula ?? `${value.basis.table}.${value.basis.column}`;
  return { value: result, scale, unit, basis: left.basis, ...(bases.length > 1 ? { bases, formula: `(${label(left)} ${op} ${label(right)})` } : left.formula || right.formula ? { formula: `(${label(left)} ${op} ${label(right)})` } : {}), scopes, ...(mathematicalOnly ? { interpretation: "mathematical_only" as const } : {}), ...(left.approximate || right.approximate ? { approximate: true } : {}), ...(left.partial || right.partial ? { partial: true } : {}), ...(left.scope_unverified || right.scope_unverified ? { scope_unverified: true as const } : {}), ...(result === null ? { undefined_reason: "zero_divisor" as const } : {}) };
}

function identicalScope(a: ArithmeticValue["scopes"][number], b: ArithmeticValue["scopes"][number]): boolean {
  return a.start === b.start && a.end === b.end && JSON.stringify(Object.entries(a.filters).sort()) === JSON.stringify(Object.entries(b.filters).sort());
}

function compatible(a: ArithmeticValue["scopes"][number], b: ArithmeticValue["scopes"][number]): boolean {
  const keys = new Set([...Object.keys(a.filters), ...Object.keys(b.filters)]);
  const changed = [...keys].filter((key) => a.filters[key] !== b.filters[key]);
  if (a.start === b.start && a.end === b.end) return changed.length <= 1 && [...keys].every((key) => Object.hasOwn(a.filters, key) && Object.hasOwn(b.filters, key));
  if (changed.length || !(a.end < b.start || b.end < a.start)) return false;
  const span = (start: string, end: string) => Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  return Number.isFinite(span(a.start, a.end)) && span(a.start, a.end) === span(b.start, b.end);
}

function validStoredDecimal(value: string, scale: number): boolean {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(value);
  return Number.isInteger(scale) && scale >= 0 && scale <= 38 && Boolean(match && (match[3]?.length ?? 0) === scale && match[2]!.length + scale <= 76);
}
