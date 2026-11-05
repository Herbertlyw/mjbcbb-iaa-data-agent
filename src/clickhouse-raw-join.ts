import { parse } from "@clickhouse/parser";
import type { DataContract, JoinConstraint } from "./types.js";
import { clickHouseScanRange } from "./clickhouse-scan-range.js";

const obj = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const ident = /^[a-z_][a-z0-9_]*$/u;

/** Additional physical JOIN and grain checks for a bounded detail query.
 * The caller must independently review all columns, functions and grants.
 * This authorizes a read only; it does not certify JOIN result evidence or
 * dimension uniqueness and must not replace a captured JOIN proof. */
export function clickHouseRawDimensionJoin(sql: string, fact: DataContract, dimension: DataContract, joins: readonly JoinConstraint[]): { start: string; end: string } | null {
  if (!fact.series || dimension.series || !fact.grain?.length || !dimension.grain?.length) return null;
  let statements: unknown[]; try { statements = parse(sql, { locations: false }); } catch { return null; }
  const root = obj(statements[0]);
  if (statements.length !== 1 || root?.type !== "SelectWithUnionQuery" || !Array.isArray(root.selects) || root.selects.length !== 1) return null;
  const query = obj(root.selects[0]);
  if (!query || query.type !== "SelectQuery" || query.with || query.prewhere || query.group_by || query.having || query.limit || query.limit_by || query.distinct || query.qualify || query.array_join || !Array.isArray(query.select) || !query.select.length) return null;
  if (query.select.some((entry) => obj(entry)?.type !== "Identifier")) return null;
  const children = obj(query.from)?.children; if (!Array.isArray(children) || children.length !== 2) return null;
  const first = obj(children[0]); const second = obj(children[1]);
  const firstExpression = obj(first?.table_expression); const secondExpression = obj(second?.table_expression);
  const left = obj(firstExpression?.database_and_table_name); const right = obj(secondExpression?.database_and_table_name); const join = obj(second?.table_join);
  if (!first || !second || first.table_join || first.array_join || second.array_join || !firstExpression || !secondExpression || firstExpression.subquery || secondExpression.subquery || firstExpression.table_function || secondExpression.table_function || firstExpression.final || secondExpression.final || firstExpression.sample_size || secondExpression.sample_size || firstExpression.sample_offset || secondExpression.sample_offset || !left || !right || left.database || right.database || left.name !== fact.table || right.name !== dimension.table || !join || !["INNER", "LEFT"].includes(String(join.kind)) || Object.keys(join).some((key) => !["type", "kind", "on"].includes(key)) || !join.on) return null;
  const a = String(left.alias ?? left.name); const b = String(right.alias ?? right.name);
  if (!ident.test(a) || !ident.test(b) || a === b) return null;
  const relation = joins.find((item) => item.tables.length === 2 && item.tables.includes(fact.table) && item.tables.includes(dimension.table));
  if (!relation?.keys.length || new Set(relation.keys).size !== relation.keys.length || [...relation.keys].sort().join("|") !== [...dimension.grain].sort().join("|") || relation.keys.some((key) => !fact.grain!.includes(key) || !fact.series!.dimensions.includes(key))) return null;
  const keys: string[] = [];
  const field = (value: unknown): string[] | null => {
    const node = obj(value); if (node?.type !== "Identifier" || node.alias !== undefined || typeof node.name !== "string") return null;
    const parts = Array.isArray(node.name_parts) ? node.name_parts : node.name.split(".");
    return parts.length === 2 && parts.every((part) => typeof part === "string" && ident.test(part)) ? parts as string[] : null;
  };
  const condition = (value: unknown): boolean => {
    const node = obj(value); if (node?.type !== "Function" || !Array.isArray(node.arguments)) return false;
    const name = String(node.name).toLowerCase();
    if (name === "and") return node.arguments.length >= 2 && node.arguments.every(condition);
    if (name !== "equals" || node.arguments.length !== 2) return false;
    const x = field(node.arguments[0]); const y = field(node.arguments[1]);
    if (!x || !y || x[1] !== y[1] || ![`${a}|${b}`, `${b}|${a}`].includes(`${x[0]}|${y[0]}`) || keys.includes(x[1]!)) return false;
    keys.push(x[1]!); return true;
  };
  if (!condition(join.on) || [...keys].sort().join("|") !== [...relation.keys].sort().join("|")) return null;
  return clickHouseScanRange(sql, fact, dimension.table);
}
