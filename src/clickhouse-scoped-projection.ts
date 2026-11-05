import { format, parse } from "@clickhouse/parser";

const obj = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Prove equivalence for a chain of direct projections over one physical
 * table. The generated SQL is used solely to analyze evidence; the original
 * statement is still the one sent to ClickHouse. Any filter, LIMIT, alias
 * collision, join or expression inside a wrapper fails closed. */
export function clickHouseScopedProjection(sql: string, tableName: string): string | null {
  let statements: unknown[]; try { statements = parse(sql, { locations: false }); } catch { return null; }
  const root = obj(statements[0]); const branches = root?.selects;
  if (statements.length !== 1 || root?.type !== "SelectWithUnionQuery" || !Array.isArray(branches) || branches.length !== 1) return null;
  const final = obj(branches[0]); if (!final || final.type !== "SelectQuery" || final.prewhere || final.having || final.limit || final.limit_by || final.distinct || final.qualify || final.group_by_all || final.group_by_grouping_sets || final.group_by_with_totals || final.group_by_with_rollup || final.group_by_with_cube || final.interpolate || Array.isArray(final.order_by) && final.order_by.some((item) => Boolean(obj(item)?.with_fill)) || !Array.isArray(final.select)) return null;
  type Source = { base: Record<string, unknown>; available: Map<string, string>; physical: Set<string>; depth: number };
  const resolve = (query: Record<string, unknown>, depth: number): Source | null => {
    if (depth > 12 || query.type !== "SelectQuery" || query.distinct || query.having || query.limit || query.limit_by || query.qualify || query.group_by || query.order_by || !Array.isArray(query.select)) return null;
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
      // Aliases visible in a ClickHouse WHERE can substitute for physical
      // fields. Never remove or lift such an alias into a different scope.
      if (!query.select.length) return null;
      const physical = new Set<string>(); const filtered = new Set<string>();
      const collect = (value: unknown): void => {
        if (Array.isArray(value)) { value.forEach(collect); return; }
        const node = obj(value); if (!node) return;
        if (node.type === "Identifier" && typeof node.name === "string") filtered.add(node.name);
        Object.values(node).forEach(collect);
      };
      collect(query.where); collect(query.prewhere);
      const items: Array<{ name: string; output: string }> = [];
      for (const raw of query.select) {
        const node = obj(raw); const parts = node && typeof node.name === "string" ? (Array.isArray(node.name_parts) ? node.name_parts : node.name.split(".")) : [];
        if (node?.type !== "Identifier" || parts.length !== 1 || typeof parts[0] !== "string") return null;
        const name = parts[0]; const output = node.alias === undefined ? name : node.alias;
        if (typeof output !== "string" || !output) return null;
        physical.add(name); items.push({ name, output });
      }
      filtered.forEach((field) => physical.add(field));
      const available = new Map<string, string>();
      for (const { name, output } of items) {
        if (available.has(output) || output !== name && physical.has(output)) return null;
        available.set(output, name);
      }
      return { base: query, available, physical, depth };
    } else if (table && !table.database && Array.isArray(query.with) && query.with.length === 1) {
      const entry = obj(query.with[0]); const source = obj(entry?.subquery); const node = obj(source?.query); const list = node?.selects;
      if (entry?.type !== "WithElement" || entry.name !== table.name || entry.aliases || node?.type !== "SelectWithUnionQuery" || !Array.isArray(list) || list.length !== 1) return null;
      nested = obj(list[0]);
    } else return null;
    if (query.where || query.prewhere || !nested) return null;
    const source = resolve(nested, depth + 1);
    if (!source) return null;
    const fields = new Map<string, string>();
    for (const raw of query.select) {
      const node = obj(raw); const parts = node && typeof node.name === "string" ? (Array.isArray(node.name_parts) ? node.name_parts : node.name.split(".")) : [];
      if (node?.type !== "Identifier" || parts.length !== 1 || typeof parts[0] !== "string") return null;
      const name = parts[0]; const output = node.alias === undefined ? name : node.alias;
      const physical = source.available.get(name);
      if (typeof output !== "string" || !output || !physical || fields.has(output) || output !== name && (source.available.has(output) || source.physical.has(output))) return null;
      fields.set(output, physical);
    }
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
  const qualifier = subquery ? subquery.alias : table?.alias ?? table?.name;
  const rewrite = (value: unknown, topLevel = false): boolean => {
    if (Array.isArray(value)) return value.every((child) => rewrite(child, topLevel));
    const node = obj(value); if (!node) return true;
    if (node.type === "Subquery" || node.is_window_function || node.window_definition || node.parameters) return false;
    if (node.type === "Identifier") {
      const parts = typeof node.name === "string" ? (Array.isArray(node.name_parts) ? node.name_parts : node.name.split(".")) : [];
      if (parts.length < 1 || parts.length > 2 || typeof parts.at(-1) !== "string" || parts.length === 2 && (typeof qualifier !== "string" || parts[0] !== qualifier)) return false;
      const original = parts.at(-1) as string; const physical = source.available.get(original);
      if (!physical) return false;
      if (node.alias !== undefined && (typeof node.alias !== "string" || node.alias !== original && node.alias !== physical && (source.available.has(node.alias) || source.physical.has(node.alias)))) return false;
      node.name = physical;
      if (Array.isArray(node.name_parts)) node.name_parts = [physical];
      if (topLevel && physical !== original && node.alias === undefined) node.alias = original;
      return true;
    }
    if (typeof node.alias === "string" && (source.available.has(node.alias) || source.physical.has(node.alias))) return false;
    return Object.entries(node).every(([key, child]) => key === "alias" || key === "location" || key === "parent" || rewrite(child));
  };
  const selection = structuredClone(final.select); const grouping = structuredClone(final.group_by);
  if (!rewrite(selection, true) || grouping && !rewrite(grouping)) return null;
  const base = structuredClone(source.base); base.select = selection;
  if (grouping) base.group_by = grouping;
  else delete base.group_by;
  if (final.where) {
    const outer = structuredClone(final.where);
    if (!rewrite(outer)) return null;
    const equalities = (value: unknown): Array<{ field: string; literal: string; expression: Record<string, unknown> }> | null => {
      const node = obj(value); if (node?.type !== "Function" || !Array.isArray(node.arguments)) return null;
      if (String(node.name).toLowerCase() === "and") {
        const parts = node.arguments.map(equalities); return parts.every((part) => part) ? parts.flatMap((part) => part!) : null;
      }
      const [left, right] = node.arguments.map(obj);
      if (String(node.name).toLowerCase() !== "equals" || node.arguments.length !== 2 || left?.type !== "Identifier" || typeof left.name !== "string" || left.name.includes(".") || right?.type !== "Literal" || right.value_type !== "String" || typeof right.value !== "string") return null;
      return [{ field: left.name, literal: right.value, expression: node }];
    };
    const additions = equalities(outer); if (!additions?.length) return null;
    // A duplicate equality may be omitted, but a conflicting constraint must
    // never be silently discarded. Other base predicates remain untouched.
    const existing: Record<string, string> = Object.create(null) as Record<string, string>;
    const collect = (value: unknown): void => {
      const node = obj(value); if (!node || node.type !== "Function" || !Array.isArray(node.arguments)) return;
      if (String(node.name).toLowerCase() === "and") { node.arguments.forEach(collect); return; }
      const item = equalities(node); if (item?.length === 1) existing[item[0]!.field] = item[0]!.literal;
    };
    collect(base.where); collect(base.prewhere);
    const append: Record<string, unknown>[] = [];
    for (const item of additions) {
      if (Object.hasOwn(existing, item.field)) { if (existing[item.field] !== item.literal) return null; continue; }
      existing[item.field] = item.literal; append.push(item.expression);
    }
    if (append.length) base.where = { type: "Function", name: "and", arguments: [...(base.where ? [base.where] : []), ...append], is_operator: true };
  }
  try { return format([{ type: "SelectWithUnionQuery", selects: [base] }] as Parameters<typeof format>[0]); } catch { return null; }
}
