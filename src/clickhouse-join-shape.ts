import { parse } from "@clickhouse/parser";
import { isCalendarDate } from "./config.js";
import type { DataContract, JoinConstraint } from "./types.js";

const obj = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const identifier = /^[a-z_][a-z0-9_]*$/u;

/** Translate a strictly bounded physical fact/dimension JOIN from CK AST to
 * the existing proof planner's shape. This does not itself authorize SQL. */
export function clickHouseJoinShape(
  sql: string,
  fact: DataContract,
  dimension: DataContract,
  joins: JoinConstraint[],
): Record<string, unknown> | null {
  let statements: unknown[];
  try {
    statements = parse(sql, { locations: false });
  } catch {
    return null;
  }
  const root = obj(statements[0]);
  const branches = root?.selects;
  if (
    statements.length !== 1 ||
    root?.type !== "SelectWithUnionQuery" ||
    !Array.isArray(branches) ||
    branches.length !== 1
  )
    return null;
  const query = obj(branches[0]);
  if (
    !query ||
    query.type !== "SelectQuery" ||
    query.with ||
    query.prewhere ||
    query.distinct ||
    query.having ||
    query.limit ||
    query.limit_by ||
    query.qualify ||
    query.array_join ||
    query.group_by_all ||
    query.group_by_grouping_sets ||
    query.group_by_with_totals ||
    query.group_by_with_rollup ||
    query.group_by_with_cube ||
    query.interpolate ||
    !Array.isArray(query.select) ||
    (query.group_by !== undefined && !Array.isArray(query.group_by))
  )
    return null;
  const elements = obj(query.from)?.children;
  if (!Array.isArray(elements) || elements.length !== 2) return null;
  const left = obj(elements[0]);
  const right = obj(elements[1]);
  const leftExpr = obj(left?.table_expression);
  const rightExpr = obj(right?.table_expression);
  const a = obj(leftExpr?.database_and_table_name);
  const b = obj(rightExpr?.database_and_table_name);
  const join = obj(right?.table_join);
  if (
    !left ||
    !right ||
    left.table_join ||
    left.array_join ||
    right.array_join ||
    !leftExpr ||
    !rightExpr ||
    leftExpr.subquery ||
    rightExpr.subquery ||
    leftExpr.table_function ||
    rightExpr.table_function ||
    leftExpr.sample_size ||
    rightExpr.sample_size ||
    leftExpr.sample_offset ||
    rightExpr.sample_offset ||
    leftExpr.final ||
    rightExpr.final ||
    !a ||
    !b ||
    a.database ||
    b.database ||
    a.name !== fact.table ||
    b.name !== dimension.table ||
    !join ||
    !["INNER", "LEFT"].includes(String(join.kind)) ||
    Object.keys(join).some((key) => !["type", "kind", "on"].includes(key)) ||
    !join.on
  )
    return null;
  const fa = String(a.alias ?? a.name);
  const da = String(b.alias ?? b.name);
  if (!identifier.test(fa) || !identifier.test(da) || fa === da) return null;
  const relation = joins.find(
    (item) =>
      item.tables.length === 2 &&
      item.tables.includes(fact.table) &&
      item.tables.includes(dimension.table),
  );
  if (
    !relation ||
    !relation.keys.length ||
    !dimension.grain ||
    [...relation.keys].sort().join("|") !==
      [...dimension.grain].sort().join("|") ||
    !fact.series ||
    relation.keys.some((key) => !fact.series!.dimensions.includes(key))
  )
    return null;
  const column = (
    value: unknown,
    allowAlias = false,
  ): Record<string, unknown> | null => {
    const node = obj(value);
    if (node?.type !== "Identifier" || typeof node.name !== "string")
      return null;
    if (!allowAlias && node.alias !== undefined) return null;
    const parts = Array.isArray(node.name_parts)
      ? node.name_parts
      : node.name.split(".");
    if (
      parts.length < 1 ||
      parts.length > 2 ||
      parts.some((part) => typeof part !== "string" || !identifier.test(part))
    )
      return null;
    return {
      type: "column_ref",
      table: parts.length === 2 ? parts[0] : null,
      column: parts.at(-1),
    };
  };
  const keys: string[] = [];
  const inspectJoin = (value: unknown): boolean => {
    const node = obj(value);
    if (node?.type !== "Function" || !Array.isArray(node.arguments))
      return false;
    if (String(node.name).toLowerCase() === "and")
      return node.arguments.length >= 2 && node.arguments.every(inspectJoin);
    if (
      String(node.name).toLowerCase() !== "equals" ||
      node.arguments.length !== 2
    )
      return false;
    const x = column(node.arguments[0]);
    const y = column(node.arguments[1]);
    if (
      !x ||
      !y ||
      x.column !== y.column ||
      ![`${fa}|${da}`, `${da}|${fa}`].includes(`${x.table}|${y.table}`) ||
      typeof x.column !== "string" ||
      keys.includes(x.column)
    )
      return false;
    keys.push(x.column);
    return true;
  };
  if (
    !inspectJoin(join.on) ||
    [...keys].sort().join("|") !== [...relation.keys].sort().join("|")
  )
    return null;
  const where = (value: unknown): Record<string, unknown> | null => {
    const node = obj(value);
    if (node?.type !== "Function" || !Array.isArray(node.arguments))
      return null;
    const name = String(node.name).toLowerCase();
    if (name === "and") {
      if (node.arguments.length < 2) return null;
      const parts = node.arguments.map(where);
      if (parts.some((item) => !item)) return null;
      return parts.slice(1).reduce<Record<string, unknown>>(
        (acc, part) => ({
          type: "binary_expr",
          operator: "AND",
          left: acc,
          right: part,
        }),
        parts[0]!,
      );
    }
    const operators: Record<string, string> = {
      equals: "=",
      greaterorequals: ">=",
      lessorequals: "<=",
    };
    const field = column(node.arguments[0]);
    let valueNode = obj(node.arguments[1]);
    if (
      valueNode?.type === "Function" &&
      String(valueNode.name).toLowerCase() === "todate" &&
      Array.isArray(valueNode.arguments) &&
      valueNode.arguments.length === 1
    ) {
      const literal = obj(valueNode.arguments[0]);
      if (
        literal?.type !== "Literal" ||
        literal.value_type !== "String" ||
        typeof literal.value !== "string" ||
        !isCalendarDate(literal.value)
      )
        return null;
      valueNode = literal;
    }
    if (
      !operators[name] ||
      node.arguments.length !== 2 ||
      !field ||
      !valueNode ||
      valueNode.type !== "Literal" ||
      valueNode.value_type !== "String" ||
      typeof valueNode.value !== "string"
    )
      return null;
    return {
      type: "binary_expr",
      operator: operators[name],
      left: field,
      right: { type: "single_quote_string", value: valueNode.value },
    };
  };
  const predicate = where(query.where);
  if (!predicate) return null;
  const columns: Array<Record<string, unknown>> = [];
  for (const value of query.select) {
    const node = obj(value);
    if (!node) return null;
    let expression = column(node, true);
    if (
      !expression &&
      node.type === "Function" &&
      String(node.name).toLowerCase() === "countif" &&
      !node.is_window_function &&
      !node.window_definition &&
      !node.parameters &&
      Array.isArray(node.arguments) &&
      node.arguments.length === 1
    ) {
      const predicate = obj(node.arguments[0]);
      if (
        predicate?.type === "Function" &&
        ["isnull", "isnotnull"].includes(
          String(predicate.name).toLowerCase(),
        ) &&
        Array.isArray(predicate.arguments) &&
        predicate.arguments.length === 1
      ) {
        const input = column(predicate.arguments[0]);
        if (input)
          expression = {
            type: "aggr_func",
            name:
              String(predicate.name).toLowerCase() === "isnull"
                ? "count_null"
                : "count",
            args: { expr: input },
          };
      }
      if (
        predicate?.type === "Function" &&
        String(predicate.name).toLowerCase() === "equals" &&
        Array.isArray(predicate.arguments) &&
        predicate.arguments.length === 2
      ) {
        const input = column(predicate.arguments[0]);
        const zero = obj(predicate.arguments[1]);
        if (
          input &&
          zero?.type === "Literal" &&
          ["UInt64", "Int64"].includes(String(zero.value_type)) &&
          (zero.value === 0 || zero.value === "0")
        )
          expression = {
            type: "aggr_func",
            name: "count_zero",
            args: { expr: input },
          };
      }
    }
    if (
      !expression &&
      node.type === "Function" &&
      String(node.name).toLowerCase() === "count" &&
      !node.is_window_function &&
      !node.window_definition &&
      !node.parameters &&
      Array.isArray(node.arguments) &&
      (node.arguments.length === 0 ||
        (node.arguments.length === 1 &&
          obj(node.arguments[0])?.type === "Asterisk"))
    ) {
      expression = { type: "aggr_func", name: "count_rows", args: {} };
    }
    if (
      !expression &&
      node.type === "Function" &&
      ["sum", "count"].includes(String(node.name).toLowerCase()) &&
      !node.is_window_function &&
      !node.window_definition &&
      !node.parameters &&
      Array.isArray(node.arguments) &&
      node.arguments.length === 1
    ) {
      const input = column(node.arguments[0]);
      if (input)
        expression = {
          type: "aggr_func",
          name: String(node.name).toLowerCase(),
          args: { expr: input },
        };
    }
    if (
      !expression ||
      (node.alias !== undefined && typeof node.alias !== "string")
    )
      return null;
    columns.push({ expr: expression, as: node.alias ?? null });
  }
  const grouped = (Array.isArray(query.group_by) ? query.group_by : []).map(
    (value) => column(value),
  );
  if (grouped.some((value) => !value)) return null;
  const order: Array<Record<string, unknown>> = [];
  if (query.order_by !== undefined) {
    if (!Array.isArray(query.order_by)) return null;
    for (const value of query.order_by) {
      const item = obj(value);
      const field = column(item?.expression);
      if (
        !item ||
        !field ||
        item.with_fill ||
        item.nulls_first ||
        item.nulls_last ||
        item.nulls_direction ||
        !["ASC", "DESC"].includes(String(item.direction ?? "ASC").toUpperCase())
      )
        return null;
      order.push({
        expr: field,
        type: String(item.direction ?? "ASC").toUpperCase(),
      });
    }
  }
  return {
    type: "select",
    from: [
      { table: fact.table, as: a.alias ?? null },
      {
        table: dimension.table,
        as: b.alias ?? null,
        join: `${join.kind} JOIN`,
      },
    ],
    columns,
    where: predicate,
    groupby: { columns: grouped },
    ...(order.length ? { orderby: order } : {}),
  };
}
