import { parse } from "@clickhouse/parser";

/** A second, ClickHouse-grammar gate. It does not grant authorization: the
 * caller must still run the contract/field/partition/JOIN checks and only use
 * results whose lineage can be verified. */
export type ClickHousePreflight = { ok: true; tables: string[]; identifiers: string[]; functions: string[] } | { ok: false; code: string };

/** Safe diagnostics contain policy guidance, never the submitted SQL. */
export function clickHousePreflightMessage(code: string): string {
  const messages: Record<string, string> = {
    clickhouse_parse_failed: "ClickHouse 无法解析该语法；请使用受支持的 SELECT、常量日期与简单表达式。",
    multiple_statements: "只允许一条只读 SELECT，不能提交多条语句。",
    write_statement: "只允许只读 SELECT，不允许修改数据或结构。",
    dangerous_table: "不允许表函数、外部数据源或系统表；请使用已授权的本地表。",
    dangerous_function: "查询含未批准的函数或 lambda；请改用契约字段和受支持函数。",
    query_parameter_unsupported: "当前查询工具不支持 SQL 参数占位符；请使用明确的合成字面量。",
    query_output_options_forbidden: "不允许查询自行指定 SETTINGS、FORMAT 或输出文件。",
    clickhouse_source_unsupported: "无法证明表来源或 CTE 作用域；请使用已绑定的本地表和明确的投影。",
    clickhouse_identifier_unsupported: "字段或表限定符无法安全解析；请使用契约列名和明确表别名。",
    clickhouse_function_unsupported: "无法安全核验函数名；请使用受支持的简单函数。",
    sql_complexity_limit: "SQL 语法树过大；请拆分为有界查询。",
  };
  return messages[code] ?? "ClickHouse 语法或来源无法安全核验；请检查已绑定契约和查询形状。";
}

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
    if (node.type === "TableIdentifier" && typeof node.database === "string" && ["system", "information_schema"].includes(node.database.toLowerCase())) return { ok: false, code: "dangerous_table" };
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

export interface ClickHouseDirectRule { table: string; allowed_columns: string[]; sensitive_columns: string[]; must_filter?: string[] }
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

export type ClickHouseScopedAuthorization =
  | { applicable: false }
  | { applicable: true; ok: false; code: string }
  | { applicable: true; ok: true; outputs: Record<string, string[]> };

/** Independent ClickHouse-AST field binding for bounded, single-source CTEs
 * and derived tables. This is an additional gate: it neither authorizes SQL
 * functions nor replaces the existing date, JOIN and resource policy. Unknown
 * shapes fall back to those policies; they are never granted by this binder. */
