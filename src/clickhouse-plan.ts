// One ClickHouse admission plan shared by execution and resource revalidation.
import { createHash } from "node:crypto";
import { parse } from "@clickhouse/parser";
import { reviewSql } from "./clickhouse-review.js";
import {
  clickHouseReviewPolicy,
  safeNativeConditionalAggregates,
  safeNativeDateFunctions,
} from "./clickhouse-review-policy.js";
import {
  authorizeClickHouseDirect,
  authorizeClickHouseJoin,
  authorizeClickHouseScoped,
  preflightClickHouseSql,
} from "./clickhouse-sql-preflight.js";
import {
  reviewDirectClickHouse,
  reviewScopedClickHouse,
} from "./clickhouse-direct-review.js";
import { clickHouseRawDimensionJoin } from "./clickhouse-raw-join.js";
import {
  prepareJoinCoverageEvidence,
  prepareJoinEvidence,
  type JoinEvidencePlan,
} from "./join-evidence.js";
import type { DataContract, JoinConstraint } from "./types.js";
import { SqlRejected, type GuardedSql, type TableRule } from "./sql.js";

export interface ClickHousePlanReceipt {
  version: 1;
  sql_hash: string;
  engine:
    | "clickhouse_ast_direct"
    | "clickhouse_ast_scoped"
    | "clickhouse_ast_scoped_observation"
    | "clickhouse_ast_join";
  tables: string[];
  time_range: { start: string; end: string };
  sql_limited: boolean;
  /** For unpartitioned dimensions, time_range denotes contract availability,
   * not a business-date filter or a claim of daily coverage. */
  scope?: {
    kind: "dimension_snapshot";
    contract_valid_from: string;
    contract_valid_until: string;
  };
  proof_sql?: string;
}
export interface ClickHousePlan {
  guarded: GuardedSql;
  receipt: ClickHousePlanReceipt;
  join: JoinEvidencePlan | null;
  coverage: "direct" | "proof" | "join" | "dimension" | "unknown";
}

/** Authorize every physical scope before selecting optional business evidence.
 * An unsupported shape never falls through to a different SQL dialect. */
