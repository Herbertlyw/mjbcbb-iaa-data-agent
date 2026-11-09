// Revalidate captured JOIN evidence against current authority.
import { createHash } from "node:crypto";
import { planClickHouse, type ClickHousePlan } from "./clickhouse-plan.js";
import { clickHouseReviewPolicy } from "./clickhouse-review-policy.js";
import { reviewSql } from "./clickhouse-review.js";
import { currentCalendarDate, type AppConfig } from "./config.js";
import { unknownCoverage } from "./coverage.js";
import { isExactZero } from "./exact-arithmetic.js";
import {
  dimensionSnapshotMatches,
  dimensionSnapshotStatusValid,
  type FreshnessPublication,
} from "./freshness.js";
import {
  joinClosedCoverage,
  joinDimensionObservations,
  joinMissingDimensionKeys,
  joinMetricColumns,
  prepareJoinAggregateEvidence,
  verifyJoinEvidence,
  verifyJoinExecutionSchema,
  type JoinEvidencePlan,
  type VerifiedJoinValue,
} from "./join-evidence.js";
import { canQueryTable, contractValidity } from "./knowledge.js";
import { type SessionRecord } from "./session.js";
import { type TableRule } from "./sql.js";
import type { DataContract, KnowledgeBase, QueryResource } from "./types.js";

export type PrivateJoinProof = {
  rows: Array<Record<string, unknown>>;
  column_types: Record<string, string>;
  capture_hash: string;
};

export type JoinQueryResource = QueryResource & { join_proof?: PrivateJoinProof };

/** The proof contains values already authorized in the original SQL, but is
 * internal metadata and is never returned as model-visible resource rows. */
export function verifyJoinResource(
  resource: JoinQueryResource,
  session: SessionRecord,
  knowledge: KnowledgeBase,
  config: AppConfig,
  publication: FreshnessPublication,
): { plan: JoinEvidencePlan; values: VerifiedJoinValue[] } | null {
  if (
    resource.engine !== "clickhouse-local" ||
    !resource.execution_id ||
    resource.tables.length !== 2 ||
    resource.truncated ||
    resource.sql_limited ||
    !resource.complete_population ||
    resource.total_rows_exact !== true ||
    !resource.join_proof ||
    resource.registry_revision !== knowledge.registry_revision ||
    publication.valid_until < currentCalendarDate(config, knowledge.timezone)
  )
    return null;
  const assets = resource.tables.map((table) => knowledge.contract_by_table.get(table));
  if (
    assets.some(
      (asset) =>
        !asset?.contract ||
        resource.contract_revisions[asset.contract.table] !== asset.contract.revision ||
        resource.asset_hashes[asset.asset_id] !== asset.content_hash ||
        !canQueryTable(knowledge, session.role, asset.contract.table) ||
        contractValidity(asset.contract, currentCalendarDate(config, asset.contract.timezone)),
    )
  )
    return null;
  const fact = assets.find((asset) => asset?.contract?.series)?.contract;
  const dimension = assets.find((asset) => asset?.contract && !asset.contract.series)?.contract;
  if (!fact || !dimension) return null;
  const receipts = resource.freshness_receipts;
  if (
    receipts.length !== 2 ||
    resource.tables.some(
      (table) =>
        !receipts.some(
          (receipt) =>
            receipt.table === table &&
            receipt.status === "fresh" &&
            receipt.publication_id === publication.publication_id &&
            receipt.version === publication.version &&
            publication.tables[table]?.status === "fresh",
        ),
    )
  )
    return null;
  if (resource.sql_review_engine !== "clickhouse_ast_join") return null;
  const rules: TableRule[] = [];
  for (const asset of assets) {
    const contract = asset?.contract;
    const binding = session.bindings.find((item) => item.table === contract?.table && item.queryable);
    if (
      !contract ||
      !binding ||
      binding.registry_revision !== knowledge.registry_revision ||
      binding.content_hash !== asset?.content_hash
    )
      return null;
    rules.push({
      table: contract.table,
      allowed_columns: binding.allowed_columns,
      sensitive_columns: binding.sensitive_columns,
      must_filter: binding.must_filter,
      column_types: Object.fromEntries(contract.columns.map((column) => [column.name, column.type])),
    });
  }
  let admission: ClickHousePlan;
  try {
    admission = planClickHouse(
      resource.sql,
      rules,
      [fact, dimension],
      knowledge.joins,
      config.clickhouseDatabase,
      config.maxResultRows,
    );
    if (
      admission.receipt.engine !== "clickhouse_ast_join" ||
      (resource.review_plan && JSON.stringify(admission.receipt) !== JSON.stringify(resource.review_plan))
    )
      return null;
  } catch {
    return null;
  }
  const plan = [
    admission.join,
    prepareJoinAggregateEvidence(resource.sql, fact, dimension, knowledge.joins, true),
  ].find((candidate) => candidate?.executionSql === resource.executed_sql);
  if (plan?.authorizationSql) {
    try {
      if (
        !reviewSql(
          plan.authorizationSql,
          clickHouseReviewPolicy(config.clickhouseDatabase, rules, config.maxResultRows),
        ).ok
      )
        return null;
    } catch {
      return null;
    }
  }
  if (
    !plan ||
    plan.range.start !== resource.time_range.start ||
    plan.range.end !== resource.time_range.end ||
    plan.range.timezone !== resource.time_range.timezone ||
    !verifyJoinExecutionSchema(plan, fact, dimension, resource.join_proof.column_types)
  )
    return null;
  if (plan.joinType === "left" && resource.execution_settings?.join_use_nulls !== true) return null;
  if (
    resource.executed_sql !== plan.executionSql ||
    resource.join_proof.capture_hash !==
      joinCaptureHash(
        resource.sql,
        resource.executed_sql,
        resource.execution_id,
        resource.join_proof.rows,
        resource.join_proof.column_types,
      )
  )
    return null;
  const visible = resource.join_proof.rows.map(({ __da_join_proof: _proof, ...row }) => row);
  if (JSON.stringify(visible) !== JSON.stringify(resource.rows)) return null;
  const values = verifyJoinEvidence(plan, resource.join_proof.rows);
  if (
    !values ||
    !joinDimensionMatchesPublication(plan, resource.join_proof.rows, publication.tables[dimension.table])
  )
    return null;
  return { plan, values };
}

