import { createRequire } from "node:module";
import { isCalendarDate } from "./config.js";

const require = createRequire(import.meta.url);
const loaded = require("node-sql-parser") as {
  Parser: new () => { astify(sql: string, opt?: { database?: string }): unknown };
};

const WRITE_TYPES = new Set([
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "create",
  "replace",
  "truncate",
  "attach",
  "detach",
  "grant",
  "revoke",
]);

const ALLOWED_FUNCTIONS = new Set(["sum", "count", "min", "max", "avg", "lower", "upper", "exists"]);
const TABLE_FUNCTIONS = /\b(file|url|s3|s3cluster|remote|remotesecure|mysql|postgresql|mongo|mongodb|hdfs|input|cluster|clusterallreplicas|sqlite|redis|executable)\s*\(/iu;

export class SqlRejected extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SqlRejected";
  }
}

export interface GuardedSql {
  sql: string;
  tables: string[];
  columns: string[];
  time_range: { start: string; end: string };
  equalities: Record<string, string>;
}

export interface TableRule {
  table: string;
  allowed_columns: string[];
  sensitive_columns: string[];
  must_filter: string[];
}

export interface ParsedSql {
  sql: string;
  tables: string[];
  ast: Record<string, unknown>;
}

export function parseReadonlySql(rawSql: string, dialect: "sqlite" | "clickhouse" = "sqlite"): ParsedSql {
  const sql = rawSql.trim().replace(/;+\s*$/u, "");
  if (!sql) throw new SqlRejected("invalid_sql", "SQL 为空");
  if (TABLE_FUNCTIONS.test(sql) || /\b(system|information_schema)\s*\./iu.test(sql)) {
    throw new SqlRejected("dangerous_table", "不允许系统表、文件或外部数据源");
  }
  let parsed: unknown;
  try {
    // 解析器没有可依赖的 ClickHouse 方言。标准 SELECT 用 sqlite 语法树做准入；
    // 解析失败，或命中系统表、文件和外部数据源，都直接拒绝。
    void dialect;
    parsed = new loaded.Parser().astify(sql, { database: "sqlite" });
  } catch {
    throw new SqlRejected("unparseable_sql", "SQL 无法安全解析，未知语法直接拒绝");
  }
  const statements = Array.isArray(parsed) ? parsed : [parsed];
  if (statements.length !== 1) throw new SqlRejected("multiple_statements", "只允许一条语句");
  const statement = asRecord(statements[0]);
  if (!statement) throw new SqlRejected("unparseable_sql", "SQL 无法安全解析");
  rejectShape(statement);
  const tables = [...physicalTables(statement, new Set())];
  if (tables.length === 0) throw new SqlRejected("missing_table", "查询没有引用表");
  return { sql, tables, ast: statement };
}

export interface RegisteredJoin {
  tables: string[];
  keys: string[];
}

export function assertJoinKeys(rawSql: string, joins: RegisteredJoin[], grains: Map<string, string[]> = new Map()): void {
  const parsed = parseReadonlySql(rawSql);
  // Walk every SELECT, including CTEs, derived tables, scalar subqueries and UNION arms.
  // A derived relation used as a JOIN operand remains unsupported because its
  // output-column lineage and grain cannot yet be proved from the contracts.
  const cteNames = new Set<string>();
  walk(parsed.ast, (record) => {
    if (Array.isArray(record.with)) for (const item of record.with) {
      const name = cteName(asRecord(item));
      if (name) cteNames.add(name);
    }
  });
  walk(parsed.ast, (statement) => {
    if (statement.type === "select") assertSelectJoinKeys(statement, joins, grains, cteNames);
  });
}

