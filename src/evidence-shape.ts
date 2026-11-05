import { clickHouseAggregateShape } from "./clickhouse-aggregate-shape.js";
import { parseReadonlySql } from "./sql.js";
import type { DataContract, QueryResource } from "./types.js";

/** Projection shape only. Callers must separately recheck authority, query
 * scope, values, completeness and freshness. */
export function queryEvidenceShape(source: QueryResource, contract: DataContract): Record<string, unknown> | null {
  if (source.engine === "clickhouse-local" && source.sql_review_engine === "clickhouse_ast_direct") return clickHouseAggregateShape(source.sql, contract.table);
  try { return parseReadonlySql(source.sql).ast; } catch { return null; }
}