export function authorizeClickHouseScoped(sql: string, rules: readonly ClickHouseDirectRule[]): ClickHouseScopedAuthorization {
  let statements: unknown;
  try { statements = parse(sql, { locations: false }); } catch { return { applicable: false }; }
  if (!Array.isArray(statements) || statements.length !== 1) return { applicable: false };
  type Fields = Map<string, Set<string>>;
  type Relation = { fields: Fields; qualifier: string; physical: boolean; sensitive: Set<string> };
  class Unsupported extends Error {}
  class Denied extends Error {}
  let nested = false;
  let nodes = 0;
  const sourceRules = new Map(rules.map((rule) => [rule.table, rule]));
  const bind = (value: unknown, inherited: ReadonlyMap<string, Fields>, depth: number): Fields => {
    if (depth > 16) throw new Unsupported();
    const root = obj(value);
    if (root?.type !== "SelectWithUnionQuery" || !Array.isArray(root.selects) || root.selects.length !== 1) throw new Unsupported();
    const select = obj(root.selects[0]);
    if (!select || select.type !== "SelectQuery" || select.recursive_with) throw new Unsupported();
    const scope = new Map(inherited);
    for (const entry of Array.isArray(select.with) ? select.with : []) {
      nested = true;
      const item = obj(entry); const subquery = obj(item?.subquery);
      if (item?.type !== "WithElement" || typeof item.name !== "string" || !identifier.test(item.name) || item.aliases || scope.has(item.name)) throw new Unsupported();
      scope.set(item.name, bind(subquery?.query, scope, depth + 1));
    }
    const from = obj(select.from);
    if (!Array.isArray(from?.children) || from.children.length !== 1) throw new Unsupported();
    const element = obj(from.children[0]); const expression = obj(element?.table_expression);
    if (!expression || element?.array_join || element?.table_join || expression.table_function) throw new Unsupported();
    const table = obj(expression.database_and_table_name); const subquery = obj(expression.subquery);
    let relation: Relation;
    if (table && !table.database && typeof table.name === "string") {
      const name = table.name;
      const qualifier = typeof table.alias === "string" ? table.alias : name;
      const cte = scope.get(name);
      if (cte) relation = { fields: cte, qualifier, physical: false, sensitive: new Set() };
      else {
        const rule = sourceRules.get(name);
        if (!rule) throw new Denied("unknown_table");
        relation = { fields: new Map(rule.allowed_columns.map((field) => [field, new Set([`${name}.${field}`])])), qualifier, physical: true, sensitive: new Set(rule.sensitive_columns) };
      }
    } else if (subquery && typeof subquery.alias === "string") {
      nested = true;
      relation = { fields: bind(subquery.query, scope, depth + 1), qualifier: subquery.alias, physical: false, sensitive: new Set() };
    } else throw new Unsupported();
    const selections = Array.isArray(select.select) ? select.select : [];
    if (!selections.length) throw new Unsupported();
    const output: Fields = new Map();
    const expr = (value: unknown, refs: Set<string>, outputAliases?: Fields): void => {
      if (++nodes > 20_000) throw new Denied("sql_complexity_limit");
      if (Array.isArray(value)) { value.forEach((item) => expr(item, refs, outputAliases)); return; }
      const node = obj(value); if (!node) return;
      if (["Subquery", "SelectQuery", "SelectWithUnionQuery", "Asterisk", "QualifiedAsterisk"].includes(String(node.type))) throw new Unsupported();
      if (node.type === "Identifier") {
        const parts = Array.isArray(node.name_parts) ? node.name_parts : [node.name];
        if (parts.length < 1 || parts.length > 2 || !parts.every((part) => typeof part === "string")) throw new Unsupported();
        const field = String(parts.at(-1));
        if (parts.length === 2 && parts[0] !== relation.qualifier) throw new Denied("column_not_in_scope");
        if (relation.sensitive.has(field)) throw new Denied("sensitive_field");
        const lineage = relation.fields.get(field) ?? (parts.length === 1 ? outputAliases?.get(field) : undefined);
        if (!lineage) throw new Denied(relation.physical ? "column_not_in_contract" : "cte_column_not_projected");
        for (const ref of lineage) refs.add(ref);
        return;
      }
      for (const [key, child] of Object.entries(node)) if (!["alias", "location", "parent"].includes(key)) expr(child, refs, outputAliases);
    };
    for (const value of selections) {
      const item = obj(value); if (!item) throw new Unsupported();
      const refs = new Set<string>(); expr(item, refs);
      const parts = Array.isArray(item.name_parts) ? item.name_parts : [item.name];
      const name = typeof item.alias === "string" ? item.alias : item.type === "Identifier" && typeof parts.at(-1) === "string" ? String(parts.at(-1)) : "";
      if (!identifier.test(name) || output.has(name)) throw new Unsupported();
      output.set(name, refs);
    }
    for (const [key, value] of Object.entries(select)) {
      if (["type", "from", "with", "select", "location", "parent"].includes(key)) continue;
      expr(value, new Set(), key === "order_by" || key === "group_by" ? output : undefined);
    }
    return output;
  };
  try {
    const outputs = bind(statements[0], new Map(), 0);
    if (!nested) return { applicable: false };
    return { applicable: true, ok: true, outputs: Object.fromEntries([...outputs].map(([name, refs]) => [name, [...refs].sort()])) };
  } catch (error) {
    if (error instanceof Denied && nested) return { applicable: true, ok: false, code: error.message };
    return { applicable: false };
  }
}

export type ClickHouseJoinAuthorization =
  | { applicable: false }
  | { applicable: true; ok: false; code: string }
  | { applicable: true; ok: true; columns: string[] };

/** Adapt the original reviewer's source/column resolution to the local
 * unqualified table contracts. This independent ClickHouse-AST check covers
 * direct physical JOINs; registered keys, grain, scan bounds and the legacy
 * policy remain mandatory. Unsupported scopes never gain authorization here. */