function assertSelectJoinKeys(statement: Record<string, unknown>, joins: RegisteredJoin[], grains: Map<string, string[]>, cteNames: Set<string>): void {
  const from = Array.isArray(statement.from) ? statement.from : [];
  if (from.length < 2) return;
  const relations = from.map((item, index) => relationOf(item, index));
  if (relations.some((item) => cteNames.has(item.table))) {
    throw new SqlRejected("join_structure_unsupported", "CTE 作为连接输入时无法证明输出列与粒度的来源。请直接连接已登记的物理表。");
  }
  if (relations.some((item) => item.derived)) {
    throw new SqlRejected("join_structure_unsupported", "连接的来源不能是子查询。请分别查询后在会话里计算，或先按登记粒度预聚合。");
  }
  const seen: Relation[] = [];
  for (const [index, relation] of relations.entries()) {
    if (!relation.join) {
      if (index !== 0) throw new SqlRejected("join_structure_unsupported", "不支持逗号连接或缺少 ON 的笛卡尔积。");
      seen.push(relation);
      continue;
    }
    if (relation.join !== "INNER JOIN") throw new SqlRejected("join_structure_unsupported", `不支持 ${relation.join}。只接受登记键上的 INNER JOIN。`);
    if (seen.some((item) => item.table === relation.table)) throw new SqlRejected("self_join_unsupported", "不支持自连接。同一张表的两个别名不能用来绕过粒度。");
    const pairs = joinEqualities(relation.on);
    const otherAliases = new Set(pairs.flatMap((pair) => [pair.left.alias, pair.right.alias]).filter((alias) => alias !== relation.alias));
    if (otherAliases.size !== 1) throw new SqlRejected("join_column_ambiguous", "每个 JOIN 的等值条件必须只连接当前表和前一张表的别名。");
    const otherAlias = [...otherAliases][0] ?? "";
    const other = seen.find((item) => item.alias === otherAlias);
    if (!other) throw new SqlRejected("join_column_ambiguous", `别名 ${otherAlias} 不是这个 FROM 里的表。`);
    if (seen.some((item) => item.alias === relation.alias)) throw new SqlRejected("join_column_ambiguous", "同一查询层级不能重复使用表别名。");
    for (const pair of pairs) {
      const sides = [pair.left.alias, pair.right.alias].sort().join("|");
      const expected = [relation.alias, other.alias].sort().join("|");
      if (sides !== expected) throw new SqlRejected("join_key_mismatch", "连接等号的两侧必须分别是两张表的别名。");
      if (pair.left.column !== pair.right.column) throw new SqlRejected("join_key_mismatch", `${pair.left.column} 和 ${pair.right.column} 不是同一个登记键。`);
    }
    const registered = joins.find((item) => sameTables(item.tables, [relation.table, other.table]));
    if (!registered) throw new SqlRejected("missing_join_constraint", `没有登记 ${other.table} 与 ${relation.table} 的连接。`);
    const required = registered.keys.map((key) => key.toLowerCase());
    const got = pairs.map((pair) => pair.left.column);
    const missing = required.filter((key) => !got.includes(key));
    if (missing.length) throw new SqlRejected("join_key_missing", `连接键缺少 ${missing.join("、")}。列名出现不等于等值关系成立。`);
    const extra = got.filter((key) => !required.includes(key));
    if (extra.length) throw new SqlRejected("join_key_not_allowed", `ON 里的 ${extra.join("、")} 不是登记连接键。筛选请写在 WHERE。`);
    if (!grains.has(other.table) || !grains.has(relation.table) || !grains.get(other.table)?.length || !grains.get(relation.table)?.length) {
      throw new SqlRejected("join_grain_unknown", "连接双方必须有可核对的契约粒度；CTE 输出或未知粒度不能直接参与连接。");
    }
    const leftLeftover = leftoverGrain(grains.get(other.table) ?? [], required);
    const rightLeftover = leftoverGrain(grains.get(relation.table) ?? [], required);
    if (leftLeftover.length && rightLeftover.length) {
      throw new SqlRejected(
        "join_grain_mismatch",
        `${other.table} 还剩 ${leftLeftover.join("、")}，${relation.table} 还剩 ${rightLeftover.join("、")}。两边都有未对齐粒度时，连接会重复汇总。列名匹配不保证基数。`,
      );
    }
    seen.push(relation);
  }
}

