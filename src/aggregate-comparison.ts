import type { VerifiedAggregate } from "./aggregate-evidence.js";

export interface AggregateComparison {
  left: VerifiedAggregate;
  right: VerifiedAggregate;
  difference: string;
  ratio: string | null;
  change_percent: string | null;
}

/** Exact base-10 comparison of two already verified decimal sums. The scope
 * restrictions deliberately mirror the existing integer comparison. */
export function compareDecimalAggregates(left: VerifiedAggregate, right: VerifiedAggregate): AggregateComparison | null {
  if (left.source_resource_id === right.source_resource_id || left.operation !== "sum" || right.operation !== "sum" || left.table !== right.table || left.column !== right.column || left.unit !== right.unit || left.prediction !== right.prediction || left.range.timezone !== right.range.timezone || left.scale < 1 || left.scale !== right.scale) return null;
  const entries = (value: Record<string, string>) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  if (entries(left.group) !== entries(right.group)) return null;
  const changed = [...new Set([...Object.keys(left.filters), ...Object.keys(right.filters)])].filter((key) => left.filters[key] !== right.filters[key]);
  const sameRange = left.range.start === right.range.start && left.range.end === right.range.end;
  if (sameRange) {
    if (changed.length !== 1) return null;
  } else {
    if (changed.length || !(left.range.end < right.range.start || right.range.end < left.range.start)) return null;
    const duration = (start: string, end: string) => Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
    if (duration(left.range.start, left.range.end) !== duration(right.range.start, right.range.end)) return null;
  }
  const parse = (value: string): bigint | null => {
    const match = /^(-?)(\d+)\.(\d+)$/u.exec(value);
    if (!match || match[3]!.length !== left.scale || match[2]!.length + match[3]!.length > 38) return null;
    const amount = BigInt(match[2]! + match[3]!);
    return match[1] ? -amount : amount;
  };
  const a = parse(left.value); const b = parse(right.value);
  if (a === null || b === null) return null;
  const delta = a - b;
  return { left, right, difference: fixed(delta, left.scale), ratio: b === 0n ? null : quotient(a, b, 4), change_percent: b === 0n ? null : quotient(delta * 100n, b, 2) };
}

function fixed(value: bigint, scale: number): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const digits = absolute.toString().padStart(scale + 1, "0");
  return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

/** Round ties away from zero. */
function quotient(numerator: bigint, denominator: bigint, scale: number): string {
  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = (numerator < 0n ? -numerator : numerator) * 10n ** BigInt(scale);
  const d = denominator < 0n ? -denominator : denominator;
  const rounded = (n * 2n + d) / (2n * d);
  return fixed(negative ? -rounded : rounded, scale);
}