export function planClickHouse(
  sql: string,
  rules: TableRule[],
  contracts: DataContract[],
  joins: JoinConstraint[],
  database: string,
  maxRows: number,
): ClickHousePlan {
  const inspected = preflightClickHouseSql(sql);
  if (!inspected.ok)
    throw new SqlRejected(
      inspected.code,
      "ClickHouse 查询来源或语法未通过只读审查。",
    );
  for (const decision of [
    authorizeClickHouseJoin(sql, rules),
    authorizeClickHouseScoped(sql, rules),
    authorizeClickHouseDirect(sql, rules),
  ]) {
    if (decision.applicable && !decision.ok)
      throw new SqlRejected(decision.code, "查询字段或作用域未获授权。");
  }
  const policy = clickHouseReviewPolicy(database, rules, maxRows);
  const review = reviewSql(sql, policy);
  if (!review.ok) {
    const codes: Record<string, string> = {
      missing_partition_predicate: "unbounded_query",
      unsafe_partition_or: "unsafe_predicate",
      wildcard_forbidden: "wildcard_projection",
      scan_limit_exceeded: "scan_date_limit",
    };
    const rejectedFunction = review.reason === "function_not_allowed" &&
      typeof review.detail === "string" && /^[a-z_][a-z0-9_]{0,63}$/u.test(review.detail)
      ? review.detail : null;
    const specificHint = rejectedFunction === "countdistinct"
      ? "COUNT(DISTINCT ...) 当前未通过函数授权；普通 COUNT 不能替代去重计数。若有完整、授权且未截断的明细，可另行评估支持的计算；否则说明限制。"
      : rejectedFunction === "multiif"
        ? "CASE 条件表达式当前未通过函数授权；不能直接假定 sumIf 与原表达式的 NULL、ELSE 和空集语义相同。请先核对口径和受支持形状，否则说明限制。"
        : null;
    throw new SqlRejected(
      codes[review.reason] ?? review.reason,
      specificHint ?? (rejectedFunction
        ? `函数 ${rejectedFunction} 不在当前允许范围。不要重复使用；可改用受支持的 SUM、COUNT、受控 countIf 或读取有界明细后使用计算工具。`
        : "ClickHouse 权限、函数或封闭扫描范围未通过审查。"),
    );
  }
  const features = queryFeatures(sql);
  if (features.unsupported)
    throw new SqlRejected(
      "clickhouse_shape_unsupported",
      "该查询结构不在当前支持范围；请使用有界 SELECT 和登记关联。",
    );
  const partitionedRules = rules.filter((rule) => rule.must_filter.length > 0);
  if (
    !safeNativeConditionalAggregates(sql) ||
    !(partitionedRules.length ? partitionedRules : rules).some((rule) =>
      safeNativeDateFunctions(sql, rule),
    )
  ) {
    throw new SqlRejected(
      "clickhouse_expression_unsupported",
      "条件聚合或日期表达式不在支持范围。",
    );
  }
  const dimension =
    inspected.tables.length === 1
      ? contracts.find(
          (contract) =>
            contract.table === inspected.tables[0] &&
            !contract.series &&
            contract.must_filter.length === 0 &&
            contract.grain?.length,
        )
      : undefined;
  if (dimension && !features.joins) {
    const range = { start: dimension.valid_from, end: dimension.valid_until };
    return {
      guarded: {
        sql,
        tables: inspected.tables,
        columns: [],
        time_range: range,
        equalities: {},
      },
      receipt: {
        version: 1,
        sql_hash: createHash("sha256").update(sql).digest("hex"),
        engine: "clickhouse_ast_direct",
        tables: inspected.tables,
        time_range: range,
        sql_limited: features.limited,
        scope: {
          kind: "dimension_snapshot",
          contract_valid_from: dimension.valid_from,
          contract_valid_until: dimension.valid_until,
        },
      },
      join: null,
      coverage: "dimension",
    };
  }
  const scans = review.scans;
  if (!scans.length || scans.some((scan) => scan.start > scan.end))
    throw new SqlRejected("missing_time_range", "查询须有有效的封闭日期范围。");
  const range = {
    start: scans.map((scan) => scan.start).sort()[0]!,
    end: scans
      .map((scan) => scan.end)
      .sort()
      .at(-1)!,
  };
  if ((Date.parse(range.end) - Date.parse(range.start)) / 86_400_000 + 1 > 400)
    throw new SqlRejected("date_range_limit", "查询总日期范围超过 400 天。");
  const receipt: ClickHousePlanReceipt = {
    version: 1,
    sql_hash: createHash("sha256").update(sql).digest("hex"),
    engine: "clickhouse_ast_scoped_observation",
    tables: inspected.tables,
    time_range: range,
    sql_limited: features.limited,
  };
  const guarded: GuardedSql = {
    sql,
    tables: inspected.tables,
    columns: [],
    time_range: range,
    equalities: {},
  };

  if (features.joins || inspected.tables.length !== 1) {
    const relationship =
      inspected.tables.length === 2
        ? joins.find(
            (item) =>
              item.tables.length === 2 &&
              inspected.tables.every((table) => item.tables.includes(table)),
          )
        : undefined;
    if (inspected.tables.length === 2 && !relationship)
      throw new SqlRejected(
        "missing_join_constraint",
        "物理来源之间没有登记连接关系。",
      );
    if (
      relationship &&
      contracts.length === 2 &&
      contracts.every((contract) =>
        contract.grain?.some((column) => !relationship.keys.includes(column)),
      )
    )
      throw new SqlRejected(
        "join_grain_mismatch",
        "连接两侧均有登记键之外的粒度，无法排除重复放大；请分别查询后按键对齐。",
      );
    const fact = contracts.find((contract) => contract.series);
    const dimension = contracts.find((contract) => !contract.series);
    if (
      inspected.tables.length !== 2 ||
      !fact ||
      !dimension ||
      features.limited
    )
      throw new SqlRejected(
        "join_structure_unsupported",
        "仅支持登记事实表与维表的有界关联。",
      );
    const join =
      (fact.series?.coverage_domains
        ? prepareJoinCoverageEvidence(sql, fact, dimension, joins, true)
        : null) ?? prepareJoinEvidence(sql, fact, dimension, joins, true);
    if (join) {
      // Proof tuples can read physical grain fields not projected by the
      // model's SQL. Those reads must obey the same current role bindings.
      const proofColumns = [
        { table: fact.table, column: join.dateColumn },
        ...join.proofFields.map((item) => ({ table: item.table === "fact" ? fact.table : dimension.table, column: item.column })),
      ];
      if (proofColumns.some(({ table, column }) => {
        const rule = rules.find((item) => item.table === table);
        return !rule || !rule.allowed_columns.includes(column) || rule.sensitive_columns.includes(column);
      }))
        throw new SqlRejected("join_proof_unauthorized", "关联证明需要读取当前主体未获授权的字段，不能执行该证明。" );
      if (join.authorizationSql && !reviewSql(join.authorizationSql, policy).ok)
        throw new SqlRejected(
          "join_proof_unauthorized",
          "关联证明查询未获授权。",
        );
      return {
        guarded: {
          ...guarded,
          time_range: join.range,
          equalities: join.factFilters,
        },
        receipt: {
          ...receipt,
          engine: "clickhouse_ast_join",
          time_range: { start: join.range.start, end: join.range.end },
        },
        join,
        coverage: "join",
      };
    }
    if (!clickHouseRawDimensionJoin(sql, fact, dimension, joins))
      throw new SqlRejected(
        "join_key_mismatch",
        "关联键、粒度、分组或聚合字段无法由当前契约证明。请读取两侧契约，在 ON 中使用完整的全部登记键并限定表别名；键完整仍被拒绝时，不要删键，应检查分组、可汇总指标与粒度，或分别查询。",
      );
    return {
      guarded,
      receipt: { ...receipt, engine: "clickhouse_ast_join" },
      join: null,
      coverage: "unknown",
    };
  }
  const contract = contracts.find((item) => item.table === inspected.tables[0]);
  const rule = rules.find((item) => item.table === contract?.table);
  if (!contract || !rule)
    throw new SqlRejected("missing_data_contract", "缺少当前物理表契约。");
  // Coverage and expression semantics can remain unknown after authorization.
  // They enrich a plan; they never choose another authorization policy.
  const direct = reviewDirectClickHouse(sql, contract, rule, database, maxRows);
  if (direct)
    return {
      guarded: direct,
      receipt: { ...receipt, engine: "clickhouse_ast_direct" },
      join: null,
      coverage: "direct",
    };
  const scoped = reviewScopedClickHouse(sql, contract, rule, database, maxRows);
  if (scoped)
    return {
      guarded: scoped.guarded,
      receipt: {
        ...receipt,
        engine: "clickhouse_ast_scoped",
        proof_sql: scoped.proofSql,
      },
      join: null,
      coverage: "proof",
    };
  return { guarded, receipt, join: null, coverage: "unknown" };
}