export function guardSql(rawSql: string, rules: TableRule[], dialect: "sqlite" | "clickhouse" = "sqlite"): GuardedSql {
  const parsed = parseReadonlySql(rawSql, dialect);
  const ruleByTable = new Map(rules.map((rule) => [rule.table, rule]));
  for (const table of parsed.tables) {
    if (!ruleByTable.has(table)) throw new SqlRejected("unknown_table", `表 ${table} 不在本次绑定中`);
  }
  const columns = authorizeSelect(parsed.ast, new Set(), ruleByTable);
  let start = "";
  let end = "";
  for (const rule of rules.filter((rule) => parsed.tables.includes(rule.table))) {
    for (const column of rule.must_filter) {
      const bounds = dateBounds(parsed.ast.where, column);
      if (bounds.start && bounds.end) {
        start = bounds.start;
        end = bounds.end;
      }
    }
  }
  return { sql: parsed.sql, tables: parsed.tables, columns, time_range: { start, end }, equalities: equalityFilters(parsed.ast.where) };
}

function equalityFilters(where: unknown): Record<string, string> {
  const found = new Map<string, Set<string>>();
  walkShallow(where, (record) => {
    if (record.type !== "binary_expr" || record.operator !== "=") return;
    const column = columnOf(record.left);
    const value = asRecord(record.right);
    if (!column || value?.type !== "single_quote_string" || typeof value.value !== "string") return;
    const bucket = found.get(column) ?? new Set<string>();
    bucket.add(value.value);
    found.set(column, bucket);
  });
  const single: Record<string, string> = {};
  for (const [column, values] of found) {
    if (values.size === 1) single[column] = [...values][0] ?? "";
  }
  return single;
}

function rejectShape(statement: Record<string, unknown>): void {
  const type = String(statement.type ?? "");
  if (WRITE_TYPES.has(type)) throw new SqlRejected("write_statement", "只允许只读查询");
  if (type !== "select") throw new SqlRejected("unsupported_sql", "只允许单条 SELECT");
  rejectFunctions(statement);
  if (Array.isArray(statement.with)) {
    for (const item of statement.with) {
      const body = nestedSelect(item);
      if (body) rejectShape(body);
    }
  }
  if (statement._next) {
    const next = asRecord(statement._next);
    if (next) rejectShape(next);
  }
  walkShallow(statement, (record) => {
    const nested = asRecord(record.ast);
    if (nested?.type) rejectShape(nested);
  });
}

function physicalTables(statement: Record<string, unknown>, cteNames: Set<string>): Set<string> {
  const tables = new Set<string>();
  const localCtes = new Set(cteNames);
  if (Array.isArray(statement.with)) {
    for (const item of statement.with) {
      const record = asRecord(item);
      const body = nestedSelect(item);
      if (body) for (const table of physicalTables(body, localCtes)) tables.add(table);
      const name = cteName(record);
      if (name) localCtes.add(name);
    }
  }
  for (const table of directTables(statement, localCtes)) tables.add(table);
  walkShallow(statement, (record) => {
    const nested = asRecord(record.ast);
    if (nested?.type) for (const table of physicalTables(nested, localCtes)) tables.add(table);
  });
  const next = asRecord(statement._next);
  if (next) for (const table of physicalTables(next, localCtes)) tables.add(table);
  return tables;
}

