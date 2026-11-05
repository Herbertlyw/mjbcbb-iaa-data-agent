import { parse } from "@clickhouse/parser";
import { isCalendarDate } from "./config.js";
import type { DataContract } from "./types.js";

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Extract only a closed physical Date scan for a direct query. This is not a
 * coverage proof: all other predicates are deliberately ignored here and must
 * be authorized by the reviewer. Unsupported query structures fail closed. */
export function clickHouseScanRange(sql: string, contract: DataContract): { start: string; end: string } | null {
  if (!contract.series || Buffer.byteLength(sql, "utf8") > 64 * 1024) return null;
  let statements: unknown[]; try { statements = parse(sql, { locations: false }); } catch { return null; }
  const root = record(statements[0]); const branches = root?.selects;
  if (statements.length !== 1 || root?.type !== "SelectWithUnionQuery" || !Array.isArray(branches) || branches.length !== 1) return null;
  const query = record(branches[0]);
  if (!query || query.type !== "SelectQuery" || query.with || query.limit || query.limit_by || query.having || query.distinct || query.qualify || query.sample || query.array_join || query.group_by_all || query.group_by_grouping_sets || query.group_by_with_totals || query.group_by_with_rollup || query.group_by_with_cube || query.interpolate || Array.isArray(query.order_by) && query.order_by.some((item) => Boolean(record(item)?.with_fill))) return null;
  const children = record(query.from)?.children;
  if (!Array.isArray(children) || children.length !== 1) return null;
  const element = record(children[0]); const expression = record(element?.table_expression); const table = record(expression?.database_and_table_name);
  if (!element || element.table_join || element.array_join || !expression || expression.subquery || expression.table_function || expression.sample_size || expression.sample_offset || expression.final || !table || table.database || table.name !== contract.table) return null;
  const qualifier = typeof table.alias === "string" ? table.alias : contract.table;
  const date = (value: unknown): number | null => {
    let node = record(value);
    if (node?.type === "Function" && String(node.name).toLowerCase() === "todate") {
      if (!Array.isArray(node.arguments) || node.arguments.length !== 1) return null;
      node = record(node.arguments[0]);
    }
    if (node?.type !== "Literal" || node.value_type !== "String" || typeof node.value !== "string" || !isCalendarDate(node.value) || node.value < "1970-01-01" || node.value > "2149-06-06") return null;
    return Date.parse(`${node.value}T00:00:00Z`) / 86_400_000;
  };
  const terms: unknown[] = [];
  const flatten = (value: unknown): void => { const node = record(value); if (node?.type === "Function" && String(node.name).toLowerCase() === "and" && Array.isArray(node.arguments)) node.arguments.forEach(flatten); else if (value) terms.push(value); };
  flatten(query.where); flatten(query.prewhere);
  let low: number | undefined; let high: number | undefined;
  for (const raw of terms) {
    const node = record(raw); if (node?.type !== "Function" || !Array.isArray(node.arguments) || node.arguments.length !== 2) continue;
    const left = record(node.arguments[0]); if (left?.type !== "Identifier" || typeof left.name !== "string") continue;
    const parts = Array.isArray(left.name_parts) ? left.name_parts : left.name.split(".");
    if (parts.at(-1) !== contract.series.date_column || parts.length > 2 || parts.length === 2 && parts[0] !== qualifier) continue;
    const op = String(node.name).toLowerCase(); const tuple = record(node.arguments[1]);
    if (op === "in" && tuple?.type === "Literal" && tuple.value_type === "Tuple" && Array.isArray(tuple.value)) {
      if (!tuple.value.length || tuple.value.length > 32) return null;
      const days = tuple.value.map((item) => { const literal = record(item); return literal ? date({ ...literal, type: "Literal" }) : null; });
      if (days.some((item) => item === null)) return null;
      low = Math.max(low ?? -Infinity, Math.min(...days as number[])); high = Math.min(high ?? Infinity, Math.max(...days as number[]));
      continue;
    }
    const day = date(node.arguments[1]);
    if (day === null || !["equals", "greaterorequals", "greater", "lessorequals", "less"].includes(op)) return null;
    if (op === "equals" || op === "greaterorequals" || op === "greater") low = Math.max(low ?? -Infinity, day + (op === "greater" ? 1 : 0));
    if (op === "equals" || op === "lessorequals" || op === "less") high = Math.min(high ?? Infinity, day - (op === "less" ? 1 : 0));
  }
  if (low === undefined || high === undefined || low > high || high - low + 1 > 400) return null;
  return { start: new Date(low * 86_400_000).toISOString().slice(0, 10), end: new Date(high * 86_400_000).toISOString().slice(0, 10) };
}