export function joinDimensionMatchesPublication(
  plan: JoinEvidencePlan,
  rows: Array<Record<string, unknown>>,
  state: FreshnessPublication["tables"][string] | undefined,
): boolean {
  if (!dimensionSnapshotStatusValid(state, plan.dimension) || state.status !== "fresh") return false;
  if (
    JSON.stringify(state.key_columns) !== JSON.stringify(plan.joinKeys) ||
    plan.joinKeys.some((name) => !state.snapshot_columns.includes(name))
  )
    return false;
  const observations = joinDimensionObservations(plan, rows);
  const missing = joinMissingDimensionKeys(plan, rows);
  if (
    !observations ||
    !missing ||
    observations.some(
      (item) => !dimensionSnapshotMatches(state, plan.dimension, item.keys, item.column, item.value),
    )
  )
    return false;
  // An unmatched key is meaningful only if the valid current publication also
  // proves absence; missing or malformed publication is never evidence of it.
  return missing.every((key) =>
    plan.joinKeys.every((name) => !dimensionSnapshotMatches(state, plan.dimension, key, name, key[name]!)),
  );
}

export function joinCaptureHash(
  sql: string,
  executedSql: string,
  executionId: string,
  rows: Array<Record<string, unknown>>,
  columnTypes: Record<string, string>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sql,
        executed_sql: executedSql,
        execution_id: executionId,
        settings: { join_use_nulls: true },
        rows,
        column_types: columnTypes,
      }),
    )
    .digest("hex");
}

export function joinCoverage(
  plan: JoinEvidencePlan,
  rows: Array<Record<string, unknown>>,
  fact?: DataContract,
): QueryResource["coverage"] {
  if (fact?.series?.coverage_semantics !== undefined && fact.series.coverage_semantics !== "sparse_observations")
    return unknownCoverage("契约覆盖语义不受支持。");
  if (plan.coverageExpectedRows !== undefined)
    return (
      joinClosedCoverage(plan, rows) ?? unknownCoverage("契约封闭范围的分组或日期不完整，无法证明整体覆盖。")
    );
  if (fact?.series?.coverage_semantics === "sparse_observations")
    return unknownCoverage("契约声明来源为稀疏观测；JOIN 已验证出现的行，但未证明未出现分组的覆盖。");
  if (fact?.series?.coverage_domains !== undefined)
    return unknownCoverage("契约声明了封闭域，但此查询无法核验完整范围。");
  if (plan.factGrainFields)
    return unknownCoverage("已核对出现的事实属性分组及原始粒度；未证明未出现的属性值或整个业务范围。不要将缺组视为零。");
  if (plan.aggregateProof)
    return unknownCoverage(
      "数据库全量聚合已检查本次观察的粒度与关联，但未证明每个业务日期和未出现分组的覆盖。",
    );
  const metricCount = joinMetricColumns(plan).length;
  const zeros = new Set<string>();
  const nulls = new Set<string>();
  for (const row of rows)
    for (const tuple of row.__da_join_proof as unknown[][]) {
      if (tuple.slice(1, 1 + metricCount).some(isExactZero)) zeros.add(String(tuple[0]));
      if (tuple.slice(1, 1 + metricCount).some(value => value === null)) nulls.add(String(tuple[0]));
    }
  return {
    status: "known",
    reason: "本次 JOIN 查询捕获的已出现分组按完整事实粒度逐日验证；未出现的分组不补零。",
    table: plan.fact,
    expected_days: plan.expectedDates.length,
    absent_dates: [],
    null_dates: [...nulls].sort(),
    zero_dates: [...zeros].sort(),
    predicted_dates: [],
    actual_dates: [...plan.expectedDates],
    unknown_prediction_dates: [],
    groups: [],
  };
}
