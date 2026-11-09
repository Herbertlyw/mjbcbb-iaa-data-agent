// Execute admitted read-only SQL and capture bounded evidence.
import { createHash } from "node:crypto";
import { verifyDatabaseAggregates } from "./aggregate-evidence.js";
import { aggregateObservationInput } from "./aggregate-observation.js";
import { verifyConditionalAggregates } from "./conditional-aggregate-evidence.js";
import {
  clickHouseColumns,
  clickHouseColumnTypes,
  ClickHousePlanError,
  clickHousePreflightedQuery,
  clickHouseQueryBounded,
} from "./clickhouse-client.js";
import { planClickHouse, type ClickHousePlan } from "./clickhouse-plan.js";
import {
  clickHousePreflightMessage,
  preflightClickHouseSql,
} from "./clickhouse-sql-preflight.js";
import { currentCalendarDate } from "./config.js";
import {
  assessCoverage,
  combineCoverage,
  provenCoverageScope,
  unknownCoverage,
} from "./coverage.js";
import { plainRows } from "./database.js";
import { verifyDimensionObservations } from "./dimension-observation.js";
import { dimensionSnapshotStatusValid } from "./freshness.js";
import {
  prepareJoinAggregateEvidence,
  verifyJoinEvidence,
  verifyJoinExecutionSchema,
  type JoinEvidencePlan,
} from "./join-evidence.js";
import {
  joinCaptureHash,
  joinCoverage,
  joinDimensionMatchesPublication,
  type JoinQueryResource,
  type PrivateJoinProof,
} from "./join-resource-proof.js";
import {
  canQueryTable,
  tableGrain,
  validateKnowledgeSources,
} from "./knowledge.js";
import { newId } from "./session.js";
import {
  assertJoinKeys,
  guardSql,
  inspectSingleSourceProjection,
  parseReadonlySql,
  SqlRejected,
} from "./sql.js";
import { fail, type ToolContext, type ToolResult } from "./tool-context.js";
import { coveragePreview, previewRows } from "./tool-preview.js";
import type {
  ContractBinding,
  DataContract,
  FreshnessReceipt,
} from "./types.js";

import { ToolAccess } from "./tool-access.js";
import { prepareWideAggregateProof, wideCaptureHash, type WideAggregateProof } from "./wide-aggregate-proof.js";

