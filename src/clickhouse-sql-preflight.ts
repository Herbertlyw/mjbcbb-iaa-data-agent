import { parse } from "@clickhouse/parser";

/** A second, ClickHouse-grammar gate. It does not grant authorization: the
 * caller must still run the contract/field/partition/JOIN checks and only use
 * results whose lineage can be verified. */
export type ClickHousePreflight = { ok: true; tables: string[]; identifiers: string[]; functions: string[] } | { ok: false; code: string };

const obj = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const identifier = /^[a-z_][a-z0-9_]*$/u;
const forbiddenFunctions = new Set(["sleep", "sleepeachrow", "url", "s3", "s3cluster", "remote", "remotesecure", "file", "mysql", "postgresql", "executable", "executablepool", "dictget", "getsetting", "currentuser"]);

export function preflightClickHouseSql(sql: string): ClickHousePreflight {
  let statements: unknown;
  try { statements = parse(sql, { locations: false }); } catch { return { ok: false, code: "clickhouse_parse_failed" }; }
  if (!Array.isArray(statements) || statements.length !== 1) return { ok: false, code: "multiple_statements" };
  const root = obj(statements[0]);
  if (root?.type !== "SelectWithUnionQuery") return { ok: false, code: "write_statement" };
  const pending: unknown[] = [root]; let nodes = 0; const identifiers = new Set<string>(); const functions = new Set<string>();
  while (pending.length) {
    const item = pending.pop();
    if (++nodes > 20_000) return { ok: false, code: "sql_complexity_limit" };
    if (Array.isArray(item)) { pending.push(...item); continue; }
    const node = obj(item); if (!node) continue;
    if (node.type === "Identifier") {
      const parts = Array.isArray(node.name_parts) ? node.name_parts : [node.name];
      if (!parts.length || parts.length > 2 || parts.some((part) => typeof part !== "string" || !identifier.test(part.toLowerCase()))) return { ok: false, code: "clickhouse_identifier_unsupported" };
      identifiers.add(parts.map((part) => String(part).toLowerCase()).join("."));
    }
    if (node.type === "TableExpression" && node.table_function) return { ok: false, code: "dangerous_table" };
    if (node.type === "QueryParameter") return { ok: false, code: "query_parameter_unsupported" };
    if (node.type === "Function" && (node.is_lambda_function || forbiddenFunctions.has(String(node.name ?? "").toLowerCase()))) return { ok: false, code: "dangerous_function" };
    // The ClickHouse parser represents infix operators as Functions too;
    // only named calls participate in the independent parser comparison.
    if (node.type === "Function" && node.is_operator !== true) {
      if (typeof node.name !== "string" || !identifier.test(node.name.toLowerCase())) return { ok: false, code: "clickhouse_function_unsupported" };
      functions.add(node.name.toLowerCase());
    }
    if ((node.type === "SelectWithUnionQuery" || node.type === "SelectIntersectExceptQuery") && (node.out_file || node.outfile_truncate || node.settings || node.format)) return { ok: false, code: "query_output_options_forbidden" };
    if (node.type === "SelectQuery" && (node.settings || node.format || node.out_file || node.recursive_with)) return { ok: false, code: "query_output_options_forbidden" };
    for (const [name, child] of Object.entries(node)) if (name !== "location" && name !== "parent") pending.push(child);
  }

  const physical = new Set<string>();
  const query = (value: unknown, inherited: ReadonlySet<string>, depth: number): boolean => {
    if (depth > 64) return false;
    const node = obj(value);
    if (!node || node.type !== "SelectWithUnionQuery" || !Array.isArray(node.selects) || !node.selects.length || node.selects.length > 8) return false;
    for (const rawBranch of node.selects) {
      const branch = obj(rawBranch);
      if (!branch || branch.type !== "SelectQuery" || branch.recursive_with) return false;
      const scope = new Set(inherited);
      for (const item of Array.isArray(branch.with) ? branch.with : []) {
        const entry = obj(item); const subquery = obj(entry?.subquery); const name = String(entry?.name ?? "").toLowerCase();
        if (entry?.type !== "WithElement" || entry.aliases || !identifier.test(name) || scope.has(name) || !query(subquery?.query, scope, depth + 1)) return false;
        scope.add(name);
      }
      const from = obj(branch.from);
      const elements = Array.isArray(from?.children) ? from.children : [];
      for (const item of elements) {
        const element = obj(item); const expression = obj(element?.table_expression);
        if (!expression || element?.array_join || expression.table_function) return false;
        const table = obj(expression.database_and_table_name); const subquery = obj(expression.subquery);
        if (table) {
          const name = typeof table.name === "string" ? table.name.toLowerCase() : "";
          if (!identifier.test(name) || table.database) return false;
          if (!scope.has(name)) physical.add(name);
        } else if (subquery) {
          if (!query(subquery.query, scope, depth + 1)) return false;
        } else return false;
      }
      const nested = (value: unknown): boolean => {
        if (Array.isArray(value)) return value.every(nested);
        const part = obj(value); if (!part) return true;
        if (part.type === "Subquery") return query(part.query, scope, depth + 1);
        return Object.entries(part).every(([name, child]) => name === "location" || name === "parent" || nested(child));
      };
      for (const [name, child] of Object.entries(branch)) {
        if (name !== "with" && name !== "from" && name !== "location" && name !== "parent" && !nested(child)) return false;
      }
      // JOIN ON/USING can themselves contain subqueries. They are not part of
      // table_expression, so independently inspect them in the local scope.
      for (const item of elements) if (!nested(obj(item)?.table_join)) return false;
    }
    return true;
  };
  if (!query(root, new Set(), 0) || !physical.size) return { ok: false, code: "clickhouse_source_unsupported" };
  return { ok: true, tables: [...physical], identifiers: [...identifiers], functions: [...functions] };
}

