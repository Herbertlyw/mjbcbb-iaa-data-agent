// Build authoritative analysis from the current task evidence graph.
import { createHash } from "node:crypto";
import { unresolvedCandidateFailures } from "./candidate-failures.js";
import { aggregateObservationInput, selectedAggregateReferences } from "./aggregate-observation.js";
import { alignmentHasUnresolvedRows } from "./alignment-completeness.js";
import {
  compareDecimalAggregates,
  compareVerifiedDecimalCells,
  type AggregateComparison,
} from "./aggregate-comparison.js";
import {
  verifyDatabaseAggregates,
  type VerifiedAggregate,
} from "./aggregate-evidence.js";
import {
  verifyGroupRollup,
  type VerifiedGroupRollup,
} from "./aggregate-rollup.js";
import { isAnalysisDeclaration } from "./analysis-declaration.js";
import {
  revisionAttempts,
  sessionAnalyses,
  type AnalysisInput,
} from "./analysis-records.js";
import {
  renderAggregate,
  renderAggregateComparison,
  renderAlignment,
  renderAnswer,
  renderArithmetic,
  renderCalculatedCell,
  renderComparison,
  renderConditionalAggregate,
  renderDecimalCell,
  renderDerivedAndGroups,
  renderDimensionObservation,
  renderGroupRollup,
  renderQueryObservation,
  renderTransform,
  renderVerifiedJoin,
} from "./analysis-renderer.js";
import { preflightClickHouseSql } from "./clickhouse-sql-preflight.js";
import {
  verifyConditionalAggregates,
  type VerifiedConditionalAggregate,
} from "./conditional-aggregate-evidence.js";
import { currentCalendarDate } from "./config.js";
import {
  verifyDimensionObservations,
  type VerifiedDimensionObservation,
} from "./dimension-observation.js";
import {
  coverageHasGap,
  provenCoverageScope,
  unknownCoverage,
} from "./coverage.js";
import {
  verifyDecimalCell,
  type VerifiedDecimalCell,
} from "./decimal-cell-evidence.js";
import {
  compareVerifiedIntegers,
  type VerifiedComparison,
} from "./evidence-comparison.js";
import { queryEvidenceShape } from "./evidence-shape.js";
import {
  verifiedNullMarkerPreview,
  verifyCell,
  type VerifiedCell,
} from "./evidence.js";
import {
  joinCoverage,
  verifyJoinResource,
  type JoinQueryResource,
} from "./join-resource-proof.js";
import { verifiedJoinArithmeticGroup } from "./join-arithmetic-group.js";
import { reviewHasVerifiedReferences, type DeliveryReview } from "./delivery-review.js";
import { displayModelProse } from "./analysis-prose.js";
import {
  canQueryTable,
  canRead,
  contractValidity,
  validateKnowledgeSources,
} from "./knowledge.js";
import { ResourceGraph } from "./resource-graph.js";
import { rawResultTable, stableHashes } from "./result-adapters.js";
import {
  verifyQueryObservation,
  type VerifiedQueryObservation,
} from "./query-observation.js";
import { evaluationContext } from "./result-evaluation-context.js";
import { newId } from "./session.js";
import {
  fail,
  unique,
  type ToolContext,
  type ToolResult,
} from "./tool-context.js";
import { coveragePreview, previewRows } from "./tool-preview.js";
import type {
  AnalysisRecord,
  AnalysisStatus,
  QueryResource,
  SessionResource,
} from "./types.js";

import { ResultEvaluator } from "./result-evaluator.js";
import { ToolAccess } from "./tool-access.js";
export class AnalysisDelivery {
  private readonly ctx: ToolContext;
  private readonly access: ToolAccess;