function authorizeSelect(statement: Record<string, unknown>, cteNames: Set<string>, rules: Map<string, TableRule>): string[] {
  const localCtes = new Set(cteNames);
  const columns: string[] = [];
  if (Array.isArray(statement.with)) {
    for (const item of statement.with) {
      const record = asRecord(item);
      const body = nestedSelect(item);
      if (body) columns.push(...authorizeSelect(body, localCtes, rules));
      const name = cteName(record);
      if (name) localCtes.add(name);
    }
  }
  const direct = directTables(statement, localCtes);
  const scopedAliases = new Map<string, string>();
  if (Array.isArray(statement.from)) {
    for (const item of statement.from) {
      const relation = asRecord(item);
      if (typeof relation?.table !== "string") continue;
      const table = relation.table.toLowerCase();
      if (localCtes.has(table)) continue;
      const alias = typeof relation.as === "string" && relation.as ? relation.as.toLowerCase() : table;
      if (scopedAliases.has(alias)) throw new SqlRejected("join_column_ambiguous", "同一查询层级不能重复使用表别名。");
      scopedAliases.set(alias, table);
    }
  }
  const localColumns = shallowColumns(statement);
  if (localColumns.some((column) => column === "*")) throw new SqlRejected("wildcard_projection", "禁止 SELECT * 或 table.*，不会按契约展开通配符");
  if (hasOperator(statement.where, "OR")) throw new SqlRejected("unsafe_predicate", "不接受可能绕过日期范围的 OR 条件");
  for (const column of localColumns) {
    const owners = direct.map((table) => rules.get(table)).filter((rule): rule is TableRule => rule !== undefined);
    if (owners.some((rule) => rule.sensitive_columns.includes(column))) {
      throw new SqlRejected("sensitive_field", `字段 ${column} 是敏感字段，不能出现在查询中`);
    }
    if (owners.length && !owners.some((rule) => rule.allowed_columns.includes(column))) {
      throw new SqlRejected("column_not_in_contract", `字段 ${column} 不在当前契约允许的字段中`);
    }
  }
  for (const key of ["columns", "where", "groupby", "having", "orderby"]) {
    walkShallow(statement[key], (record) => {
      if (record.type !== "column_ref" || typeof record.table !== "string" || typeof record.column !== "string") return;
      const alias = record.table.toLowerCase();
      const table = scopedAliases.get(alias);
      // CTE and derived output lineage is handled conservatively by the JOIN guard.
      if (!table && direct.length) throw new SqlRejected("column_scope_unsupported", "无法确认列所属表或关联子查询的作用域。");
      if (!table) return;
      const rule = rules.get(table);
      const column = record.column.toLowerCase();
      if (rule?.sensitive_columns.includes(column)) throw new SqlRejected("sensitive_field", `字段 ${column} 是敏感字段，不能出现在查询中`);
      if (!rule?.allowed_columns.includes(column)) throw new SqlRejected("column_not_in_contract", `字段 ${column} 不属于该别名对应的契约`);
    });
  }
  columns.push(...localColumns);
  for (const table of direct) {
    const rule = rules.get(table);
    if (!rule) throw new SqlRejected("unknown_table", `表 ${table} 不在本次绑定中`);
    for (const column of rule.must_filter) {
      const alias = [...scopedAliases].find(([, scopedTable]) => scopedTable === table)?.[0];
      const bounds = dateBounds(statement.where, column, alias, direct.length > 1);
      if (!bounds.start || !bounds.end) throw new SqlRejected("unbounded_query", `必须为 ${table}.${column} 提供封闭的日期范围`);
      if (!isCalendarDate(bounds.start) || !isCalendarDate(bounds.end) || bounds.start > bounds.end) throw new SqlRejected("invalid_date_range", `${table}.${column} 的日期范围无效`);
    }
  }
  walkShallow(statement, (record) => {
    const nested = asRecord(record.ast);
    if (nested?.type) columns.push(...authorizeSelect(nested, localCtes, rules));
  });
  const next = asRecord(statement._next);
  if (next) columns.push(...authorizeSelect(next, localCtes, rules));
  return columns;
}

function directTables(statement: Record<string, unknown>, cteNames: Set<string>): string[] {
  if (!Array.isArray(statement.from)) return [];
  const tables: string[] = [];
  for (const item of statement.from) {
    const record = asRecord(item);
    if (!record) continue;
    if (record.expr) {
      const expr = asRecord(record.expr);
      if (expr?.type === "function") throw new SqlRejected("table_function", "不允许表函数或外部数据源");
      continue;
    }
    if (typeof record.table !== "string") throw new SqlRejected("unsupported_sql", "无法识别查询中的表");
    if (record.db) throw new SqlRejected("unsupported_sql", "不支持带库名前缀的表");
    const table = record.table.toLowerCase();
    if (!cteNames.has(table)) tables.push(table);
  }
  return tables;
}

