import { format, parse, type Statement } from "@clickhouse/parser";
import type { DataContract } from "./types.js";
import type { GuardedSql, TableRule } from "./sql.js";
import { clickHouseScanRange } from "./clickhouse-scan-range.js";
import { preflightClickHouseSql } from "./clickhouse-sql-preflight.js";
import { clickHouseReviewPolicy, safeNativeConditionalAggregates, safeNativeDateFunctions } from "./clickhouse-review-policy.js";
import { reviewSql } from "./clickhouse-review.js";

const obj = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Review bounded, single-physical-source CTE/derived queries whose expression
 * results cannot yet be given business lineage. The original SQL is executed;
 * formatting is used only to recover the physical scan interval. Coverage and
 * metric semantics must remain unknown unless separately proved. */
export function reviewScopedObservation(sql: string, contract: DataContract, rule: TableRule, database: string, maxRows: number): GuardedSql | null {
  const inspection = preflightClickHouseSql(sql);
  if (!inspection.ok || inspection.tables.length !== 1 || inspection.tables[0] !== rule.table || rule.table !== contract.table || !safeNativeConditionalAggregates(sql) || !safeNativeDateFunctions(sql, rule)) return null;
  try { if (!reviewSql(sql, clickHouseReviewPolicy(database, [rule], maxRows)).ok) return null; } catch { return null; }
  let statements: unknown[]; try { statements = parse(sql, { locations: false }); } catch { return null; }
  if (statements.length !== 1) return null;
  let physical: unknown; let physicalCount = 0; let nodes = 0; let nested = false; let hasAggregate = false;
  const containsSubquery = (value: unknown): boolean => {
    if (++nodes > 20_000) return true;
    if (Array.isArray(value)) return value.some(containsSubquery);
    const node = obj(value); if (!node) return false;
    if (["Subquery", "SelectQuery", "SelectWithUnionQuery"].includes(String(node.type))) return true;
    return Object.entries(node).some(([key, child]) => key !== "location" && key !== "parent" && containsSubquery(child));
  };
  const walk = (value: unknown, depth: number): boolean => {
    if (depth > 16 || ++nodes > 20_000) return false;
    const root = obj(value); if (root?.type !== "SelectWithUnionQuery" || !Array.isArray(root.selects) || root.selects.length !== 1) return false;
    const query = obj(root.selects[0]);
    if (!query || query.type !== "SelectQuery" || query.recursive_with || query.limit || query.limit_by || query.having || query.distinct || query.qualify || query.array_join || query.sample || query.group_by_all || query.group_by_grouping_sets || query.group_by_with_totals || query.group_by_with_rollup || query.group_by_with_cube || query.interpolate || Array.isArray(query.order_by) && query.order_by.some((part) => Boolean(obj(part)?.with_fill))) return false;
    const findAggregate = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(findAggregate); return; }
      const node = obj(value); if (!node) return;
      if (node.type === "Function" && ["sum", "count", "countif", "sumif", "min", "max", "avg"].includes(String(node.name).toLowerCase())) hasAggregate = true;
      for (const [key, child] of Object.entries(node)) if (key !== "location" && key !== "parent") findAggregate(child);
    };
    findAggregate(query.select);
    for (const [key, child] of Object.entries(query)) if (!["type", "with", "from", "location", "parent"].includes(key) && containsSubquery(child)) return false;
    const withItems = Array.isArray(query.with) ? query.with : [];
    for (const raw of withItems) {
      const item = obj(raw); const subquery = obj(item?.subquery);
      if (item?.type !== "WithElement" || typeof item.name !== "string" || item.name === contract.table || !subquery?.query || !walk(subquery.query, depth + 1)) return false;
      nested = true;
    }
    const children = obj(query.from)?.children; if (!Array.isArray(children) || children.length !== 1) return false;
    const entry = obj(children[0]); const expression = obj(entry?.table_expression); const table = obj(expression?.database_and_table_name); const subquery = obj(expression?.subquery);
    if (!entry || entry.table_join || entry.array_join || !expression || expression.table_function || expression.final || expression.sample_size || expression.sample_offset) return false;
    if (table) {
      if (table.database || typeof table.name !== "string") return false;
      if (table.name === contract.table) { if (withItems.length) return false; physical = value; physicalCount++; }
    } else if (subquery?.query) { nested = true; if (!walk(subquery.query, depth + 1)) return false; }
    else return false;
    return true;
  };
  if (!walk(statements[0], 0) || !nested || !hasAggregate || physicalCount !== 1 || !physical) return null;
  let physicalSql: string; try { physicalSql = format([physical as Statement]); } catch { return null; }
  const range = clickHouseScanRange(physicalSql, contract); if (!range) return null;
  return { sql, tables: [rule.table], columns: [], time_range: range, equalities: {} };
}
