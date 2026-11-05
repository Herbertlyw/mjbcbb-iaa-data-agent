import { format, parse } from "@clickhouse/parser";
import type { DataContract } from "./types.js";

const obj = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const ident = (value: unknown): value is string => typeof value === "string" && /^[a-z_][a-z0-9_]*$/u.test(value) && !["__proto__", "prototype", "constructor"].includes(value);

/** Expand a single, strictly equivalent grouped fact subquery before a
 * registered dimension JOIN. The result is an internal proof query; the
 * original SQL remains recorded and must be independently authorized. */
export function expandClickHousePreaggregate(sql: string, fact: DataContract): { sql: string; grain: string[] } | null {
  let statements: unknown[]; try { statements = parse(sql, { locations: false }); } catch { return null; }
  const root = obj(statements[0]); const branches = root?.selects;
  if (statements.length !== 1 || root?.type !== "SelectWithUnionQuery" || !Array.isArray(branches) || branches.length !== 1) return null;
  const outer = obj(branches[0]); const elements = obj(outer?.from)?.children;
  if (!outer || outer.type !== "SelectQuery" || outer.where || outer.prewhere || outer.having || outer.limit || outer.limit_by || outer.distinct || outer.qualify || outer.group_by_all || outer.group_by_grouping_sets || outer.group_by_with_totals || outer.group_by_with_rollup || outer.group_by_with_cube || !Array.isArray(outer.select) || !Array.isArray(outer.group_by) || !Array.isArray(elements) || elements.length !== 2) return null;
  const left = obj(elements[0]); const leftExpr = obj(left?.table_expression); const leftTable = obj(leftExpr?.database_and_table_name); const leftSubquery = obj(leftExpr?.subquery);
  if (!left || left.table_join || left.array_join || !leftExpr || leftExpr.table_function || leftExpr.final || leftExpr.sample_size || leftExpr.sample_offset) return null;
  let nested: Record<string, unknown> | null = null; let outerAlias: string;
  if (Array.isArray(outer.with) && outer.with.length === 1 && leftTable && !leftTable.database && !leftSubquery) {
    const entry = obj(outer.with[0]); const query = obj(obj(entry?.subquery)?.query); const list = query?.selects;
    if (entry?.type !== "WithElement" || entry.aliases || entry.name !== leftTable.name || query?.type !== "SelectWithUnionQuery" || !Array.isArray(list) || list.length !== 1) return null;
    nested = obj(list[0]); outerAlias = String(leftTable.alias ?? leftTable.name);
  } else if (!outer.with && leftSubquery && !leftTable) {
    const query = obj(leftSubquery.query); const list = query?.selects;
    if (query?.type !== "SelectWithUnionQuery" || !Array.isArray(list) || list.length !== 1 || !ident(leftSubquery.alias)) return null;
    nested = obj(list[0]); outerAlias = leftSubquery.alias;
  } else return null;
  if (!ident(outerAlias) || !nested || nested.type !== "SelectQuery" || nested.with || nested.prewhere || !nested.where || nested.having || nested.limit || nested.limit_by || nested.distinct || nested.qualify || nested.order_by || nested.group_by_all || nested.group_by_grouping_sets || nested.group_by_with_totals || nested.group_by_with_rollup || nested.group_by_with_cube || !Array.isArray(nested.group_by) || !nested.group_by.length || !Array.isArray(nested.select)) return null;
  const from = obj(nested.from)?.children;
  if (!Array.isArray(from) || from.length !== 1) return null;
  const innerElement = obj(from[0]); const innerExpr = obj(innerElement?.table_expression); const physical = obj(innerExpr?.database_and_table_name);
  if (!innerElement || innerElement.table_join || innerElement.array_join || !innerExpr || innerExpr.subquery || innerExpr.table_function || innerExpr.final || innerExpr.sample_size || innerExpr.sample_offset || !physical || physical.database || physical.name !== fact.table) return null;
  const innerAlias = String(physical.alias ?? physical.name); if (!ident(innerAlias) || !ident(fact.table)) return null;
  const field = (value: unknown, alias: string): string | null => {
    const node = obj(value); if (node?.type !== "Identifier" || typeof node.name !== "string") return null;
    const parts = Array.isArray(node.name_parts) ? node.name_parts : node.name.split(".");
    return parts.length === 1 && ident(parts[0]) ? parts[0] : parts.length === 2 && parts[0] === alias && ident(parts[1]) ? parts[1] : null;
  };
  const grain = nested.group_by.map((item) => obj(item)?.alias === undefined ? field(item, innerAlias) : null);
  if (grain.some((item) => !item || !fact.grain?.includes(item)) || new Set(grain).size !== grain.length) return null;
  const keys = new Map<string, string>(); const metrics = new Map<string, string>();
  for (const item of nested.select) {
    const node = obj(item); if (!node) return null;
    const plain = field(node, innerAlias); const output = node.alias ?? plain;
    if (!ident(output) || keys.has(output) || metrics.has(output) || fact.columns.some((column) => column.name === output) && output !== plain) return null;
    if (plain) { if (!grain.includes(plain)) return null; keys.set(output, plain); continue; }
    if (node.type !== "Function" || String(node.name).toLowerCase() !== "sum" || node.is_window_function || node.window_definition || node.parameters || !Array.isArray(node.arguments) || node.arguments.length !== 1) return null;
    const metric = obj(node.arguments[0])?.alias === undefined ? field(node.arguments[0], innerAlias) : null; if (!metric || !fact.series?.metrics.includes(metric)) return null;
    metrics.set(output, metric);
  }
  if (!metrics.size || metrics.size > 8 || keys.size !== grain.length || new Set(keys.values()).size !== keys.size || [...keys.values()].sort().join("|") !== [...grain].sort().join("|")) return null;
  const rewriteKey = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.every(rewriteKey);
    const node = obj(value); if (!node) return true;
    if (node.type === "Subquery" || node.is_window_function || node.window_definition || node.parameters) return false;
    if (node.type === "Identifier") {
      const parts = typeof node.name === "string" ? (Array.isArray(node.name_parts) ? node.name_parts : node.name.split(".")) : [];
      if (parts.length === 2 && parts[0] === outerAlias) {
        const mapped = typeof parts[1] === "string" ? keys.get(parts[1]) : undefined; if (!mapped) return false;
        node.name = `${outerAlias}.${mapped}`; node.name_parts = [outerAlias, mapped];
      }
      return true;
    }
    return Object.entries(node).every(([key, child]) => key === "alias" || key === "location" || key === "parent" || rewriteKey(child));
  };
  const used = new Set<string>();
  for (const value of outer.select) {
    const node = obj(value); if (!node) return null;
    if (node.type === "Identifier") {
      const old = field(node, outerAlias); const parts = typeof node.name === "string" ? (Array.isArray(node.name_parts) ? node.name_parts : node.name.split(".")) : [];
      if (parts.length === 2 && parts[0] === outerAlias && old && keys.get(old) !== old && node.alias === undefined) node.alias = old;
      if (!rewriteKey(node)) return null; continue;
    }
    if (node.type !== "Function" || String(node.name).toLowerCase() !== "sum" || node.is_window_function || node.window_definition || node.parameters || !Array.isArray(node.arguments) || node.arguments.length !== 1) return null;
    const arg = obj(node.arguments[0]); const parts = typeof arg?.name === "string" ? (Array.isArray(arg.name_parts) ? arg.name_parts : arg.name.split(".")) : [];
    const subtotal = parts.length === 2 && parts[0] === outerAlias && typeof parts[1] === "string" ? parts[1] : "";
    const mapped = metrics.get(subtotal); if (!arg || arg.alias !== undefined || !mapped || used.has(subtotal)) return null;
    used.add(subtotal); arg.name = `${outerAlias}.${mapped}`; arg.name_parts = [outerAlias, mapped];
  }
  if (used.size !== metrics.size || !rewriteKey(outer.group_by) || !rewriteKey(outer.order_by) || !rewriteKey(obj(elements[1])?.table_join)) return null;
  const where = structuredClone(nested.where);
  const rewriteWhere = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.every(rewriteWhere);
    const node = obj(value); if (!node) return true;
    if (node.type === "Subquery") return false;
    if (node.type === "Identifier") {
      const name = field(node, innerAlias); if (!name) return false;
      node.name = `${outerAlias}.${name}`; node.name_parts = [outerAlias, name]; return true;
    }
    return Object.entries(node).every(([key, child]) => key === "location" || key === "parent" || rewriteWhere(child));
  };
  if (!rewriteWhere(where)) return null;
  delete outer.with; outer.where = where;
  delete leftExpr.subquery; leftExpr.database_and_table_name = { type: "TableIdentifier", name: fact.table, alias: outerAlias };
  try { return { sql: format(statements as Parameters<typeof format>[0]), grain: grain as string[] }; } catch { return null; }
}
