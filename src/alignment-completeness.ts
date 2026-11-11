import { isExactZero } from "./exact-arithmetic.js";
import type { AlignedRow } from "./result-alignment.js";

/** An exact zero denominator is a known mathematical outcome only when both
 * inputs and their coverage remain complete. NULL and missing groups differ. */
export function alignmentHasUnresolvedRows(rows: readonly AlignedRow[]): boolean {
  return rows.some((row) => {
    if (Object.values(row.group).some((value) => value === null)) return true;
    if (row.status === "matched") return false;
    return !(row.status === "zero_divisor" && row.left && row.right && row.left.value !== null && isExactZero(row.right.value) && row.result?.value === null && row.result.undefined_reason === "zero_divisor" && !row.result.partial && !row.result.scope_unverified && !row.result.approximate && row.result.interpretation !== "mathematical_only" && (row.left_null_count ?? 0) === 0 && (row.right_null_count ?? 0) === 0);
  });
}