export interface ClickHouseDirectRule { table: string; allowed_columns: string[]; sensitive_columns: string[] }
export type ClickHouseDirectAuthorization = { applicable: false } | { applicable: true; ok: true; table: string; columns: string[] } | { applicable: true; ok: false; code: string };

/** Independently bind physical fields in a single-relation ClickHouse AST.
 * Complex scopes continue through the existing full policy; this function is
 * an additional authorization boundary, not permission to skip that policy. */
export function authorizeClickHouseDirect(sql: string, rules: readonly ClickHouseDirectRule[]): ClickHouseDirectAuthorization {
  let statements: unknown;
  try { statements = parse(sql, { locations: false }); } catch { return { applicable: false }; }
  if (!Array.isArray(statements) || statements.length !== 1) return { applicable: false };
  const root = obj(statements[0]);
  if (root?.type !== "SelectWithUnionQuery" || !Array.isArray(root.selects) || root.selects.length !== 1) return { applicable: false };
  const select = obj(root.selects[0]);
  const from = obj(select?.from);
  if (!select || select.type !== "SelectQuery" || (Array.isArray(select.with) && select.with.length) || !Array.isArray(from?.children) || from.children.length !== 1) return { applicable: false };
  const element = obj(from.children[0]);
  const expression = obj(element?.table_expression);
  const table = obj(expression?.database_and_table_name);
  if (!table || table.type !== "TableIdentifier" || table.database || expression?.subquery || expression?.table_function || element?.array_join || element?.table_join) return { applicable: false };
  const name = typeof table.name === "string" ? table.name : "";
  const rule = rules.find((item) => item.table === name);
  if (!rule) return { applicable: true, ok: false, code: "unknown_table" };
  const alias = typeof table.alias === "string" ? table.alias : name;
  const selections = Array.isArray(select.select) ? select.select : [];
  const aliases = new Set(selections.map((item) => obj(item)?.alias).filter((value): value is string => typeof value === "string"));
  const columns = new Set<string>();
  let visited = 0;
  const visit = (value: unknown, allowAlias: boolean): string | null => {
    if (++visited > 20000) return "sql_complexity_limit";
    if (Array.isArray(value)) { for (const item of value) { const error = visit(item, allowAlias); if (error) return error; } return null; }
    const node = obj(value); if (!node) return null;
    if (node.type === "Subquery" || node.type === "SelectWithUnionQuery" || node.type === "SelectQuery") return "clickhouse_scope_unsupported";
    if (node.type === "Identifier") {
      const parts = Array.isArray(node.name_parts) ? node.name_parts : [node.name];
      if (!parts.every((part) => typeof part === "string") || parts.length < 1 || parts.length > 2) return "clickhouse_identifier_unsupported";
      const field = String(parts.at(-1));
      if (parts.length === 2 && parts[0] !== alias && parts[0] !== name) return "column_not_in_contract";
      if (rule.sensitive_columns.includes(field)) return "sensitive_field";
      if (parts.length === 1 && allowAlias && aliases.has(field)) return null;
      if (!rule.allowed_columns.includes(field)) return "column_not_in_contract";
      columns.add(field);
      return null;
    }
    for (const [key, child] of Object.entries(node)) {
      if (["alias", "location", "parent"].includes(key)) continue;
      const error = visit(child, allowAlias); if (error) return error;
    }
    return null;
  };
  for (const [key, value] of Object.entries(select)) {
    if (["type", "from", "with", "location", "parent"].includes(key)) continue;
    const error = visit(value, key === "order_by" || key === "group_by");
    // Nested SELECTs use the established recursive policy instead.
    if (error === "clickhouse_scope_unsupported") return { applicable: false };
    if (error) return { applicable: true, ok: false, code: error };
  }
  return { applicable: true, ok: true, table: name, columns: [...columns] };
}
