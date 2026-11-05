import { format, parse } from "@clickhouse/parser";

const obj = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Prove equivalence for a chain of identity projections over one physical
 * table. The generated SQL is used solely to analyze evidence; the original
 * statement is still the one sent to ClickHouse. Any filter, LIMIT, alias
 * rewrite, join or expression inside a wrapper fails closed. */
export function clickHouseScopedProjection(sql: string, tableName: string): string | null {
  let statements: unknown[]; try { statements = parse(sql, { locations: false }); } catch { return null; }
  const root = obj(statements[0]); const branches = root?.selects;
  if (statements.length !== 1 || root?.type !== "SelectWithUnionQuery" || !Array.isArray(branches) || branches.length !== 1) return null;
  const final = obj(branches[0]); if (!final || final.type !== "SelectQuery" || final.where || final.prewhere || final.having || final.limit || final.limit_by || final.distinct || final.qualify || final.group_by_all || final.group_by_grouping_sets || final.group_by_with_totals || final.group_by_with_rollup || final.group_by_with_cube || final.interpolate || Array.isArray(final.order_by) && final.order_by.some((item) => Boolean(obj(item)?.with_fill)) || !Array.isArray(final.select)) return null;
  const identity = (select: unknown): Set<string> | null => {
    if (!Array.isArray(select) || !select.length) return null;
    const names = new Set<string>();
    for (const raw of select) {
      const node = obj(raw); const parts = node && typeof node.name === "string" ? (Array.isArray(node.name_parts) ? node.name_parts : node.name.split(".")) : [];
      if (node?.type !== "Identifier" || parts.length !== 1 || typeof parts[0] !== "string" || node.alias !== undefined && node.alias !== parts[0] || names.has(parts[0])) return null;
      names.add(parts[0]);
    }
    return names;
  };
  type Source = { base: Record<string, unknown>; available: Set<string>; depth: number };
  const resolve = (query: Record<string, unknown>, depth: number): Source | null => {
    if (depth > 12 || query.type !== "SelectQuery" || query.distinct || query.having || query.limit || query.limit_by || query.qualify || query.group_by || query.order_by || !Array.isArray(query.select)) return null;
    const fields = identity(query.select); if (!fields) return null;
    const from = obj(query.from); const elements = from?.children;
    if (!Array.isArray(elements) || elements.length !== 1) return null;
    const element = obj(elements[0]); const expression = obj(element?.table_expression); const table = obj(expression?.database_and_table_name); const subquery = obj(expression?.subquery);
    if (!element || element.table_join || element.array_join || !expression || expression.table_function || expression.sample_size || expression.sample_offset || expression.final) return null;
    let nested: Record<string, unknown> | null = null;
    if (subquery) {
      const node = obj(subquery.query); const list = node?.selects;
      if (node?.type !== "SelectWithUnionQuery" || !Array.isArray(list) || list.length !== 1 || query.with) return null;
      nested = obj(list[0]);
    } else if (table && !table.database && table.name === tableName && !query.with) {
      return { base: query, available: fields, depth };
    } else if (table && !table.database && Array.isArray(query.with) && query.with.length === 1) {
      const entry = obj(query.with[0]); const source = obj(entry?.subquery); const node = obj(source?.query); const list = node?.selects;
      if (entry?.type !== "WithElement" || entry.name !== table.name || entry.aliases || node?.type !== "SelectWithUnionQuery" || !Array.isArray(list) || list.length !== 1) return null;
      nested = obj(list[0]);
    } else return null;
    if (query.where || query.prewhere || !nested) return null;
    const source = resolve(nested, depth + 1);
    if (!source || [...fields].some((field) => !source.available.has(field))) return null;
    return { ...source, available: fields };
  };
  const from = obj(final.from); const elements = from?.children;
  if (!Array.isArray(elements) || elements.length !== 1) return null;
  const element = obj(elements[0]); const expression = obj(element?.table_expression); const table = obj(expression?.database_and_table_name); const subquery = obj(expression?.subquery);
  if (!element || element.table_join || element.array_join || !expression || expression.table_function || expression.sample_size || expression.sample_offset || expression.final) return null;
  let nested: Record<string, unknown> | null = null;
  if (subquery && !final.with) {
    const node = obj(subquery.query); const list = node?.selects;
    if (node?.type !== "SelectWithUnionQuery" || !Array.isArray(list) || list.length !== 1) return null;
    nested = obj(list[0]);
  } else if (table && !table.database && Array.isArray(final.with) && final.with.length === 1) {
    const entry = obj(final.with[0]); const source = obj(entry?.subquery); const node = obj(source?.query); const list = node?.selects;
    if (entry?.type !== "WithElement" || entry.name !== table.name || entry.aliases || node?.type !== "SelectWithUnionQuery" || !Array.isArray(list) || list.length !== 1) return null;
    nested = obj(list[0]);
  }
  if (!nested) return null;
  const source = resolve(nested, 1); if (!source) return null;
  const check = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.every(check);
    const node = obj(value); if (!node) return true;
    if (node.type === "Subquery" || node.is_window_function || node.window_definition || node.parameters) return false;
    if (node.type === "Identifier") {
      const parts = typeof node.name === "string" ? (Array.isArray(node.name_parts) ? node.name_parts : node.name.split(".")) : [];
      return parts.length === 1 && typeof parts[0] === "string" && source.available.has(parts[0]);
    }
    return Object.entries(node).every(([key, child]) => key === "alias" || key === "location" || key === "parent" || check(child));
  };
  if (!check(final.select) || final.group_by && !check(final.group_by)) return null;
  const base = structuredClone(source.base); base.select = structuredClone(final.select);
  if (final.group_by) base.group_by = structuredClone(final.group_by);
  else delete base.group_by;
  try { return format([{ type: "SelectWithUnionQuery", selects: [base] }] as Parameters<typeof format>[0]); } catch { return null; }
}
