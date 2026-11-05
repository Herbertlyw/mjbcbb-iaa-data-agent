import { parse } from "@clickhouse/parser";
import { isCalendarDate } from "./config.js";
import type { DataContract } from "./types.js";
import type { CoverageScope } from "./coverage.js";

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Prove the exact input filters of a direct CK query. This is coverage
 * analysis, not SQL authorization; complex shapes intentionally stay unknown.
 * undefined means the CK parser could not parse and permits the caller's
 * existing conservative compatibility path. */
export function clickHouseCoverageScope(sql: string, contract: DataContract, range: { start: string; end: string }): CoverageScope | null | undefined {
  const result = clickHouseCoverageAnalysis(sql, contract);
  if (!result) return result;
  return result.time_range.start === range.start && result.time_range.end === range.end ? result.scope : null;
}

/** The same restricted proof can establish the closed range for a newly
 * authorized direct query; consumers must independently authorize the AST. */
export function clickHouseCoverageAnalysis(sql: string, contract: DataContract): { scope: CoverageScope; time_range: { start: string; end: string } } | null | undefined {
  if (!contract.series || Buffer.byteLength(sql, "utf8") > 64 * 1024) return null;
  let statements: unknown[];
  try { statements = parse(sql, { locations: false }); } catch { return undefined; }
  const root = record(statements[0]); const branches = root?.selects;
  if (statements.length !== 1 || root?.type !== "SelectWithUnionQuery" || !Array.isArray(branches) || branches.length !== 1) return null;
  const query = record(branches[0]);
  if (!query || query.type !== "SelectQuery" || query.with || query.limit || query.limit_by || query.having || query.distinct || query.qualify || query.sample || query.array_join || query.group_by_all || query.group_by_grouping_sets || query.group_by_with_totals || query.group_by_with_rollup || query.group_by_with_cube || query.interpolate || Array.isArray(query.order_by) && query.order_by.some((item) => Boolean(record(item)?.with_fill))) return null;
  const from = record(query.from); const children = from?.children;
  if (!Array.isArray(children) || children.length !== 1) return null;
  const element = record(children[0]); const expression = record(element?.table_expression); const table = record(expression?.database_and_table_name);
  if (!element || element.table_join || element.array_join || !expression || expression.subquery || expression.table_function || expression.sample_size || expression.sample_offset || expression.final || !table || table.database || table.name !== contract.table) return null;
  const qualifier = typeof table.alias === "string" ? table.alias : contract.table;
  const dimensions = new Set(contract.series.dimensions);
  const equalities: Record<string, string> = {}; const inSets: Record<string, string[]> = {};
  let start = ""; let end = "";
  const stringLiteral = (value: unknown): string | null => { const item = record(value); return item?.type === "Literal" && item.value_type === "String" && typeof item.value === "string" ? item.value : null; };
  const dateLiteral = (value: unknown): string | null => {
    const item = record(value);
    const literal = item?.type === "Function" && String(item.name).toLowerCase() === "todate" && Array.isArray(item.arguments) && item.arguments.length === 1 ? stringLiteral(item.arguments[0]) : stringLiteral(value);
    return literal && isCalendarDate(literal) && literal >= "1970-01-01" && literal <= "2149-06-06" ? literal : null;
  };
  const visit = (value: unknown): boolean => {
    const node = record(value); if (!node || node.type !== "Function" || !Array.isArray(node.arguments)) return false;
    const op = String(node.name).toLowerCase(); const args = node.arguments;
    if (op === "and") return args.length >= 2 && args.every(visit);
    if (args.length !== 2) return false;
    const left = record(args[0]); if (left?.type !== "Identifier" || typeof left.name !== "string") return false;
    const parts = Array.isArray(left.name_parts) ? left.name_parts : left.name.split(".");
    if (parts.length > 2 || (parts.length === 2 && parts[0] !== qualifier)) return false;
    const column = String(parts.at(-1));
    if (column === contract.series!.date_column) {
      const date = dateLiteral(args[1]); if (!date) return false;
      if (op === "equals" && !start && !end) { start = date; end = date; return true; }
      if (op === "greaterorequals" && !start) { start = date; return true; }
      if (op === "lessorequals" && !end) { end = date; return true; }
      return false;
    }
    if (!/^[a-z_][a-z0-9_]*$/u.test(column) || ["__proto__", "prototype", "constructor"].includes(column) || !dimensions.has(column) || Object.hasOwn(equalities, column) || Object.hasOwn(inSets, column)) return false;
    if (op === "equals") { const value = stringLiteral(args[1]); if (!value || !/^[A-Za-z0-9_-]+$/u.test(value)) return false; equalities[column] = value; return true; }
    const tuple = record(args[1]);
    if (op !== "in" || tuple?.type !== "Literal" || tuple.value_type !== "Tuple" || !Array.isArray(tuple.value) || !tuple.value.length || tuple.value.length > 32) return false;
    const values = tuple.value.map((item) => { const v = record(item); return v?.value_type === "String" && typeof v.value === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(v.value) ? v.value : null; });
    if (values.some((item) => item === null) || new Set(values).size !== values.length) return false;
    if (values.length === 1) equalities[column] = values[0]!; else inSets[column] = (values as string[]).sort();
    return true;
  };
  if (query.prewhere && !visit(query.prewhere)) return null;
  if (!visit(query.where) || !start || !end || start > end) return null;
  return { scope: { equalities, inSets }, time_range: { start, end } };
}
