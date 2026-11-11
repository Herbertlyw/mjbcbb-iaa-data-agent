import type { JoinEvidencePlan, VerifiedJoinValue } from "./join-evidence.js";
import type { AnalysisRecord, QueryResource } from "./types.js";

type Arithmetic = NonNullable<AnalysisRecord["arithmetic_results"]>[number];

/** Describe a selected same-row calculation only after the caller has fully
 * verified the JOIN and its publication. Model-provided labels are ignored. */
export function verifiedJoinArithmeticGroup(
  arithmetic: Arithmetic,
  source: QueryResource,
  plan: JoinEvidencePlan,
  values: readonly VerifiedJoinValue[],
): Record<string, string | null> | null {
  const { left, right } = arithmetic;
  if (!plan.groups.length || typeof source.execution_id !== "string" || !source.execution_id || left.resource_id !== source.resource_id || right.resource_id !== source.resource_id ||
      left.execution_id !== source.execution_id || right.execution_id !== source.execution_id ||
      !Number.isSafeInteger(left.row) || left.row! < 0 || left.row !== right.row ||
      left.row! >= source.rows.length) return null;
  const row = source.rows[left.row!]!;
  const group: Record<string, string | null> = {};
  for (const item of plan.groups) {
    const value = row[item.output];
    if (typeof value !== "string" && value !== null) return null;
    group[`${item.table === "fact" ? plan.fact : plan.dimension}.${item.column}`] = value;
  }
  for (const ref of [left, right]) {
    const metric = plan.metrics.find((item) => item.output === ref.cell);
    if (!metric || !values.some((item) => item.column === metric.column && item.operation === metric.operation && JSON.stringify(item.group) === JSON.stringify(group))) return null;
  }
  return group;
}
