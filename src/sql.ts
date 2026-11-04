import { createRequire } from "node:module";
import { isCalendarDate } from "./config.js";
import { authorizeClickHouseDirect, authorizeClickHouseScoped, authorizeClickHouseJoin, clickHousePreflightMessage, preflightClickHouseSql } from "./clickhouse-sql-preflight.js";

const require = createRequire(import.meta.url);
const loaded = require("node-sql-parser") as {
  Parser: new () => { astify(sql: string, opt?: { database?: string }): unknown; sqlify(ast: unknown, opt?: { database?: string }): string };
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

const CLICKHOUSE_DATE_PROJECTIONS = new Set(["toyear", "tomonth", "toyyyymm", "tostartofmonth", "tostartofday"]);
const CLICKHOUSE_ONLY_FUNCTIONS = new Set(["todate", "countif", "isnull", "isnotnull", ...CLICKHOUSE_DATE_PROJECTIONS]);
const ALLOWED_FUNCTIONS = new Set(["sum", "count", "min", "max", "avg", "lower", "upper", "exists", ...CLICKHOUSE_ONLY_FUNCTIONS]);
const TABLE_FUNCTIONS = /\b(file|url|s3|s3cluster|remote|remotesecure|mysql|postgresql|mongo|mongodb|hdfs|input|cluster|clusterallreplicas|sqlite|redis|executable)\s*\(/iu;
// Match the maximum interval that the coverage evaluator can enumerate.
// Row/time limits in the ClickHouse driver remain independent safeguards.
const MAX_SCAN_DAYS = 400;
const MAX_SQL_BYTES = 64 * 1024;

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
  /** Host-supplied contract types; absent types never authorize date projection. */
  column_types?: Record<string, string>;
}

export interface ParsedSql {
  sql: string;
  tables: string[];
  ast: Record<string, unknown>;
}

export function parseReadonlySql(rawSql: string, dialect: "sqlite" | "clickhouse" = "sqlite"): ParsedSql {
  const sql = rawSql.trim().replace(/;+\s*$/u, "");
  if (!sql) throw new SqlRejected("invalid_sql", "SQL 为空");
  if (Buffer.byteLength(sql, "utf8") > MAX_SQL_BYTES) throw new SqlRejected("sql_size_limit", "SQL 超出安全长度上限");
  // Check before parsing. Ignore literals and comments so a closing bracket
  // inside a string cannot hide later nesting from the parser safety limit.
  let depth = 0; let quote = ""; let lineComment = false; let blockComment = false;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i]!; const next = sql[i + 1];
    if (lineComment) { if (char === "\n" || char === "\r") lineComment = false; continue; }
    if (blockComment) { if (char === "*" && next === "/") { blockComment = false; i += 1; } continue; }
    if (quote) {
      if (char === "\\") { i += 1; continue; }
      if (char === quote) { if (next === quote) i += 1; else quote = ""; }
      continue;
    }
    if (char === "-" && next === "-") { lineComment = true; i += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; i += 1; continue; }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (char === "(" && ++depth > 64) throw new SqlRejected("sql_depth_limit", "SQL 嵌套过深");
    if (char === ")") depth = Math.max(0, depth - 1);
  }
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
  assertAstBudget(statement);
  rejectShape(statement);
  const tables = [...physicalTables(statement, new Set())];
  if (tables.length === 0) throw new SqlRejected("missing_table", "查询没有引用表");
  if (dialect === "clickhouse") {
    const clickhouse = preflightClickHouseSql(sql);
    if (!clickhouse.ok) throw new SqlRejected(clickhouse.code, clickHousePreflightMessage(clickhouse.code));
    if (clickhouse.tables.length !== tables.length || clickhouse.tables.some((table) => !tables.includes(table))) throw new SqlRejected("clickhouse_source_mismatch", "两个语法树对物理来源的解析不一致。");
    const legacyIdentifiers = new Set<string>(); const legacyFunctions = new Set<string>(); let ambiguousQuotes = false;
    walk(statement, (entry) => {
      const fn = functionName(entry); if (fn) legacyFunctions.add(fn);
      // SQLite treats double quotes as strings in contexts where ClickHouse
      // treats them as identifiers. Map only simple identifier-shaped values;
      // authorization below independently treats them as column references.
      if (entry.type === "double_quote_string") {
        if (typeof entry.value !== "string" || !/^[a-z_][a-z0-9_]*$/iu.test(entry.value)) ambiguousQuotes = true;
        else legacyIdentifiers.add(entry.value.toLowerCase());
      }
      if (entry.type !== "column_ref" || typeof entry.column !== "string" || entry.column === "*") return;
      const column = entry.column.toLowerCase();
      const qualifier = typeof entry.table === "string" && entry.table ? `${entry.table.toLowerCase()}.` : "";
      legacyIdentifiers.add(`${qualifier}${column}`);
    });
    if (ambiguousQuotes || clickhouse.identifiers.some((name) => !legacyIdentifiers.has(name))) throw new SqlRejected("clickhouse_identifier_mismatch", "两个语法树对字段标识符的解析不一致。");
    if (clickhouse.functions.some((name) => !legacyFunctions.has(name)) || [...legacyFunctions].some((name) => name !== "exists" && !clickhouse.functions.includes(name))) throw new SqlRejected("clickhouse_function_mismatch", "两个语法树对函数调用的解析不一致。");
  }
  return { sql, tables, ast: statement };
}

