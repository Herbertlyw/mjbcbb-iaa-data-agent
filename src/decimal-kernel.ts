// Shared bounded decimal math for cells, transforms, alignment and comparisons.
export interface Decimal { n: bigint; scale: number }
export type DecimalOperation = "add" | "subtract" | "multiply" | "divide";

/** Parse decimal text without converting its value through Number. */
export function parseDecimal(value: string): Decimal | null {
  if (typeof value !== "string" || value.length > 84) return null;
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d{1,3}))?$/u.exec(value);
  if (!match || (!match[2] && !match[3])) return null;
  const digits = `${match[2] || "0"}${match[3] || ""}`.replace(/^0+/u, "") || "0";
  const exponent = Number(match[4] || 0);
  if (digits.length > 76 || Math.abs(exponent) > 76) return null;
  let n = BigInt(digits) * (match[1] === "-" ? -1n : 1n);
  let scale = (match[3]?.length ?? 0) - exponent;
  if (scale < 0) { n *= 10n ** BigInt(-scale); scale = 0; }
  while (scale > 0 && n % 10n === 0n) { n /= 10n; scale--; }
  return scale <= 76 && magnitude(n).length <= 76 ? { n, scale } : null;
}

/** Format a checked integer coefficient; zero never retains a negative sign. */
export function formatDecimal(value: bigint, scale: number): string {
  const digits = magnitude(value).padStart(scale + 1, "0");
  const sign = value < 0n ? "-" : "";
  return scale ? `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}` : `${sign}${digits}`;
}

/** Canonical text for numeric keys and database Float observations. */
export function normalizeDecimal(value: string): string | null {
  const parsed = parseDecimal(value);
  return parsed ? formatDecimal(parsed.n, parsed.scale) : null;
}

/** Add values at an explicit scale; an empty input has no observed sum. */
export function sumDecimals(values: readonly string[], scale: number): string | null {
  if (!values.length || !validScale(scale)) return null;
  let total = 0n;
  for (const value of values) {
    const parsed = parseDecimal(value);
    if (!parsed || parsed.scale > scale) return null;
    total += parsed.n * 10n ** BigInt(scale - parsed.scale);
  }
  return magnitude(total).length <= 76 ? formatDecimal(total, scale) : null;
}

/** Invalid/overflow is undefined; division by zero is null. Ties round away
 * from zero. A caller's metadata, not this function, grants business meaning. */
export function decimalOperation(op: DecimalOperation, left: string, right: string, scale: number): string | null | undefined {
  if (!validScale(scale)) return undefined;
  const a = parseDecimal(left); const b = parseDecimal(right);
  if (!a || !b) return undefined;
  let result: bigint;
  if (op === "divide") {
    if (b.n === 0n) return null;
    const numerator = a.n * 10n ** BigInt(scale + b.scale);
    const denominator = b.n * 10n ** BigInt(a.scale);
    const x = numerator < 0n ? -numerator : numerator;
    const y = denominator < 0n ? -denominator : denominator;
    const rounded = (x * 2n + y) / (2n * y);
    result = (numerator < 0n) !== (denominator < 0n) ? -rounded : rounded;
  } else if (op === "multiply") {
    if (a.scale + b.scale > scale) return undefined;
    result = a.n * b.n * 10n ** BigInt(scale - a.scale - b.scale);
  } else if (op === "add" || op === "subtract") {
    if (a.scale > scale || b.scale > scale) return undefined;
    const x = a.n * 10n ** BigInt(scale - a.scale); const y = b.n * 10n ** BigInt(scale - b.scale);
    result = op === "add" ? x + y : x - y;
  } else return undefined;
  return magnitude(result).length <= 76 ? formatDecimal(result, scale) : undefined;
}

/** Compare parsed decimals, including different textual scales. */
export function compareDecimals(a: Decimal, b: Decimal): number {
  const scale = Math.max(a.scale, b.scale);
  const left = a.n * 10n ** BigInt(scale - a.scale); const right = b.n * 10n ** BigInt(scale - b.scale);
  return left < right ? -1 : left > right ? 1 : 0;
}

function validScale(scale: number): boolean { return Number.isInteger(scale) && scale >= 0 && scale <= 76; }
function magnitude(value: bigint): string { return (value < 0n ? -value : value).toString(); }
