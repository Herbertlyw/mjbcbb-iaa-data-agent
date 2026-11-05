import type { TableRule } from "./sql.js";
import type { SqlReviewPolicy } from "./clickhouse-review.js";
import { parse } from "@clickhouse/parser";
import { isCalendarDate } from "./config.js";

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Translate already bound and authorized contract rules to the original CK
 * reviewer. This is not yet a complete JOIN or result-lineage authorization. */
export function clickHouseReviewPolicy(database: string, rules: readonly TableRule[], maxRows: number): SqlReviewPolicy {
  if (!identifier.test(database) || !Number.isSafeInteger(maxRows) || maxRows < 1 || !rules.length) throw new Error("clickhouse_review_policy_invalid");
  const seenTables = new Set<string>();
  const tables = rules.map((rule) => {
    if (!identifier.test(rule.table) || seenTables.has(rule.table) || rule.must_filter.length > 1) throw new Error("clickhouse_review_policy_invalid");
    seenTables.add(rule.table);
    const sensitive = new Set(rule.sensitive_columns);
    const fields = new Set([...rule.allowed_columns, ...rule.sensitive_columns]);
    if (!fields.size || [...fields].some((field) => !identifier.test(field)) || rule.must_filter.some((field) => !rule.allowed_columns.includes(field) || sensitive.has(field))) throw new Error("clickhouse_review_policy_invalid");
    const partitionColumn = rule.must_filter[0];
    if (partitionColumn && rule.column_types?.[partitionColumn]?.replace(/\s/gu, "").toLowerCase() !== "date") throw new Error("clickhouse_review_partition_unsupported");
    return { fqn: `${database}.${rule.table}`, columns: [...fields].map((name) => ({ name, privacy: sensitive.has(name) ? "forbidden" as const : "ordinary" as const })), maxScanDays: 400, ...(partitionColumn ? { partitionColumn, scanKind: "day" as const } : { scanKind: "unpartitioned" as const }) };
  });
  const aggregates = ["sum", "count", "min", "max", "avg", "countIf", "sumIf"];
  return { defaultDatabase: database, allowDetail: true, tables, maxRows, maxSqlBytes: 64 * 1024, aggregateFunctions: aggregates, allowedFunctions: [...aggregates, "toDate", "toYear", "toMonth", "toYYYYMM", "toStartOfMonth", "toStartOfDay", "isNull", "isNotNull", "ifNull", "nullIf", "lower", "upper"] };
}

/** Keep the prior explicitly bounded countIf grammar while migrating the
 * authorization tree. Field grants are checked independently by reviewSql. */
export function safeNativeConditionalAggregates(sql: string): boolean {
  let statements: unknown[];
  try { statements = parse(sql, { locations: false }); } catch { return false; }
  const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const column = (value: unknown) => { const node = object(value); return node?.type === "Identifier" && typeof node.name === "string" && /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/u.test(node.name); };
  let predicateNodes = 0;
  const predicate = (value: unknown): boolean => {
    if (++predicateNodes > 32) return false;
    const node = object(value); if (node?.type !== "Function" || !Array.isArray(node.arguments)) return false;
    const name = String(node.name).toLowerCase(); const args = node.arguments;
    if (name === "and" || name === "or") return args.length >= 2 && args.every(predicate);
    if (name === "isnull" || name === "isnotnull") return args.length === 1 && column(args[0]);
    if (!["equals", "notequals", "less", "lessorequals", "greater", "greaterorequals"].includes(name) || args.length !== 2 || !column(args[0])) return false;
    const literal = object(args[1]);
    return literal?.type === "Literal" && ((literal.value_type === "String" && typeof literal.value === "string" && literal.value.length <= 1024) || (["UInt64", "Int64", "Float64"].includes(String(literal.value_type)) && (typeof literal.value === "number" && Number.isFinite(literal.value) || typeof literal.value === "string" && /^-?\d+(?:\.\d+)?$/u.test(literal.value) && literal.value.length <= 128)));
  };
  const pending: unknown[] = [...statements]; let nodes = 0;
  while (pending.length) {
    if (++nodes > 20_000) return false;
    const value = pending.pop(); if (Array.isArray(value)) { pending.push(...value); continue; }
    const node = object(value); if (!node) continue;
    if (node.type === "Function" && ["countif", "sumif"].includes(String(node.name).toLowerCase())) {
      const name = String(node.name).toLowerCase();
      if (!Array.isArray(node.arguments) || (name === "countif" ? node.arguments.length !== 1 || !predicate(node.arguments[0]) : node.arguments.length !== 2 || !column(node.arguments[0]) || !predicate(node.arguments[1]))) return false;
    }
    for (const [key, child] of Object.entries(node)) if (key !== "location" && key !== "parent") pending.push(child);
  }
  return true;
}