export interface RegisteredJoin {
  tables: string[];
  keys: string[];
}

/** LEFT is opt-in only for host-verified dimension contracts. Grain alone is
 * not enough to distinguish a dimension from another fact table. */
export interface JoinGuardOptions { leftJoinDimensions?: ReadonlySet<string> }

export function assertJoinKeys(rawSql: string, joins: RegisteredJoin[], grains: Map<string, string[]> = new Map(), options: JoinGuardOptions = {}): void {
  const parsed = parseReadonlySql(rawSql);
  const preaggregated = rewritePreaggregatedDimensionJoin(parsed.ast);
  if (preaggregated) {
    const grain = grains.get(preaggregated.fact);
    if (!grain?.length || !preaggregated.grain.length || preaggregated.grain.some((field) => !grain.includes(field))) throw new SqlRejected("join_grain_mismatch", "预聚合只能使用事实契约粒度中的字段。");
    assertJoinKeys(preaggregated.sql, joins, grains, options);
    return;
  }
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
    if (statement.type === "select") assertSelectJoinKeys(statement, joins, grains, cteNames, options);
  });
}

function assertSelectJoinKeys(statement: Record<string, unknown>, joins: RegisteredJoin[], grains: Map<string, string[]>, cteNames: Set<string>, options: JoinGuardOptions): void {
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
    if (relation.join !== "INNER JOIN" && relation.join !== "LEFT JOIN") throw new SqlRejected("join_structure_unsupported", `不支持 ${relation.join}。只接受登记键上的受限 INNER 或 LEFT JOIN。`);
    if (relation.join === "LEFT JOIN" && !options.leftJoinDimensions?.has(relation.table)) throw new SqlRejected("join_structure_unsupported", "LEFT JOIN 右侧必须是宿主确认的维表，不能仅凭粒度猜测。");
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
    if (relation.join === "LEFT JOIN" && (seen.length !== 1 || !leftLeftover.length || rightLeftover.length)) throw new SqlRejected("join_grain_mismatch", "LEFT JOIN 仅允许事实表关联登记键唯一的右侧维表。");
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
  if (dialect === "clickhouse") {
    const join = authorizeClickHouseJoin(rawSql, rules);
    if (join.applicable && !join.ok) throw new SqlRejected(join.code, "ClickHouse JOIN 字段未获授权或来源不明确。");
    const scoped = authorizeClickHouseScoped(rawSql, rules);
    if (scoped.applicable && !scoped.ok) throw new SqlRejected(scoped.code, "ClickHouse 作用域中的表或字段未获授权，或未被内层投影。");
    const direct = authorizeClickHouseDirect(rawSql, rules);
    if (direct.applicable && !direct.ok) throw new SqlRejected(direct.code, "ClickHouse 语法树中的物理来源或字段未获授权。");
  }
  const parsed = parseReadonlySql(rawSql, dialect);
  if (dialect !== "clickhouse") walk(parsed.ast, (node) => {
    if (CLICKHOUSE_ONLY_FUNCTIONS.has(functionName(node) ?? "")) throw new SqlRejected("clickhouse_function_only", "该函数仅支持 ClickHouse，SQLite 不会模拟其语义。");
  });
  // Date projection functions are not date-bound proofs. Require a single
  // physical table and its declared scan field; the ordinary date predicate
  // and all field/sensitive checks still apply independently below.
  walk(parsed.ast, (node) => {
    if (!CLICKHOUSE_DATE_PROJECTIONS.has(functionName(node) ?? "")) return;
    const args = callArguments(node); const col = asRecord(args?.[0]);
    const from = Array.isArray(parsed.ast.from) ? parsed.ast.from : [];
    const relation = asRecord(from[0]); const name = parsed.tables[0];
    const rule = rules.find((item) => item.table === name);
    if (parsed.ast.with || from.length !== 1 || parsed.tables.length !== 1 || relation?.table !== name || relation?.expr || !rule || !col || typeof col.column !== "string" || !rule.must_filter.includes(col.column) || rule.column_types?.[col.column]?.replace(/\s/gu, "").toLowerCase() !== "date" || col.table && col.table !== (relation.as || relation.table)) throw new SqlRejected("date_projection_scope_unsupported", "日期函数仅允许单表契约声明的 Date 类型扫描字段。");
  });
  const preaggregated = rewritePreaggregatedDimensionJoin(parsed.ast);
  if (preaggregated) {
    const factRule = rules.find((rule) => rule.table === preaggregated.fact);
    if (!factRule) throw new SqlRejected("unknown_table", "预聚合事实表不在本次绑定中。");
    for (const field of preaggregated.grain) {
      if (factRule.sensitive_columns.includes(field)) throw new SqlRejected("sensitive_field", "预聚合粒度包含敏感字段。");
      if (!factRule.allowed_columns.includes(field)) throw new SqlRejected("column_not_in_contract", "预聚合粒度包含未授权字段。");
    }
    const checked = guardSql(preaggregated.sql, rules, dialect);
    if (checked.tables.length !== parsed.tables.length || parsed.tables.some((table) => !checked.tables.includes(table))) throw new SqlRejected("join_structure_unsupported", "预聚合来源不一致。");
    return { ...checked, sql: parsed.sql, tables: parsed.tables };
  }
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
  // For a bounded single-source wrapper, the physical date predicate lives in
  // its inner SELECT. Never invent a range or combine conflicting scans.
  if (!start || !end) {
    const ranges: Array<{ start: string; end: string }> = [];
    walk(parsed.ast, (statement) => {
      if (statement.type !== "select" || !Array.isArray(statement.from)) return;
      for (const item of statement.from) {
        const relation = asRecord(item); if (typeof relation?.table !== "string") continue;
        const table = relation.table.toLowerCase(); const rule = ruleByTable.get(table);
        if (!rule) continue;
        const alias = typeof relation.as === "string" && relation.as ? relation.as.toLowerCase() : table;
        for (const field of rule.must_filter) {
          const bounds = dateBounds(statement.where, field, alias, statement.from.length > 1);
          if (bounds.start && bounds.end) ranges.push({ start: bounds.start, end: bounds.end });
        }
      }
    });
    if (ranges.length && ranges.every((range) => range.start === ranges[0]!.start && range.end === ranges[0]!.end)) ({ start, end } = ranges[0]!);
    else if (ranges.length > 1) throw new SqlRejected("time_range_ambiguous", "多层查询的日期范围不一致，无法绑定单一证据范围。");
  }
  return { sql: parsed.sql, tables: parsed.tables, columns, time_range: { start, end }, equalities: equalityFilters(parsed.ast.where) };
}

