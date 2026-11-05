import type { DataContract } from "./types.js";
import type { GuardedSql, TableRule } from "./sql.js";
import { clickHouseCoverageAnalysis } from "./clickhouse-coverage-scope.js";
import { preflightClickHouseSql } from "./clickhouse-sql-preflight.js";
import { clickHouseReviewPolicy, safeNativeConditionalAggregates, safeNativeDateFunctions } from "./clickhouse-review-policy.js";
import { reviewSql } from "./clickhouse-review.js";
import { clickHouseScopedProjection } from "./clickhouse-scoped-projection.js";
import { clickHouseAggregateProjection } from "./clickhouse-aggregate-projection.js";
import { clickHouseScanRange } from "./clickhouse-scan-range.js";

/** A native path for one physical fact table with a proven scan range. Exact
 * business coverage is a separate proof and may remain unknown. */
export function reviewDirectClickHouse(sql: string, contract: DataContract, rule: TableRule, database: string, maxRows: number): GuardedSql | null {
  const preflight = preflightClickHouseSql(sql);
  if (!preflight.ok || preflight.tables.length !== 1 || preflight.tables[0] !== rule.table || contract.table !== rule.table) return null;
  const scope = clickHouseCoverageAnalysis(sql, contract);
  const range = scope?.time_range ?? clickHouseScanRange(sql, contract);
  if (!range || !safeNativeConditionalAggregates(sql) || !safeNativeDateFunctions(sql, rule)) return null;
  try {
    const review = reviewSql(sql, clickHouseReviewPolicy(database, [rule], maxRows));
    if (!review.ok || review.tables.length !== 1 || review.tables[0] !== `${database}.${rule.table}`) return null;
    return { sql, tables: [rule.table], columns: [], time_range: range, equalities: scope?.scope.equalities ?? {} };
  } catch { return null; }
}

/** Review the original scoped query and independently derive a narrow,
 * equivalent direct or grouped-SUM projection proof. Only the original SQL is executed. */
export function reviewScopedClickHouse(sql: string, contract: DataContract, rule: TableRule, database: string, maxRows: number): { guarded: GuardedSql; proofSql: string } | null {
  const preflight = preflightClickHouseSql(sql);
  if (!preflight.ok || preflight.tables.length !== 1 || preflight.tables[0] !== rule.table || contract.table !== rule.table || !safeNativeConditionalAggregates(sql) || !safeNativeDateFunctions(sql, rule)) return null;
  const proofSql = clickHouseScopedProjection(sql, rule.table) ?? clickHouseAggregateProjection(sql, contract); if (!proofSql) return null;
  const proof = reviewDirectClickHouse(proofSql, contract, rule, database, maxRows); if (!proof) return null;
  try {
    const review = reviewSql(sql, clickHouseReviewPolicy(database, [rule], maxRows));
    if (!review.ok || review.tables.length !== 1 || review.tables[0] !== `${database}.${rule.table}`) return null;
    return { guarded: { ...proof, sql }, proofSql };
  } catch { return null; }
}
