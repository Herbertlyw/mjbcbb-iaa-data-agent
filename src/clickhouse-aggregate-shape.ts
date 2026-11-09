import { parse } from "@clickhouse/parser";

const obj = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Translate only a direct CK aggregate projection into the existing evidence
 * verifier's narrow shape. This is not an authorization decision and never
 * accepts CTEs, expressions, window functions or unrecognized combinators. */
export function clickHouseAggregateShape(sql: string, tableName: string): Record<string, unknown> | null {
  let raw: unknown[]; try { raw = parse(sql, { locations: false }); } catch { return null; }
  const root = obj(raw[0]); const branches = root?.selects;
  if (raw.length !== 1 || root?.type !== "SelectWithUnionQuery" || !Array.isArray(branches) || branches.length !== 1) return null;
  const q = obj(branches[0]); const from = obj(q?.from); const children = from?.children;
  if (!q || q.type !== "SelectQuery" || q.with || q.having || q.limit || q.limit_by || q.distinct || q.qualify || q.group_by_all || q.group_by_grouping_sets || q.group_by_with_totals || q.group_by_with_rollup || q.group_by_with_cube || q.interpolate || Array.isArray(q.order_by) && q.order_by.some((item) => Boolean(obj(item)?.with_fill)) || !Array.isArray(children) || children.length !== 1 || !Array.isArray(q.select)) return null;
  const element = obj(children[0]); const expression = obj(element?.table_expression); const table = obj(expression?.database_and_table_name);
  if (!element || element.table_join || element.array_join || !expression || expression.subquery || expression.table_function || expression.sample_size || expression.sample_offset || expression.final || !table || table.database || table.name !== tableName) return null;
  const qualifier = typeof table.alias === "string" ? table.alias : tableName;
  const column = (input: unknown): Record<string, unknown> | null => {
    const node = obj(input); if (node?.type !== "Identifier" || typeof node.name !== "string") return null;
    const parts = Array.isArray(node.name_parts) ? node.name_parts : node.name.split(".");
    if (parts.length > 2 || (parts.length === 2 && parts[0] !== qualifier) || typeof parts.at(-1) !== "string") return null;
    return { type: "column_ref", table: parts.length === 2 ? qualifier : null, column: parts.at(-1) };
  };
  const columns: Record<string, unknown>[] = [];
  for (const rawProjection of q.select) {
    const projection = obj(rawProjection); if (!projection) return null;
    const as = typeof projection.alias === "string" ? projection.alias : null;
    const direct = column(projection);
    if (direct) { columns.push({ expr: direct, as }); continue; }
    if (projection.type !== "Function" || projection.is_window_function || projection.window_definition || projection.parameters || !Array.isArray(projection.arguments)) return null;
    const name = String(projection.name).toLowerCase(); const args = projection.arguments;
    if (["sum", "count", "min", "max"].includes(name)) {
      const input = args.length === 1 ? column(args[0]) : null;
      const asterisk = args.length === 1 ? obj(args[0]) : null;
      const star = name === "count" && (args.length === 0 || asterisk?.type === "Asterisk" && (!asterisk.transformers || Array.isArray(asterisk.transformers) && asterisk.transformers.length === 0));
      if (!input && !star) return null;
      columns.push({ as, expr: { type: "aggr_func", name, args: { expr: input ?? { type: "star" } } } });
      continue;
    }
    if ((name === "isnull" || name === "isnotnull") && args.length === 1) {
      const field = column(args[0]); if (!field) return null;
      columns.push({ as, expr: { type: "function", name: { name: [{ value: name }] }, args: { type: "expr_list", value: [field] } } });
      continue;
    }
    if (name !== "countif" || args.length !== 1) return null;
    const condition = obj(args[0]); if (!condition || condition.type !== "Function" || !Array.isArray(condition.arguments)) return null;
    const op = String(condition.name).toLowerCase(); const condArgs = condition.arguments;
    let translated: Record<string, unknown> | null = null;
    if ((op === "isnull" || op === "isnotnull") && condArgs.length === 1) {
      const field = column(condArgs[0]);
      if (field) translated = { type: "function", name: { name: [{ value: op }] }, args: { type: "expr_list", value: [field] } };
    } else if (["equals", "notequals", "less", "lessorequals", "greater", "greaterorequals"].includes(op) && condArgs.length === 2) {
      const field = column(condArgs[0]); const literal = obj(condArgs[1]);
      const number = literal?.type === "Literal" && ["UInt64", "Int64"].includes(String(literal.value_type)) && typeof literal.value === "string" && /^-?\d+$/u.test(literal.value) ? Number(literal.value) : NaN;
      const operators: Record<string, string> = { equals: "=", notequals: "!=", less: "<", lessorequals: "<=", greater: ">", greaterorequals: ">=" };
      if (field && Number.isSafeInteger(number)) translated = { type: "binary_expr", operator: operators[op], left: field, right: { type: "number", value: number } };
      if (field && ["equals", "notequals"].includes(op) && literal?.type === "Literal" && literal.value_type === "String" && typeof literal.value === "string" && literal.value.length <= 256) translated = { type: "binary_expr", operator: operators[op], left: field, right: { type: "single_quote_string", value: literal.value } };
    }
    if (!translated) return null;
    columns.push({ as, expr: { type: "function", name: { name: [{ value: "countif" }] }, args: { type: "expr_list", value: [translated] } } });
  }
  const groups = Array.isArray(q.group_by) ? q.group_by.map(column) : [];
  if (groups.some((value) => !value) || q.group_by && !Array.isArray(q.group_by)) return null;
  return { columns, from: [{ table: tableName, as: typeof table.alias === "string" ? table.alias : null }], ...(q.group_by ? { groupby: { columns: groups } } : {}) };
}