/** A guarded algebraic rewrite of one preaggregated fact and a dimension.
 * It establishes no authority by itself: the caller must recheck every
 * physical column, contracted grain, JOIN key and actual captured tuple. */
export function rewritePreaggregatedDimensionJoin(ast: Record<string, unknown>): { sql: string; fact: string; grain: string[] } | null {
  const collapsed = collapsePreaggregateProjectionWrappers(ast);
  return rewriteFlatPreaggregatedDimensionJoin(collapsed ?? ast);
}

/** Collapse bijective direct-column wrappers. An equality predicate on an
 * unchanged grouping key may be pushed through SUM: every contributing row
 * in a group has that same key. All other predicates and modifiers fail
 * closed. The rewritten query still passes normal authorization and evidence
 * checks, and never moves a predicate across the outer LEFT JOIN. */
function collapsePreaggregateProjectionWrappers(ast: Record<string, unknown>): Record<string, unknown> | null {
  const output = structuredClone(ast);
  if (!Array.isArray(output.from) || output.from.length !== 2) return null;
  const relation = asRecord(output.from[0]); if (!relation) return null;
  const ident = (value: unknown): value is string => typeof value === "string" && /^[a-z_][a-z0-9_]*$/u.test(value)
    && !["__proto__", "prototype", "constructor"].includes(value);
  let checkedPhysicalScope = false;
  const rename = (base: Record<string, unknown>, wrapper: Record<string, unknown>, source: string): boolean => {
    if (wrapper.type !== "select" || wrapper.with || wrapper._next || wrapper.distinct || wrapper.options || wrapper.groupby || wrapper.having || wrapper.orderby || wrapper.limit || wrapper.window || wrapper.for_update || wrapper.into || !Array.isArray(wrapper.from) || wrapper.from.length !== 1 || !Array.isArray(wrapper.columns) || !Array.isArray(base.columns)) return false;
    const from = asRecord(wrapper.from[0]);
    if (!from || from.db || from.join || (from.table !== source && !(source === "" && from.expr)) || (source && from.expr)) return false;
    const alias = String(from.as || from.table || ""); if (!ident(alias)) return false;
    const physicalNames = new Set<string>();
    walkShallow(base, (node) => { if (node.type === "column_ref" && typeof node.column === "string") physicalNames.add(node.column); });
    const original = new Map<string, Record<string, unknown>>();
    for (const raw of base.columns) {
      const col = asRecord(raw); const expr = asRecord(col?.expr);
      const name = col?.as || (expr?.type === "column_ref" ? expr.column : undefined);
      // ClickHouse can substitute SELECT aliases into other expressions in the
      // same scope. Never reason about a renamed layer if an output alias could
      // instead name a different physical column in the aggregate query.
      if (!col || !ident(name) || original.has(name) || (!checkedPhysicalScope && physicalNames.has(name) && !(expr?.type === "column_ref" && expr.column === name))) return false;
      original.set(name, col);
    }
    checkedPhysicalScope = true;
    const names = new Map<string, string>(); const used = new Set<string>();
    for (const raw of wrapper.columns) {
      const col = asRecord(raw); const expr = asRecord(col?.expr);
      if (!col || expr?.type !== "column_ref" || expr.collate || !ident(expr.column) || (expr.table && expr.table !== alias)) return false;
      const target = col.as || expr.column;
      if (!ident(target) || !original.has(expr.column) || names.has(expr.column) || used.has(target)) return false;
      names.set(expr.column, target); used.add(target);
    }
    if (!names.size || names.size !== original.size) return false;
    if (wrapper.where) {
      const grouped = asRecord(base.groupby)?.columns;
      if (!Array.isArray(grouped) || !base.where) return false;
      const existing = new Set<string>();
      walkShallow(base.where, (node) => {
        if (node.type === "column_ref" && typeof node.column === "string") existing.add(node.column);
      });
      const push: Record<string, unknown>[] = [];
      const visit = (value: unknown): boolean => {
        const predicate = asRecord(value);
        if (!predicate || predicate.type !== "binary_expr") return false;
        if (predicate.operator === "AND") return visit(predicate.left) && visit(predicate.right);
        if (predicate.operator !== "=") return false;
        const ref = asRecord(predicate.left); const literal = asRecord(predicate.right);
        if (!ref || ref.type !== "column_ref" || ref.collate || !ident(ref.column) || (ref.table && ref.table !== alias)
          || !literal || literal.type !== "single_quote_string" || typeof literal.value !== "string" || !/^[\p{L}\p{N}_ .-]{1,100}$/u.test(literal.value)) return false;
        const physical = asRecord(original.get(ref.column)?.expr);
        if (!physical || physical.type !== "column_ref" || physical.collate || !ident(physical.column) || existing.has(physical.column)) return false;
        if (!grouped.some((item) => { const group = asRecord(item); return group?.type === "column_ref" && !group.collate && group.column === physical.column && (group.table || "") === (physical.table || ""); })) return false;
        existing.add(physical.column);
        push.push({ type: "binary_expr", operator: "=", left: structuredClone(physical), right: structuredClone(literal) });
        return true;
      };
      if (!visit(wrapper.where) || !push.length) return false;
      for (const predicate of push) base.where = { type: "binary_expr", operator: "AND", left: base.where, right: predicate };
    }
    for (const [old, col] of original) col.as = names.get(old)!;
    return true;
  };
  if (Array.isArray(output.with) && output.with.length > 1 && output.with.length <= 8 && typeof relation.table === "string" && !relation.expr) {
    const entries = output.with.map(asRecord);
    if (entries.some((entry) => !entry || entry.columns)) return null;
    const names = entries.map(cteName);
    if (names.some((name) => !ident(name)) || new Set(names).size !== names.length || relation.table !== names.at(-1)) return null;
    const base = nestedSelect(entries[0]); if (!base) return null;
    for (let i = 1; i < entries.length; i += 1) {
      const wrapper = nestedSelect(entries[i]);
      if (!wrapper || !rename(base, wrapper, names[i - 1]!)) return null;
    }
    const last = entries.at(-1)!; const stmt = asRecord(last.stmt);
    if (!stmt || !asRecord(stmt.ast)) return null;
    stmt.ast = base; output.with = [last];
    return output;
  }
  if (!output.with && relation.expr && typeof relation.as === "string") {
    let current = asRecord(asRecord(relation.expr)?.ast); const wrappers: Record<string, unknown>[] = [];
    while (current && Array.isArray(current.from) && current.from.length === 1 && asRecord(current.from[0])?.expr && wrappers.length < 8) {
      wrappers.push(current);
      current = asRecord(asRecord(asRecord(current.from[0])?.expr)?.ast);
    }
    if (!current || !wrappers.length) return null;
    for (const wrapper of wrappers.reverse()) if (!rename(current, wrapper, "")) return null;
    const expr = asRecord(relation.expr); if (!expr) return null;
    expr.ast = current;
    return output;
  }
  return null;
}

