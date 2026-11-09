import type { DataContract, QueryResource } from "./types.js";

/** Policy only removes authority: malformed declarations fail closed. */
export function requiredAggregationDimensions(contract: DataContract, metric: string): string[] | null {
  const policy: unknown = contract.aggregation_policy;
  if (policy === undefined) return [];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return null;
  if (!Object.hasOwn(policy, metric)) return [];
  const dimensions: unknown = (policy as Record<string, unknown>)[metric];
  if (!Array.isArray(dimensions) || !dimensions.length || dimensions.length > 32 || dimensions.some((name) => typeof name !== "string" || !/^[a-z_][a-z0-9_]*$/u.test(name) || !contract.columns.some((column) => column.name === name) || contract.sensitive_columns.includes(name)) || new Set(dimensions).size !== dimensions.length) return null;
  return dimensions as string[];
}

export function permitsAggregation(contract: DataContract, metric: string, filters: Record<string, string>, grouped: readonly (string | null)[], range: QueryResource["time_range"]): boolean {
  const required = requiredAggregationDimensions(contract, metric);
  return required !== null && required.every((dimension) => Object.hasOwn(filters, dimension) || grouped.includes(dimension) || dimension === contract.series?.date_column && range.start === range.end);
}