function shallowColumns(statement: Record<string, unknown>): string[] {
  const columns: string[] = [];
  for (const key of ["columns", "where", "groupby", "having", "orderby"]) {
    walkShallow(statement[key], (record) => {
      const name = identifierName(record);
      if (name) columns.push(name);
    });
  }
  return columns;
}

function nestedSelect(item: unknown): Record<string, unknown> | undefined {
  const stmt = asRecord(asRecord(item)?.stmt);
  return asRecord(stmt?.ast) ?? stmt;
}

function cteName(item: Record<string, unknown> | undefined): string | undefined {
  const name = asRecord(item?.name);
  return typeof name?.value === "string" ? name.value.toLowerCase() : undefined;
}

function rejectFunctions(node: unknown): void {
  walk(node, (record) => {
    const name = functionName(record);
    if (!name) return;
    if (!ALLOWED_FUNCTIONS.has(name)) throw new SqlRejected("dangerous_function", `函数 ${name} 不在允许列表中`);
  });
}

function functionName(record: Record<string, unknown>): string | undefined {
  if (record.type === "aggr_func" && typeof record.name === "string") return record.name.toLowerCase();
  if (record.type !== "function") return undefined;
  const name = asRecord(record.name);
  const parts = name?.name;
  if (!Array.isArray(parts)) return undefined;
  const text = parts
    .map((part) => {
      const item = asRecord(part);
      return typeof item?.value === "string" ? item.value : "";
    })
    .join(".");
  return text.toLowerCase();
}

function dateBounds(where: unknown, column: string, alias?: string, requireQualified = false): { start?: string; end?: string } {
  const bounds: { start?: string; end?: string } = {};
  const matches = (value: unknown): boolean => {
    const record = asRecord(value);
    if (!record || columnOf(record) !== column) return false;
    const qualifier = typeof record.table === "string" ? record.table.toLowerCase() : undefined;
    if (requireQualified && !qualifier) return false;
    return !alias || !qualifier || qualifier === alias;
  };
  const visit = (node: unknown): void => {
    const record = asRecord(node);
    if (!record) return;
    if (record.type !== "binary_expr" || typeof record.operator !== "string") return;
    const operator = record.operator.toUpperCase();
    if (operator === "AND") {
      visit(record.left);
      visit(record.right);
      return;
    }
    if (operator === "BETWEEN" && matches(record.left)) {
      const values = asRecord(record.right);
      const list = Array.isArray(values?.value) ? values.value : [];
      const start = literal(list[0]);
      const end = literal(list[1]);
      if (start && end) {
        bounds.start = start;
        bounds.end = end;
      }
      return;
    }
    if (!matches(record.left)) return;
    const value = literal(record.right);
    if (!value) return;
    if (operator === ">=" || operator === ">") bounds.start = value;
    if (operator === "<=" || operator === "<") bounds.end = value;
  };
  visit(where);
  return bounds;
}

function hasOperator(node: unknown, operator: string): boolean {
  let found = false;
  walkShallow(node, (record) => {
    if (record.type === "binary_expr" && String(record.operator).toUpperCase() === operator) found = true;
  });
  return found;
}

function columnOf(value: unknown): string | undefined {
  const record = asRecord(value);
  return record ? identifierName(record) : undefined;
}

function identifierName(record: Record<string, unknown>): string | undefined {
  if (record.type === "column_ref" && typeof record.column === "string") return record.column.toLowerCase();
  if ((record.type === "double_quote_string" || record.type === "backticks_quote_string") && typeof record.value === "string") {
    return record.value.toLowerCase();
  }
  return undefined;
}