function rewriteFlatPreaggregatedDimensionJoin(ast: Record<string, unknown>): { sql: string; fact: string; grain: string[] } | null {
  try {
    if (ast._next || ast.distinct || ast.options || ast.where || ast.having || ast.limit || ast.window || ast.for_update || !Array.isArray(ast.from) || ast.from.length !== 2 || !Array.isArray(ast.columns)) return null;
    const left = asRecord(ast.from[0]); const right = asRecord(ast.from[1]);
    if (!left || !right || right.expr || right.db || typeof right.table !== "string" || !["INNER JOIN", "LEFT JOIN"].includes(String(right.join))) return null;
    let inner: Record<string, unknown> | undefined; let alias: string;
    if (Array.isArray(ast.with) && ast.with.length === 1 && typeof left.table === "string" && !left.expr) {
      const entry = asRecord(ast.with[0]); const name = cteName(entry);
      if (!name || entry?.columns || left.table !== name) return null;
      inner = nestedSelect(entry); alias = String(left.as || left.table);
    } else if (!ast.with && left.expr && typeof left.as === "string") {
      inner = asRecord(asRecord(left.expr)?.ast); alias = left.as;
    } else return null;
    if (!inner || inner.with || inner._next || inner.distinct || inner.options || inner.having || inner.orderby || inner.limit || inner.window || inner.for_update || !inner.where || !Array.isArray(inner.from) || inner.from.length !== 1 || !Array.isArray(inner.columns)) return null;
    const physical = asRecord(inner.from[0]);
    if (!physical || physical.expr || physical.db || physical.join || typeof physical.table !== "string") return null;
    const fact = physical.table; const fa = String(physical.as || fact);
    const ident = (s: string) => /^[a-z_][a-z0-9_]*$/u.test(s) && !["__proto__", "prototype", "constructor"].includes(s);
    if (![fact, fa, alias].every(ident)) return null;
    const plain = (node: unknown): string | null => { const x = asRecord(node); return x?.type === "column_ref" && !x.collate && typeof x.column === "string" && ident(x.column) && (!x.table || x.table === fa) ? x.column : null; };
    const groupBy = asRecord(inner.groupby);
    if (!groupBy || Object.keys(groupBy).some((key) => key !== "columns")) return null;
    const groups = groupBy.columns;
    if (!Array.isArray(groups) || !groups.length || groups.some((g) => !plain(g))) return null;
    const grain = groups.map((g) => plain(g)!);
    if (new Set(grain).size !== grain.length) return null;
    const selected = new Map<string, string>(); const metrics = new Map<string, string>();
    for (const raw of inner.columns) {
      const entry = asRecord(raw); const expr = asRecord(entry?.expr); const col = plain(expr);
      if (!entry || !expr) return null;
      const name = String(entry.as || col || "");
      if (!ident(name) || selected.has(name) || metrics.has(name)) return null;
      if (col) { selected.set(name, col); continue; }
      const args = asRecord(expr.args); const arg = plain(args?.expr);
      if (expr.type !== "aggr_func" || String(expr.name).toLowerCase() !== "sum" || expr.over || !args || args.distinct || args.orderby || !arg || !entry.as) return null;
      metrics.set(name, arg);
    }
    if (!metrics.size || metrics.size > 8 || selected.size !== grain.length || new Set(selected.values()).size !== selected.size || [...selected.values()].sort().join("|") !== [...grain].sort().join("|")) return null;
    const output = structuredClone(ast); const used = new Set<string>();
    for (const raw of output.columns as unknown[]) {
      const entry = asRecord(raw); const expr = asRecord(entry?.expr);
      if (!entry || !expr) return null;
      if (expr.type === "column_ref") {
        if (expr.table === alias) {
          const old = String(expr.column); const column = selected.get(old); if (!column) return null;
          expr.column = column; if (!entry.as && old !== column) entry.as = old;
        }
        continue;
      }
      const args = asRecord(expr.args); const arg = asRecord(args?.expr);
      const subtotal = typeof arg?.column === "string" ? arg.column : "";
      if (expr.type !== "aggr_func" || String(expr.name).toLowerCase() !== "sum" || expr.over || !args || args.distinct || args.orderby || arg?.type !== "column_ref" || arg.table !== alias || !metrics.has(subtotal) || used.has(subtotal)) return null;
      arg.column = metrics.get(subtotal)!; used.add(subtotal);
    }
    if (used.size !== metrics.size) return null;
    let invalid = false;
    // In group/ordering/join predicates only projected keys are permitted.
    // Metric aliases may occur solely as the SUM arguments handled above.
    for (const field of [output.groupby, output.orderby, asRecord((output.from as unknown[])[1])?.on]) walkShallow(field, (node) => {
      if (node.type !== "column_ref" || node.table !== alias) return;
      const column = typeof node.column === "string" ? selected.get(node.column) : undefined;
      if (!column) invalid = true; else node.column = column;
    });
    if (invalid) return null;
    const where = structuredClone(inner.where);
    walkShallow(where, (node) => { if (node.type === "column_ref") { if (node.table && node.table !== fa) invalid = true; node.table = alias; } });
    if (invalid) return null;
    output.with = null; output.where = where;
    (output.from as unknown[])[0] = { db: null, table: fact, as: alias };
    const sql = unquoteProofIdentifiers(new loaded.Parser().sqlify(output, { database: "sqlite" }));
    return sql ? { sql, fact, grain } : null;
  } catch { return null; }
}