/** A structural capability check, independent of field/date authorization. */
function queryFeatures(sql: string): {
  limited: boolean;
  joins: boolean;
  unsupported: boolean;
} {
  const pending: unknown[] = parse(sql, { locations: false });
  let limited = false;
  let joins = false;
  let unsupported = false;
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const node = value as Record<string, unknown>;
    if (
      node.table_join ||
      (node.type === "TablesInSelectQuery" &&
        Array.isArray(node.children) &&
        node.children.length > 1)
    )
      joins = true;
    if (node.type === "SelectQuery") {
      limited ||= Boolean(node.limit || node.limit_by);
      unsupported ||= Boolean(
        node.array_join ||
        node.sample ||
        node.qualify ||
        node.group_by_all ||
        node.group_by_grouping_sets ||
        node.group_by_with_totals ||
        node.group_by_with_rollup ||
        node.group_by_with_cube ||
        node.interpolate,
      );
    }
    if (node.type === "TableExpression")
      unsupported ||= Boolean(
        node.final || node.sample_size || node.sample_offset,
      );
    if (node.with_fill || node.is_window_function) unsupported = true;
    for (const [key, child] of Object.entries(node))
      if (key !== "location" && key !== "parent") pending.push(child);
  }
  return { limited, joins, unsupported };
}