/** Preserve the existing direct Date-column and literal toDate restrictions. */
export function safeNativeDateFunctions(sql: string, rule: TableRule): boolean {
  let statements: unknown[];
  try { statements = parse(sql, { locations: false }); } catch { return false; }
  const pending: unknown[] = [...statements]; let nodes = 0;
  const projections = new Set(["toyear", "tomonth", "toyyyymm", "tostartofmonth", "tostartofday"]);
  while (pending.length) {
    if (++nodes > 20_000) return false;
    const value = pending.pop(); if (Array.isArray(value)) { pending.push(...value); continue; }
    if (!value || typeof value !== "object") continue;
    const node = value as Record<string, unknown>;
    if (node.type === "Function") {
      const name = String(node.name).toLowerCase(); const args = node.arguments;
      if (name === "todate") {
        const literal = Array.isArray(args) && args.length === 1 && args[0] && typeof args[0] === "object" ? args[0] as Record<string, unknown> : null;
        if (!literal || literal.type !== "Literal" || literal.value_type !== "String" || typeof literal.value !== "string" || !isCalendarDate(literal.value) || literal.value < "1970-01-01" || literal.value > "2149-06-06") return false;
      }
      if (projections.has(name)) {
        const col = Array.isArray(args) && args.length === 1 && args[0] && typeof args[0] === "object" ? args[0] as Record<string, unknown> : null;
        const parts = col && typeof col.name === "string" ? (Array.isArray(col.name_parts) ? col.name_parts : col.name.split(".")) : [];
        const field = parts.at(-1);
        if (col?.type !== "Identifier" || typeof field !== "string" || !rule.must_filter.includes(field) || rule.column_types?.[field]?.replace(/\s/gu, "").toLowerCase() !== "date") return false;
      }
      if (name === "isnull" || name === "isnotnull") {
        const col = Array.isArray(args) && args.length === 1 && args[0] && typeof args[0] === "object" ? args[0] as Record<string, unknown> : null;
        if (col?.type !== "Identifier" || typeof col.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/u.test(col.name)) return false;
      }
      if (name === "ifnull" || name === "nullif") {
        if (!Array.isArray(args) || args.length !== 2) return false;
        const first = args[0] && typeof args[0] === "object" ? args[0] as Record<string, unknown> : null;
        const second = args[1] && typeof args[1] === "object" ? args[1] as Record<string, unknown> : null;
        const direct = first?.type === "Identifier" && typeof first.name === "string" && /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/u.test(first.name);
        const count = first?.type === "Function" && String(first.name).toLowerCase() === "count" && Array.isArray(first.arguments) && (first.arguments.length === 0 || first.arguments.length === 1 && (first.arguments[0] as Record<string, unknown>)?.type === "Asterisk");
        if (!(direct || name === "nullif" && count) || second?.type !== "Literal" || !["String", "UInt64", "Int64", "Float64"].includes(String(second.value_type))) return false;
      }
    }
    for (const [key, child] of Object.entries(node)) if (key !== "location" && key !== "parent") pending.push(child);
  }
  return true;
}