export interface SingleSourceProjectionLineage {
  /** Original SQL is the SQL actually submitted to the driver. */
  original_sql: string;
  /** Proof-only canonical equivalent; never execute or present it as the executed SQL. */
  proof_sql: string;
  table: string;
  output_columns: Record<string, string>;
  time_range: { start: string; end: string };
}

/**
 * Prove a deliberately narrow equivalence: one CTE or derived SELECT whose
 * inner and outer projections are direct column references to one physical
 * table. Inner filters remain unchanged, outer modifiers/filters are rejected.
 * This never grants authorization: both original and proof SQL are guarded
 * against the caller's current table rules before a result is returned.
 */
export function inspectSingleSourceProjection(rawSql: string, rules: TableRule[]): SingleSourceProjectionLineage | null {
  try {
    const original = guardSql(rawSql, rules);
    if (original.tables.length !== 1 || !original.time_range.start || !original.time_range.end) return null;
    const ast = parseReadonlySql(rawSql).ast;
    if (ast._next || ast.distinct || ast.options || ast.where || ast.groupby || ast.having || ast.orderby || ast.limit || ast.window || ast.for_update || !Array.isArray(ast.from) || ast.from.length !== 1 || !Array.isArray(ast.columns)) return null;
    const relation = asRecord(ast.from[0]); if (!relation || relation.join || relation.db) return null;
    let inner: Record<string, unknown> | undefined; let virtualAlias = "";
    if (Array.isArray(ast.with) && ast.with.length === 1 && typeof relation.table === "string" && !relation.expr) {
      const cte = asRecord(ast.with[0]); const name = cteName(cte);
      if (!name || relation.table.toLowerCase() !== name || cte?.columns) return null;
      inner = nestedSelect(cte); virtualAlias = String(relation.as || relation.table).toLowerCase();
    } else if (!ast.with && relation.expr && typeof relation.as === "string") {
      inner = asRecord(asRecord(relation.expr)?.ast); virtualAlias = relation.as.toLowerCase();
    } else return null;
    if (!inner || inner.with || inner._next || inner.distinct || inner.options || inner.groupby || inner.having || inner.orderby || inner.limit || inner.window || inner.for_update || !Array.isArray(inner.from) || inner.from.length !== 1 || !Array.isArray(inner.columns) || !inner.where) return null;
    const physical = asRecord(inner.from[0]);
    if (!physical || physical.expr || physical.join || physical.db || typeof physical.table !== "string" || physical.table.toLowerCase() !== original.tables[0]) return null;
    const physicalAlias = String(physical.as || physical.table).toLowerCase();
    if (!/^[a-z_][a-z0-9_]*$/u.test(virtualAlias) || !/^[a-z_][a-z0-9_]*$/u.test(physicalAlias)) return null;
    const inputs = new Map<string, string>();
    for (const item of inner.columns) {
      const projection = asRecord(item); const expr = asRecord(projection?.expr);
      if (!expr || expr.type !== "column_ref" || typeof expr.column !== "string" || expr.column === "*" || expr.collate || (expr.table && String(expr.table).toLowerCase() !== physicalAlias)) return null;
      const source = expr.column.toLowerCase(); const output = String(projection?.as || source).toLowerCase();
      if (!/^[a-z_][a-z0-9_]*$/u.test(source) || !/^[a-z_][a-z0-9_]*$/u.test(output) || inputs.has(output)) return null;
      inputs.set(output, source);
    }
    const outputs: Record<string, string> = Object.create(null) as Record<string, string>;
    const projections: Record<string, unknown>[] = [];
    for (const item of ast.columns) {
      const projection = asRecord(item); const expr = asRecord(projection?.expr);
      if (!projection || !expr || expr.type !== "column_ref" || typeof expr.column !== "string" || expr.collate || (expr.table && String(expr.table).toLowerCase() !== virtualAlias)) return null;
      const virtual = expr.column.toLowerCase(); const source = inputs.get(virtual);
      const output = String(projection.as || virtual).toLowerCase();
      if (!source || !/^[a-z_][a-z0-9_]*$/u.test(output) || Object.hasOwn(outputs, output)) return null;
      outputs[output] = source;
      projections.push({ ...projection, expr: { ...expr, table: physical.as || null, column: source }, as: output === source ? null : output });
    }
    if (!projections.length) return null;
    const proofAst = { ...ast, with: null, columns: projections, from: inner.from, where: inner.where };
    // sqlify emits double-quoted identifiers that this parser reads back as
    // double_quote_string rather than column_ref. Unquote identifiers only
    // outside string literals; never change literal contents.
    const proofSql = unquoteProofIdentifiers(new loaded.Parser().sqlify(proofAst, { database: "sqlite" }));
    if (!proofSql) return null;
    const proof = guardSql(proofSql, rules);
    if (proof.tables.length !== 1 || proof.tables[0] !== original.tables[0] || proof.time_range.start !== original.time_range.start || proof.time_range.end !== original.time_range.end) return null;
    return { original_sql: original.sql, proof_sql: proofSql, table: original.tables[0]!, output_columns: outputs, time_range: original.time_range };
  } catch { return null; }
}