function literal(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (typeof record.value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(record.value)) return record.value;
  return undefined;
}

function walk(node: unknown, visit: (record: Record<string, unknown>) => void): void {
  walkInternal(node, visit, false);
}

function walkShallow(node: unknown, visit: (record: Record<string, unknown>) => void): void {
  walkInternal(node, visit, true);
}

function walkInternal(node: unknown, visit: (record: Record<string, unknown>) => void, shallow: boolean): void {
  if (Array.isArray(node)) {
    for (const item of node) walkInternal(item, visit, shallow);
    return;
  }
  const record = asRecord(node);
  if (!record) return;
  visit(record);
  for (const [key, value] of Object.entries(record)) {
    if (shallow && (key === "ast" || key === "with" || key === "_next" || key === "stmt")) continue;
    walkInternal(value, visit, shallow);
  }
}

interface Relation {
  alias: string;
  table: string;
  join: string | null;
  on: unknown;
  derived: boolean;
}

interface JoinSide {
  alias: string;
  column: string;
}

function relationOf(item: unknown, index: number): Relation {
  const record = asRecord(item);
  if (!record) throw new SqlRejected("join_structure_unsupported", "无法识别 FROM 里的表。");
  if (record.expr) throw new SqlRejected("join_structure_unsupported", "连接的来源不能是子查询。请分别查询后在会话里计算。");
  if (typeof record.table !== "string") throw new SqlRejected("unsupported_sql", "无法识别查询中的表");
  const table = record.table.toLowerCase();
  const alias = typeof record.as === "string" && record.as ? record.as.toLowerCase() : table;
  return {
    alias,
    table,
    join: index === 0 ? null : String(record.join ?? ""),
    on: record.on,
    derived: false,
  };
}

function joinEqualities(on: unknown): Array<{ left: JoinSide; right: JoinSide }> {
  const pairs: Array<{ left: JoinSide; right: JoinSide }> = [];
  const visit = (node: unknown): void => {
    const record = asRecord(node);
    if (!record || record.type !== "binary_expr" || typeof record.operator !== "string") {
      throw new SqlRejected("join_predicate_unsafe", "ON 只接受登记键的等值条件，并且必须同时成立。");
    }
    const operator = record.operator.toUpperCase();
    if (operator === "AND") {
      visit(record.left);
      visit(record.right);
      return;
    }
    if (operator === "OR") throw new SqlRejected("join_predicate_unsafe", "ON 里的 OR 会让登记键不再同时成立。");
    if (operator !== "=") throw new SqlRejected("join_predicate_unsafe", "ON 只接受等值连接。");
    const left = joinSide(record.left);
    const right = joinSide(record.right);
    pairs.push({ left, right });
  };
  if (!on) throw new SqlRejected("join_predicate_unsafe", "JOIN 缺少 ON。不会把笛卡尔积当成已登记连接。");
  visit(on);
  if (pairs.length === 0) throw new SqlRejected("join_key_missing", "ON 没有登记键的等值条件。");
  return pairs;
}

function joinSide(value: unknown): JoinSide {
  const record = asRecord(value);
  if (!record || record.type !== "column_ref" || typeof record.column !== "string") {
    throw new SqlRejected("join_predicate_unsafe", "ON 的等号两侧必须是带表别名的列，不能是常量或其他表达式。");
  }
  if (typeof record.table !== "string" || !record.table) throw new SqlRejected("join_column_ambiguous", `列 ${record.column} 没有表别名。`);
  return { alias: record.table.toLowerCase(), column: record.column.toLowerCase() };
}

function sameTables(registered: string[], actual: string[]): boolean {
  return [...registered].map((item) => item.toLowerCase()).sort().join("|") === [...actual].map((item) => item.toLowerCase()).sort().join("|");
}

function leftoverGrain(grain: string[], keys: string[]): string[] {
  const covered = new Set(keys);
  return grain.map((item) => item.toLowerCase()).filter((item) => !covered.has(item));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