export class QueryTools {
  private readonly ctx: ToolContext;
  private readonly access: ToolAccess;
  private readonly configuredScanLimit: number;
  constructor(ctx: ToolContext, access: ToolAccess) {
    this.ctx = ctx;
    this.access = access;
    this.configuredScanLimit = ctx.config.clickhouseMaxRowsToRead;
  }
  async query(
    sessionId: string,
    input: { sql?: string; purpose?: string; preview_limit?: number },
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const cancelled = await this.access.gate(sessionId, signal);
    if (cancelled) return cancelled;
    const session = await this.ctx.sessions.requireAsync(sessionId);
    const sql = input.sql ?? "";
    const previewLimit = input.preview_limit ?? 20;
    if (
      !Number.isInteger(previewLimit) ||
      previewLimit < 0 ||
      previewLimit > 100
    )
      return fail("invalid_resource_page", "预览行数须在 0 到 100 之间。");
    let sqlLimited = false;
    let clickHousePlan: ClickHousePlan | undefined;
    let nativeProofSql: string | undefined;
    let nativeScopedObservation = false;
    let nativeJoinPlan: JoinEvidencePlan | null = null;
    let guarded;
    try {
      // In ClickHouse mode, discover candidate physical sources from its own
      // grammar before loading the session's contract-bound rules. This is
      // discovery only; planClickHouse owns ClickHouse admission below.
      const normalized = sql.trim().replace(/;+\s*$/u, "");
      if (!normalized) throw new SqlRejected("invalid_sql", "SQL 为空");
      if (Buffer.byteLength(normalized, "utf8") > 64 * 1024)
        throw new SqlRejected("sql_size_limit", "SQL 超出安全长度上限");
      const inspected =
        this.ctx.businessEngine === "clickhouse"
          ? preflightClickHouseSql(normalized)
          : undefined;
      if (inspected && !inspected.ok)
        throw new SqlRejected(
          inspected.code,
          clickHousePreflightMessage(inspected.code),
        );
      if (this.ctx.businessEngine === "clickhouse") {
        if (!inspected?.ok)
          throw new SqlRejected(
            "clickhouse_parse_failed",
            "ClickHouse 来源未通过审查。",
          );
        const rules = inspected.tables.map((table) =>
          this.access.ruleFor(session, table),
        );
        const contracts = inspected.tables.map(
          (table) => this.ctx.knowledge.contract_by_table.get(table)!.contract!,
        );
        clickHousePlan = planClickHouse(
          normalized,
          rules,
          contracts,
          this.ctx.knowledge.joins,
          this.ctx.config.clickhouseDatabase,
          this.ctx.config.maxResultRows,
        );
        guarded = clickHousePlan.guarded;
        nativeProofSql = clickHousePlan.receipt.proof_sql;
        nativeScopedObservation = clickHousePlan.coverage === "unknown";
        nativeJoinPlan = clickHousePlan.join;
        sqlLimited = clickHousePlan.receipt.sql_limited;
      } else {
        const parsed = parseReadonlySql(sql);
        sqlLimited = containsSqlLimit(parsed.ast);
        guarded = guardSql(
          sql,
          parsed.tables.map((table) => this.access.ruleFor(session, table)),
          "sqlite",
        );
      }
    } catch (error) {
      if (error instanceof SqlRejected) return fail(error.code, error.message);
      throw error;
    }
    const bindings = guarded.tables.map((table) =>
      this.access.queryableBinding(session, table),
    );
    if (
      !(await validateKnowledgeSources(
        this.ctx.knowledge,
        bindings.map((binding) => binding.asset_id),
      ))
    )
      return fail(
        "knowledge_source_changed",
        "权限、连接规则或本次契约文件已变化，请重新加载并绑定。",
      );
    const timezones = new Set(bindings.map((binding) => binding.timezone));
    if (timezones.size !== 1)
      return fail("timezone_conflict", "一张查询里的契约时区不一致");
    const revisions = new Set(
      bindings.map((binding) => binding.registry_revision),
    );
    if (
      revisions.size !== 1 ||
      !revisions.has(this.ctx.knowledge.registry_revision)
    ) {
      return fail("stale_data_contract_binding", "契约绑定不是当前目录修订");
    }
    const decimalTypes: Record<string, string> = {};
    for (const binding of bindings) {
      const asset = this.ctx.knowledge.by_id.get(binding.asset_id);
      if (!asset || asset.content_hash !== binding.content_hash) {
        return fail(
          "asset_revision_changed",
          `${binding.table} 的契约内容在绑定之后变了，本次回答不能混用版本`,
        );
      }
      if (!/^[a-z_][a-z0-9_]*$/u.test(binding.table))
        return fail("unknown_table", "表名无法安全核对");
      const columns = new Set(await this.tableColumns(binding.table));
      const expected = [
        ...binding.allowed_columns,
        ...binding.sensitive_columns,
      ];
      if (expected.some((column) => !columns.has(column))) {
        return fail(
          "schema_contract_mismatch",
          `${binding.table} 的库表字段和契约不一致`,
        );
      }
      const decimalColumns =
        asset.contract?.columns.filter((column) =>
          /^(?:nullable\()?\s*decimal\(/iu.test(column.type),
        ) ?? [];
      if (
        decimalColumns.length &&
        this.ctx.businessEngine === "clickhouse" &&
        this.ctx.clickhouse
      ) {
        const actual = await clickHouseColumnTypes(
          this.ctx.clickhouse,
          binding.table,
        );
        for (const column of decimalColumns) {
          const actualType = actual[column.name];
          if (
            !actualType ||
            actualType.replace(/\s/gu, "").toLowerCase() !==
              column.type.replace(/\s/gu, "").toLowerCase()
          )
            return fail(
              "schema_contract_mismatch",
              `${binding.table} 的十进制类型与契约不一致`,
            );
          decimalTypes[`${binding.table}.${column.name}`] = actualType;
        }
      }
    }
    try {
      const grains = new Map(
        guarded.tables.map((table) => [
          table,
          tableGrain(this.ctx.knowledge, table),
        ]),
      );
      const leftJoinDimensions = new Set(
        guarded.tables.filter((table) => {
          const contract =
            this.ctx.knowledge.contract_by_table.get(table)?.contract;
          return Boolean(
            contract &&
            !contract.series &&
            contract.must_filter.length === 0 &&
            contract.grain?.length &&
            canQueryTable(this.ctx.knowledge, session.role, table),
          );
        }),
      );
      if (!clickHousePlan)
        assertJoinKeys(sql, this.ctx.knowledge.joins, grains, {
          leftJoinDimensions,
        });
    } catch (error) {
      if (error instanceof SqlRejected) return fail(error.code, error.message);
      throw error;
    }
    const joinContracts = guarded.tables.map(
      (table) => this.ctx.knowledge.contract_by_table.get(table)?.contract,
    );
    const joinFact = joinContracts.find((contract) => contract?.series);
    const joinDimension = joinContracts.find(
      (contract) => contract && !contract.series,
    );
    let joinPlan = nativeJoinPlan;
    const initialFreshness = await this.access.currentFreshness();
    if (!initialFreshness.ok) return initialFreshness;
    const published = initialFreshness.publication;
    if (!published)
      return fail(
        "freshness_not_published",
        "没有已发布的新鲜度。查询不会用数据库连通或最大日期代替发布状态。",
      );
    if (
      published.valid_until <
      currentCalendarDate(this.ctx.config, this.ctx.knowledge.timezone)
    ) {
      return fail(
        "freshness_expired",
        "已发布的新鲜度已过期，受影响的数据不能当成已验证事实。",
      );
    }
    const freshnessVersion = published.version;
    const freshnessReceipts: FreshnessReceipt[] = [];
    for (const table of guarded.tables) {
      const contract =
        this.ctx.knowledge.contract_by_table.get(table)?.contract;
      const tableState = published.tables[table];
      // Legacy SQLite examples may query a dimension for diagnostics, but a
      // JOIN cannot later become verified without its authority receipt.
      if (
        !contract?.series &&
        contract?.must_filter.length === 0 &&
        !tableState &&
        this.ctx.config.stateMode !== "mysql"
      )
        continue;
      if (!tableState)
        return fail("freshness_table_missing", `${table} 不在已发布新鲜度里。`);
      if (tableState.status === "probe_failed")
        return fail(
          "freshness_probe_failed",
          `${table} 的离线探测失败，不能当成可查询事实。`,
        );
      if (tableState.status !== "fresh")
        return fail(
          "freshness_not_fresh",
          `${table} 的已发布状态是 ${tableState.status}。`,
        );
      if (
        !contract?.series &&
        contract?.must_filter.length === 0 &&
        (!("kind" in tableState) || tableState.kind !== "dimension_snapshot")
      )
        return fail(
          "dimension_snapshot_missing",
          `${table} 缺少有效的维表发布快照。`,
        );
      freshnessReceipts.push({
        publication_id: published.publication_id,
        version: published.version,
        table,
        status: tableState.status,
        published_at: published.published_at,
      });
    }
    // One deadline covers preflight, the actual read, any proof fallback and
    // coverage reads; EXPLAIN must not create a fresh full timeout budget.
    const deadline = AbortSignal.timeout(this.ctx.config.queryTimeoutMs);
    const querySignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const latency = await waitForQuery(
      this.ctx.config.queryLatencyMs,
      this.ctx.config.queryTimeoutMs,
      querySignal,
    );
    if (latency === "cancelled")
      return deadline.aborted && !signal?.aborted
        ? fail("query_timeout", "查询超时，没有留下结果")
        : fail("query_cancelled", "查询已取消");
    if (latency === "timeout")
      return fail("query_timeout", "查询超时，没有留下结果");
    let rows: Array<Record<string, unknown>>;
    let bounded: Awaited<ReturnType<typeof clickHouseQueryBounded>> | null =
      null;
    let joinProof: PrivateJoinProof | undefined;
    let wideProof: WideAggregateProof | undefined;
    const wideContract = this.ctx.businessEngine === "clickhouse" && clickHousePlan?.receipt.engine === "clickhouse_ast_direct" && guarded.tables.length === 1
      ? this.ctx.knowledge.contract_by_table.get(guarded.tables[0]!)?.contract : undefined;
    const widePlan = wideContract && !sqlLimited
      ? prepareWideAggregateProof(guarded.sql, wideContract, { ...guarded.time_range, timezone: wideContract.timezone }) : null;
    if (widePlan && wideContract && this.ctx.clickhouse) {
      const actual = await clickHouseColumnTypes(this.ctx.clickhouse, wideContract.table);
      for (const field of widePlan.fields) {
        const declared = wideContract.columns.find((column) => column.name === field.physical);
        if (!declared || actual[field.physical]?.replace(/\s/gu, "").toLowerCase() !== declared.type.replace(/\s/gu, "").toLowerCase())
          return fail("schema_contract_mismatch", `${wideContract.table} 的整数类型与契约不一致`);
      }
    }
    let executedSql = joinPlan?.executionSql ?? widePlan?.executionSql ?? guarded.sql;
    const started = Date.now();
    try {
      if (this.ctx.businessEngine === "clickhouse") {
        if (!this.ctx.clickhouse) throw new Error("clickhouse_unavailable");
        bounded = await clickHousePreflightedQuery(
          this.ctx.clickhouse,
          executedSql,
          this.ctx.config.maxResultRows,
          this.ctx.config.maxResultBytes,
          querySignal,
        );
        // Retry only a successfully returned, read-only observation whose
        // detailed proof did not fit or could not verify. This is a new
        // observation, never a continuation or a claim of a shared snapshot.
        if (
          joinPlan?.coarse &&
          !joinPlan.aggregateProof &&
          joinFact &&
          joinDimension &&
          (bounded.truncated ||
            !verifyJoinExecutionSchema(
              joinPlan,
              joinFact,
              joinDimension,
              bounded.column_types,
            ) ||
            !verifyJoinEvidence(joinPlan, bounded.rows) ||
            Buffer.byteLength(
              JSON.stringify({
                captured: bounded.rows,
                cleanRows: bounded.rows.map(
                  ({ __da_join_proof: _proof, ...row }) => row,
                ),
                types: bounded.column_types,
              }),
            ) > this.ctx.config.maxResultBytes)
        ) {
          const aggregatePlan = prepareJoinAggregateEvidence(
            guarded.sql,
            joinFact,
            joinDimension,
            this.ctx.knowledge.joins,
            Boolean(nativeJoinPlan),
          );
          if (aggregatePlan) {
            joinPlan = aggregatePlan;
            executedSql = aggregatePlan.executionSql;
            bounded = await clickHousePreflightedQuery(
              this.ctx.clickhouse,
              executedSql,
              this.ctx.config.maxResultRows,
              this.ctx.config.maxResultBytes,
              querySignal,
            );
          }
        }
        if (joinPlan && joinFact && joinDimension) {
          const captured = bounded.rows;
          const types = bounded.column_types;
          const cleanRows = captured.map(
            ({ __da_join_proof: _proof, ...row }) => row,
          );
          const { __da_join_proof: _proofType, ...cleanTypes } = types;
          if (
            !bounded.truncated &&
            verifyJoinExecutionSchema(
              joinPlan,
              joinFact,
              joinDimension,
              types,
            ) &&
            verifyJoinEvidence(joinPlan, captured) &&
            Buffer.byteLength(JSON.stringify({ captured, cleanRows, types })) <=
              this.ctx.config.maxResultBytes
          ) {
            const dimensionState = published.tables[joinDimension.table];
            if (
              !joinDimensionMatchesPublication(
                joinPlan,
                captured,
                dimensionState,
              )
            )
              return fail(
                "dimension_snapshot_mismatch",
                "本次关联捕获的维表值或缺失键不符合当前权威发布，未保存可交付结果。",
              );
            joinProof = {
              rows: captured,
              column_types: types,
              capture_hash: joinCaptureHash(
                guarded.sql,
                executedSql,
                bounded.query_id,
                captured,
                types,
              ),
            };
          }
          bounded.rows = cleanRows;
          bounded.column_types = cleanTypes;
        }
        if (widePlan && !joinPlan) {
          const captured = bounded.rows;
          const types = bounded.column_types;
          const hidden = new Set([...widePlan.fields.flatMap((field) => [field.proof, ...(field.nonnull ? [field.nonnull] : [])]), ...(widePlan.rowCount ? [widePlan.rowCount] : [])]);
          const cleanRows = captured.map((row) => Object.fromEntries(Object.entries(row).filter(([name]) => !hidden.has(name))));
          const cleanTypes = Object.fromEntries(Object.entries(types).filter(([name]) => !hidden.has(name)));
          if (!bounded.truncated && Buffer.byteLength(JSON.stringify({ captured, cleanRows, types })) <= this.ctx.config.maxResultBytes)
            wideProof = { rows: captured, column_types: types, capture_hash: wideCaptureHash(guarded.sql, executedSql, bounded.query_id, captured, types) };
          bounded.rows = cleanRows;
          bounded.column_types = cleanTypes;
        }
        rows = bounded.rows;
      } else rows = await this.executeGuarded(guarded.sql, querySignal);
    } catch (error) {
      if (signal?.aborted) return fail("query_cancelled", "查询已取消");
      if (deadline.aborted)
        return fail("query_timeout", "查询超时，没有留下结果");
      if (error instanceof ClickHousePlanError)
        return fail(
          error.code,
          "ClickHouse 执行计划预检失败或结果不完整，正式查询没有继续执行。",
        );
      const message = error instanceof Error ? error.message : "查询执行失败";
      if (/max_rows_to_read|Limit for rows/iu.test(message))
        return fail("scan_limit", "查询超过扫描行数限制");
      if (/Timeout|max_execution_time/iu.test(message))
        return fail("query_timeout", "查询超时，没有留下结果");
      return fail(
        "query_execution_failed",
        "查询执行失败；未返回数据库原始错误或查询正文。",
      );
    }
    const elapsedMs = Date.now() - started;
    const refreshed = await this.access.currentFreshness();
    if (!refreshed.ok) return refreshed;
    const after = refreshed.publication;
    if (
      !after ||
      after.publication_id !== published.publication_id ||
      after.version !== freshnessVersion
    ) {
      return fail(
        "freshness_version_changed",
        "查询执行期间新鲜度发布变了，这次没有留下可引用结果。",
      );
    }
    let coverage;
    try {
      const projection = clickHousePlan
        ? null
        : inspectSingleSourceProjection(
            guarded.sql,
            guarded.tables.map((table) => this.access.ruleFor(session, table)),
          );
      coverage =
        clickHousePlan?.coverage === "dimension"
          ? unknownCoverage(
              "维表使用键值快照，不适用业务日期覆盖；契约有效期不是数据统计周期。",
            )
          : nativeScopedObservation
            ? unknownCoverage(
                "嵌套表达式的业务覆盖尚未证明；数据库观察不能当作完整指标。",
              )
            : joinPlan && joinProof
              ? joinCoverage(joinPlan, joinProof.rows, joinFact)
              : await this.coverageForTables(
                  nativeProofSql ?? projection?.proof_sql ?? guarded.sql,
                  guarded.tables,
                  guarded.time_range,
                  bindings,
                  querySignal,
                );
    } catch {
      if (signal?.aborted) return fail("query_cancelled", "查询已取消");
      if (deadline.aborted)
        return fail("query_timeout", "查询超时，没有留下结果");
      return fail(
        "coverage_query_failed",
        "覆盖统计无法完成，查询结果没有保存。",
      );
    }
    if (signal?.aborted) return fail("query_cancelled", "查询已取消");
    if (deadline.aborted)
      return fail("query_timeout", "查询超时，没有留下结果");
    if (Buffer.byteLength(JSON.stringify(coverage)) > 500_000)
      coverage = unknownCoverage("覆盖回执超过保存预算，未证明完整覆盖。");
    // Coverage can itself be a separate database query. It must be included in
    // the freshness interval, rather than checking only the first SELECT.
    const afterCoverage = await this.access.currentFreshness();
    if (!afterCoverage.ok) return afterCoverage;
    if (
      !afterCoverage.publication ||
      afterCoverage.publication.publication_id !== published.publication_id ||
      afterCoverage.publication.version !== freshnessVersion
    ) {
      return fail(
        "freshness_version_changed",
        "覆盖统计期间新鲜度发布变了，这次没有留下可引用结果。",
      );
    }
    const total = bounded?.observed_rows ?? rows.length;
    let returned = rows;
    let truncated = bounded?.truncated ?? false;
    if (returned.length > this.ctx.config.maxResultRows) {
      returned = returned.slice(0, this.ctx.config.maxResultRows);
      truncated = true;
    }
    while (
      returned.length > 0 &&
      Buffer.byteLength(JSON.stringify(returned)) >
        this.ctx.config.maxResultBytes
    ) {
      returned = returned.slice(
        0,
        Math.max(1, Math.floor(returned.length / 2)),
      );
      if (
        Buffer.byteLength(JSON.stringify(returned)) >
        this.ctx.config.maxResultBytes
      )
        returned = returned.slice(0, returned.length - 1);
      truncated = true;
    }
    const timezone = bindings[0]?.timezone ?? this.ctx.knowledge.timezone;
    const dimensionTable =
      clickHousePlan?.coverage === "dimension" ? guarded.tables[0] : undefined;
    const dimensionState = dimensionTable
      ? published.tables[dimensionTable]
      : undefined;
    const dimensionReceipt =
      dimensionTable &&
      dimensionSnapshotStatusValid(dimensionState, dimensionTable) &&
      dimensionState.status === "fresh" &&
      dimensionState.snapshot_hash
        ? {
            table: dimensionTable,
            snapshot_hash: dimensionState.snapshot_hash,
            observed_at: dimensionState.probed_at,
            publication_id: published.publication_id,
            version: published.version,
          }
        : undefined;
    if (dimensionTable && !dimensionReceipt)
      return fail(
        "dimension_snapshot_missing",
        "维表缺少有效的权威键值快照，未保存可交付结果。",
      );
    const resource: JoinQueryResource = {
      resource_id: newId("res"),
      session_id: session.session_id,
      kind: "query_result",
      key_lineage_version: 1,
      result_semantics_version: 2,
      created_at: new Date().toISOString(),
      ...(session.active_job_id ? { job_id: session.active_job_id } : {}),
      engine:
        this.ctx.businessEngine === "clickhouse"
          ? "clickhouse-local"
          : "sqlite-local",
      sql_review_engine: clickHousePlan?.receipt.engine ?? "legacy_guard",
      ...(clickHousePlan ? { review_plan: clickHousePlan.receipt } : {}),
      ...(dimensionReceipt ? { dimension_snapshot: dimensionReceipt } : {}),
      elapsed_ms: elapsedMs,
      execution_id: bounded?.query_id ?? newId("exec"),
      ...(bounded
        ? {
            column_types: bounded.column_types,
            execution_settings: { join_use_nulls: true as const },
          }
        : {}),
      ...(this.ctx.businessEngine === "clickhouse"
        ? { scan_limit: this.configuredScanLimit }
        : {}),
      ...(Object.keys(decimalTypes).length
        ? { decimal_types: decimalTypes }
        : {}),
      simulated: true,
      sql: guarded.sql,
      executed_sql: executedSql,
      tables: guarded.tables,
      contract_revisions: Object.fromEntries(
        bindings.map((binding) => [binding.table, binding.contract_revision]),
      ),
      asset_hashes: Object.fromEntries(
        bindings.map((binding) => [binding.asset_id, binding.content_hash]),
      ),
      registry_revision: this.ctx.knowledge.registry_revision,
      receipt_ids: bindings.map((binding) => binding.receipt_id),
      time_range: { ...guarded.time_range, timezone },
      freshness: bindings.map((binding) => binding.freshness),
      truncated,
      sql_limited: sqlLimited,
      total_rows: total,
      total_rows_exact: !truncated,
      returned_rows: returned.length,
      complete_population: !truncated && !sqlLimited,
      value_semantics: {
        null: "missing",
        zero: "observed_zero",
        predicted_flag: "is_predicted",
      },
      columns: bounded
        ? Object.keys(bounded.column_types)
        : this.ctx.db
            .prepare(executedSql)
            .columns()
            .map((column) => column.name),
      rows: returned,
      coverage,
      freshness_receipts: freshnessReceipts,
      ...(joinProof ? { join_proof: joinProof } : {}),
      ...(wideProof ? { wide_aggregate_proof: wideProof } : {}),
    };
    let dimensionProjectionUnsupported = false;
    if (dimensionTable) {
      const contract =
        this.ctx.knowledge.contract_by_table.get(dimensionTable)!.contract!;
      const verified = verifyDimensionObservations(
        resource,
        contract,
        published,
      );
      if (!verified.ok && verified.code === "dimension_snapshot_mismatch")
        return fail(
          verified.code,
          "本次读取的维表键值与当前权威发布不一致，未保存可交付结果。",
        );
      dimensionProjectionUnsupported = !verified.ok;
    }
    await this.ctx.sessions.saveResourceAsync(resource);
    const resourceHash = createHash("sha256")
      .update(JSON.stringify(resource))
      .digest("hex");
    const preview = previewRows(resource.rows, previewLimit);
    const primaryContract = resource.tables.length === 1
      ? this.ctx.knowledge.contract_by_table.get(resource.tables[0]!)?.contract
      : undefined;
    const inspected = resource.engine === "clickhouse-local" ? preflightClickHouseSql(resource.sql) : null;
    const observedAggregate = primaryContract && aggregateObservationInput(resource, primaryContract);
    const aggregateObservation = !resource.dimension_snapshot && primaryContract && inspected?.ok &&
      inspected.functions.some((name) => ["sum", "sumif", "count", "countif", "avg", "min", "max"].includes(name)) &&
      !observedAggregate && !verifyDatabaseAggregates(resource, primaryContract) && !verifyConditionalAggregates(resource, primaryContract);
    return {
      ok: true,
      resource_id: resource.resource_id,
      sql: resource.sql,
      sql_review_engine: resource.sql_review_engine,
      executed_sql: resource.executed_sql,
      tables: resource.tables,
      contract_revisions: resource.contract_revisions,
      asset_hashes: resource.asset_hashes,
      purpose: input.purpose ?? "",
      time_range: resource.time_range,
      ...(resource.dimension_snapshot
        ? {
            dimension_snapshot: resource.dimension_snapshot,
            time_range_kind: "contract_validity",
          }
        : {}),
      timezone: resource.time_range.timezone,
      freshness: resource.freshness,
      truncated: resource.truncated,
      sql_limited: resource.sql_limited,
      total_rows: resource.total_rows,
      total_rows_exact: resource.total_rows_exact,
      returned_rows: resource.returned_rows,
      complete_population: resource.complete_population,
      value_semantics: resource.value_semantics,
      simulated: true,
      engine: resource.engine,
      execution_id: resource.execution_id ?? null,
      execution_settings: resource.execution_settings ?? null,
      column_types: resource.column_types ?? null,
      elapsed_ms: resource.elapsed_ms,
      columns: resource.columns,
      rows: preview,
      resource_hash: resourceHash,
      preview_has_more: preview.length < resource.rows.length,
      next_row_offset:
        preview.length < resource.rows.length ? preview.length : null,
      coverage: coveragePreview(resource.coverage),
      freshness_receipts: resource.freshness_receipts,
      notice: resource.dimension_snapshot
          ? dimensionProjectionUnsupported
            ? `此维表投影目前不能认证为名称证据。请读取契约，直接投影完整主键（${primaryContract?.grain?.join("、") ?? "以契约为准"}）和所需名称字段，并检查非空、截断与发布快照；不要把别名、聚合或空结果当作键值证明。resource_id=${resource.resource_id}`
            : `维表键值读取；time_range 仅为契约有效期，不是业务统计周期。只有含完整主键且匹配发布快照的直接字段可作为名称证据；空结果不证明不存在，COUNT 不代表业务人数。最终需要此名称时，请同时选择 [[result:${resource.resource_id}]]，仅引用数值计算不会自动选入独立维表。resource_id=${resource.resource_id}`
        : truncated || sqlLimited
          ? `源结果受截断或 SQL LIMIT 约束，不能当作完整总体。resource_id=${resource.resource_id}`
          : resource.rows.length === 0
            ? `给定筛选没有观测到行，空结果不是数值零；请核对契约中的编码、大小写、日期和授权范围，不要凭空补零。resource_id=${resource.resource_id}`
            : observedAggregate?.incomplete
              ? `已识别受契约约束的分组观察值；尚未证明总体或未出现分组的完整性。可使用当前结果计算，并保留部分完成和缺失限制。resource_id=${resource.resource_id}`
            : aggregateObservation
              ? `查询结果已保存，但这个聚合形状当前无法预先证明业务含义和完整性，模型自选别名不是已验证口径。如需可认证的合计，可在权限与行数限制内读取必要明细字段并通过计算工具计算；仍须检查范围、缺失及契约，不能假定一定可交付。resource_id=${resource.resource_id}`
              : resource.coverage.status === "unknown"
                ? `结果已保存，但覆盖范围目前未知，不能把它当作完整总体。若要比较多个不连续日期，可以分别读取各个确定日期并核对各自覆盖。resource_id=${resource.resource_id}`
              : `结果来自本地合成 ${resource.engine}。预览与保存资源分页分开。resource_id=${resource.resource_id}`,
    };
  }

  private async tableColumns(table: string): Promise<string[]> {
    if (this.ctx.businessEngine === "clickhouse") {
      if (!this.ctx.clickhouse) throw new Error("ClickHouse 客户端没有配置");
      return clickHouseColumns(this.ctx.clickhouse, table);
    }
    return plainRows(
      this.ctx.db.prepare(`PRAGMA table_info(${table})`).all(),
    ).map((row) => String(row.name));
  }

  private async executeGuarded(
    sql: string,
    signal?: AbortSignal,
  ): Promise<Array<Record<string, unknown>>> {
    if (this.ctx.businessEngine === "clickhouse") {
      if (!this.ctx.clickhouse) throw new Error("ClickHouse 客户端没有配置");
      const result = await clickHouseQueryBounded(
        this.ctx.clickhouse,
        sql,
        this.ctx.config.maxResultRows,
        this.ctx.config.maxResultBytes,
        signal,
      );
      return result.rows;
    }
    return plainRows(this.ctx.db.prepare(sql).all());
  }

  private async seriesRows(
    contract: DataContract,
    equalities: Record<string, string>,
    timeRange: { start: string; end: string },
    signal?: AbortSignal,
    inSets: Record<string, string[]> = {},
  ) {
    if (this.ctx.businessEngine === "clickhouse") {
      const series = contract.series;
      if (!series) return [];
      const names = [
        ...new Set([
          series.date_column,
          ...series.dimensions,
          ...series.metrics,
          ...(series.predicted_column ? [series.predicted_column] : []),
        ]),
      ];
      if (
        !this.ctx.clickhouse ||
        names.some((name) => !/^[a-z_][a-z0-9_]*$/u.test(name))
      )
        return [];
      const filters = Object.entries(equalities)
        .filter(
          ([column, value]) =>
            /^[a-z_][a-z0-9_]*$/u.test(column) &&
            /^[A-Za-z0-9_-]+$/u.test(value),
        )
        .map(([column, value]) => ` AND ${column} = '${value}'`)
        .join("");
      if (
        Object.entries(inSets).some(
          ([column, values]) =>
            !series.dimensions.includes(column) ||
            !Array.isArray(values) ||
            values.length < 2 ||
            values.length > 32 ||
            values.some((value) => !/^[A-Za-z0-9_-]{1,64}$/u.test(value)),
        )
      )
        return null;
      const setFilters = Object.entries(inSets)
        .map(
          ([column, values]) =>
            ` AND ${column} IN (${values.map((value) => `'${value}'`).join(", ")})`,
        )
        .join("");
      const sql = `SELECT ${names.join(", ")} FROM ${contract.table} WHERE ${series.date_column} >= '${timeRange.start}' AND ${series.date_column} <= '${timeRange.end}'${filters}${setFilters}`;
      const result = await clickHouseQueryBounded(
        this.ctx.clickhouse,
        sql,
        this.ctx.config.maxResultRows,
        this.ctx.config.maxResultBytes,
        signal,
      );
      return result.truncated ? null : result.rows;
    }
    return readSeriesRows(this.ctx.db, contract, equalities, timeRange, inSets);
  }

  private async coverageForTables(
    sql: string,
    tables: string[],
    timeRange: { start: string; end: string },
    bindings: ContractBinding[],
    signal?: AbortSignal,
  ) {
    if (!timeRange.start || !timeRange.end)
      return unknownCoverage("没有封闭日期范围，覆盖情况未知");
    if (tables.length !== 1)
      return unknownCoverage("多表查询的覆盖过滤尚不能证明与主查询一致。");
    const parts = await Promise.all(
      tables.map(async (table) => {
        const contract =
          this.ctx.knowledge.contract_by_table.get(table)?.contract;
        if (!contract?.series)
          return {
            table,
            report: unknownCoverage(`${table} 没有声明日期序列，覆盖情况未知`),
          };
        const applicable = provenCoverageScope(sql, contract, timeRange);
        if (!applicable)
          return {
            table,
            report: unknownCoverage("覆盖统计无法证明与查询筛选完全一致。"),
          };
        if (applicable.selectedDates)
          return {
            table,
            report: unknownCoverage("查询只选择离散日期，尚未验证这些日期及各组的完整覆盖；不能把中间日期当作已查询。"),
          };
        const permitted = new Set(
          bindings.find((binding) => binding.table === table)
            ?.allowed_columns ?? [],
        );
        const needed = [
          contract.series.date_column,
          ...contract.series.dimensions,
          ...contract.series.metrics,
          ...(contract.series.predicted_column
            ? [contract.series.predicted_column]
            : []),
        ];
        if (needed.some((column) => !permitted.has(column)))
          return {
            table,
            report: unknownCoverage("覆盖统计需要未授权字段，未读取这些字段。"),
          };
        const rows = await this.seriesRows(
          contract,
          applicable.equalities,
          timeRange,
          signal,
          applicable.inSets,
        );
        if (!rows)
          return {
            table,
            report: unknownCoverage(
              "覆盖查询超过保存预算，未把预览当作完整覆盖。",
            ),
          };
        // Only a comparison of observed content, not a claim of an immutable
        // ClickHouse version. Sorting makes database row order irrelevant.
        const canonical = rows
          .map((row) =>
            JSON.stringify(
              Object.entries(row).sort(([a], [b]) => a.localeCompare(b)),
            ),
          )
          .sort();
        const observation_hash = createHash("sha256")
          .update(JSON.stringify(canonical))
          .digest("hex");
        return {
          table,
          report: {
            ...assessCoverage(
              contract,
              applicable.equalities,
              timeRange,
              rows,
              applicable.inSets,
            ),
            observation_hash,
          },
        };
      }),
    );
    return combineCoverage(parts);
  }
}

function containsSqlLimit(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsSqlLimit);
  const record = value as Record<string, unknown>;
  if (record.type === "select" && record.limit) return true;
  return Object.values(record).some(containsSqlLimit);
}

function readSeriesRows(
  db: ToolContext["db"],
  contract: DataContract,
  equalities: Record<string, string>,
  timeRange: { start: string; end: string },
  inSets: Record<string, string[]> = {},
): Array<Record<string, unknown>> {
  const series = contract.series;
  if (!series) return [];
  const names = [
    ...new Set([
      series.date_column,
      ...series.dimensions,
      ...series.metrics,
      ...(series.predicted_column ? [series.predicted_column] : []),
    ]),
  ];
  if (
    names.some((name) => !/^[a-z_][a-z0-9_]*$/u.test(name)) ||
    !/^[a-z_][a-z0-9_]*$/u.test(contract.table)
  )
    return [];
  const where = [`${series.date_column} >= ?`, `${series.date_column} <= ?`];
  const params = [timeRange.start, timeRange.end];
  for (const [column, value] of Object.entries(equalities)) {
    if (!/^[a-z_][a-z0-9_]*$/u.test(column)) continue;
    where.push(`${column} = ?`);
    params.push(value);
  }
  for (const [column, values] of Object.entries(inSets)) {
    if (
      !series.dimensions.includes(column) ||
      !Array.isArray(values) ||
      values.length < 2 ||
      values.length > 32 ||
      values.some((value) => !/^[A-Za-z0-9_-]{1,64}$/u.test(value))
    )
      throw new Error("coverage_scope_invalid");
    where.push(`${column} IN (${values.map(() => "?").join(", ")})`);
    params.push(...values);
  }
  return plainRows(
    db
      .prepare(
        `SELECT ${names.join(", ")} FROM ${contract.table} WHERE ${where.join(" AND ")}`,
      )
      .all(...params),
  );
}

function waitForQuery(
  latencyMs: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<"ok" | "timeout" | "cancelled"> {
  if (signal?.aborted) return Promise.resolve("cancelled");
  if (latencyMs <= 0) return Promise.resolve("ok");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: "ok" | "timeout" | "cancelled") => {
      if (settled) return;
      settled = true;
      clearTimeout(latencyTimer);
      clearTimeout(timeoutTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish("cancelled");
    const latencyTimer = setTimeout(() => finish("ok"), latencyMs);
    const timeoutTimer = setTimeout(() => finish("timeout"), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