function unquoteProofIdentifiers(sql: string): string | null {
  let output = "";
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i]!;
    if (char === "'") {
      output += char; let closed = false;
      while (++i < sql.length) {
        const current = sql[i]!; output += current;
        if (current === "\\" && i + 1 < sql.length) { output += sql[++i]; continue; }
        if (current === "'") {
          if (sql[i + 1] === "'") { output += sql[++i]; continue; }
          closed = true; break;
        }
      }
      if (!closed) return null;
      continue;
    }
    if (char === '"') {
      const end = sql.indexOf('"', i + 1); if (end < 0) return null;
      const identifier = sql.slice(i + 1, end);
      if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) return null;
      output += identifier; i = end; continue;
    }
    output += char;
  }
  return output;
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

function authorizeSelect(statement: Record<string, unknown>, cteNames: Set<string>, rules: Map<string, TableRule>, inheritedSchemas: Map<string, Set<string>> = new Map()): string[] {
  const localCtes = new Set(cteNames);
  const localSchemas = new Map(inheritedSchemas);
  const columns: string[] = [];
  if (Array.isArray(statement.with)) {
    for (const item of statement.with) {
      const record = asRecord(item);
      const body = nestedSelect(item);
      if (!body || record?.columns) throw new SqlRejected("cte_structure_unsupported", "无法证明 CTE 输出列。");
      columns.push(...authorizeSelect(body, localCtes, rules, localSchemas));
      const name = cteName(record);
      if (!name || localCtes.has(name)) throw new SqlRejected("cte_structure_unsupported", "CTE 名称缺失或重复。");
      const schema = projectionNames(body);
      if (!schema) throw new SqlRejected("cte_structure_unsupported", "CTE 输出列必须可唯一确定。");
      localCtes.add(name); localSchemas.set(name, schema);
    }
  }
  const direct = directTables(statement, localCtes);
  const scopedAliases = new Map<string, string>();
  const virtualAliases = new Map<string, Set<string>>();
  if (Array.isArray(statement.from)) {
    for (const item of statement.from) {
      const relation = asRecord(item);
      if (relation?.expr) {
        const body = asRecord(asRecord(relation.expr)?.ast);
        const alias = typeof relation.as === "string" ? relation.as.toLowerCase() : "";
        const schema = body && projectionNames(body);
        if (!alias || !schema || virtualAliases.has(alias) || scopedAliases.has(alias)) throw new SqlRejected("derived_structure_unsupported", "派生表必须有唯一别名和可确定的输出列。");
        virtualAliases.set(alias, schema);
        continue;
      }
      if (typeof relation?.table !== "string") continue;
      const table = relation.table.toLowerCase();
      const alias = typeof relation.as === "string" && relation.as ? relation.as.toLowerCase() : table;
      if (scopedAliases.has(alias) || virtualAliases.has(alias)) throw new SqlRejected("join_column_ambiguous", "同一查询层级不能重复使用表别名。");
      if (localCtes.has(table)) {
        const schema = localSchemas.get(table);
        if (!schema) throw new SqlRejected("cte_structure_unsupported", "不能确认 CTE 输出列。");
        virtualAliases.set(alias, schema); continue;
      }
      scopedAliases.set(alias, table);
    }
  }
  if (virtualAliases.size && (virtualAliases.size !== 1 || direct.length || (Array.isArray(statement.from) && statement.from.length !== 1))) throw new SqlRejected("join_structure_unsupported", "CTE 或派生表参与 JOIN 的粒度尚未证明。");
  const localColumns = shallowColumns(statement);
  if (localColumns.some((column) => column === "*")) throw new SqlRejected("wildcard_projection", "禁止 SELECT * 或 table.*，不会按契约展开通配符");
  if (hasOperator(statement.where, "OR")) throw new SqlRejected("unsafe_predicate", "不接受可能绕过日期范围的 OR 条件");
  const owners = direct.map((table) => rules.get(table)).filter((rule): rule is TableRule => rule !== undefined);
  const projectionAliases = new Set((Array.isArray(statement.columns) ? statement.columns : []).flatMap((entry) => {
    const col = asRecord(entry); return typeof col?.as === "string" ? [col.as.toLowerCase()] : [];
  }));
  if (owners.some((rule) => rule.must_filter.some((field) => projectionAliases.has(field)))) throw new SqlRejected("date_alias_shadowing", "输出别名不能遮蔽必须过滤的日期字段。");
  for (const key of ["columns", "where", "groupby", "having", "orderby", "from"]) {
    walkShallow(statement[key], (record) => {
      const column = identifierName(record); if (!column) return;
      if (column === "*") throw new SqlRejected("wildcard_projection", "禁止 SELECT * 或 table.*");
      if (record.type === "column_ref" && typeof record.table === "string" && record.table) {
        const alias = record.table.toLowerCase();
        const table = scopedAliases.get(alias); const schema = virtualAliases.get(alias);
        if (schema) { if (!schema.has(column)) throw new SqlRejected("column_not_in_contract", `字段 ${column} 不在派生结果中`); return; }
        if (!table) throw new SqlRejected("column_scope_unsupported", "无法确认列所属表或关联子查询的作用域。");
        const rule = rules.get(table);
        if (rule?.sensitive_columns.includes(column)) throw new SqlRejected("sensitive_field", `字段 ${column} 是敏感字段，不能出现在查询中`);
        if (!rule?.allowed_columns.includes(column)) throw new SqlRejected("column_not_in_contract", `字段 ${column} 不属于该别名对应的契约`);
        return;
      }
      if (owners.some((rule) => rule.sensitive_columns.includes(column))) throw new SqlRejected("sensitive_field", `字段 ${column} 是敏感字段，不能出现在查询中`);
      if (owners.some((rule) => rule.allowed_columns.includes(column)) || [...virtualAliases.values()].some((schema) => schema.has(column))) return;
      if (["orderby", "groupby", "having"].includes(key) && projectionAliases.has(column)) return;
      if (owners.length || virtualAliases.size) throw new SqlRejected("column_not_in_contract", `字段 ${column} 不在当前来源允许的字段中`);
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
      const days = (Date.parse(`${bounds.end}T00:00:00.000Z`) - Date.parse(`${bounds.start}T00:00:00.000Z`)) / 86_400_000 + 1;
      if (days > MAX_SCAN_DAYS) throw new SqlRejected("scan_date_limit", `单次查询日期范围不能超过 ${MAX_SCAN_DAYS} 天`);
    }
  }
  walkShallow(statement, (record) => {
    const nested = asRecord(record.ast);
    if (nested?.type) columns.push(...authorizeSelect(nested, localCtes, rules, localSchemas));
  });
  const next = asRecord(statement._next);
  if (next) columns.push(...authorizeSelect(next, localCtes, rules, localSchemas));
  return columns;
}

/** Only explicit, unique output identifiers can become a virtual schema. */
function projectionNames(statement: Record<string, unknown>): Set<string> | null {
  if (statement._next || !Array.isArray(statement.columns) || !statement.columns.length) return null;
  const result = new Set<string>();
  for (const item of statement.columns) {
    const projection = asRecord(item); const expr = asRecord(projection?.expr);
    const name = typeof projection?.as === "string" && projection.as ? projection.as : expr?.type === "column_ref" && typeof expr.column === "string" ? expr.column : "";
    const normalized = name.toLowerCase();
    if (!/^[a-z_][a-z0-9_]*$/u.test(normalized) || result.has(normalized)) return null;
    result.add(normalized);
  }
  return result;
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
    if (name === "todate" && !clickHouseDateConstant(record)) throw new SqlRejected("unsafe_date_function", "toDate 仅接受一个 ClickHouse Date 范围内的规范日期字符串常量。");
    if ((name === "isnull" || name === "isnotnull") && !directNullFunction(record)) throw new SqlRejected("unsafe_null_function", "空值函数仅允许直接列引用。");
    if (name === "countif" && !safeCountIf(record)) throw new SqlRejected("unsafe_conditional_aggregate", "countIf 仅接受受限的列与常量条件。");
    if (CLICKHOUSE_DATE_PROJECTIONS.has(name) && !directNullFunction(record)) throw new SqlRejected("unsafe_date_function", "日期投影函数仅接受一个直接列引用。");
  });
}

