import type { DataContract } from "./types.js";
import type { GuardedSql, TableRule } from "./sql.js";
import { clickHouseCoverageAnalysis } from "./clickhouse-coverage-scope.js";
import { preflightClickHouseSql } from "./clickhouse-sql-preflight.js";
import { clickHouseReviewPolicy, safeNativeConditionalAggregates, safeNativeDateFunctions } from "./clickhouse-review-policy.js";
import { reviewSql } from "./clickhouse-review.js";
import { clickHouseScopedProjection } from "./clickhouse-scoped-projection.js";

/** A deliberately narrow native path: one physical fact table and an exact
 * coverage scope. Complex queries remain on the prior guarded path. */
export function reviewDirectClickHouse(sql: string, contract: DataContract, rule: TableRule, database: string, maxRows: number): GuardedSql | null {
  const preflight = preflightClickHouseSql(sql);
  if (!preflight.ok || preflight.tables.length !== 1 || preflight.tables[0] !== rule.table || contract.table !== rule.table) return null;
  const scope = clickHouseCoverageAnalysis(sql, contract);
  if (!scope || !safeNativeConditionalAggregates(sql) || !safeNativeDateFunctions(sql, rule)) return null;
  try {
    const review = reviewSql(sql, clickHouseReviewPolicy(database, [rule], maxRows));
    if (!review.ok || review.tables.length !== 1 || review.tables[0] !== `${database}.${rule.table}`) return null;
    return { sql, tables: [rule.table], columns: [], time_range: scope.time_range, equalities: scope.scope.equalities };
  } catch { return null; }
}

/** Review the original scoped query and independently derive a narrow,
 * equivalent identity-projection proof. Only the original SQL is executed. */
export function reviewScopedClickHouse(sql: string, contract: DataContract, rule: TableRule, database: string, maxRows: number): { guarded: GuardedSql; proofSql: string } | null {
  const preflight = preflightClickHouseSql(sql);
  if (!preflight.ok || preflight.tables.length !== 1 || preflight.tables[0] !== rule.table || contract.table !== rule.table || !safeNativeConditionalAggregates(sql) || !safeNativeDateFunctions(sql, rule)) return null;
  const proofSql = clickHouseScopedProjection(sql, rule.table); if (!proofSql) return null;
  const proof = reviewDirectClickHouse(proofSql, contract, rule, database, maxRows); if (!proof) return null;
  try {
    const review = reviewSql(sql, clickHouseReviewPolicy(database, [rule], maxRows));
    if (!review.ok || review.tables.length !== 1 || review.tables[0] !== `${database}.${rule.table}`) return null;
    return { guarded: { ...proof, sql }, proofSql };
  } catch { return null; }
}
