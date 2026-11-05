import { format, parse } from "@clickhouse/parser";
import type { DataContract } from "./types.js";

const obj = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const ident = (value: unknown): value is string => typeof value === "string" && /^[a-z_][a-z0-9_]*$/u.test(value) && !["__proto__", "prototype", "constructor"].includes(value);

/** Build an internal proof projection for a chain of one-to-one projections
 * over a single physical grouped SUM or COUNT. The query actually sent to ClickHouse
 * remains the original. Both SQL forms must be independently authorized. */
export function clickHouseAggregateProjection(sql: string, contract: DataContract): string | null {
  if (!contract.series || !contract.grain?.length) return null;
  let statements: unknown[]; try { statements = parse(sql, { locations: false }); } catch { return null; }
  const root = obj(statements[0]); const branches = root?.selects;
  if (statements.length !== 1 || root?.type !== "SelectWithUnionQuery" || !Array.isArray(branches) || branches.length !== 1) return null;
  const outer = obj(branches[0]); const elements = obj(outer?.from)?.children;
  if (!outer || outer.type !== "SelectQuery" || outer.where || outer.prewhere || outer.having || outer.limit || outer.limit_by || outer.distinct || outer.qualify || outer.order_by || outer.group_by || !Array.isArray(outer.select) || !Array.isArray(elements) || elements.length !== 1) return null;
  const expression = obj(obj(elements[0])?.table_expression); const table = obj(expression?.database_and_table_name); const subquery = obj(expression?.subquery);
  if (!expression || obj(elements[0])?.table_join || obj(elements[0])?.array_join || expression.table_function || expression.final || expression.sample_size || expression.sample_offset) return null;
  const queryOf = (value: unknown): Record<string, unknown> | null => {
    const node = obj(value); return node?.type === "SelectWithUnionQuery" && Array.isArray(node.selects) && node.selects.length === 1 ? obj(node.selects[0]) : null;
  };
  let base: Record<string, unknown> | null = null; let outerAlias: string;
  const wrappers: Array<{ query: Record<string, unknown>; alias: string }> = [];
  if (Array.isArray(outer.with) && outer.with.length >= 1 && outer.with.length <= 8 && table && !subquery && !table.database) {
    const entries = outer.with.map(obj);
    if (entries.some((item) => item?.type !== "WithElement" || !ident(item.name) || item.aliases || item.name === contract.table) || new Set(entries.map((item) => item!.name)).size !== entries.length || entries.at(-1)?.name !== table.name || !ident(table.alias ?? table.name)) return null;
    base = queryOf(obj(entries[0]!.subquery)?.query); outerAlias = String(table.alias ?? table.name);
    for (let index = 1; index < entries.length; index++) {
      const query = queryOf(obj(entries[index]!.subquery)?.query); const children = obj(query?.from)?.children;
      if (!query || !Array.isArray(children) || children.length !== 1) return null;
      const element = obj(children[0]); const expr = obj(element?.table_expression); const previous = obj(expr?.database_and_table_name);
      if (!element || element.table_join || element.array_join || !expr || expr.subquery || expr.table_function || expr.final || expr.sample_size || expr.sample_offset || !previous || previous.database || previous.name !== entries[index - 1]!.name || !ident(previous.alias ?? previous.name)) return null;
      wrappers.push({ query, alias: String(previous.alias ?? previous.name) });
    }
  } else if (!outer.with && subquery && !table && ident(subquery.alias)) {
    base = queryOf(subquery.query); outerAlias = subquery.alias;
    while (base && wrappers.length < 8) {
      const children = obj(base.from)?.children; if (!Array.isArray(children) || children.length !== 1) break;
      const element = obj(children[0]); const expr = obj(element?.table_expression); const nested = obj(expr?.subquery);
      if (!nested) break;
      if (!element || element.table_join || element.array_join || !expr || expr.database_and_table_name || expr.table_function || expr.final || expr.sample_size || expr.sample_offset || !ident(nested.alias)) return null;
      wrappers.push({ query: base, alias: nested.alias }); base = queryOf(nested.query);
    }
    wrappers.reverse();
  } else return null;
  if (!base || base.type !== "SelectQuery" || base.with || base.prewhere || !base.where || base.having || base.limit || base.limit_by || base.distinct || base.qualify || base.order_by || base.group_by_all || base.group_by_grouping_sets || base.group_by_with_totals || base.group_by_with_rollup || base.group_by_with_cube || !Array.isArray(base.select)) return null;
  const children = obj(base.from)?.children; if (!Array.isArray(children) || children.length !== 1) return null;
  const element = obj(children[0]); const innerExpr = obj(element?.table_expression); const physical = obj(innerExpr?.database_and_table_name);
  if (!element || element.table_join || element.array_join || !innerExpr || innerExpr.subquery || innerExpr.table_function || innerExpr.final || innerExpr.sample_size || innerExpr.sample_offset || !physical || physical.database || physical.name !== contract.table || !ident(physical.alias ?? physical.name)) return null;
  const innerAlias = String(physical.alias ?? physical.name);
  const field = (value: unknown, alias: string): string | null => {
    const node = obj(value); if (node?.type !== "Identifier" || typeof node.name !== "string") return null;
    const parts = Array.isArray(node.name_parts) ? node.name_parts : node.name.split(".");
    return parts.length === 1 && ident(parts[0]) ? parts[0] : parts.length === 2 && parts[0] === alias && ident(parts[1]) ? parts[1] : null;
  };
  const groups = (Array.isArray(base.group_by) ? base.group_by : []).map((item) => obj(item)?.alias === undefined ? field(item, innerAlias) : null);
  if (groups.some((name) => !name || !contract.grain!.includes(name)) || new Set(groups).size !== groups.length) return null;
  const referenced = new Set<string>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(collect); return; }
    const node = obj(value); if (!node) return;
    if (node.type === "Identifier" && typeof node.name === "string") {
      const parts = Array.isArray(node.name_parts) ? node.name_parts : node.name.split(".");
      if (typeof parts.at(-1) === "string") referenced.add(parts.at(-1) as string);
    }
    for (const [key, child] of Object.entries(node)) if (key !== "location" && key !== "parent") collect(child);
  };
  collect(base.where); collect(base.group_by);
  type Item = { kind: "key" | "metric"; field: string; expression: Record<string, unknown> };
  let outputs = new Map<string, Item>();
  for (const raw of base.select) {
    const node = obj(raw); if (!node) return null;
    const direct = field(node, innerAlias); const name = node.alias ?? direct;
    if (!ident(name) || outputs.has(name) || name !== direct && referenced.has(name) || contract.columns.some((column) => column.name === name) && name !== direct) return null;
    if (direct) { if (!groups.includes(direct)) return null; outputs.set(name, { kind: "key", field: direct, expression: structuredClone(node) }); continue; }
    if (node.type !== "Function" || !["sum", "count"].includes(String(node.name).toLowerCase()) || node.is_window_function || node.window_definition || node.parameters || !Array.isArray(node.arguments)) return null;
    const star = node.arguments.length === 1 ? obj(node.arguments[0]) : null;
    if (String(node.name).toLowerCase() === "count" && (node.arguments.length === 0 || star?.type === "Asterisk" && (!star.transformers || Array.isArray(star.transformers) && !star.transformers.length))) {
      outputs.set(name, { kind: "metric", field: "*", expression: structuredClone(node) }); continue;
    }
    if (node.arguments.length !== 1) return null;
    const metric = field(node.arguments[0], innerAlias); if (!metric || !contract.series.metrics.includes(metric)) return null;
    outputs.set(name, { kind: "metric", field: metric, expression: structuredClone(node) });
  }
  if (![...outputs.values()].some((item) => item.kind === "metric") || [...outputs.values()].filter((item) => item.kind === "key").length !== groups.length || groups.some((group) => ![...outputs.values()].some((item) => item.kind === "key" && item.field === group))) return null;
  for (const wrapper of wrappers) {
    const query = wrapper.query;
    if (query.type !== "SelectQuery" || query.with || query.where || query.prewhere || query.having || query.limit || query.limit_by || query.distinct || query.qualify || query.order_by || query.group_by || !Array.isArray(query.select)) return null;
    const next = new Map<string, Item>(); const used = new Set<string>();
    for (const raw of query.select) {
      const node = obj(raw); const input = field(node, wrapper.alias); const output = node?.alias ?? input;
      if (!input || !ident(output) || used.has(input) || next.has(output) || !outputs.has(input) || output !== input && outputs.has(output) || contract.columns.some((column) => column.name === output) && output !== outputs.get(input)!.field) return null;
      used.add(input); next.set(output, outputs.get(input)!);
    }
    if (used.size !== outputs.size) return null;
    outputs = next;
  }
  const selections: Record<string, unknown>[] = []; const used = new Set<string>(); const usedInputs = new Set<string>(); const selectedKeys = new Set<string>();
  for (const raw of outer.select) {
    const node = obj(raw); const input = field(node, outerAlias); const name = node?.alias ?? input; const item = input && outputs.get(input);
    if (!input || !item || !ident(name) || used.has(name) || usedInputs.has(input) || name !== input && outputs.has(name) || contract.columns.some((column) => column.name === name) && name !== item.field) return null;
    used.add(name); usedInputs.add(input); if (item.kind === "key") selectedKeys.add(item.field);
    const selection = structuredClone(item.expression); selection.alias = name; selections.push(selection);
  }
  if (!selections.length || groups.some((group) => !selectedKeys.has(group!)) || !outer.select.some((raw) => { const key = field(raw, outerAlias); return key && outputs.get(key)?.kind === "metric"; })) return null;
  const proof = structuredClone(base); proof.select = selections;
  try { return format([{ type: "SelectWithUnionQuery", selects: [proof] }] as Parameters<typeof format>[0]); } catch { return null; }
}