function callArguments(value: Record<string, unknown>): unknown[] | null {
  const args = asRecord(value.args);
  return args?.type === "expr_list" && Array.isArray(args.value) && !value.over ? args.value : null;
}

function directColumn(value: unknown): boolean {
  const col = asRecord(value);
  return col?.type === "column_ref" && typeof col.column === "string" && /^[a-z_][a-z0-9_]*$/iu.test(col.column) && (!col.table || typeof col.table === "string" && /^[a-z_][a-z0-9_]*$/iu.test(col.table));
}

function directNullFunction(value: Record<string, unknown>): boolean {
  const args = callArguments(value);
  return args?.length === 1 && directColumn(args[0]);
}

/** Accept only a bounded, data-only conditional predicate. Field access is
 * still checked separately against the exact scoped table and its contract. */
function safeCountIf(value: Record<string, unknown>): boolean {
  const args = callArguments(value);
  if (!args || args.length !== 1) return false;
  let nodes = 0;
  const predicate = (item: unknown): boolean => {
    if (++nodes > 32) return false;
    const node = asRecord(item); if (!node) return false;
    const fn = functionName(node);
    if (fn === "isnull" || fn === "isnotnull") return directNullFunction(node);
    if (node.type !== "binary_expr") return false;
    const op = String(node.operator).toUpperCase();
    if (op === "AND" || op === "OR") return predicate(node.left) && predicate(node.right);
    if (!directColumn(node.left)) return false;
    const right = asRecord(node.right); if (!right) return false;
    if (op === "IS" || op === "IS NOT") return right.type === "null";
    if (!["=", "!=", "<>", "<", "<=", ">", ">="].includes(op)) return false;
    return right.type === "number" && typeof right.value === "number" && Number.isFinite(right.value)
      || right.type === "single_quote_string" && typeof right.value === "string" && right.value.length <= 1024;
  };
  return predicate(args[0]);
}