  private readonly evaluator: ResultEvaluator;
  constructor(
    ctx: ToolContext,
    access: ToolAccess,
    evaluator: ResultEvaluator,
  ) {
    this.ctx = ctx;
    this.access = access;
    this.evaluator = evaluator;
  }
  async updateAnalysis(
    sessionId: string,
    input: AnalysisInput,
    signal?: AbortSignal,
    host?: { events: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>; review?: DeliveryReview | null; reviewInvalid?: boolean; textReviewed?: boolean; allowUnreferenced?: boolean },
  ): Promise<ToolResult> {
    const cancelled = await this.access.gate(sessionId, signal);
    if (cancelled) return cancelled;
    if (
      input.declaration !== undefined &&
      !isAnalysisDeclaration(input.declaration)
    )
      return fail(
        "invalid_analysis_declaration",
        "分析工作记录格式或长度不合法。",
      );
    if (
      typeof input.draft_answer !== "string" ||
      input.draft_answer.length > 32_000 ||
      !Array.isArray(input.resource_ids ?? []) ||
      (input.resource_ids?.length ?? 0) > 40 ||
      input.resource_ids?.some(
        (id) => typeof id !== "string" || id.length > 128,
      ) ||
      (input.clarification_question !== undefined &&
        (typeof input.clarification_question !== "string" ||
          input.clarification_question.length > 2000))
    )
      return fail("analysis_input_limit", "分析草稿或资源引用超过上限。");
    if (
      (input.suggested_status === "needs_clarification" ||
        input.clarification_question !== undefined) &&
      !input.clarification_question?.trim()
    )
      return fail(
        "clarification_question_required",
        "需要澄清时请填写具体的 clarification_question；不要提交空白问题。",
      );
    const session = await this.ctx.sessions.requireAsync(sessionId);
    const jobId = session.active_job_id ?? "";
    const citations: AnalysisRecord["citations"] = [];
    const sources: AnalysisRecord["sources"] = [];
    const calculations: AnalysisRecord["calculations"] = [];
    const reasons: string[] = [];
    const resources: SessionResource[] = [];
    let invalidSelectedResource = false;
    const graph = new ResourceGraph(
      (id) => this.ctx.sessions.lookupResourceAsync(sessionId, id),
      sessionId,
      jobId || undefined,
    );
    for (const id of input.resource_ids ?? []) {
      const error = await graph.add(id);
      if (error) {
        if (
          error === "resource_dependency_cycle" ||
          error === "resource_dependency_limit"
        )
          return fail(error, "证据依赖存在循环或超过限制；请重新计算。");
        invalidSelectedResource = true;
        reasons.push(error);
      }
    }
    for (const resource of graph.nodes()) {
      resources.push(resource);
      citations.push({
        resource_id: resource.resource_id,
        note: resource.kind,
      });
      if (resource.kind === "query_result") {
        sources.push({
          resource_id: resource.resource_id,
          sql: resource.sql,
          executed_sql: resource.executed_sql,
          tables: resource.tables,
          contract_revisions: resource.contract_revisions,
          asset_hashes: resource.asset_hashes,
          time_range: resource.time_range,
          ...(resource.dimension_snapshot
            ? { dimension_snapshot: resource.dimension_snapshot }
            : {}),
          freshness: resource.freshness,
          truncated: resource.truncated,
          total_rows: resource.total_rows,
          total_rows_exact: resource.total_rows_exact,
          returned_rows: resource.returned_rows,
          complete_population: resource.complete_population,
          simulated: true,
          engine: resource.engine,
          ...(resource.execution_id
            ? { execution_id: resource.execution_id }
            : {}),
          ...(resource.execution_settings
            ? { execution_settings: resource.execution_settings }
            : {}),
          observed_at: resource.created_at,
          ...((resource as JoinQueryResource).join_proof
            ? {
                data_capture_hash: (resource as JoinQueryResource).join_proof!
                  .capture_hash,
              }
            : {}),
          ...(resource.wide_aggregate_proof && !(resource as JoinQueryResource).join_proof
            ? { data_capture_hash: resource.wide_aggregate_proof.capture_hash }
            : {}),
          rows: resource.rows,
          coverage:
            resource.coverage ??
            unknownCoverage("资源没有覆盖回执，覆盖情况未知。"),
          freshness_receipts: resource.freshness_receipts ?? [],
        });
      }
    }
    const declaredExcerptIds =
      input.declaration?.source_excerpts?.map((item) => item.asset_id) ?? [];
    for (const assetId of declaredExcerptIds) {
      const allowed = await this.access.authorizeRead(sessionId, assetId);
      if (!allowed.ok)
        return fail(
          "analysis_declaration_source_invalid",
          "工作记录引用的知识来源不可读取或已变化。",
        );
    }
    const contractIds = resources
      .filter((item): item is QueryResource => item.kind === "query_result")
      .flatMap((item) => Object.keys(item.asset_hashes));
    if (
      contractIds.some(
        (assetId) => !canRead(this.ctx.knowledge, session.role, assetId),
      )
    )
      return fail(
        "analysis_declaration_source_invalid",
        "当前主体不能读取引用的契约，旧证据不能交付。",
      );
    if (
      !(await validateKnowledgeSources(this.ctx.knowledge, [
        ...contractIds,
        ...declaredExcerptIds,
      ]))
    )
      return fail(
        "knowledge_source_changed",
        "权限或引用的契约、知识文件已变化；旧证据不能交付。",
      );
    const claimsNumbers =
      input.suggested_status === "completed" ||
      input.suggested_status === "partial";
    const verifiedQueries = sources.filter(
      (source) => source.sql && source.freshness_receipts.length > 0,
    );
    if (
      claimsNumbers &&
      !input.clarification_question &&
      verifiedQueries.length === 0 && !host?.allowUnreferenced
    ) {
      const attempt = await this.nextRevision(sessionId, jobId);
      if (attempt === "lost")
        return fail(
          "provider_fence_rejected",
          "任务围栏已经变化，修订次数没有重置。",
        );
      if (attempt <= 1) {
        return fail(
          "evidence_feedback",
          "候选回答缺少本次执行的成功查询和新鲜度回执。请改为引用本次查询资源，或改成澄清。模型文字里的数字不会被采用。",
          {
            server_reasons: reasons,
            revisions_remaining: 1,
          },
        );
      }
      const exhausted: AnalysisRecord = {
        analysis_id: newId("an"),
        job_id: jobId,
        session_id: sessionId,
        status: "partial",
        answer:
          "修订次数已用完。没有本次执行的成功查询和新鲜度回执，不能把模型文字当成数据结论。未解内容需要重新提问或澄清范围。",
        limitations: [
          "没有可引用的成功查询。",
          "数据来自本地合成库，不是生产数据。",
        ],
        clarification_question: null,
        citations,
        resource_hashes: Object.fromEntries(
          resources.map((resource) => [
            resource.resource_id,
            createHash("sha256").update(JSON.stringify(resource)).digest("hex"),
          ]),
        ),
        sources,
        calculations,
        model_suggested_status: input.suggested_status,
        model_draft: input.draft_answer,
        server_reasons: unique([
          ...reasons,
          "revision_exhausted",
          "insufficient_evidence",
        ]),
        simulated: true,
      };
      sessionAnalyses(session).push(exhausted);
      return {
        ok: true,
        ...exhausted,
        notice: "修订次数用完后，只交付有证据的部分。",
      };
    }
    let status: AnalysisStatus = input.suggested_status;
    const failedUnreferencedData = Boolean(host?.allowUnreferenced && host.events.some((event) => event.type === "tool_finished" && event.payload.is_error === true && ["query", "read_session_resource", "calculate_session_cells"].includes(String(event.payload.tool_name))));
    if (failedUnreferencedData) {
      if (status === "completed") status = "partial";
      reasons.push("data_tool_failure_without_result");
    }
    if (invalidSelectedResource && status === "completed") status = "partial";
    if (input.clarification_question) {
      status = "needs_clarification";
      reasons.push("clarification_requested");
    }
    const optionalQuestions = Boolean(host?.textReviewed && input.declaration?.unresolved_questions.length && input.declaration.unresolved_questions.every((question) => host.review?.items.some((item) => item.requirement === question && item.status === "optional")));
    if (
      input.declaration?.unresolved_questions.length &&
      status === "completed" && !optionalQuestions
    ) {
      status = "partial";
      reasons.push("model_declared_unresolved");
    }
    if (
      (status === "completed" || status === "partial") &&
      sources.length === 0 && !host?.allowUnreferenced
    ) {
      status = input.clarification_question ? "needs_clarification" : "failed";
      reasons.push("insufficient_evidence");
    }
    if (
      input.suggested_status === "failed" &&
      sources.length === 0 &&
      !input.clarification_question
    ) {
      status = "failed";
      reasons.push("no_authorized_result");
    }
    // A question with no evidence does not make a data-freshness claim. It
    // must remain available when the freshness authority is down; any actual
    // query source still requires the same authoritative revalidation.
    const deliveredFreshness = sources.length
      ? await this.access.currentFreshness()
      : { ok: true as const, publication: null };
    if (!deliveredFreshness.ok) return deliveredFreshness;
    const liveFreshness = deliveredFreshness.publication;
    const evaluation = evaluationContext();
    const eligible = new Set<string>();
    const aggregates: VerifiedAggregate[] = [];
    const conditionalAggregates: VerifiedConditionalAggregate[] = [];
    const joinLines: string[] = [];
    const joinResults: NonNullable<AnalysisRecord["join_results"]> = [];
    const verifiedJoinSources = new Map<string, { source: QueryResource; proof: NonNullable<ReturnType<typeof verifyJoinResource>> }>();
    const expressionLines: string[] = [];
    const dimensionObservations: VerifiedDimensionObservation[] = [];
    for (const source of sources) {
      const original = resources.find(
        (item): item is QueryResource =>
          item.kind === "query_result" &&
          item.resource_id === source.resource_id,
      );
      const evidence =
        original && this.access.evidenceSource(session, original);
      const asset =
        original && original.tables.length === 1
          ? this.ctx.knowledge.contract_by_table.get(original.tables[0] ?? "")
          : undefined;
      const contract = asset?.contract;
      const currentContract = Boolean(
        original &&
        asset &&
        contract &&
        original.registry_revision === this.ctx.knowledge.registry_revision &&
        original.contract_revisions[contract.table] === contract.revision &&
        original.asset_hashes[asset.asset_id] === asset.content_hash &&
        canQueryTable(this.ctx.knowledge, session.role, contract.table) &&
        !contractValidity(
          contract,
          currentCalendarDate(this.ctx.config, contract.timezone),
        ),
      );
      const currentFresh = Boolean(
        liveFreshness &&
        liveFreshness.valid_until >=
          currentCalendarDate(this.ctx.config, this.ctx.knowledge.timezone) &&
        source.freshness_receipts.length === source.tables.length &&
        source.tables.every((table) =>
          source.freshness_receipts.some((receipt) => receipt.table === table),
        ) &&
        source.freshness_receipts.every(
          (receipt) =>
            receipt.publication_id === liveFreshness.publication_id &&
            receipt.version === liveFreshness.version &&
            liveFreshness.tables[receipt.table]?.status === "fresh",
        ),
      );
      if (original?.dimension_snapshot) {
        const dimension =
          evidence &&
          contract &&
          liveFreshness &&
          currentContract &&
          currentFresh
            ? verifyDimensionObservations(evidence, contract, liveFreshness)
            : null;
        if (dimension?.ok) {
          source.evidence_eligible = true;
          source.rows = [];
          eligible.add(source.resource_id);
          dimensionObservations.push(
            ...dimension.observations.slice(
              0,
              Math.max(0, 100 - dimensionObservations.length),
            ),
          );
          reasons.push("dimension_snapshot_observation");
          continue;
        }
        if (dimension) reasons.push(dimension.code);
        if (!currentFresh) reasons.push("freshness_version_changed");
        if (!currentContract) reasons.push("contract_or_authorization_changed");
        source.evidence_eligible = false;
        source.rows = [];
        if (status === "completed") status = "partial";
        continue;
      }
      const shape =
        evidence &&
        contract &&
        verifyCell(
          evidence,
          contract,
          { op: "count_rows", as: "internal" },
          evidence.rows.length,
        );
      const databaseAggregates =
        evidence && contract && verifyDatabaseAggregates(evidence, contract);
      const conditional =
        evidence && contract && verifyConditionalAggregates(evidence, contract);
      const observation =
        !shape &&
        !databaseAggregates &&
        !conditional &&
        original &&
        liveFreshness &&
        jobId
          ? await this.evaluator.evaluateVerifiedResult(
              session,
              jobId,
              original.resource_id,
              liveFreshness,
              new Set(),
              evaluation,
            )
          : null;
      const joined =
        original && liveFreshness
          ? verifyJoinResource(
              original as JoinQueryResource,
              session,
              this.ctx.knowledge,
              this.ctx.config,
              liveFreshness,
            )
          : null;
      if (joined) {
        verifiedJoinSources.set(source.resource_id, { source: original!, proof: joined });
        source.evidence_eligible = true;
        source.coverage = joinCoverage(
          joined.plan,
          (original as JoinQueryResource).join_proof!.rows,
          this.ctx.knowledge.contract_by_table.get(joined.plan.fact)?.contract,
        );
        if (source.coverage.status === "unknown") {
          reasons.push("coverage_unknown");
          if (status === "completed") status = "partial";
        }
        if (
          source.coverage.status === "known" &&
          coverageHasGap(source.coverage)
        ) {
          reasons.push("completeness_gap");
          if (status === "completed") status = "partial";
        }
        source.rows = [];
        eligible.add(source.resource_id);
        joinResults.push({
          resource_id: source.resource_id,
          execution_id: original!.execution_id!,
          values: joined.values.slice(0, 100),
        });
        joinLines.push(
          ...joined.values
            .slice(0, 100)
            .map((value) => renderVerifiedJoin(value, source.resource_id)),
        );
        if (joined.values.length > 100)
          joinLines.push(
            `JOIN 验证了 ${joined.values.length} 个分组，此处展示前 100 个；其余分组保存在当前结果资源中。`,
          );
        continue;
      }
      source.evidence_eligible = Boolean(
        currentContract &&
        currentFresh &&
        (shape ||
          databaseAggregates ||
          conditional ||
          observation?.aggregate_input ||
          observation?.expression_only ||
          (evidence && contract && evidence.time_range.selected_dates?.length &&
            observation?.partial && rawResultTable(evidence, contract))) &&
        !source.truncated &&
        source.complete_population,
      );
      if (source.evidence_eligible) {
        eligible.add(source.resource_id);
        if (observation?.aggregate_input && observation.partial && status === "completed")
          status = "partial";
        if (
          observation?.aggregate_input &&
          observation.table.columns.some(
            (column) => column.approximate &&
              observation.table.rows.some((row) => row[column.name] !== null),
          )
        ) {
          reasons.push("floating_point_approximate");
          if (status === "completed") status = "partial";
        }
        if (observation?.expression_only) {
          reasons.push("query_expression_semantics_unverified");
          // A query result whose business meaning cannot be certified cannot
          // satisfy a completed analysis, even when its mathematical value
          // and the source's freshness are known. A dimension observation or
          // unrelated verified value does not prove the requested metric.
          if (status === "completed") status = "partial";
          // A typed observation is mathematically reproducible but it does
          // not prove the business aggregate's meaning or completeness.
          // Preserve that distinction when known NULLs, missing days or
          // forecasts caused the business proof to fail.
          const inspected = original && preflightClickHouseSql(original.sql);
          if (
            source.coverage.status === "known" &&
            coverageHasGap(source.coverage) &&
            inspected?.ok &&
            inspected.functions.some((name) =>
              [
                "sum",
                "sumif",
                "count",
                "countif",
                "avg",
                "min",
                "max",
              ].includes(name),
            )
          )
            reasons.push("query_lineage_unsupported");
          if (observation.table.columns.some((column) => column.approximate)) {
            reasons.push("floating_point_approximate");
          }
          if (!observation.table.rows.length)
            expressionLines.push(
              `查询资源 ${source.resource_id} 没有结果行；空结果不等于零。`,
            );
          for (const row of previewRows(observation.table.rows, 100))
            expressionLines.push(
              `查询资源 ${source.resource_id} 的表达式结果：${observation.table.columns.map((column) => `${column.label}=${row[column.name] === null ? "NULL（未知）" : column.type === "text" ? JSON.stringify(row[column.name]) : String(row[column.name])}（单位未认证）`).join("；")}。`,
            );
        }
        if (source.engine === "clickhouse-local")
          reasons.push("clickhouse_observation_nonatomic");
        if (databaseAggregates?.some((item) => item.coverage_incomplete)) {
          reasons.push("aggregate_groups_incomplete");
          if (status === "completed") status = "partial";
        }
        if (databaseAggregates) aggregates.push(...databaseAggregates);
        if (conditional) conditionalAggregates.push(...conditional);
        // SQL aliases are model-controlled and can look like another metric or
        // unit. The verified statements use contract names; do not present the
        // raw alias-labelled preview as verified evidence in the answer.
        const columns =
          evidence && contract
            ? queryEvidenceShape(evidence, contract)?.columns
            : null;
        if (
          !Array.isArray(columns) ||
          columns.some(
            (item) =>
              item &&
              typeof item === "object" &&
              (("as" in item && item.as) ||
                ("expr" in item &&
                  item.expr &&
                  typeof item.expr === "object" &&
                  "type" in item.expr &&
                  item.expr.type === "function")),
          )
        ) {
          const preview =
            evidence && contract
              ? verifiedNullMarkerPreview(evidence, contract)
              : null;
          source.rows = preview ?? [];
          reasons.push(
            preview ? "null_marker_preview_sanitized" : "alias_preview_hidden",
          );
        }
      } else {
        delete source.data_capture_hash;
        if (!currentFresh) reasons.push("freshness_version_changed");
        if (!currentContract) reasons.push("contract_or_authorization_changed");
        if (source.truncated || !source.complete_population)
          reasons.push("truncated_result_is_not_population");
        if (!shape && !databaseAggregates && !conditional && currentContract)
          reasons.push("query_lineage_unsupported");
        source.rows = [];
        source.coverage = unknownCoverage(
          "该查询结果不满足当前证据条件，覆盖回执不作为事实展示。",
        );
        if (status === "completed") status = "partial";
      }
      if (!source.coverage || source.coverage.status === "unknown") {
        if (status === "completed") status = "partial";
        reasons.push("coverage_unknown");
      } else if (coverageHasGap(source.coverage)) {
        if (status === "completed") status = "partial";
        reasons.push("completeness_gap");
      }
    }
    if (host && (status === "completed" || status === "partial")) {
      // A selected, successful tool call is not enough to retire an earlier
      // failure. It must be a currently authorized, complete query with a
      // usable freshness/coverage receipt. Calculations remain conservative
      // until their own complete result is proven as a repair route.
      const verifiedQueries = new Set(sources.filter((source) => source.evidence_eligible && !source.truncated && source.complete_population && source.coverage.status === "known" && !coverageHasGap(source.coverage) && source.coverage.unknown_prediction_dates.length === 0).map((source) => source.resource_id));
      if (unresolvedCandidateFailures(host.events, verifiedQueries) > 0) {
        reasons.push("unresolved_tool_failure");
        if (status === "completed") status = "partial";
      }
    }
    let analysisDeclaration: AnalysisRecord["analysis_declaration"];
    if (input.declaration) {
      for (const excerpt of input.declaration.source_excerpts ?? []) {
        const asset = this.ctx.knowledge.by_id.get(excerpt.asset_id);
        if (
          !asset ||
          asset.content_hash !== excerpt.content_hash ||
          !asset.body.includes(excerpt.quote)
        )
          return fail(
            "analysis_declaration_source_invalid",
            "工作记录摘录与当前可读的知识版本不一致。",
          );
      }
      const cells: NonNullable<
        AnalysisRecord["analysis_declaration"]
      >["verified_cells"] = [];
      for (const ref of input.declaration.result_cells ?? []) {
        const source = resources.find(
          (item): item is QueryResource =>
            item.kind === "query_result" &&
            item.resource_id === ref.resource_id,
        );
        const verified =
          source &&
          eligible.has(source.resource_id) &&
          source.execution_id === ref.execution_id
            ? await this.access.workingCell(session, source, ref.row, ref.column, liveFreshness)
            : null;
        if (!source || !verified)
          return fail(
            "analysis_declaration_cell_invalid",
            "工作记录的结果引用不可验证：必须是当前任务、当前执行号的完整授权字段或可证明分组求和。",
          );
        cells.push({ ...ref, ...verified });
      }
      analysisDeclaration = {
        provenance: "model_declared",
        declaration: structuredClone(input.declaration),
        excerpts_checked: input.declaration.source_excerpts?.length ?? 0,
        verified_cells: cells,
      };
    }
    // A shared publication is not a ClickHouse snapshot. Detect observed
    // contradictions for the same table and coverage population rather than
    // either asserting atomicity or downgrading every ordinary observation.
    const observed = new Map<string, string>();
    for (const source of sources) {
      if (
        !source.evidence_eligible ||
        source.engine !== "clickhouse-local" ||
        source.tables.length !== 1 ||
        !source.coverage.observation_hash
      )
        continue;
      const contract = this.ctx.knowledge.contract_by_table.get(
        source.tables[0]!,
      )?.contract;
      const original = resources.find(
        (item): item is QueryResource =>
          item.kind === "query_result" &&
          item.resource_id === source.resource_id,
      );
      const evidence =
        original && this.access.evidenceSource(session, original);
      const scope =
        contract &&
        evidence &&
        provenCoverageScope(evidence.sql, contract, source.time_range);
      if (!scope) continue;
      const key = JSON.stringify([
        source.tables[0],
        source.time_range,
        Object.entries(scope.equalities).sort(([a], [b]) => a.localeCompare(b)),
        Object.entries(scope.inSets).sort(([a], [b]) => a.localeCompare(b)),
      ]);
      const previous = observed.get(key);
      if (previous && previous !== source.coverage.observation_hash) {
        reasons.push("coverage_observations_conflict");
        if (status === "completed") status = "partial";
      }
      observed.set(key, source.coverage.observation_hash);
    }
    const verified: VerifiedCell[] = [];
    const verifiedDecimal: VerifiedDecimalCell[] = [];
    const verifiedGroupRollups: VerifiedGroupRollup[] = [];
    const verifiedByCalculation = new Map<string, Map<string, VerifiedCell>>();
    const verifiedDecimalByCalculation = new Map<string, Map<string, VerifiedDecimalCell>>();
    const tableCellLines: string[] = [];
    for (const resource of resources) {
      if (resource.kind !== "calculation") continue;
      const parentResource = resources.find(
        (item) => item.resource_id === resource.source_resource_id,
      );
      const parentEvaluation =
        resource.evaluated_table_v1 &&
        parentResource?.kind === "query_result" &&
        liveFreshness &&
        jobId
          ? await this.evaluator.evaluateVerifiedResult(
              session,
              jobId,
              parentResource.resource_id,
              liveFreshness,
              new Set(),
              evaluation,
            )
          : null;
      const parentContract =
        parentResource?.kind === "query_result" &&
        parentResource.tables.length === 1
          ? this.ctx.knowledge.contract_by_table.get(parentResource.tables[0]!)
              ?.contract
          : undefined;
      const parentEvidence =
        parentResource?.kind === "query_result" && parentContract
          ? this.access.evidenceSource(session, parentResource)
          : null;
      const hasBusinessShape =
        parentResource?.kind === "query_result" &&
        parentContract &&
        parentEvidence &&
        Boolean(
          verifyCell(
            parentEvidence,
            parentContract,
            { op: "count_rows", as: "shape" },
            parentEvidence.rows.length,
          ) ||
          verifyDatabaseAggregates(parentEvidence, parentContract) ||
          verifyConditionalAggregates(parentEvidence, parentContract),
        );
      const evaluatedCells =
        resource.evaluated_table_v1 && liveFreshness && jobId
          ? await this.evaluator.evaluateVerifiedResult(
              session,
              jobId,
              resource.resource_id,
              liveFreshness,
              new Set(),
              evaluation,
            )
          : null;
      // A verified JOIN has no single-table contract. Its saved cell result
      // uses the shared evaluator and the already authorized query leaves.
      if (
        resource.evaluated_table_v1 &&
        (parentResource?.kind !== "query_result" ||
          !parentContract ||
          parentEvaluation?.aggregate_input ||
          (parentEvaluation?.expression_only && !hasBusinessShape))
      ) {
        const checked = evaluatedCells;
        if (!checked || checked.leaves.some((id) => !eligible.has(id))) {
          reasons.push("calculation_lineage_unsupported");
          if (status === "completed") status = "partial";
          continue;
        }
        if (checked.partial) {
          reasons.push("transform_coverage_incomplete");
          if (status === "completed") status = "partial";
        }
        calculations.push({
          resource_id: resource.resource_id,
          source_resource_id: resource.source_resource_id,
          cells: resource.cells,
          verified_cells: [],
          verified_decimal_cells: [],
          verified_group_rollups: [],
          verified_result: checked.table,
          input_truncated: resource.input_truncated,
          complete_population: resource.complete_population,
        });
        for (const column of checked.table.columns) {
          const value = checked.table.rows[0]?.[column.name];
          tableCellLines.push(
            renderCalculatedCell(
              resource,
              column,
              value!,
              resource.operations?.[column.name],
            ),
          );
        }
        continue;
      }
      if (resource.evaluated_table_v1 && !evaluatedCells) {
        reasons.push("calculation_lineage_unsupported");
        if (status === "completed") status = "partial";
        continue;
      }
      const original = resources.find(
        (item): item is QueryResource =>
          item.kind === "query_result" &&
          item.resource_id === resource.source_resource_id,
      );
      const evidence =
        original && this.access.evidenceSource(session, original);
      const asset =
        original && original.tables.length === 1
          ? this.ctx.knowledge.contract_by_table.get(original.tables[0] ?? "")
          : undefined;
      const contract = asset?.contract;
      const accepted: VerifiedCell[] = [];
      const acceptedDecimal: VerifiedDecimalCell[] = [];
      const acceptedGrouped: VerifiedGroupRollup[] = [];
      const cells: Record<string, number | string | null> = {};
      if (
        original &&
        evidence &&
        contract &&
        eligible.has(original.resource_id) &&
        resource.operations &&
        resource.source_resource_hash ===
          createHash("sha256").update(JSON.stringify(original)).digest("hex")
      ) {
        for (const [name, operation] of Object.entries(resource.operations)) {
          const stored = resource.cells[name];
          const nullColumn =
            stored === null && evaluatedCells?.table.rows[0]?.[name] === null
              ? evaluatedCells.table.columns.find(
                  (column) => column.name === name,
                )
              : undefined;
          if (nullColumn) {
            cells[name] = null;
            tableCellLines.push(
              renderCalculatedCell(resource, nullColumn, null, operation),
            );
            reasons.push("calculation_input_incomplete");
            if (status === "completed") status = "partial";
            continue;
          }
          const cell =
            typeof stored === "number"
              ? verifyCell(evidence, contract, operation, stored)
              : null;
          if (cell) {
            cells[name] = cell.value;
            accepted.push(cell);
            verified.push(cell);
            const verifiedCells =
              verifiedByCalculation.get(resource.resource_id) ??
              new Map<string, VerifiedCell>();
            verifiedCells.set(name, cell);
            verifiedByCalculation.set(resource.resource_id, verifiedCells);
          } else {
            const decimal =
              typeof stored === "string"
                ? verifyDecimalCell(evidence, contract, operation, stored)
                : null;
            const grouped =
              !decimal &&
              (typeof stored === "string" || typeof stored === "number")
                ? verifyGroupRollup(evidence, contract, operation, stored)
                : null;
            if (decimal) {
              cells[name] = decimal.value;
              acceptedDecimal.push(decimal);
              verifiedDecimal.push(decimal);
              const verifiedCells = verifiedDecimalByCalculation.get(resource.resource_id) ?? new Map<string, VerifiedDecimalCell>();
              verifiedCells.set(name, decimal);
              verifiedDecimalByCalculation.set(resource.resource_id, verifiedCells);
            } else if (grouped) {
              cells[name] = grouped.value;
              acceptedGrouped.push(grouped);
              verifiedGroupRollups.push(grouped);
            } else reasons.push("calculation_lineage_unsupported");
          }
        }
      } else reasons.push("calculation_lineage_unsupported");
      calculations.push({
        resource_id: resource.resource_id,
        source_resource_id: resource.source_resource_id,
        cells,
        verified_cells: accepted,
        verified_decimal_cells: acceptedDecimal,
        verified_group_rollups: acceptedGrouped,
        input_truncated: resource.input_truncated,
        complete_population: resource.complete_population,
      });
    }
    const comparisons: VerifiedComparison[] = [];
    const aggregateComparisons: AggregateComparison[] = [];
    const noteUnprovenSnapshot = (ids: string[]) => {
      if (
        ids.some((id) =>
          sources.some(
            (source) =>
              source.resource_id === id && source.engine === "clickhouse-local",
          ),
        )
      ) {
        reasons.push("clickhouse_observation_nonatomic");
      }
    };
    for (const request of (input.comparisons ?? []).slice(0, 20)) {
      if (
        !request ||
        !request.left ||
        !request.right ||
        typeof request.left.resource_id !== "string" ||
        typeof request.left.cell !== "string" ||
        typeof request.right.resource_id !== "string" ||
        typeof request.right.cell !== "string"
      ) {
        reasons.push("comparison_unverifiable");
        continue;
      }
      const a = verifiedByCalculation
        .get(request.left.resource_id)
        ?.get(request.left.cell);
      const b = verifiedByCalculation
        .get(request.right.resource_id)
        ?.get(request.right.cell);
      const aSource =
        a &&
        resources.find(
          (item): item is QueryResource =>
            item.kind === "query_result" &&
            item.resource_id === a.sourceResourceId,
        );
      const bSource =
        b &&
        resources.find(
          (item): item is QueryResource =>
            item.kind === "query_result" &&
            item.resource_id === b.sourceResourceId,
        );
      const contract =
        a && this.ctx.knowledge.contract_by_table.get(a.table)?.contract;
      const comparison =
        a &&
        b &&
        aSource &&
        bSource &&
        contract &&
        compareVerifiedIntegers(
          {
            calculation_id: request.left.resource_id,
            cell: request.left.cell,
            source: a,
          },
          {
            calculation_id: request.right.resource_id,
            cell: request.right.cell,
            source: b,
          },
          aSource,
          bSource,
          contract,
        );
      if (comparison) {
        comparisons.push(comparison);
        noteUnprovenSnapshot([a!.sourceResourceId, b!.sourceResourceId]);
      } else {
        const left = aggregates.filter(
          (item) =>
            item.source_resource_id === request.left.resource_id &&
            item.output_column === request.left.cell,
        );
        const right = aggregates.filter(
          (item) =>
            item.source_resource_id === request.right.resource_id &&
            item.output_column === request.right.cell,
        );
        const aggregate =
          left.length === 1 && right.length === 1
            ? compareDecimalAggregates(left[0]!, right[0]!)
            : null;
        const leftCell = verifiedDecimalByCalculation.get(request.left.resource_id)?.get(request.left.cell);
        const rightCell = verifiedDecimalByCalculation.get(request.right.resource_id)?.get(request.right.cell);
        const decimal = aggregate ?? (leftCell && rightCell ? compareVerifiedDecimalCells(leftCell, rightCell, request.left.cell, request.right.cell) : null);
        if (decimal) {
          aggregateComparisons.push(decimal);
          noteUnprovenSnapshot([
            decimal.left.source_resource_id,
            decimal.right.source_resource_id,
          ]);
        } else reasons.push("comparison_unverifiable");
      }
    }
    if (input.comparisons && input.comparisons.length > 20)
      reasons.push("comparison_unverifiable");
    if (reasons.includes("comparison_unverifiable") && status === "completed")
      status = "partial";
    const arithmeticResults: NonNullable<AnalysisRecord["arithmetic_results"]> =
      [];
    for (const resource of resources) {
      if (resource.kind !== "arithmetic") continue;
      const checked =
        liveFreshness && jobId
          ? await this.evaluator.resolveArithmetic(
              session,
              jobId,
              { resource_id: resource.resource_id, cell: "result" },
              liveFreshness,
              new Set(),
              evaluation,
            )
          : null;
      if (!checked || checked.leaves.some((id) => !eligible.has(id))) {
        reasons.push("arithmetic_lineage_unsupported");
        if (status === "completed") status = "partial";
        continue;
      }
      const arithmetic: NonNullable<AnalysisRecord["arithmetic_results"]>[number] = {
        resource_id: resource.resource_id,
        operation: resource.operation,
        left: resource.left,
        right: resource.right,
        result: checked.value,
      };
      const joined = verifiedJoinSources.get(arithmetic.left.resource_id);
      const group = joined && verifiedJoinArithmeticGroup(arithmetic, joined.source, joined.proof.plan, joined.proof.values);
      arithmeticResults.push({ ...arithmetic, ...(group ? { verified_group: group } : {}) });
      if (checked.value.approximate) {
        reasons.push("floating_point_approximate");
        if (status === "completed") status = "partial";
      }
      noteUnprovenSnapshot(checked.leaves);
      if (checked.value.partial) {
        reasons.push("arithmetic_input_incomplete");
        if (status === "completed") status = "partial";
      }
      if (
        checked.value.value === null &&
        status === "completed" &&
        (checked.value.undefined_reason !== "zero_divisor" ||
          checked.value.partial ||
          checked.value.scope_unverified ||
          checked.value.approximate ||
          checked.value.interpretation === "mathematical_only")
      ) status = "partial";
    }
    const transformResults: NonNullable<AnalysisRecord["transform_results"]> =
      [];
    const transformLines: string[] = [];
    for (const resource of resources) {
      if (resource.kind !== "transform") continue;
      const checked =
        liveFreshness && jobId
          ? await this.evaluator.evaluateVerifiedResult(
              session,
              jobId,
              resource.resource_id,
              liveFreshness,
              new Set(),
              evaluation,
            )
          : null;
      const source =
        liveFreshness && jobId
          ? await this.evaluator.evaluateVerifiedResult(
              session,
              jobId,
              resource.source_resource_id,
              liveFreshness,
              new Set(),
              evaluation,
            )
          : null;
      if (
        !checked ||
        !source ||
        checked.leaves.some((id) => !eligible.has(id))
      ) {
        reasons.push("transform_lineage_unsupported");
        if (status === "completed") status = "partial";
        continue;
      }
      if (checked.partial) {
        reasons.push(...(checked.partial_reasons ?? [checked.partial_reason ?? "transform_coverage_incomplete"]));
        if (status === "completed") status = "partial";
      }
      if (checked.table.columns.some((column) => column.approximate)) {
        reasons.push("floating_point_approximate");
        if (status === "completed") status = "partial";
      }
      noteUnprovenSnapshot(checked.leaves);
      const preview = previewRows(checked.table.rows, 100);
      transformResults.push({
        resource_id: resource.resource_id,
        source_resource_id: resource.source_resource_id,
        steps: resource.steps,
        result: { ...checked.table, rows: preview },
        total_rows: checked.table.rows.length,
        preview_has_more: checked.table.rows.length > preview.length,
      });
      transformLines.push(
        ...renderTransform(resource, source.table, checked.table),
      );
    }
    const alignmentResults: NonNullable<AnalysisRecord["alignment_results"]> =
      [];
    const alignmentLines: string[] = [];
    for (const resource of resources) {
      if (resource.kind !== "alignment") continue;
      const evaluated =
        liveFreshness && jobId
          ? await this.evaluator.evaluateVerifiedResult(
              session,
              jobId,
              resource.resource_id,
              liveFreshness,
              new Set(),
              evaluation,
            )
          : null;
      const checked =
        liveFreshness && jobId
          ? await this.evaluator.resolveAlignment(
              session,
              jobId,
              resource.spec,
              liveFreshness,
              new Set(),
              evaluation,
            )
          : null;
      if (
        !evaluated ||
        !checked ||
        Boolean(resource.coverage_incomplete) !== checked.partial ||
        checked.leaves.some((id) => !eligible.has(id)) ||
        stableHashes(checked.hashes) !== stableHashes(resource.input_hashes) ||
        JSON.stringify(checked.rows) !== JSON.stringify(resource.rows)
      ) {
        reasons.push("alignment_lineage_unsupported");
        if (status === "completed") status = "partial";
        continue;
      }
      if (checked.partial) {
        reasons.push("transform_coverage_incomplete");
        if (status === "completed") status = "partial";
      }
      if (alignmentHasUnresolvedRows(checked.rows)) {
        reasons.push("alignment_incomplete");
        if (status === "completed") status = "partial";
      }
      noteUnprovenSnapshot(checked.leaves);
      const preview = previewRows(checked.rows, 100);
      alignmentResults.push({
        resource_id: resource.resource_id,
        spec: resource.spec,
        rows: preview,
        total_rows: checked.rows.length,
        preview_has_more: checked.rows.length > preview.length,
        coverage_incomplete: checked.partial,
      });
      alignmentLines.push(...renderAlignment(resource, checked.rows));
    }
    if (
      verified.some((cell) => cell.precision === "floating_point_approximate")
    ) {
      reasons.push("floating_point_approximate");
      if (status === "completed") status = "partial";
    }
    if (
      verified.some(
        (cell) =>
          (cell.operation === "count_null" && cell.value > 0) ||
          (cell.operation === "sum" && cell.excludedNulls > 0),
      )
    )
      reasons.push("missing_values_disclosed");
    if (
      verified.some((cell) => cell.operation === "count_zero" && cell.value > 0)
    )
      reasons.push("true_zeros_disclosed");
    if (verified.some((cell) => cell.prediction.startsWith("预测")))
      reasons.push("predicted_values_disclosed");
    if (
      reasons.includes("calculation_lineage_unsupported") &&
      status === "completed"
    )
      status = "partial";
    if (input.suggested_status === "completed" && status !== "completed")
      reasons.push("model_completion_was_not_authoritative");
    const limitations: string[] = [];
    if (optionalQuestions) limitations.push("模型复核将工作记录中的未解事项列为可选研究；该判断未被宿主独立认证。");
    if (failedUnreferencedData) limitations.push("本轮数据工具失败且没有可交付结果；模型对原因的解释未经独立核验。");
    // Successful evidence verification only covers the selected resources.
    // A natural-language request can contain additional requirements that the
    // model never selected, so the host cannot certify request completeness.
    if (host && (status === "completed" || status === "partial")) {
      reasons.push("request_coverage_unverified");
      limitations.push("仅对标为已核验的结果检查了来源和计算；尚不能独立确认结果覆盖了用户问题的全部要求，请对照原问题检查是否有漏项。");
    }
    for (const source of sources) {
      if (source.evidence_eligible && source.time_range.selected_dates?.length)
        limitations.push(`查询仅选择日期 ${source.time_range.selected_dates.join("、")}（${source.time_range.timezone}）；中间日期没有查询，所选日期的业务覆盖尚未证明。`);
    }
    // Show independently proven input cells even when another input is NULL.
    // Prefer the actual computation operands over unrelated columns retrieved
    // by the same query. Optional model working notes are not a prerequisite.
    const queryObservations: VerifiedQueryObservation[] = [];
    let groupedObservationPreviewTruncated = false;
    for (const resource of resources) {
      if (
        resource.kind !== "query_result" ||
        !eligible.has(resource.resource_id) ||
        resource.tables.length !== 1
      )
        continue;
      const contract = this.ctx.knowledge.contract_by_table.get(
        resource.tables[0]!,
      )?.contract;
      const evidence = this.access.evidenceSource(session, resource);
      if (!contract || !evidence) continue;
      const refs = arithmeticResults
        .flatMap((item) => [item.left, item.right])
        .filter(
          (ref) =>
            ref.resource_id === resource.resource_id && ref.row !== undefined,
        )
        .map((ref) => ({ row: ref.row!, column: ref.cell }));
      const grouped = input.resource_ids?.includes(resource.resource_id)
        ? aggregateObservationInput(evidence, contract) : null;
      // An explicitly selected grouped query is itself a deliverable. If a
      // calculation references it, limit expansion to the referenced metrics;
      // otherwise show its independently verified observations directly.
      const directQueryOnly = !arithmeticResults.length && !calculations.length && !transformResults.length && !alignmentResults.length && !comparisons.length && !aggregateComparisons.length;
      if (grouped?.incomplete && (refs.length || directQueryOnly)) {
        refs.push(...selectedAggregateReferences(grouped, refs, directQueryOnly));
        if (queryObservations.length + new Set(refs.map((item) => JSON.stringify([item.row, item.column]))).size > 32) groupedObservationPreviewTruncated = true;
      }
      if (resource.rows.length === 1) {
        for (const node of resources) {
          if (
            node.kind !== "calculation" ||
            node.source_resource_id !== resource.resource_id ||
            !calculations.some((item) => item.resource_id === node.resource_id)
          )
            continue;
          for (const operation of Object.values(node.operations ?? {}))
            if (operation.column)
              refs.push({ row: 0, column: operation.column });
        }
      }
      if (
        !refs.length &&
        resource.rows.length === 1 &&
        input.resource_ids?.includes(resource.resource_id)
      )
        refs.push(...resource.columns.map((column) => ({ row: 0, column })));
      const seen = new Set<string>();
      for (const ref of refs) {
        const key = JSON.stringify([ref.row, ref.column]);
        if (seen.has(key) || queryObservations.length >= 32) continue;
        seen.add(key);
        const cell = verifyQueryObservation(
          evidence,
          contract,
          ref.row,
          ref.column,
        );
        if (cell) queryObservations.push(cell);
      }
    }
    if (groupedObservationPreviewTruncated)
      limitations.push("分组观察值最多展示 32 个；其余保存在本任务结果资源中，可分页回读，不能据此推断未出现分组。");
    if (host) {
      // A review can only reference selected, host-verified deliverables. The
      // model's interpretation of the original wording is never certified.
      const verifiedResults = new Set([
        ...aggregates.map((item) => item.source_resource_id),
        ...conditionalAggregates.map((item) => item.source_resource_id),
        ...queryObservations.map((item) => item.resource_id),
        ...joinResults.map((item) => item.resource_id),
        ...dimensionObservations.map((item) => item.resource_id),
        ...calculations.filter((item) => item.verified_result || item.verified_cells?.length || item.verified_decimal_cells?.length || item.verified_group_rollups?.length).map((item) => item.resource_id),
        ...arithmeticResults.map((item) => item.resource_id),
        ...transformResults.map((item) => item.resource_id),
        ...alignmentResults.map((item) => item.resource_id),
      ]);
      const unknowns = new Set(arithmeticResults.filter((item) => item.result.value === null && item.result.undefined_reason === "zero_divisor" && !item.result.partial && !item.result.scope_unverified && !item.result.approximate).map((item) => item.resource_id));
      const explicitlyMissing = host.review?.items.some((item) => item.status === "missing" || item.status === "uncertain") ?? false;
      if (host.reviewInvalid || (host.review && (!reviewHasVerifiedReferences(host.review, new Set(input.resource_ids ?? []), verifiedResults, unknowns) || explicitlyMissing))) {
        if (status === "completed") status = "partial";
        reasons.push("request_coverage_review_incomplete");
        limitations.push("本轮交付覆盖复核未完成、发现缺项，或引用的结果未通过核验；不能认定问题已答全。");
        const missing = host.review?.items.filter((item) => item.status === "missing" || item.status === "uncertain").map((item) => item.requirement) ?? [];
        if (missing.length) limitations.push(`模型复核认为以下要求尚未完成或有歧义（这是模型理解，并非服务端认证）：${missing.join("；")}`);
        if (input.suggested_status === "completed") reasons.push("model_completion_was_not_authoritative");
      }
    }
    // The model's prose is retained only as an explicitly unverified draft.
    // Its numbers must neither certify a claim nor downgrade an independently
    // verified result: matching text cannot establish metric, scope or units.
    if (input.draft_answer.trim()) {
      reasons.push("model_draft_not_verified");
      limitations.push("模型草稿和分析中的数字、标签及解释未逐句核验，未作为已验证事实；请与已核验结果及来源对照。");
    }
    if (reasons.includes("model_declared_unresolved"))
      limitations.push(
        "模型工作记录仍有待解决问题；其范围、粒度和假设均为自报，不作为已验证事实。",
      );
    if (reasons.includes("unresolved_tool_failure"))
      limitations.push(
        "本任务仍有未与所选结果依赖对应的查询或计算失败，不能认定所有请求均已完成。",
      );
    if (input.findings?.length || input.limitations?.length)
      limitations.push(
        "模型提供的标签、分组、单位、状态和自由文字未作为事实采用；数值与范围由服务端元数据生成。",
      );
    if (
      reasons.includes("calculation_lineage_unsupported") ||
      reasons.includes("query_lineage_unsupported")
    )
      limitations.push(
        "部分表达式或计算缺少可证明的血缘，没有作为已验证数值展示。",
      );
    if (reasons.includes("comparison_unverifiable"))
      limitations.push(
        "部分比较的范围、覆盖、单位、预测状态或整数精度无法证明，没有展示比较结果。",
      );
    if (reasons.includes("arithmetic_lineage_unsupported"))
      limitations.push(
        "部分四则运算的递归来源、资源哈希、授权或新鲜度无法证明，没有展示结果。",
      );
    if (reasons.includes("arithmetic_input_incomplete"))
      limitations.push(
        "部分数学输入包含缺失或覆盖不完整；非 NULL 合计不代表完整总体。",
      );
    if (reasons.includes("aggregate_groups_incomplete"))
      limitations.push(
        "本次聚合结果缺少请求的分组或日期组合；已显示数值只描述返回的分组，不能代表完整总体。",
      );
    if (reasons.includes("transform_lineage_unsupported"))
      limitations.push(
        "部分结果变换的递归来源、资源哈希、授权或新鲜度无法证明，没有展示结果。",
      );
    if (reasons.includes("alignment_lineage_unsupported"))
      limitations.push(
        "部分分组对齐的完整来源、范围或口径无法证明，没有展示结果。",
      );
    if (reasons.includes("alignment_incomplete"))
      limitations.push(
        "对齐来源存在未出现的分组或零分母；变换未把未知结果当作零。",
      );
    if (reasons.includes("transform_coverage_incomplete"))
      limitations.push(
        "变换可能仅覆盖已观察分组，或输入存在未覆盖日期、NULL 或预测状态不明；结果不代表完整总体。",
      );
    if (reasons.includes("transform_undefined_division"))
      limitations.push("变换存在 NULL 输入或零分母，相关结果未知，没有补零。");
    if (reasons.includes("clickhouse_observation_nonatomic"))
      limitations.push(
        "ClickHouse 查询和覆盖统计是独立读取；结果代表各次观测，不宣称跨查询原子快照或共同数据版本。",
      );
    if (reasons.includes("coverage_observations_conflict"))
      limitations.push(
        "相同范围的覆盖观测内容发生变化；跨次比较可能不一致，只能部分交付。",
      );
    if (reasons.includes("alias_preview_hidden"))
      limitations.push(
        "含模型自选列别名的结果预览已隐藏；正式数值按契约字段及单位展示。",
      );
    if (reasons.includes("query_expression_semantics_unverified"))
      limitations.push(
        "SQL 表达式的返回值可追溯到本次查询，但指标名称、单位和业务含义未认证。SQL 中显式空值替换如有发生，不代表观测到零。",
      );
    if (reasons.includes("null_marker_preview_sanitized"))
      limitations.push(
        "结果预览仅显示契约原字段；模型自选的空值标记和别名没有作为可信标签展示。",
      );
    if (reasons.includes("floating_point_approximate"))
      limitations.push(
        "浮点字段及其派生值仅是近似数，尚未实现可验证的精确十进制金额计算。",
      );
    if (reasons.includes("coverage_unknown"))
      limitations.push("预期覆盖范围无法确定，覆盖情况未知。");
    if (reasons.includes("freshness_version_changed"))
      limitations.push(
        "新鲜度发布版本已变化或失效，受影响的数值没有作为已验证事实展示。",
      );
    if (reasons.includes("truncated_result_is_not_population"))
      limitations.push(
        "结果已截断，不能代表完整总体，受影响的数值没有作为已验证事实展示。",
      );
    if (reasons.includes("missing_values_disclosed"))
      limitations.push("NULL 是缺失，没有当作零。");
    if (reasons.includes("true_zeros_disclosed"))
      limitations.push("结果包含数值为零的行；预测状态按契约单独标示。");
    if (reasons.includes("predicted_values_disclosed"))
      limitations.push("预测值和实际值分开列出。");
    if (aggregates.some((item) => Object.keys(item.group).length))
      limitations.push("分组只展示查询中出现的取值，未出现的组合没有补零。");
    if (joinLines.length)
      limitations.push(
        "JOIN 分组只证明实际匹配键在本次查询捕获数据中没有放大；未出现的分组未补零，跨表不具备原子快照。",
      );
    if (dimensionObservations.length)
      limitations.push(
        "维表名称按完整键匹配当前发布快照；仅证明已返回键值，不证明业务日期覆盖、未返回对象或跨查询原子快照。正式区最多展示 100 条键值记录。",
      );
    limitations.push("数据来自本地合成库，不是生产数据。");
    const derivedLines = [
      ...dimensionObservations.map(renderDimensionObservation),
      ...queryObservations.map(renderQueryObservation),
      ...renderDerivedAndGroups(verified, resources, this.ctx.knowledge),
      ...verifiedDecimal.map(renderDecimalCell),
      ...verifiedGroupRollups.map(renderGroupRollup),
      ...tableCellLines,
      ...expressionLines,
      ...comparisons.map(renderComparison),
      ...aggregates.slice(0, 100).map(renderAggregate),
      ...conditionalAggregates.slice(0, 100).map(renderConditionalAggregate),
      ...aggregateComparisons.map(renderAggregateComparison),
      ...arithmeticResults.map((item) => renderArithmetic(item, item.verified_group)),
      ...transformLines,
    ];
    if (aggregates.length > 100)
      derivedLines.push(
        `已验证聚合共 ${aggregates.length} 个，此处展示前 100 个；其余结果保存在当前查询资源中。`,
      );
    if (conditionalAggregates.length > 100)
      derivedLines.push(
        `已验证条件计数共 ${conditionalAggregates.length} 个，此处展示前 100 个；其余结果保存在当前查询资源中。`,
      );
    derivedLines.push(...alignmentLines);
    if (reasons.includes("clickhouse_observation_nonatomic"))
      derivedLines.push(
        "结果基于各次 ClickHouse 观测；查询和覆盖统计不是同一原子快照，未证明共同数据版本。",
      );
    if (reasons.includes("coverage_observations_conflict"))
      derivedLines.push(
        "相同范围的覆盖观测内容发生变化，跨次计算结果不能作为一致数据集的完整结论。",
      );
    derivedLines.push(...joinLines);
    const answer = host?.allowUnreferenced && sources.length === 0 ? "本轮未交付数据库查询结果；模型分析未逐句核验。" : renderAnswer(
      status,
      verified,
      sources,
      input.clarification_question,
      derivedLines,
    );
    const unsafeProse = invalidSelectedResource || reasons.some((reason) => ["contract_or_authorization_changed", "freshness_version_changed", "arithmetic_lineage_unsupported", "calculation_lineage_unsupported", "alignment_lineage_unsupported", "transform_lineage_unsupported"].includes(reason));
    const analysis: AnalysisRecord = {
      analysis_id: newId("an"),
      job_id: jobId,
      session_id: sessionId,
      status,
      answer,
      ...((host && !unsafeProse && displayModelProse(input.draft_answer)) ? { model_answer: displayModelProse(input.draft_answer) } : {}),
      ...(host ? { source_review: { status: sources.length === 0 && !failedUnreferencedData ? "not_applicable" as const : sources.length > 0 && sources.every((source) => source.evidence_eligible && !source.truncated && source.complete_population && (source.dimension_snapshot || source.coverage.status === "known" && !coverageHasGap(source.coverage) && source.coverage.unknown_prediction_dates.length === 0)) && !unsafeProse ? "verified" as const : "partial" as const }, text_review: { status: host.textReviewed ? host.review?.items.some((item) => item.status === "uncertain") ? "ambiguous" as const : status === "partial" ? "gaps_found" as const : "model_checked" as const : "not_run" as const, correctness: "not_certified" as const } } : {}),
      ...(host?.textReviewed && host.review ? { model_coverage_review: { provenance: "model_declared" as const, items: structuredClone(host.review.items) } } : {}),
      limitations: unique(limitations),
      clarification_question: input.clarification_question ?? null,
      citations,
      resource_hashes: Object.fromEntries(
        resources.map((resource) => [
          resource.resource_id,
          createHash("sha256").update(JSON.stringify(resource)).digest("hex"),
        ]),
      ),
      sources: sources.map((source) => {
        const preview = previewRows(source.rows, 100);
        return {
          ...source,
          rows: preview,
          preview_has_more: source.rows.length > preview.length,
          coverage: coveragePreview(source.coverage),
        };
      }),
      calculations,
      ...(queryObservations.length
        ? { query_observations: queryObservations }
        : {}),
      ...(dimensionObservations.length
        ? { dimension_observations: dimensionObservations }
        : {}),
      ...(joinResults.length ? { join_results: joinResults } : {}),
      comparisons,
      aggregate_comparisons: aggregateComparisons,
      arithmetic_results: arithmeticResults,
      transform_results: transformResults,
      alignment_results: alignmentResults,
      aggregates: aggregates.slice(0, 100),
      conditional_aggregates: conditionalAggregates.slice(0, 100),
      aggregate_total: aggregates.length,
      aggregates_has_more: aggregates.length > 100,
      ...(analysisDeclaration
        ? { analysis_declaration: analysisDeclaration }
        : {}),
      model_suggested_status: input.suggested_status,
      model_draft: input.draft_answer,
      server_reasons: unique(reasons),
      simulated: true,
    };
    const existing = sessionAnalyses(session);
    existing.push(analysis);
    return {
      ok: true,
      ...analysis,
      notice: "服务端状态覆盖了模型建议。模型草稿不是权威结论。",
    };
  }

  private async nextRevision(
    sessionId: string,
    jobId: string,
  ): Promise<number | "lost"> {
    const persisted = await this.ctx.sessions.consumeRevision(jobId);
    if (persisted === "lost") return "lost";
    if (typeof persisted === "number") return persisted;
    const key = jobId || sessionId;
    const prior = revisionAttempts.get(key) ?? 0;
    revisionAttempts.set(key, prior + 1);
    return prior + 1;
  }
}