export function authorizeClickHouseJoin(sql: string, rules: readonly ClickHouseDirectRule[]): ClickHouseJoinAuthorization {
  let statements: unknown;
  try { statements = parse(sql, { locations: false }); } catch { return { applicable: false }; }
  if (!Array.isArray(statements) || statements.length !== 1) return { applicable: false };
  const root = obj(statements[0]);
  if (root?.type !== "SelectWithUnionQuery" || !Array.isArray(root.selects) || root.selects.length !== 1) return { applicable: false };
  const select = obj(root.selects[0]); const from = obj(select?.from);
  if (!select || select.type !== "SelectQuery" || (Array.isArray(select.with) && select.with.length) || !Array.isArray(from?.children) || from.children.length < 2 || from.children.length > 8) return { applicable: false };
  type Source = { alias: string; table: string; allowed: Set<string>; sensitive: Set<string>; required: Set<string> };
  const sources: Source[] = [];
  for (const [index, value] of from.children.entries()) {
    const item = obj(value); const expression = obj(item?.table_expression); const table = obj(expression?.database_and_table_name); const join = obj(item?.table_join);
    if (!expression || !table || typeof table.name !== "string" || table.database || expression.subquery || expression.table_function || item?.array_join || index > 0 && (!join || !join.on || join.using)) return { applicable: false };
    const rule = rules.find((entry) => entry.table === table.name);
    if (!rule) return { applicable: true, ok: false, code: "unknown_table" };
    const alias = typeof table.alias === "string" ? table.alias : table.name;
    if (sources.some((source) => source.alias === alias)) return { applicable: true, ok: false, code: "duplicate_source_alias" };
    sources.push({ alias, table: table.name, allowed: new Set(rule.allowed_columns), sensitive: new Set(rule.sensitive_columns), required: new Set(rule.must_filter ?? []) });
  }
  const selections = Array.isArray(select.select) ? select.select : [];
  if (!selections.length) return { applicable: false };
  const aliases = new Map<string, unknown>();
  for (const value of selections) {
    const item = obj(value); if (!item || typeof item.alias !== "string") continue;
    if (aliases.has(item.alias)) return { applicable: true, ok: false, code: "duplicate_output_alias" };
    const collisions = sources.filter((source) => source.allowed.has(String(item.alias)) || source.sensitive.has(String(item.alias)));
    const parts = Array.isArray(item.name_parts) ? item.name_parts : [item.name];
    const identity = item.type === "Identifier" && parts.at(-1) === item.alias;
    if (collisions.length && !identity) {
      // As in the original review, don't let alias substitution change a
      // partition/privacy proof or an unqualified expression's meaning.
      const protectedName = collisions.some((source) => source.sensitive.has(String(item.alias)) || source.required.has(String(item.alias)));
      const unqualified = (value: unknown): boolean => {
        if (Array.isArray(value)) return value.some(unqualified);
        const node = obj(value); if (!node) return false;
        if (node.type === "Identifier") {
          const names = Array.isArray(node.name_parts) ? node.name_parts : [node.name];
          return names.length === 1 && names[0] === item.alias;
        }
        return Object.entries(node).some(([key, child]) => !["alias", "location", "parent", "from", "with", "order_by"].includes(key) && unqualified(child));
      };
      if (protectedName || unqualified({ ...select, select: selections.filter((entry) => entry !== value) })) return { applicable: true, ok: false, code: "column_alias_collision" };
    }
    aliases.set(item.alias, item);
  }
  const columns = new Set<string>(); let nodes = 0;
  const visit = (value: unknown, allowAlias = false): string | null => {
    if (++nodes > 20_000) return "sql_complexity_limit";
    if (Array.isArray(value)) { for (const child of value) { const error = visit(child, allowAlias); if (error) return error; } return null; }
    const node = obj(value); if (!node) return null;
    if (["Subquery", "SelectQuery", "SelectWithUnionQuery"].includes(String(node.type))) return "join_scope_unsupported";
    if (node.type === "Identifier") {
      const parts = Array.isArray(node.name_parts) ? node.name_parts : [node.name];
      if (parts.length < 1 || parts.length > 2 || !parts.every((part) => typeof part === "string")) return "clickhouse_identifier_unsupported";
      const name = String(parts.at(-1));
      const candidates = sources.filter((source) => (parts.length === 1 || source.alias === parts[0]) && (source.allowed.has(name) || source.sensitive.has(name)));
      if (!candidates.length && parts.length === 1 && allowAlias && aliases.has(name)) return null;
      if (!candidates.length) return "column_not_in_contract";
      if (candidates.some((source) => source.sensitive.has(name))) return "sensitive_field";
      if (parts.length === 1 && candidates.length > 1) return "ambiguous_column";
      for (const source of candidates) columns.add(`${source.table}.${name}`);
      return null;
    }
    for (const [key, child] of Object.entries(node)) {
      if (["alias", "location", "parent"].includes(key)) continue;
      const error = visit(child, allowAlias); if (error) return error;
    }
    return null;
  };
  for (const item of from.children) {
    const error = visit(obj(item)?.table_join);
    if (error === "join_scope_unsupported") return { applicable: false };
    if (error) return { applicable: true, ok: false, code: error };
  }
  for (const [key, value] of Object.entries(select)) {
    if (["type", "from", "with", "location", "parent"].includes(key)) continue;
    const error = visit(value, key === "order_by" || key === "group_by");
    if (error === "join_scope_unsupported") return { applicable: false };
    if (error) return { applicable: true, ok: false, code: error };
  }
  return { applicable: true, ok: true, columns: [...columns].sort() };
}