/** Only the one-argument, literal ClickHouse Date conversion is safe to
 * identify with an inclusive calendar bound. Dynamic expressions, timezones,
 * numeric arguments and conversions outside Date's range remain unsupported. */
function clickHouseDateConstant(value: unknown): string | undefined {
  const call = asRecord(value);
  if (!call || call.type !== "function" || functionName(call) !== "todate" || call.over) return undefined;
  const args = asRecord(call.args); const list = args?.type === "expr_list" && Array.isArray(args.value) ? args.value : [];
  if (list.length !== 1) return undefined;
  const item = asRecord(list[0]);
  if (item?.type !== "single_quote_string" || typeof item.value !== "string" || !isCalendarDate(item.value) || item.value < "1970-01-01" || item.value > "2149-06-06") return undefined;
  return item.value;
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
  const lower = (value: string) => { bounds.start = bounds.start && bounds.start > value ? bounds.start : value; };
  const upper = (value: string) => { bounds.end = bounds.end && bounds.end < value ? bounds.end : value; };
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
        lower(start);
        upper(end);
      }
      return;
    }
    if (!matches(record.left)) return;
    const value = literal(record.right);
    if (!value) return;
    if (operator === "=") { lower(value); upper(value); }
    if (operator === ">=" || operator === ">") lower(value);
    if (operator === "<=" || operator === "<") upper(value);
  };
  visit(where);
  return bounds;
}

/** Exact inclusive predicates for evidence, restricted to one DATE column.
 * The caller still has to prove every other conjunct and match the final range. */
export function exactCalendarDatePredicate(node: unknown, column: string, qualifier: string): { start?: string; end?: string } | null {
  const expr = asRecord(node); const left = asRecord(expr?.left);
  if (!expr || expr.type !== "binary_expr" || !left || left.type !== "column_ref" || left.column !== column || (left.table && left.table !== qualifier)) return null;
  const date = (value: unknown): string | null => {
    const entry = asRecord(value);
    if (entry?.type === "single_quote_string" && typeof entry.value === "string" && isCalendarDate(entry.value)) return entry.value;
    return clickHouseDateConstant(entry) ?? null;
  };
  if (expr.operator === "BETWEEN") {
    const right = asRecord(expr.right); const list = right?.type === "expr_list" && Array.isArray(right.value) ? right.value : [];
    const start = date(list[0]); const end = date(list[1]);
    return list.length === 2 && start && end && start <= end ? { start, end } : null;
  }
  const value = date(expr.right);
  if (!value) return null;
  if (expr.operator === "=") return { start: value, end: value };
  if (expr.operator === ">=") return { start: value };
  if (expr.operator === "<=") return { end: value };
  return null;
}

function assertAstBudget(root: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++nodes > 20_000 || depth > 128) throw new SqlRejected("sql_complexity_limit", "SQL 语法树过大或过深");
    if (Array.isArray(value)) for (const child of value) pending.push({ value: child, depth: depth + 1 });
    else if (value && typeof value === "object") for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
  }
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
  if (record.type === "single_quote_string" && typeof record.value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(record.value)) return record.value;
  return clickHouseDateConstant(record);
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
