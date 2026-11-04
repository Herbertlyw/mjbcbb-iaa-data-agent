import { createHash, randomUUID } from "node:crypto";
import { isAnalysisDeclaration, type AnalysisDeclaration } from "./analysis-declaration.js";
import { currentCalendarDate, isCalendarDate, type AppConfig } from "./config.js";
import { assessCoverage, combineCoverage, coverageHasGap, provenCoverageFilters, provenCoverageScope, unknownCoverage } from "./coverage.js";
import { plainRows } from "./database.js";
import { verifyCell, type CellOperation, type VerifiedCell } from "./evidence.js";
import { compareVerifiedIntegers, type VerifiedComparison } from "./evidence-comparison.js";
import { compareDecimalAggregates, type AggregateComparison } from "./aggregate-comparison.js";
import { arithmeticUnit, computeArithmetic, fromAggregate, isExactZero, sumDecimalStrings, type ArithmeticOp, type ArithmeticValue } from "./exact-arithmetic.js";
import { verifyDecimalCell, type VerifiedDecimalCell } from "./decimal-cell-evidence.js";
import { verifyDatabaseAggregates, type VerifiedAggregate } from "./aggregate-evidence.js";
import { verifyConditionalAggregates, type VerifiedConditionalAggregate } from "./conditional-aggregate-evidence.js";
import { verifyGroupRollup, type VerifiedGroupRollup } from "./aggregate-rollup.js";
import { joinClosedCoverage, joinDimensionObservations, joinMissingDimensionKeys, prepareJoinAggregateEvidence, prepareJoinCoverageEvidence, prepareJoinEvidence, verifyJoinEvidence, verifyJoinExecutionSchema, type JoinEvidencePlan, type VerifiedJoinValue } from "./join-evidence.js";
import { joinResultTable } from "./join-result-table.js";
import { fitsResultCalculationBytes, RESULT_CALCULATION_MAX_ROWS, RESULT_CALCULATION_MAX_BYTES, transformResult, type ResultColumn, type ResultTable, type ResultValue, type TransformStep } from "./result-transform.js";
import { alignAggregates, alignCompleteTables, type AlignedRow, type AlignmentSpec, type CompleteKeyedInput } from "./result-alignment.js";
import { dimensionSnapshotMatches, dimensionSnapshotStatusValid, freshnessManifest, freshnessPeriodKey, matchesFreshnessManifest, readPublication, type FreshnessPublication } from "./freshness.js";
import type { MysqlFreshnessStore } from "./mysql-freshness.js";
import { canQueryTable, canRead, contractValidity, tableGrain, validateKnowledgeSources } from "./knowledge.js";
import { newId, type SessionRecord, type SessionStore } from "./session.js";
import type {
  AnalysisRecord,
  AnalysisStatus,
  AlignmentResource,
  ArithmeticRef,
  ArithmeticResource,
  CalculationResource,
  CoverageReport,
  ContractBinding,
  DataContract,
  FreshnessReceipt,
  KnowledgeBase,
  QueryResource,
  SessionResource,
  ToolFailure,
  TransformResource,
} from "./types.js";
import { clickHouseColumns, clickHouseColumnTypes, clickHouseQueryBounded } from "./clickhouse-client.js";
import { assertJoinKeys, guardSql, inspectSingleSourceProjection, parseReadonlySql, SqlRejected, type TableRule } from "./sql.js";
import type { ClickHouseClient } from "@clickhouse/client";
import type { DatabaseSync } from "node:sqlite";

export interface ToolContext {
  config: AppConfig;
  knowledge: KnowledgeBase;
  db: DatabaseSync;
  sessions: SessionStore;
  businessEngine: "sqlite" | "clickhouse";
  clickhouse: ClickHouseClient | null;
  mysqlFreshness?: () => Promise<MysqlFreshnessStore | null>;
}

type ToolResult = ToolFailure | { ok: true; [key: string]: unknown };
type PrivateJoinProof = { rows: Array<Record<string, unknown>>; column_types: Record<string, string>; capture_hash: string };
type JoinQueryResource = QueryResource & { join_proof?: PrivateJoinProof };

/** Full coverage stays in the resource; model/API responses receive a bounded
 * preview with an explicit count, never a claim that omitted groups are absent. */
function coveragePreview(report: CoverageReport): CoverageReport {
  const groups: CoverageReport["groups"] = []; let bytes = 0;
  for (const group of report.groups.slice(0, 20)) {
    const size = Buffer.byteLength(JSON.stringify(group));
    if (bytes + size > 8000) break;
    groups.push(group); bytes += size;
  }
  return { ...report, groups, groups_total: report.groups.length, groups_has_more: report.groups.length > groups.length, ...(report.per_table ? { per_table: report.per_table.map(coveragePreview) } : {}) };
}

/** Keep response payloads bounded independently of the saved result budget. */
function previewRows<T>(rows: T[], limit: number): T[] {
  const preview: T[] = []; let bytes = 2;
  for (const row of rows.slice(0, limit)) {
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (bytes + size > 32_000) break;
    preview.push(row); bytes += size;
  }
  return preview;
}

export class ToolService {
  private readonly assetBytesRead = new Map<string, number>();
  private readonly configuredScanLimit: number;

  constructor(private readonly ctx: ToolContext) { this.configuredScanLimit = ctx.config.clickhouseMaxRowsToRead; }

  async reserveToolCall(sessionId: string): Promise<"ok" | "budget_exhausted" | "lost"> {
    return this.ctx.sessions.reserveToolCall(sessionId, this.ctx.config.maxToolCalls);
  }

  async searchAssets(sessionId: string, input: { query?: string; kinds?: string[]; offset?: number; limit?: number; expected_search_hash?: string }, signal?: AbortSignal): Promise<ToolResult> {
    const cancelled = await this.gate(sessionId, signal);
    if (cancelled) return cancelled;
    const session = await this.ctx.sessions.requireAsync(sessionId);
    if (!await validateKnowledgeSources(this.ctx.knowledge, this.ctx.knowledge.assets.filter((asset) => asset.status === "published" && asset.discoverable && canRead(this.ctx.knowledge, session.role, asset.asset_id)).map((asset) => asset.asset_id))) return fail("knowledge_source_changed", "知识目录或可读资产已变化，请重新加载后再检索。");
    const query = (input.query ?? "").trim().toLowerCase();
    const kinds = new Set(input.kinds ?? []);
    const offset = input.offset ?? 0; const limit = input.limit ?? 50;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) return fail("invalid_search_page", "搜索偏移须为非负整数，每页限 1 到 100 项。");
    const assets = this.ctx.knowledge.assets
      .filter((asset) => asset.discoverable && asset.status === "published")
      .filter((asset) => kinds.size === 0 || kinds.has(asset.kind))
      .filter((asset) => {
        if (!query) return true;
        // Body and contract definitions may contain searchable metric names,
        // aliases and dimensions. Do not expose a match on a body the caller
        // could not read: search itself must not become a content oracle.
        const body = canRead(this.ctx.knowledge, session.role, asset.asset_id) ? asset.body : "";
        const haystack = [asset.asset_id, asset.kind, asset.title, asset.summary, asset.table ?? "", body].join("\n").toLowerCase();
        if (haystack.includes(query)) return true;
        return query.split(/\s+/u).filter((part) => part.length >= 2).some((part) => haystack.includes(part));
      })
      .sort((a, b) => a.asset_id < b.asset_id ? -1 : a.asset_id > b.asset_id ? 1 : 0);
    const searchHash = createHash("sha256").update(JSON.stringify({ role: session.role, query, kinds: [...kinds].sort(), registry: this.ctx.knowledge.registry_revision, results: assets.map((asset) => [asset.asset_id, asset.content_hash]) })).digest("hex");
    if ((offset > 0 && !input.expected_search_hash) || (input.expected_search_hash && input.expected_search_hash !== searchHash)) return fail("search_version_changed", "续页须使用首页 search_hash；查询、权限或结果变化后请从头搜索。");
    if (offset > assets.length) return fail("invalid_search_page", "搜索偏移超出结果长度。");
    const hits = assets.slice(offset, offset + limit).map((asset) => {
      const readable = canRead(this.ctx.knowledge, session.role, asset.asset_id);
      const term = (input.query ?? "").trim();
      const match = readable && term ? asset.body.indexOf(term) : -1;
      const codePointOffset = match < 0 ? -1 : Array.from(asset.body.slice(0, match)).length;
      const excerptStart = Math.max(0, codePointOffset - 30);
      const excerpt = codePointOffset < 0 ? null : Array.from(asset.body).slice(excerptStart, excerptStart + 120).join("");
      return {
        asset_id: asset.asset_id,
        kind: asset.kind,
        title: asset.title,
        summary: asset.summary,
        revision: asset.revision,
        content_hash: asset.content_hash,
        path: asset.path,
        status: asset.status,
      ...(excerpt === null ? {} : { match_excerpt: excerpt, excerpt_offset: excerptStart, excerpt_offset_unit: "unicode_code_points" }),
        ...(asset.table ? { table: asset.table } : {}),
      };
    });
    return {
      ok: true,
      hits,
      role: session.role,
      search_hash: searchHash,
      total: assets.length,
      offset,
      has_more: offset + hits.length < assets.length,
      next_offset: offset + hits.length < assets.length ? offset + hits.length : null,
      notice: "搜索只用于发现资产，不授予读取正文或查询数据的权限。",
    };
  }

  async readAsset(sessionId: string, input: { asset_id?: string; body_offset?: number; body_limit?: number; expected_content_hash?: string }, signal?: AbortSignal): Promise<ToolResult> {
    const cancelled = await this.gate(sessionId, signal);
    if (cancelled) return cancelled;
    const decision = await this.authorizeRead(sessionId, input.asset_id ?? "");
    if (!decision.ok) return decision;
    const offset = input.body_offset ?? 0;
    const limit = input.body_limit ?? 4000;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 4000) {
      return fail("invalid_asset_page", "正文偏移必须是非负整数，每页限 1 到 4000 个 Unicode 码点。");
    }
    if ((offset > 0 && !input.expected_content_hash) || (input.expected_content_hash && input.expected_content_hash !== decision.asset.content_hash)) {
      return fail("asset_version_changed", "续读必须携带第一页的内容哈希；版本不一致时请从头读取。");
    }
    const characters = Array.from(decision.asset.body);
    if (offset > characters.length) return fail("invalid_asset_page", "正文偏移超出资产长度。");
    const body = characters.slice(offset, offset + limit).join("");
    const next = offset + Array.from(body).length;
    const used = this.assetBytesRead.get(sessionId) ?? 0;
    const bodyBytes = Buffer.byteLength(body);
    if (used + bodyBytes > this.ctx.config.maxAssetReadBytes) {
      return fail("asset_read_budget_exceeded", "本次会话的知识正文读取超过上限。正文不会返回，也不能据此形成正式结论。", { asset_id: decision.asset.asset_id });
    }
    this.assetBytesRead.set(sessionId, used + bodyBytes);
    return {
      ok: true,
      asset_id: decision.asset.asset_id,
      kind: decision.asset.kind,
      revision: decision.asset.revision,
      content_hash: decision.asset.content_hash,
      title: decision.asset.title,
      body,
      body_offset: offset,
      body_limit: limit,
      body_offset_unit: "unicode_code_points",
      total_body_length: characters.length,
      has_more: next < characters.length,
      next_body_offset: next < characters.length ? next : null,
      notice: "读到正文不等于可以查询数据。",
    };
  }

  async readAssets(sessionId: string, input: { asset_ids?: string[]; requests?: Array<{ asset_id: string; body_offset?: number; body_limit?: number; expected_content_hash?: string }>; offset?: number; limit?: number }, signal?: AbortSignal): Promise<ToolResult> {
    const cancelled = await this.gate(sessionId, signal);
    if (cancelled) return cancelled;
    if (input.asset_ids && input.requests) return fail("invalid_asset_page", "请只提供资产 ID 列表或逐项读取请求。");
    const requests = input.requests ?? (input.asset_ids ?? []).map((asset_id) => ({ asset_id }));
    const offset = input.offset ?? 0; const limit = input.limit ?? 50;
    if (!Array.isArray(requests) || requests.length > 100 || !Number.isInteger(offset) || offset < 0 || offset > requests.length || !Number.isInteger(limit) || limit < 1 || limit > 100) return fail("invalid_asset_page", "批量读取最多 100 项，偏移与页大小须在有效范围。");
    const page = requests.slice(offset, offset + limit);
    const results = [];
    for (const request of page) {
      if (!request || typeof request.asset_id !== "string") { results.push(fail("invalid_asset_page", "资产读取请求无效。")); continue; }
      const result = await this.readAsset(sessionId, request, signal);
      results.push({ ...result, asset_id: request.asset_id });
    }
    const anyOk = results.some((item) => item.ok);
    if (!anyOk) {
      return {
        ok: false,
        code: "asset_not_authorized",
        message: "这些资产都没有读取许可",
        results,
        offset,
        limit,
        total: requests.length,
        has_more: offset + page.length < requests.length,
        next_offset: offset + page.length < requests.length ? offset + page.length : null,
        notice: "批量读取逐个授权。成功读取不会创建查询绑定。",
      };
    }
    return {
      ok: true,
      results,
      offset,
      limit,
      total: requests.length,
      has_more: offset + page.length < requests.length,
      next_offset: offset + page.length < requests.length ? offset + page.length : null,
      notice: "批量读取逐项授权；正文偏移按 Unicode 码点，续读须带该资产的内容哈希。成功读取不会创建查询绑定。",
    };
  }

  async readDataContractView(sessionId: string, input: { asset_id?: string; columns_offset?: number; columns_limit?: number; expected_content_hash?: string }, signal?: AbortSignal): Promise<ToolResult> {
    const cancelled = await this.gate(sessionId, signal);
    if (cancelled) return cancelled;
    const decision = await this.authorizeRead(sessionId, input.asset_id ?? "");
    if (!decision.ok) return { ...decision, asset_id: input.asset_id ?? "" };
    const asset = decision.asset;
    if (asset.kind !== "data_contract" || !asset.contract) {
      return fail("missing_data_contract", "这个资产没有数据契约", { asset_id: asset.asset_id });
    }
    const contract = asset.contract;
    const offset = input.columns_offset ?? 0; const limit = input.columns_limit ?? 100;
    if (!Number.isInteger(offset) || offset < 0 || offset > contract.columns.length || !Number.isInteger(limit) || limit < 1 || limit > 100) return fail("invalid_contract_page", "字段偏移或页大小无效。");
    if ((offset > 0 && !input.expected_content_hash) || (input.expected_content_hash && input.expected_content_hash !== asset.content_hash)) return fail("asset_version_changed", "续页须带首页的内容哈希，版本变化后请重新读取。");
    const session = await this.ctx.sessions.requireAsync(sessionId);
    const validity = contractValidity(contract, currentCalendarDate(this.ctx.config, contract.timezone));
    const allowed = canQueryTable(this.ctx.knowledge, session.role, contract.table);
    const queryable = !validity && allowed;
    const denyReason = validity === "expired" ? "expired_contract" : validity === "not_yet_valid" ? "contract_not_yet_valid" : validity === "invalid" ? "invalid_contract_period" : !allowed ? "table_not_authorized" : undefined;
    const binding: ContractBinding = {
      receipt_id: `rcpt_${randomUUID()}`,
      session_id: session.session_id,
      asset_id: asset.asset_id,
      table: contract.table,
      contract_revision: contract.revision,
      registry_revision: this.ctx.knowledge.registry_revision,
      content_hash: asset.content_hash,
      queryable,
      ...(denyReason ? { deny_reason: denyReason } : {}),
      allowed_columns: contract.columns.map((column) => column.name).filter((name) => !contract.sensitive_columns.includes(name)),
      sensitive_columns: contract.sensitive_columns,
      must_filter: contract.must_filter,
      timezone: contract.timezone,
      freshness: contract.freshness,
      valid_until: contract.valid_until,
      read_at: new Date().toISOString(),
    };
    session.bindings = [...session.bindings.filter((item) => item.table !== contract.table), binding];
    await this.ctx.sessions.saveAsync(session);
    const freshnessResult = await this.currentFreshness();
    const publication = freshnessResult.ok ? freshnessResult.publication : null;
    const publishedTable = publication?.tables[contract.table];
    return {
      ok: true,
      asset_id: asset.asset_id,
      receipt_id: binding.receipt_id,
      table: contract.table,
      contract_revision: contract.revision,
      registry_revision: binding.registry_revision,
      queryable,
      ...(denyReason ? { reason: denyReason } : {}),
      timezone: contract.timezone,
      must_filter: contract.must_filter,
      series: contract.series ?? null,
      content_hash: asset.content_hash,
      grain: tableGrain(this.ctx.knowledge, contract.table),
      columns: contract.columns.slice(offset, offset + limit).map((column) => ({
        name: column.name,
        type: column.type,
        unit: column.unit ?? null,
        description: column.description,
        sensitive: contract.sensitive_columns.includes(column.name),
        nullable: column.nullable === true,
        null_means: column.null_means ?? null,
        zero_means: column.zero_means ?? null,
      })),
      columns_offset: offset,
      columns_total: contract.columns.length,
      columns_has_more: offset + limit < contract.columns.length,
      columns_next_offset: offset + limit < contract.columns.length ? offset + limit : null,
      freshness: contract.freshness,
      published_freshness: publication && publishedTable ? { ...publishedTable, status: publication.valid_until < currentCalendarDate(this.ctx.config, this.ctx.knowledge.timezone) ? "expired" : publishedTable.status, publication_id: publication.publication_id, version: publication.version, valid_until: publication.valid_until } : { status: freshnessResult.ok ? "not_published" : "unavailable" },
      valid_from: contract.valid_from,
      valid_until: contract.valid_until,
      simulated: true,
      notice: queryable ? "服务端已记录当前契约绑定。模型提交的资产 ID 本身不是授权。" : "契约已读取，但不能用于查询。",
    };
  }

  async query(sessionId: string, input: { sql?: string; purpose?: string; preview_limit?: number }, signal?: AbortSignal): Promise<ToolResult> {
    const cancelled = await this.gate(sessionId, signal);
    if (cancelled) return cancelled;
    const session = await this.ctx.sessions.requireAsync(sessionId);
    const sql = input.sql ?? "";
    const previewLimit = input.preview_limit ?? 20;
    if (!Number.isInteger(previewLimit) || previewLimit < 0 || previewLimit > 100) return fail("invalid_resource_page", "预览行数须在 0 到 100 之间。");
    let sqlLimited = false;
    let guarded;
    try {
      const parsed = parseReadonlySql(sql);
      sqlLimited = containsSqlLimit(parsed.ast);
      const rules = parsed.tables.map((table) => this.ruleFor(session, table));
      guarded = guardSql(sql, rules, this.ctx.businessEngine === "clickhouse" ? "clickhouse" : "sqlite");
    } catch (error) {
      if (error instanceof SqlRejected) return fail(error.code, error.message);
      throw error;
    }
    const bindings = guarded.tables.map((table) => this.queryableBinding(session, table));
    if (!await validateKnowledgeSources(this.ctx.knowledge, bindings.map((binding) => binding.asset_id))) return fail("knowledge_source_changed", "权限、连接规则或本次契约文件已变化，请重新加载并绑定。");
    const timezones = new Set(bindings.map((binding) => binding.timezone));
    if (timezones.size !== 1) return fail("timezone_conflict", "一张查询里的契约时区不一致");
    const revisions = new Set(bindings.map((binding) => binding.registry_revision));
    if (revisions.size !== 1 || !revisions.has(this.ctx.knowledge.registry_revision)) {
      return fail("stale_data_contract_binding", "契约绑定不是当前目录修订");
    }
    const decimalTypes: Record<string, string> = {};
    for (const binding of bindings) {
      const asset = this.ctx.knowledge.by_id.get(binding.asset_id);
      if (!asset || asset.content_hash !== binding.content_hash) {
        return fail("asset_revision_changed", `${binding.table} 的契约内容在绑定之后变了，本次回答不能混用版本`);
      }
      if (!/^[a-z_][a-z0-9_]*$/u.test(binding.table)) return fail("unknown_table", "表名无法安全核对");
      const columns = new Set(await this.tableColumns(binding.table));
      const expected = [...binding.allowed_columns, ...binding.sensitive_columns];
      if (expected.some((column) => !columns.has(column))) {
        return fail("schema_contract_mismatch", `${binding.table} 的库表字段和契约不一致`);
      }
      const decimalColumns = asset.contract?.columns.filter((column) => /^(?:nullable\()?\s*decimal\(/iu.test(column.type)) ?? [];
      if (decimalColumns.length && this.ctx.businessEngine === "clickhouse" && this.ctx.clickhouse) {
        const actual = await clickHouseColumnTypes(this.ctx.clickhouse, binding.table);
        for (const column of decimalColumns) {
          const actualType = actual[column.name];
          if (!actualType || actualType.replace(/\s/gu, "").toLowerCase() !== column.type.replace(/\s/gu, "").toLowerCase()) return fail("schema_contract_mismatch", `${binding.table} 的十进制类型与契约不一致`);
          decimalTypes[`${binding.table}.${column.name}`] = actualType;
        }
      }
    }
    try {
      const grains = new Map(guarded.tables.map((table) => [table, tableGrain(this.ctx.knowledge, table)]));
      const leftJoinDimensions = new Set(guarded.tables.filter((table) => {
        const contract = this.ctx.knowledge.contract_by_table.get(table)?.contract;
        return Boolean(contract && !contract.series && contract.must_filter.length === 0 && contract.grain?.length && canQueryTable(this.ctx.knowledge, session.role, table));
      }));
      assertJoinKeys(sql, this.ctx.knowledge.joins, grains, { leftJoinDimensions });
    } catch (error) {
      if (error instanceof SqlRejected) return fail(error.code, error.message);
      throw error;
    }
    const joinContracts = guarded.tables.map((table) => this.ctx.knowledge.contract_by_table.get(table)?.contract);
    const joinFact = joinContracts.find((contract) => contract?.series);
    const joinDimension = joinContracts.find((contract) => contract && !contract.series);
    let joinPlan = this.ctx.businessEngine === "clickhouse" && guarded.tables.length === 2 && joinFact && joinDimension
      ? (joinFact.series?.coverage_domains !== undefined ? prepareJoinCoverageEvidence(guarded.sql, joinFact, joinDimension, this.ctx.knowledge.joins) : null) ?? prepareJoinEvidence(guarded.sql, joinFact, joinDimension, this.ctx.knowledge.joins) : null;
    const initialFreshness = await this.currentFreshness();
    if (!initialFreshness.ok) return initialFreshness;
    const published = initialFreshness.publication;
    if (!published) return fail("freshness_not_published", "没有已发布的新鲜度。查询不会用数据库连通或最大日期代替发布状态。");
    if (published.valid_until < currentCalendarDate(this.ctx.config, this.ctx.knowledge.timezone)) {
      return fail("freshness_expired", "已发布的新鲜度已过期，受影响的数据不能当成已验证事实。");
    }
    const freshnessVersion = published.version;
    const freshnessReceipts: FreshnessReceipt[] = [];
    for (const table of guarded.tables) {
      const contract = this.ctx.knowledge.contract_by_table.get(table)?.contract;
      const tableState = published.tables[table];
      // Legacy SQLite examples may query a dimension for diagnostics, but a
      // JOIN cannot later become verified without its authority receipt.
      if (!contract?.series && contract?.must_filter.length === 0 && !tableState && this.ctx.config.stateMode !== "mysql") continue;
      if (!tableState) return fail("freshness_table_missing", `${table} 不在已发布新鲜度里。`);
      if (tableState.status === "probe_failed") return fail("freshness_probe_failed", `${table} 的离线探测失败，不能当成可查询事实。`);
      if (tableState.status !== "fresh") return fail("freshness_not_fresh", `${table} 的已发布状态是 ${tableState.status}。`);
      if (!contract?.series && contract?.must_filter.length === 0 && (!("kind" in tableState) || tableState.kind !== "dimension_snapshot")) return fail("dimension_snapshot_missing", `${table} 缺少有效的维表发布快照。`);
      freshnessReceipts.push({
        publication_id: published.publication_id,
        version: published.version,
        table,
        status: tableState.status,
        published_at: published.published_at,
      });
    }
    const latency = await waitForQuery(this.ctx.config.queryLatencyMs, this.ctx.config.queryTimeoutMs, signal);
    if (latency === "cancelled") return fail("query_cancelled", "查询已取消");
    if (latency === "timeout") return fail("query_timeout", "查询超时，没有留下结果");
    let rows: Array<Record<string, unknown>>;
    let bounded: Awaited<ReturnType<typeof clickHouseQueryBounded>> | null = null;
    let joinProof: PrivateJoinProof | undefined;
    let executedSql = joinPlan?.executionSql ?? guarded.sql;
    const started = Date.now();
    try {
      if (this.ctx.businessEngine === "clickhouse") {
        if (!this.ctx.clickhouse) throw new Error("clickhouse_unavailable");
        bounded = await clickHouseQueryBounded(this.ctx.clickhouse, executedSql, this.ctx.config.maxResultRows, this.ctx.config.maxResultBytes, signal);
        // Retry only a successfully returned, read-only observation whose
        // detailed proof did not fit or could not verify. This is a new
        // observation, never a continuation or a claim of a shared snapshot.
        if (joinPlan?.coarse && !joinPlan.aggregateProof && joinFact && joinDimension && (bounded.truncated || !verifyJoinExecutionSchema(joinPlan, joinFact, joinDimension, bounded.column_types) || !verifyJoinEvidence(joinPlan, bounded.rows) || Buffer.byteLength(JSON.stringify({ captured: bounded.rows, cleanRows: bounded.rows.map(({ __da_join_proof: _proof, ...row }) => row), types: bounded.column_types })) > this.ctx.config.maxResultBytes)) {
          const aggregatePlan = prepareJoinAggregateEvidence(guarded.sql, joinFact, joinDimension, this.ctx.knowledge.joins);
          if (aggregatePlan) {
            joinPlan = aggregatePlan;
            executedSql = aggregatePlan.executionSql;
            bounded = await clickHouseQueryBounded(this.ctx.clickhouse, executedSql, this.ctx.config.maxResultRows, this.ctx.config.maxResultBytes, signal);
          }
        }
        if (joinPlan && joinFact && joinDimension) {
          const captured = bounded.rows;
          const types = bounded.column_types;
          const cleanRows = captured.map(({ __da_join_proof: _proof, ...row }) => row);
          const { __da_join_proof: _proofType, ...cleanTypes } = types;
          if (!bounded.truncated && verifyJoinExecutionSchema(joinPlan, joinFact, joinDimension, types) && verifyJoinEvidence(joinPlan, captured) && Buffer.byteLength(JSON.stringify({ captured, cleanRows, types })) <= this.ctx.config.maxResultBytes) {
            const dimensionState = published.tables[joinDimension.table];
            if (!joinDimensionMatchesPublication(joinPlan, captured, dimensionState)) return fail("dimension_snapshot_mismatch", "本次关联捕获的维表值或缺失键不符合当前权威发布，未保存可交付结果。");
            joinProof = { rows: captured, column_types: types, capture_hash: joinCaptureHash(guarded.sql, executedSql, bounded.query_id, captured, types) };
          }
          bounded.rows = cleanRows;
          bounded.column_types = cleanTypes;
        }
        rows = bounded.rows;
      } else rows = await this.executeGuarded(guarded.sql, signal);
    } catch (error) {
      if (signal?.aborted) return fail("query_cancelled", "查询已取消");
      const message = error instanceof Error ? error.message : "查询执行失败";
      if (/max_rows_to_read|Limit for rows/iu.test(message)) return fail("scan_limit", "查询超过扫描行数限制");
      if (/Timeout|max_execution_time/iu.test(message)) return fail("query_timeout", "查询超时，没有留下结果");
      return fail("query_execution_failed", "查询执行失败；未返回数据库原始错误或查询正文。");
    }
    const elapsedMs = Date.now() - started;
    const refreshed = await this.currentFreshness();
    if (!refreshed.ok) return refreshed;
    const after = refreshed.publication;
    if (!after || after.publication_id !== published.publication_id || after.version !== freshnessVersion) {
      return fail("freshness_version_changed", "查询执行期间新鲜度发布变了，这次没有留下可引用结果。");
    }
    let coverage;
    try {
      const projection = inspectSingleSourceProjection(guarded.sql, guarded.tables.map((table) => this.ruleFor(session, table)));
      coverage = joinPlan && joinProof ? joinCoverage(joinPlan, joinProof.rows, joinFact) : await this.coverageForTables(projection?.proof_sql ?? guarded.sql, guarded.tables, guarded.time_range, bindings, signal);
    } catch {
      if (signal?.aborted) return fail("query_cancelled", "查询已取消");
      return fail("coverage_query_failed", "覆盖统计无法完成，查询结果没有保存。");
    }
    if (Buffer.byteLength(JSON.stringify(coverage)) > 500_000) coverage = unknownCoverage("覆盖回执超过保存预算，未证明完整覆盖。");
    // Coverage can itself be a separate database query. It must be included in
    // the freshness interval, rather than checking only the first SELECT.
    const afterCoverage = await this.currentFreshness();
    if (!afterCoverage.ok) return afterCoverage;
    if (!afterCoverage.publication || afterCoverage.publication.publication_id !== published.publication_id || afterCoverage.publication.version !== freshnessVersion) {
      return fail("freshness_version_changed", "覆盖统计期间新鲜度发布变了，这次没有留下可引用结果。");
    }
    const total = bounded?.observed_rows ?? rows.length;
    let returned = rows;
    let truncated = bounded?.truncated ?? false;
    if (returned.length > this.ctx.config.maxResultRows) {
      returned = returned.slice(0, this.ctx.config.maxResultRows);
      truncated = true;
    }
    while (returned.length > 0 && Buffer.byteLength(JSON.stringify(returned)) > this.ctx.config.maxResultBytes) {
      returned = returned.slice(0, Math.max(1, Math.floor(returned.length / 2)));
      if (Buffer.byteLength(JSON.stringify(returned)) > this.ctx.config.maxResultBytes) returned = returned.slice(0, returned.length - 1);
      truncated = true;
    }
    const timezone = bindings[0]?.timezone ?? this.ctx.knowledge.timezone;
    const resource: JoinQueryResource = {
      resource_id: newId("res"),
      session_id: session.session_id,
      kind: "query_result",
      created_at: new Date().toISOString(),
      ...(session.active_job_id ? { job_id: session.active_job_id } : {}),
      engine: this.ctx.businessEngine === "clickhouse" ? "clickhouse-local" : "sqlite-local",
      elapsed_ms: elapsedMs,
      execution_id: bounded?.query_id ?? newId("exec"),
      ...(bounded ? { column_types: bounded.column_types, execution_settings: { join_use_nulls: true as const } } : {}),
      ...(this.ctx.businessEngine === "clickhouse" ? { scan_limit: this.configuredScanLimit } : {}),
      ...(Object.keys(decimalTypes).length ? { decimal_types: decimalTypes } : {}),
      simulated: true,
      sql: guarded.sql,
      executed_sql: executedSql,
      tables: guarded.tables,
      contract_revisions: Object.fromEntries(bindings.map((binding) => [binding.table, binding.contract_revision])),
      asset_hashes: Object.fromEntries(bindings.map((binding) => [binding.asset_id, binding.content_hash])),
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
      value_semantics: { null: "missing", zero: "observed_zero", predicted_flag: "is_predicted" },
      columns: bounded ? Object.keys(bounded.column_types) : returned[0] ? Object.keys(returned[0]) : guarded.columns,
      rows: returned,
      coverage,
      freshness_receipts: freshnessReceipts,
      ...(joinProof ? { join_proof: joinProof } : {}),
    };
    await this.ctx.sessions.saveResourceAsync(resource);
    const resourceHash = createHash("sha256").update(JSON.stringify(resource)).digest("hex");
    const preview = previewRows(resource.rows, previewLimit);
    return {
      ok: true,
      resource_id: resource.resource_id,
      sql: resource.sql,
      executed_sql: resource.executed_sql,
      tables: resource.tables,
      contract_revisions: resource.contract_revisions,
      asset_hashes: resource.asset_hashes,
      purpose: input.purpose ?? "",
      time_range: resource.time_range,
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
      next_row_offset: preview.length < resource.rows.length ? preview.length : null,
      coverage: coveragePreview(resource.coverage),
      freshness_receipts: resource.freshness_receipts,
      notice: truncated || sqlLimited ? `源结果受截断或 SQL LIMIT 约束，不能当作完整总体。resource_id=${resource.resource_id}` : `结果来自本地合成 ${resource.engine}。预览与保存资源分页分开。resource_id=${resource.resource_id}`,
    };
  }

  async calculateSessionCells(
    sessionId: string,
    input: { resource_id?: string; operations?: CellOperation[]; arithmetic?: { op: ArithmeticOp; left: ArithmeticRef; right: ArithmeticRef }; transform?: { resource_id: string; steps: TransformStep[] }; align?: AlignmentSpec },
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const cancelled = await this.gate(sessionId, signal);
    if (cancelled) return cancelled;
    if (!await validateKnowledgeSources(this.ctx.knowledge)) return fail("knowledge_source_changed", "权限或知识目录已变化，请重新加载。");
    const references = input.align ? [input.align.left?.resource_id, input.align.right?.resource_id] : input.transform ? [input.transform.resource_id] : input.arithmetic ? [input.arithmetic.left?.resource_id, input.arithmetic.right?.resource_id] : [input.resource_id];
    for (const id of references) {
      if (typeof id !== "string") continue;
      const resource = await this.ctx.sessions.lookupResourceAsync(sessionId, id);
      if (!resource.ok) return fail(resource.code, resource.message);
      if (!await this.resourceReadable(sessionId, resource.resource, new Set())) return fail("resource_authorization_changed", "资源引用的授权、契约或来源发生变化，不能继续读取或计算。");
    }
    if (input.align) {
      if (input.transform || input.arithmetic || input.resource_id || input.operations) return fail("invalid_alignment", "分组对齐须单独提交。");
      return this.calculateAlignment(sessionId, input.align);
    }
    if (input.transform) {
      if (input.arithmetic || input.resource_id || input.operations) return fail("invalid_transform", "表格变换须单独提交。");
      return this.calculateTransform(sessionId, input.transform);
    }
    if (input.arithmetic) {
      if (input.resource_id || input.operations) return fail("invalid_arithmetic", "四则运算与单资源汇总须分开提交。");
      return this.calculateArithmetic(sessionId, input.arithmetic);
    }
    if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 40) return fail("invalid_calculation", "每次须提供 1 到 40 个计算操作。");
    const found = await this.ctx.sessions.lookupResourceAsync(sessionId, input.resource_id ?? "");
    if (!found.ok) return fail(found.code, found.message);
    if (found.resource.kind !== "query_result") return fail("resource_not_calculable", "只能计算查询结果资源");
    const source = found.resource;
    const activeJob = (await this.ctx.sessions.requireAsync(sessionId)).active_job_id;
    if (activeJob && source.job_id !== activeJob) return fail("resource_from_other_execution", "只能计算当前任务的查询结果；请重新查询并复核契约与新鲜度。");
    const cells: Record<string, number | string | null> = {};
    const notes: string[] = [];
    const operations: Record<string, CellOperation> = Object.create(null) as Record<string, CellOperation>;
    for (const operation of input.operations) {
      if (!operation || !["sum", "count_null", "count_zero", "count_rows"].includes(operation.op) || operation.predicted && !["any", "actual_only", "predicted_only"].includes(operation.predicted)) return fail("invalid_calculation", "不支持的计算或预测筛选。");
      if (typeof operation.as !== "string" || !operation.as || operation.as.length > 80 || Object.hasOwn(operations, operation.as)) return fail("duplicate_cell", "计算单元格名称必须非空、长度有限且不重复。");
      if (operation.op !== "count_rows" && (!operation.column || !source.columns.includes(operation.column))) return fail("column_not_in_resource", "计算字段不在已保存资源中。");
      operations[operation.as] = { ...operation };
      const contract = source.tables.length === 1 ? this.ctx.knowledge.contract_by_table.get(source.tables[0]!)?.contract : undefined;
      Object.defineProperty(cells, operation.as, { value: computeCell(source, contract, operation, notes), enumerable: true, configurable: true, writable: true });
    }
    const resource: CalculationResource = {
      resource_id: newId("res"),
      session_id: sessionId,
      kind: "calculation",
      created_at: new Date().toISOString(),
      ...(activeJob ? { job_id: activeJob } : {}),
      source_resource_id: source.resource_id,
      cells,
      operations,
      input_truncated: source.truncated || source.sql_limited === true,
      complete_population: source.complete_population && !source.truncated,
      null_means: "missing",
      zero_means: "observed_zero",
      predicted_means: "forecast_not_actual",
      notes,
    };
    await this.ctx.sessions.saveResourceAsync(resource);
    return {
      ok: true,
      resource_id: resource.resource_id,
      source_resource_id: source.resource_id,
      cells,
      input_truncated: resource.input_truncated,
      complete_population: resource.complete_population,
      null_means: resource.null_means,
      zero_means: resource.zero_means,
      predicted_means: resource.predicted_means,
      notes,
      notice: `resource_id=${resource.resource_id}`,
    };
  }

  private async calculateArithmetic(sessionId: string, expression: { op: ArithmeticOp; left: ArithmeticRef; right: ArithmeticRef }): Promise<ToolResult> {
    if (!expression || !["add", "subtract", "multiply", "divide"].includes(expression.op)) return fail("invalid_arithmetic", "未支持的运算。");
    const session = await this.ctx.sessions.requireAsync(sessionId);
    const jobId = session.active_job_id;
    if (!jobId) return fail("missing_active_job", "四则运算需要当前任务及其证据资源。");
    const fresh = await this.currentFreshness();
    if (!fresh.ok) return fresh;
    if (!fresh.publication) return fail("freshness_not_published", "没有已发布新鲜度。");
    const left = await this.resolveArithmetic(session, jobId, expression.left, fresh.publication, new Set());
    const right = await this.resolveArithmetic(session, jobId, expression.right, fresh.publication, new Set());
    if (!left || !right) return fail("arithmetic_lineage_unsupported", "输入不属于当前任务、已变化或不能证明完整血缘。");
    const result = this.computeProvenArithmetic(expression.op, left.value, right.value);
    if (!result) return fail("arithmetic_scope_incompatible", "指标关系须由契约声明，且单位、粒度、实际/预测状态及范围须兼容。");
    const resource: ArithmeticResource = { resource_id: newId("res"), session_id: sessionId, job_id: jobId, kind: "arithmetic", created_at: new Date().toISOString(), operation: expression.op, left: expression.left, right: expression.right, input_hashes: { ...left.hashes, ...right.hashes }, result, input_truncated: false, complete_population: true };
    await this.ctx.sessions.saveResourceAsync(resource);
    return { ok: true, resource_id: resource.resource_id, result: resource.result, dependencies: Object.keys(resource.input_hashes), notice: `${result.value === null ? "除数为零，结果不可计算；没有补成零。" : "定点计算；除法保留 18 位小数、半数远离零。正式结论须引用所有来源并经服务端复核。"} resource_id=${resource.resource_id}` };
  }

  private computeProvenArithmetic(op: ArithmeticOp, left: ArithmeticValue, right: ArithmeticValue): ArithmeticValue | null {
    const a = left.basis; const b = right.basis;
    const aBases = left.bases ?? [a]; const bBases = right.bases ?? [b];
    let declared = false;
    if (aBases.length === 1 && bBases.length === 1 && (a.table !== b.table || a.column !== b.column)) {
      const leftContract = this.ctx.knowledge.contract_by_table.get(a.table)?.contract;
      const rightContract = this.ctx.knowledge.contract_by_table.get(b.table)?.contract;
      const aSeries = leftContract?.series; const bSeries = rightContract?.series;
      const keys = (items: string[]) => JSON.stringify([...items].sort());
      const equalGrain = leftContract && rightContract && aSeries && bSeries && aSeries.date_column === bSeries.date_column && keys(aSeries.dimensions) === keys(bSeries.dimensions) && keys(tableGrain(this.ctx.knowledge, a.table)) === keys(tableGrain(this.ctx.knowledge, b.table)) && [aSeries.date_column, ...aSeries.dimensions].every((name) => {
        const leftType = leftContract.columns.find((column) => column.name === name)?.type.replace(/\s/gu, "").toLowerCase();
        const rightType = rightContract.columns.find((column) => column.name === name)?.type.replace(/\s/gu, "").toLowerCase();
        return Boolean(leftType && leftType === rightType);
      });
      const metric = (table: string, field: string, name: string) => name === `${table}.${field}` || name === field && a.table === b.table;
      const definitions = [...(leftContract?.derived_metrics ?? []), ...(a.table === b.table ? [] : rightContract?.derived_metrics ?? [])];
      const expectedUnit = arithmeticUnit(op, a.unit, b.unit);
      declared = Boolean(equalGrain && expectedUnit && a.operation === "sum" && b.operation === "sum" && a.prediction === "actual_observed_only" && b.prediction === a.prediction && a.timezone === b.timezone && definitions.some((item) => item.operation === op && item.prediction === "actual_only" && item.unit === expectedUnit && metric(a.table, a.column, item.numerator) && metric(b.table, b.column, item.denominator)));
    }
    return computeArithmetic(op, left, right, declared);
  }

  private async calculateTransform(sessionId: string, input: { resource_id: string; steps: TransformStep[] }): Promise<ToolResult> {
    if (!input || typeof input.resource_id !== "string" || !Array.isArray(input.steps)) return fail("invalid_transform", "变换须指定输入资源和操作列表。");
    const session = await this.ctx.sessions.requireAsync(sessionId);
    const jobId = session.active_job_id;
    if (!jobId) return fail("missing_active_job", "表格变换需要当前任务。");
    const fresh = await this.currentFreshness();
    if (!fresh.ok) return fresh;
    if (!fresh.publication) return fail("freshness_not_published", "没有已发布新鲜度。");
    const inputTable = await this.resolveTransform(session, jobId, input.resource_id, fresh.publication, new Set());
    if (!inputTable) return fail("transform_lineage_unsupported", `输入必须为当前任务完整、可验证的查询或变换资源；计算上限为 ${RESULT_CALCULATION_MAX_ROWS} 行和 ${RESULT_CALCULATION_MAX_BYTES} 字节。`);
    const transformed = this.applyProvenTransform(inputTable.table, input.steps);
    if (!transformed) return fail("invalid_transform", "变换参数、类型、契约指标关系或资源边界不受支持。");
    const result = transformed.table;
    const resource: TransformResource = { resource_id: newId("res"), session_id: sessionId, job_id: jobId, kind: "transform", created_at: new Date().toISOString(), source_resource_id: input.resource_id, steps: input.steps, input_hashes: inputTable.hashes, result, input_truncated: false, complete_population: true };
    await this.ctx.sessions.saveResourceAsync(resource);
    const preview = previewRows(result.rows, 100);
    return { ok: true, resource_id: resource.resource_id, result: { ...result, rows: preview }, result_total_rows: result.rows.length, result_has_more: result.rows.length > preview.length, dependencies: Object.keys(resource.input_hashes), notice: `变换应用于完整已保存结果；预览限 100 行及 32 KB，可使用 read_session_resource 续读。${transformed.undefinedArithmetic ? "存在 NULL 输入或零分母，部分运算结果未知。" : ""}正式交付时递归复核来源。resource_id=${resource.resource_id}` };
  }

  /** Only host-reconstructed JOIN SUM provenance can establish a declared
   * same-row arithmetic. Labels and units supplied by the model confer no rights. */
  private authorizeTransformArithmetic(left: ResultColumn, right: ResultColumn, op: ArithmeticOp): boolean {
    const a = left.metric; const b = right.metric;
    if (!a || !b || a.table !== b.table || a.operation !== "sum" || b.operation !== "sum") return false;
    const contract = this.ctx.knowledge.contract_by_table.get(a.table)?.contract;
    if (!contract?.series || contract.series.prediction_mode !== "observed_only" || contract.series.predicted_column || !contract.series.metrics.includes(a.column) || !contract.series.metrics.includes(b.column)) return false;
    const leftColumn = contract.columns.find((item) => item.name === a.column); const rightColumn = contract.columns.find((item) => item.name === b.column);
    if (!leftColumn?.unit || !rightColumn?.unit || left.unit !== leftColumn.unit || right.unit !== rightColumn.unit || contract.sensitive_columns.includes(a.column) || contract.sensitive_columns.includes(b.column)) return false;
    const unit = arithmeticUnit(op, left.unit, right.unit);
    return Boolean(unit && contract.derived_metrics?.some((item) => item.operation === op && item.prediction === "actual_only" && item.numerator === a.column && item.denominator === b.column && item.unit === unit));
  }

  private applyProvenTransform(input: ResultTable, steps: TransformStep[]): { table: ResultTable; undefinedArithmetic: boolean } | null {
    if (!Array.isArray(steps) || !steps.length || steps.length > 10) return null;
    let table = input; let undefinedArithmetic = false;
    for (const step of steps) {
      if (step && (step.op === "add" || step.op === "subtract" || step.op === "multiply" || step.op === "divide") && table.rows.some((row) => row[step.left] === null || row[step.right] === null || step.op === "divide" && isExactZero(row[step.right]))) undefinedArithmetic = true;
      const next = transformResult(table, [step], (left, right, op) => this.authorizeTransformArithmetic(left, right, op));
      if (!next) return null;
      table = next;
    }
    return { table, undefinedArithmetic };
  }

  private async calculateAlignment(sessionId: string, spec: AlignmentSpec): Promise<ToolResult> {
    const session = await this.ctx.sessions.requireAsync(sessionId); const jobId = session.active_job_id;
    if (!jobId) return fail("missing_active_job", "分组对齐需要当前任务。");
    const fresh = await this.currentFreshness();
    if (!fresh.ok) return fresh;
    if (!fresh.publication) return fail("freshness_not_published", "没有已发布新鲜度。");
    const checked = await this.resolveAlignment(session, jobId, spec, fresh.publication);
    if (!checked) return fail("alignment_lineage_unsupported", "分组、指标口径、范围或完整来源无法证明。");
    const resource: AlignmentResource = { resource_id: newId("res"), session_id: sessionId, job_id: jobId, kind: "alignment", created_at: new Date().toISOString(), spec, input_hashes: checked.hashes, rows: checked.rows, coverage_incomplete: checked.partial, input_truncated: false, complete_population: true };
    await this.ctx.sessions.saveResourceAsync(resource);
    const preview = previewRows(checked.rows, 100);
    return { ok: true, resource_id: resource.resource_id, rows: preview, result_total_rows: checked.rows.length, result_has_more: checked.rows.length > preview.length, coverage_incomplete: checked.partial, dependencies: Object.keys(checked.hashes), notice: `按完整结果的分组键全集对齐；预览限 100 行及 32 KB，某侧未出现的组不补零。${checked.partial ? "来源覆盖不完整或未知，结果只能部分交付。" : ""}resource_id=${resource.resource_id}` };
  }

  private async resolveAlignment(session: SessionRecord, jobId: string, spec: AlignmentSpec, publication: FreshnessPublication): Promise<{ rows: AlignedRow[]; hashes: Record<string, string>; leaves: string[]; partial: boolean } | null> {
    if (!spec || !spec.left || !spec.right || typeof spec.left.resource_id !== "string" || typeof spec.right.resource_id !== "string" || typeof spec.left.cell !== "string" || typeof spec.right.cell !== "string") return null;
    const inputs: Array<{ source: QueryResource; contract: DataContract; aggregates: VerifiedAggregate[] | null }> = [];
    for (const ref of [spec.left, spec.right]) {
      const found = await this.ctx.sessions.lookupResourceAsync(session.session_id, ref.resource_id);
      if (!found.ok || found.resource.kind !== "query_result" || found.resource.job_id !== jobId) return null;
      const source = found.resource; const contract = this.arithmeticContract(session, source, publication);
      if (!contract) return null;
      const aggregates = verifyDatabaseAggregates(source, contract)?.filter((item) => item.output_column === ref.cell) ?? null;
      inputs.push({ source, contract, aggregates });
    }
    if (!inputs[0]!.aggregates?.length || !inputs[1]!.aggregates?.length) return this.resolveCompleteRawAlignment(session, jobId, spec, publication, inputs);
    const first = inputs[0]!.aggregates[0]!; const second = inputs[1]!.aggregates[0]!;
    if (stableHashes(first.filters) !== stableHashes(second.filters)) return null;
    const aScope = fromAggregate(first); const bScope = fromAggregate(second);
    aScope.scopes[0]!.filters = { ...first.filters }; bScope.scopes[0]!.filters = { ...second.filters };
    if (!this.computeProvenArithmetic(spec.op, aScope, bScope)) return null;
    const rows = alignAggregates(inputs[0]!.aggregates, inputs[1]!.aggregates, spec.keys, spec.op, (op, a, b) => this.computeProvenArithmetic(op, a, b));
    if (!rows) return null;
    const hashes = Object.fromEntries(inputs.map(({ source }) => [source.resource_id, createHash("sha256").update(JSON.stringify(source)).digest("hex")]));
    return { rows, hashes, leaves: [...new Set(inputs.map(({ source }) => source.resource_id))], partial: false };
  }

  /** Each side is a complete direct projection or a verified database SUM;
   * both are re-authorized and hash-bound on calculation and delivery. */
  private async resolveCompleteRawAlignment(session: SessionRecord, jobId: string, spec: AlignmentSpec, publication: FreshnessPublication, inputs: Array<{ source: QueryResource; contract: DataContract; aggregates: VerifiedAggregate[] | null }>): Promise<{ rows: AlignedRow[]; hashes: Record<string, string>; leaves: string[]; partial: boolean } | null> {
    const keys = spec.keys;
    if (!Array.isArray(keys) || !keys.length || keys.length > 3 || new Set(keys).size !== keys.length || keys.some((key) => !/^[a-z_][a-z0-9_]{0,63}$/u.test(key))) return null;
    const prepared: Array<{ input: CompleteKeyedInput; make: (value: string | null, values: ReadonlyArray<ResultValue>) => ArithmeticValue | null; filters: Record<string,string>; source: QueryResource; partial: boolean }> = [];
    for (let i = 0; i < inputs.length; i++) {
      const { source, contract, aggregates } = inputs[i]!; const ref = i === 0 ? spec.left : spec.right;
      const evidence = this.evidenceSource(session, source); const series = contract.series;
      if (!evidence || !series || series.prediction_mode !== "observed_only" || series.predicted_column || source.coverage.unknown_prediction_dates.length || source.coverage.predicted_dates.length) return null;
      if (aggregates?.length) {
        const first = aggregates[0]!;
        const orderedKeys = [...keys].sort();
        if (first.operation !== "sum" || !series.metrics.includes(first.column) || JSON.stringify(Object.keys(first.group).sort()) !== JSON.stringify(orderedKeys) || !series.dimensions.every((key) => keys.includes(key) || Object.hasOwn(first.filters, key)) || keys.some((key) => !series.dimensions.includes(key) || Object.hasOwn(first.filters, key)) || aggregates.some((item) => item.operation !== "sum" || item.table !== first.table || item.column !== first.column || item.output_column !== first.output_column || item.unit !== first.unit || item.scale !== first.scale || stableHashes(item.filters) !== stableHashes(first.filters) || JSON.stringify(Object.keys(item.group).sort()) !== JSON.stringify(orderedKeys))) return null;
        const table = aggregateTable(aggregates);
        if (!table) return null;
        const normalized: ResultTable = { ...table, columns: table.columns.map((column) => keys.includes(column.name) ? { ...column, unit: `维度 ${column.name}` } : column) };
        const make = (value: string | null, values: ReadonlyArray<ResultValue>): ArithmeticValue | null => {
          if (values.some((v) => typeof v !== "string")) return null;
          const filters: Record<string, string | null> = { ...first.filters };
          keys.forEach((key, index) => { filters[key] = values[index] as string; });
          return { value, scale: first.scale, unit: first.unit, basis: { table: first.table, column: first.column, operation: "sum", unit: first.unit, prediction: first.prediction, timezone: first.range.timezone }, scopes: [{ filters, start: first.range.start, end: first.range.end }] };
        };
        prepared.push({ input: { table: normalized, valueColumn: ref.cell, keyColumns: keys, valueForGroup: make }, make, filters: first.filters, source, partial: false });
        continue;
      }
      const shape = verifyCell(evidence, contract, { op: "count_rows", as: "shape" }, source.rows.length);
      const projections = parseReadonlySql(evidence.sql).ast.columns;
      if (!shape || !Array.isArray(projections)) return null;
      const fields = new Map<string, string>();
      for (const entry of projections as Array<{ as?: string | null; expr?: { type?: string; column?: string } }>) if (entry.expr?.type === "column_ref" && entry.expr.column) fields.set(entry.as ?? entry.expr.column, entry.expr.column);
      const field = fields.get(ref.cell); const declared = contract.columns.find((item) => item.name === field);
      if (!field || !declared?.unit || !series.metrics.includes(field) || keys.some((key) => fields.get(key) !== key || key !== series.date_column && !series.dimensions.includes(key) || Object.hasOwn(shape.filters, key)) || !series.dimensions.every((key) => keys.includes(key) || Object.hasOwn(shape.filters, key))) return null;
      const checked = await this.resolveTransform(session, jobId, source.resource_id, publication, new Set());
      const table = checked?.table; const metric = table?.columns.find((column) => column.name === ref.cell);
      if (!table || !metric || metric.type !== "decimal" || metric.scale === undefined || keys.some((key) => table.columns.find((column) => column.name === key)?.type !== "text") || table.rows.some((row) => keys.some((key) => key === series.date_column ? typeof row[key] !== "string" || !isCalendarDate(row[key]) || row[key] < source.time_range.start || row[key] > source.time_range.end : row[key] !== null && typeof row[key] !== "string"))) return null;
      // Normalize only after physical key names and contract types have been
      // checked; a model-provided alias never establishes key equivalence.
      const normalized: ResultTable = { ...table, columns: table.columns.map((column) => keys.includes(column.name) ? { ...column, unit: `维度 ${column.name}` } : column) };
      const make = (value: string | null, values: ReadonlyArray<ResultValue>): ArithmeticValue | null => {
        if (values.some((v) => v !== null && typeof v !== "string")) return null;
        const filters: Record<string,string|null> = { ...shape.filters };
        for (let n = 0; n < keys.length; n++) filters[keys[n]!] = values[n] as string | null;
        return { value, scale: metric.scale!, unit: declared.unit!, basis: { table: contract.table, column: field, operation: "sum", unit: declared.unit!, prediction: "actual_observed_only", timezone: source.time_range.timezone }, scopes: [{ filters, start: source.time_range.start, end: source.time_range.end }] };
      };
      prepared.push({ input: { table: normalized, valueColumn: ref.cell, keyColumns: keys, valueForGroup: make }, make, filters: shape.filters, source, partial: checked!.partial });
    }
    if (prepared.length !== 2 || stableHashes(prepared[0]!.filters) !== stableHashes(prepared[1]!.filters)) return null;
    const a = prepared[0]!, b = prepared[1]!;
    const fakeKeys = keys.map(() => "scope");
    const sampleA = a.make(`1${a.input.table.columns.find((c) => c.name === a.input.valueColumn)!.scale ? "." + "0".repeat(a.input.table.columns.find((c) => c.name === a.input.valueColumn)!.scale!) : ""}`, fakeKeys);
    const sampleB = b.make(`1${b.input.table.columns.find((c) => c.name === b.input.valueColumn)!.scale ? "." + "0".repeat(b.input.table.columns.find((c) => c.name === b.input.valueColumn)!.scale!) : ""}`, fakeKeys);
    if (!sampleA || !sampleB || !this.computeProvenArithmetic(spec.op, sampleA, sampleB)) return null;
    const aligned = alignCompleteTables(a.input, b.input, spec.op, (op, x, y) => this.computeProvenArithmetic(op, x, y));
    if (!aligned) return null;
    const rows: AlignedRow[] = [];
    for (const row of aligned) {
      const values = keys.map((key) => row.group[key]!);
      if (values.some((value) => value !== null && typeof value !== "string")) return null;
      rows.push({ group: row.group as Record<string,string|null>, status: row.status, left: row.left ? a.make(row.left.value, values) : null, right: row.right ? b.make(row.right.value, values) : null, result: row.result, ...(row.left ? { left_count: row.left.count, left_null_count: row.left.null_count } : {}), ...(row.right ? { right_count: row.right.count, right_null_count: row.right.null_count } : {}) });
    }
    const hashes = Object.fromEntries(inputs.map(({ source }) => [source.resource_id, createHash("sha256").update(JSON.stringify(source)).digest("hex")]));
    return { rows, hashes, leaves: [...new Set(inputs.map(({ source }) => source.resource_id))], partial: prepared.some((item) => item.partial) };
  }

  private async resolveTransform(session: SessionRecord, jobId: string, resourceId: string, publication: FreshnessPublication, path: Set<string>): Promise<{ table: ResultTable; hashes: Record<string, string>; leaves: string[]; partial: boolean; partial_reason?: "alignment_incomplete" | "transform_coverage_incomplete" | "transform_undefined_division" } | null> {
    if (typeof resourceId !== "string" || path.has(resourceId) || path.size >= 8) return null;
    const found = await this.ctx.sessions.lookupResourceAsync(session.session_id, resourceId);
    if (!found.ok || found.resource.job_id !== jobId) return null;
    const resource = found.resource;
    const ownHash = createHash("sha256").update(JSON.stringify(resource)).digest("hex");
    if (resource.kind === "query_result") {
      // JOIN rows are accepted only after revalidating their private proof,
      // both contracts, authorization and the current publication. Build
      // semantic column labels from the contracts rather than SQL aliases.
      if (resource.tables.length === 2) {
        const joined = verifyJoinResource(resource as JoinQueryResource, session, this.ctx.knowledge, this.ctx.config, publication);
        const fact = joined && this.ctx.knowledge.contract_by_table.get(joined.plan.fact)?.contract;
        const dimension = joined && this.ctx.knowledge.contract_by_table.get(joined.plan.dimension)?.contract;
        const table = joined && fact && dimension && joinResultTable(joined.plan, joined.values, fact, dimension);
        return table ? { table, hashes: { [resource.resource_id]: ownHash }, leaves: [resource.resource_id], partial: false } : null;
      }
      const contract = this.arithmeticContract(session, resource, publication);
      const evidence = this.evidenceSource(session, resource);
      const aggregates = contract && evidence && verifyDatabaseAggregates(evidence, contract);
      let table = aggregates && aggregateTable(aggregates);
      if (!table && contract && evidence) {
        // Read the stored result through the same bounded, hash-bound pages
        // exposed to agents. A mutation between pages invalidates the input.
        const rows: Array<Record<string, unknown>> = [];
        let offset = 0;
        do {
          const page = await this.readSessionResource(session.session_id, { resource_id: resourceId, row_offset: offset, row_limit: 100, expected_resource_hash: ownHash });
          if (!page.ok || page.resource_hash !== ownHash || page.resource_truncated || !page.resource || typeof page.resource !== "object") return null;
          const result = page.resource as QueryResource;
          if (result.job_id !== jobId || !Array.isArray(result.rows) || result.rows.length > 100) return null;
          rows.push(...result.rows);
          if (rows.length > RESULT_CALCULATION_MAX_ROWS) return null;
          const next = page.next_row_offset;
          if (!page.has_more) break;
          if (!Number.isInteger(next) || (next as number) !== offset + result.rows.length || !result.rows.length) return null;
          offset = next as number;
        } while (true);
        if (rows.length !== resource.returned_rows || rows.length !== resource.total_rows || resource.total_rows_exact !== true) return null;
        table = rawResultTable({ ...evidence, rows }, contract);
      }
      const partial = coverageHasGap(resource.coverage) || resource.coverage.unknown_prediction_dates.length > 0;
      return table ? { table, hashes: { [resource.resource_id]: ownHash }, leaves: [resource.resource_id], partial, ...(partial ? { partial_reason: "transform_coverage_incomplete" as const } : {}) } : null;
    }
    if (resource.kind === "alignment") {
      const checked = await this.resolveAlignment(session, jobId, resource.spec, publication);
      if (!checked || Boolean(resource.coverage_incomplete) !== checked.partial || stableHashes(checked.hashes) !== stableHashes(resource.input_hashes) || JSON.stringify(checked.rows) !== JSON.stringify(resource.rows)) return null;
      const table = alignmentTable(resource.spec, checked.rows);
      const partial = checked.partial || checked.rows.some((row) => row.status !== "matched" || Object.values(row.group).some((value) => value === null));
      return table ? { table, hashes: { ...checked.hashes, [resource.resource_id]: ownHash }, leaves: checked.leaves, partial, ...(partial ? { partial_reason: "alignment_incomplete" as const } : {}) } : null;
    }
    if (resource.kind !== "transform") return null;
    const next = new Set(path); next.add(resourceId);
    const source = await this.resolveTransform(session, jobId, resource.source_resource_id, publication, next);
    if (!source || stableHashes(source.hashes) !== stableHashes(resource.input_hashes)) return null;
    const transformed = this.applyProvenTransform(source.table, resource.steps);
    if (!transformed || JSON.stringify(transformed.table) !== JSON.stringify(resource.result)) return null;
    const partial = source.partial || transformed.undefinedArithmetic;
    const partialReason = source.partial_reason ?? (transformed.undefinedArithmetic ? "transform_undefined_division" as const : undefined);
    return { table: transformed.table, hashes: { ...source.hashes, [resource.resource_id]: ownHash }, leaves: source.leaves, partial, ...(partialReason ? { partial_reason: partialReason } : {}) };
  }

  private async resolveArithmetic(session: SessionRecord, jobId: string, ref: ArithmeticRef, publication: FreshnessPublication, path: Set<string>): Promise<{ value: ArithmeticValue; hashes: Record<string, string>; leaves: string[] } | null> {
    if (!ref || typeof ref.resource_id !== "string" || typeof ref.cell !== "string" || path.has(ref.resource_id) || path.size >= 8) return null;
    const found = await this.ctx.sessions.lookupResourceAsync(session.session_id, ref.resource_id);
    if (!found.ok || found.resource.job_id !== jobId) return null;
    const resource = found.resource;
    const ownHash = createHash("sha256").update(JSON.stringify(resource)).digest("hex");
    const next = new Set(path); next.add(resource.resource_id);
    if (resource.kind === "query_result") {
      const contract = this.arithmeticContract(session, resource, publication);
      const evidence = this.evidenceSource(session, resource);
      if (!contract || !evidence) return null;
      if (ref.row !== undefined || ref.aggregate !== undefined || ref.execution_id !== undefined) {
        if (ref.group || !ref.execution_id || ref.execution_id !== resource.execution_id || (ref.row === undefined) === (ref.aggregate === undefined) || (ref.row !== undefined && (!Number.isSafeInteger(ref.row) || ref.row < 0)) || (ref.aggregate !== undefined && ref.aggregate !== "sum") || coverageHasGap(resource.coverage) || resource.coverage.unknown_prediction_dates.length) return null;
        const checked = await this.resolveTransform(session, jobId, resource.resource_id, publication, new Set());
        const table = checked?.table; const column = table?.columns.find((candidate) => candidate.name === ref.cell);
        const shape = verifyCell(evidence, contract, { op: "count_rows", as: "shape" }, resource.rows.length);
        const projections = parseReadonlySql(evidence.sql).ast.columns;
        const projection = Array.isArray(projections) ? projections.find((item) => item && typeof item === "object" && ((item as { as?: string | null; expr?: { column?: string } }).as ?? (item as { expr?: { column?: string } }).expr?.column) === ref.cell) as { expr?: { type?: string; column?: string } } | undefined : undefined;
        const field = projection?.expr?.type === "column_ref" ? projection.expr.column : undefined;
        if (!checked || !table || !column || column.type !== "decimal" || !shape || !field || !contract.series?.metrics.includes(field) || !contract.columns.find((candidate) => candidate.name === field)?.unit || !rawResultTable(evidence, contract)) return null;
        const filters = { ...shape.filters }; let start = resource.time_range.start; let end = resource.time_range.end;
        let value: string | null;
        if (ref.row !== undefined) {
          const row = table.rows[ref.row];
          if (!row || typeof row[ref.cell] !== "string") return null;
          value = row[ref.cell] as string;
          const outputs = new Map<string, string>();
          for (const item of projections as Array<{ as?: string | null; expr?: { type?: string; column?: string } }>) if (item.expr?.type === "column_ref" && item.expr.column) outputs.set(item.expr.column, item.as ?? item.expr.column);
          for (const dimension of contract.series.dimensions) {
            if (Object.hasOwn(filters, dimension)) continue;
            const output = outputs.get(dimension); const selected = output && row[output];
            if (typeof selected !== "string") return null;
            filters[dimension] = selected;
          }
          const dateOutput = outputs.get(contract.series.date_column); const dateValue = dateOutput && row[dateOutput];
          if (typeof dateValue === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(dateValue) && dateValue >= start && dateValue <= end) start = end = dateValue;
          else if (start !== end) return null;
        } else {
          if (table.rows.some((row) => typeof row[ref.cell] !== "string")) return null;
          value = sumDecimalStrings(table.rows.map((row) => row[ref.cell]), column.scale!);
          if (value === null) return null;
        }
        const exact: ArithmeticValue = { value, scale: column.scale!, unit: column.unit, basis: { table: contract.table, column: field, operation: ref.row === undefined ? "sum" : "value", unit: column.unit, prediction: "actual_observed_only", timezone: resource.time_range.timezone }, scopes: [{ filters, start, end }] };
        return { value: exact, hashes: checked.hashes, leaves: checked.leaves };
      }
      const canonical = (group: Record<string, string>) => JSON.stringify(Object.entries(group).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
      const matching = verifyDatabaseAggregates(evidence, contract)?.filter((item) => item.output_column === ref.cell && canonical(item.group) === canonical(ref.group ?? {})) ?? [];
      if (matching.length !== 1) return null;
      return { value: fromAggregate(matching[0]!), hashes: { [resource.resource_id]: ownHash }, leaves: [resource.resource_id] };
    }
    if (ref.execution_id !== undefined || ref.row !== undefined || ref.aggregate !== undefined) return null;
    if (resource.kind === "calculation") {
      if (ref.group || !resource.operations || !Object.hasOwn(resource.operations, ref.cell)) return null;
      const foundSource = await this.ctx.sessions.lookupResourceAsync(session.session_id, resource.source_resource_id);
      if (!foundSource.ok || foundSource.resource.kind !== "query_result" || foundSource.resource.job_id !== jobId) return null;
      const source = foundSource.resource; const contract = this.arithmeticContract(session, source, publication);
      const evidence = this.evidenceSource(session, source);
      const operation = resource.operations[ref.cell]; const stored = resource.cells[ref.cell];
      if (!contract || !evidence || !operation || operation.op !== "sum" || coverageHasGap(source.coverage) || source.coverage.unknown_prediction_dates.length) return null;
      const decimal = typeof stored === "string" ? verifyDecimalCell(evidence, contract, operation, stored) : null;
      const integer = typeof stored === "number" ? verifyCell(evidence, contract, operation, stored) : null;
      if (!decimal && (!integer || integer.precision !== "exact_integer" || !integer.column || integer.unit === "契约未声明" || !integer.prediction.startsWith("实际（") || integer.excludedNulls)) return null;
      const base = decimal ?? integer!;
      const column = base.column!; const value = String(base.value);
      const scale = decimal ? (value.split(".")[1]?.length ?? 0) : 0;
      const aggregate: VerifiedAggregate = { source_resource_id: source.resource_id, table: base.table, column, output_column: operation.column ?? "", operation: "sum", value, scale, unit: base.unit, description: base.description, filters: base.filters, group: {}, range: base.range, prediction: "actual_observed_only" };
      return { value: fromAggregate(aggregate), hashes: { [source.resource_id]: createHash("sha256").update(JSON.stringify(source)).digest("hex"), [resource.resource_id]: ownHash }, leaves: [source.resource_id] };
    }
    if (resource.kind !== "arithmetic" || ref.cell !== "result" || ref.group) return null;
    const left = await this.resolveArithmetic(session, jobId, resource.left, publication, next);
    const right = await this.resolveArithmetic(session, jobId, resource.right, publication, next);
    if (!left || !right) return null;
    const hashes = { ...left.hashes, ...right.hashes };
    const stable = (value: Record<string, string>) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    if (stable(hashes) !== stable(resource.input_hashes)) return null;
    const value = this.computeProvenArithmetic(resource.operation, left.value, right.value);
    if (!value || JSON.stringify(value) !== JSON.stringify(resource.result)) return null;
    return { value, hashes: { ...hashes, [resource.resource_id]: ownHash }, leaves: [...new Set([...left.leaves, ...right.leaves])] };
  }

  private arithmeticContract(session: SessionRecord, resource: QueryResource, publication: FreshnessPublication): DataContract | null {
    if (resource.tables.length !== 1 || resource.truncated || !resource.complete_population) return null;
    const asset = this.ctx.knowledge.contract_by_table.get(resource.tables[0]!); const contract = asset?.contract;
    if (!asset || !contract || resource.registry_revision !== this.ctx.knowledge.registry_revision || resource.contract_revisions[contract.table] !== contract.revision || resource.asset_hashes[asset.asset_id] !== asset.content_hash || !canQueryTable(this.ctx.knowledge, session.role, contract.table) || contractValidity(contract, currentCalendarDate(this.ctx.config, contract.timezone))) return null;
    if (publication.valid_until < currentCalendarDate(this.ctx.config, this.ctx.knowledge.timezone) || resource.freshness_receipts.length !== 1 || resource.freshness_receipts[0]?.table !== contract.table || resource.freshness_receipts[0]?.publication_id !== publication.publication_id || resource.freshness_receipts[0]?.version !== publication.version || publication.tables[contract.table]?.status !== "fresh") return null;
    return contract;
  }

  async readSessionResource(sessionId: string, input: { resource_id?: string; row_offset?: number; row_limit?: number; columns?: string[]; expected_resource_hash?: string }, signal?: AbortSignal): Promise<ToolResult> {
    const cancelled = await this.gate(sessionId, signal);
    if (cancelled) return cancelled;
    const found = await this.ctx.sessions.lookupResourceAsync(sessionId, input.resource_id ?? "");
    if (!found.ok) return fail(found.code, found.message);
    if (!await this.resourceReadable(sessionId, found.resource, new Set())) return fail("resource_authorization_changed", "资源引用的授权、契约或来源发生变化，不能继续读取。");
    const hash = createHash("sha256").update(JSON.stringify(found.resource)).digest("hex");
    const offset = input.row_offset ?? 0;
    const limit = input.row_limit ?? 50;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) return fail("invalid_resource_page", "行偏移须为非负整数，每页限 1 到 100 行。");
    if ((offset > 0 && !input.expected_resource_hash) || (input.expected_resource_hash && input.expected_resource_hash !== hash)) return fail("resource_version_changed", "续读须携带首页的资源哈希，资源变化后请从头读取。");
    if (found.resource.kind === "transform") {
      const resource = found.resource; const available = resource.result.columns.map((column) => column.name);
      const selected = input.columns ?? available;
      if (offset > resource.result.rows.length || !Array.isArray(selected) || selected.some((name) => typeof name !== "string" || !available.includes(name)) || new Set(selected).size !== selected.length) return fail("invalid_resource_page", "行偏移或列选择不合法。");
      const rows = previewRows(resource.result.rows.slice(offset, offset + limit).map((row) => Object.fromEntries(selected.map((name) => [name, row[name]]))), limit);
      if (!rows.length && offset < resource.result.rows.length) return fail("resource_page_byte_limit", "单行超过页面字节上限，请选择较少字段。");
      const next = offset + rows.length;
      return { ok: true, resource: { ...resource, result: { columns: resource.result.columns.filter((column) => selected.includes(column.name)), rows } }, resource_hash: hash, has_more: next < resource.result.rows.length, next_row_offset: next < resource.result.rows.length ? next : null, resource_truncated: false };
    }
    if (found.resource.kind === "alignment") {
      const resource = found.resource;
      if (input.columns || offset > resource.rows.length) return fail("invalid_resource_page", "对齐结果仅支持行分页。");
      const rows = previewRows(resource.rows.slice(offset, offset + limit), limit); const next = offset + rows.length;
      if (!rows.length && offset < resource.rows.length) return fail("resource_page_byte_limit", "单行超过页面字节上限。");
      return { ok: true, resource: { ...resource, rows }, resource_hash: hash, has_more: next < resource.rows.length, next_row_offset: next < resource.rows.length ? next : null, resource_truncated: false };
    }
    if (found.resource.kind !== "query_result") {
      if (offset !== 0 || input.columns) return fail("invalid_resource_page", "计算资源没有可分页的表格行。");
      return { ok: true, resource: found.resource, resource_hash: hash, has_more: false, resource_truncated: found.resource.input_truncated };
    }
    const source = found.resource as JoinQueryResource;
    if (offset > source.rows.length) return fail("invalid_resource_page", "行偏移超出已保存的结果。");
    const columns = input.columns ?? source.columns;
    if (!Array.isArray(columns) || columns.some((column) => typeof column !== "string" || !source.columns.includes(column)) || new Set(columns).size !== columns.length) return fail("invalid_resource_columns", "只能选择资源中已有且不重复的列。");
    const rows = previewRows(source.rows.slice(offset, offset + limit).map((row) => Object.fromEntries(columns.map((column) => [column, row[column]]))), limit);
    if (!rows.length && offset < source.rows.length) return fail("resource_page_byte_limit", "单行超过页面字节上限，请选择较少字段。");
    const next = offset + rows.length;
    const { join_proof: _privateProof, ...publicSource } = source;
    return {
      ok: true,
      resource: { ...publicSource, columns, rows, coverage: coveragePreview(publicSource.coverage) },
      resource_hash: hash,
      row_offset: offset,
      row_limit: limit,
      has_more: next < source.rows.length,
      next_row_offset: next < source.rows.length ? next : null,
      resource_truncated: source.truncated || source.sql_limited === true,
      sql_limited: source.sql_limited === true,
      notice: "has_more 仅表示已保存资源还有页面；resource_truncated 表示源查询结果不完整。历史资源可回读，但不能当作当前任务的证据。",
    };
  }

  async updateAnalysis(sessionId: string, input: AnalysisInput, signal?: AbortSignal): Promise<ToolResult> {
    const cancelled = await this.gate(sessionId, signal);
    if (cancelled) return cancelled;
    if (input.declaration !== undefined && !isAnalysisDeclaration(input.declaration)) return fail("invalid_analysis_declaration", "分析工作记录格式或长度不合法。");
    if (typeof input.draft_answer !== "string" || input.draft_answer.length > 32_000 || !Array.isArray(input.resource_ids ?? []) || (input.resource_ids?.length ?? 0) > 40 || input.resource_ids?.some((id) => typeof id !== "string" || id.length > 128) || (input.clarification_question !== undefined && (typeof input.clarification_question !== "string" || input.clarification_question.length > 2000))) return fail("analysis_input_limit", "分析草稿或资源引用超过上限。");
    const session = await this.ctx.sessions.requireAsync(sessionId);
    const jobId = session.active_job_id ?? "";
    const citations: AnalysisRecord["citations"] = [];
    const sources: AnalysisRecord["sources"] = [];
    const calculations: AnalysisRecord["calculations"] = [];
    const reasons: string[] = [];
    const resources: SessionResource[] = [];
    for (const resourceId of input.resource_ids ?? []) {
      const found = await this.ctx.sessions.lookupResourceAsync(sessionId, resourceId);
      if (!found.ok) {
        reasons.push(found.code);
        continue;
      }
      if (jobId && found.resource.job_id !== jobId) {
        reasons.push("resource_from_other_execution");
        continue;
      }
      if (found.resource.kind === "calculation" && jobId) {
        const source = await this.ctx.sessions.lookupResourceAsync(sessionId, found.resource.source_resource_id);
        if (!source.ok || source.resource.kind !== "query_result" || source.resource.job_id !== jobId || !(input.resource_ids ?? []).includes(source.resource.resource_id)) {
          reasons.push("resource_from_other_execution");
          continue;
        }
      }
      resources.push(found.resource);
      citations.push({ resource_id: resourceId, note: found.resource.kind });
      if (found.resource.kind === "query_result") {
        sources.push({
          resource_id: found.resource.resource_id,
          sql: found.resource.sql,
          executed_sql: found.resource.executed_sql,
          tables: found.resource.tables,
          contract_revisions: found.resource.contract_revisions,
          asset_hashes: found.resource.asset_hashes,
          time_range: found.resource.time_range,
          freshness: found.resource.freshness,
          truncated: found.resource.truncated,
          total_rows: found.resource.total_rows,
          total_rows_exact: found.resource.total_rows_exact,
          returned_rows: found.resource.returned_rows,
          complete_population: found.resource.complete_population,
          simulated: true,
          engine: found.resource.engine,
          ...(found.resource.execution_id ? { execution_id: found.resource.execution_id } : {}),
          ...(found.resource.execution_settings ? { execution_settings: found.resource.execution_settings } : {}),
          observed_at: found.resource.created_at,
          ...((found.resource as JoinQueryResource).join_proof ? { data_capture_hash: (found.resource as JoinQueryResource).join_proof!.capture_hash } : {}),
          rows: found.resource.rows,
          coverage: found.resource.coverage ?? unknownCoverage("资源没有覆盖回执，覆盖情况未知。"),
          freshness_receipts: found.resource.freshness_receipts ?? [],
        });
      }
    }
    const declaredExcerptIds = input.declaration?.source_excerpts?.map((item) => item.asset_id) ?? [];
    for (const assetId of declaredExcerptIds) {
      const allowed = await this.authorizeRead(sessionId, assetId);
      if (!allowed.ok) return fail("analysis_declaration_source_invalid", "工作记录引用的知识来源不可读取或已变化。");
    }
    const contractIds = resources.filter((item): item is QueryResource => item.kind === "query_result").flatMap((item) => Object.keys(item.asset_hashes));
    if (contractIds.some((assetId) => !canRead(this.ctx.knowledge, session.role, assetId))) return fail("analysis_declaration_source_invalid", "当前主体不能读取引用的契约，旧证据不能交付。");
    if (!await validateKnowledgeSources(this.ctx.knowledge, [...contractIds, ...declaredExcerptIds])) return fail("knowledge_source_changed", "权限或引用的契约、知识文件已变化；旧证据不能交付。");
    const claimsNumbers = input.suggested_status === "completed" || input.suggested_status === "partial";
    const verifiedQueries = sources.filter((source) => source.sql && source.freshness_receipts.length > 0);
    if (claimsNumbers && !input.clarification_question && verifiedQueries.length === 0) {
      const attempt = await this.nextRevision(sessionId, jobId);
      if (attempt === "lost") return fail("provider_fence_rejected", "任务围栏已经变化，修订次数没有重置。");
      if (attempt <= 1) {
        return fail("evidence_feedback", "候选回答缺少本次执行的成功查询和新鲜度回执。请改为引用本次查询资源，或改成澄清。模型文字里的数字不会被采用。", {
          server_reasons: reasons,
          revisions_remaining: 1,
        });
      }
      const exhausted: AnalysisRecord = {
        analysis_id: newId("an"),
        job_id: jobId,
        session_id: sessionId,
        status: "partial",
        answer: "修订次数已用完。没有本次执行的成功查询和新鲜度回执，不能把模型文字当成数据结论。未解内容需要重新提问或澄清范围。",
        limitations: ["没有可引用的成功查询。", "数据来自本地合成库，不是生产数据。"],
        clarification_question: null,
        citations,
        resource_hashes: Object.fromEntries(resources.map((resource) => [resource.resource_id, createHash("sha256").update(JSON.stringify(resource)).digest("hex")])),
        sources,
        calculations,
        model_suggested_status: input.suggested_status,
        model_draft: input.draft_answer,
        server_reasons: unique([...reasons, "revision_exhausted", "insufficient_evidence"]),
        simulated: true,
      };
      sessionAnalyses(session).push(exhausted);
      return { ok: true, ...exhausted, notice: "修订次数用完后，只交付有证据的部分。" };
    }
    let status: AnalysisStatus = input.suggested_status;
    if (input.clarification_question) {
      status = "needs_clarification";
      reasons.push("clarification_requested");
    }
    if (input.declaration?.unresolved_questions.length && status === "completed") {
      status = "partial";
      reasons.push("model_declared_unresolved");
    }
    if ((status === "completed" || status === "partial") && sources.length === 0) {
      status = input.clarification_question ? "needs_clarification" : "failed";
      reasons.push("insufficient_evidence");
    }
    if (input.suggested_status === "failed" && sources.length === 0 && !input.clarification_question) {
      status = "failed";
      reasons.push("no_authorized_result");
    }
    const deliveredFreshness = await this.currentFreshness();
    if (!deliveredFreshness.ok) return deliveredFreshness;
    const liveFreshness = deliveredFreshness.publication;
    const eligible = new Set<string>();
    const aggregates: VerifiedAggregate[] = [];
    const conditionalAggregates: VerifiedConditionalAggregate[] = [];
    const joinLines: string[] = [];
    for (const source of sources) {
      const original = resources.find((item): item is QueryResource => item.kind === "query_result" && item.resource_id === source.resource_id);
      const evidence = original && this.evidenceSource(session, original);
      const asset = original && original.tables.length === 1 ? this.ctx.knowledge.contract_by_table.get(original.tables[0] ?? "") : undefined;
      const contract = asset?.contract;
      const currentContract = Boolean(original && asset && contract && original.registry_revision === this.ctx.knowledge.registry_revision && original.contract_revisions[contract.table] === contract.revision && original.asset_hashes[asset.asset_id] === asset.content_hash && canQueryTable(this.ctx.knowledge, session.role, contract.table) && !contractValidity(contract, currentCalendarDate(this.ctx.config, contract.timezone)));
      const currentFresh = Boolean(liveFreshness && liveFreshness.valid_until >= currentCalendarDate(this.ctx.config, this.ctx.knowledge.timezone) && source.freshness_receipts.length === source.tables.length && source.tables.every((table) => source.freshness_receipts.some((receipt) => receipt.table === table)) && source.freshness_receipts.every((receipt) => receipt.publication_id === liveFreshness.publication_id && receipt.version === liveFreshness.version && liveFreshness.tables[receipt.table]?.status === "fresh"));
      const shape = evidence && contract && verifyCell(evidence, contract, { op: "count_rows", as: "internal" }, evidence.rows.length);
      const databaseAggregates = evidence && contract && verifyDatabaseAggregates(evidence, contract);
      const conditional = evidence && contract && verifyConditionalAggregates(evidence, contract);
      const joined = original && liveFreshness ? verifyJoinResource(original as JoinQueryResource, session, this.ctx.knowledge, this.ctx.config, liveFreshness) : null;
      if (joined) {
        source.evidence_eligible = true;
        source.coverage = joinCoverage(joined.plan, (original as JoinQueryResource).join_proof!.rows, this.ctx.knowledge.contract_by_table.get(joined.plan.fact)?.contract);
        if (source.coverage.status === "unknown") {
          reasons.push("coverage_unknown");
          if (status === "completed") status = "partial";
        }
        source.rows = [];
        eligible.add(source.resource_id);
        joinLines.push(...joined.values.slice(0, 100).map((value) => renderVerifiedJoin(value, source.resource_id)));
        if (joined.values.length > 100) joinLines.push(`JOIN 验证了 ${joined.values.length} 个分组，此处展示前 100 个；其余分组保存在当前结果资源中。`);
        continue;
      }
      source.evidence_eligible = Boolean(currentContract && currentFresh && (shape || databaseAggregates || conditional) && !source.truncated && source.complete_population);
      if (source.evidence_eligible) {
        eligible.add(source.resource_id);
        if (source.engine === "clickhouse-local") reasons.push("clickhouse_observation_nonatomic");
        if (databaseAggregates) aggregates.push(...databaseAggregates);
        if (conditional) conditionalAggregates.push(...conditional);
        // SQL aliases are model-controlled and can look like another metric or
        // unit. The verified statements use contract names; do not present the
        // raw alias-labelled preview as verified evidence in the answer.
        const columns = parseReadonlySql(original!.sql).ast.columns;
        if (Array.isArray(columns) && columns.some((item) => item && typeof item === "object" && "as" in item && item.as)) {
          source.rows = [];
          reasons.push("alias_preview_hidden");
        }
      }
      else {
        delete source.data_capture_hash;
        if (!currentFresh) reasons.push("freshness_version_changed");
        if (!currentContract) reasons.push("contract_or_authorization_changed");
        if (source.truncated || !source.complete_population) reasons.push("truncated_result_is_not_population");
        if (!shape && !databaseAggregates && !conditional && currentContract) reasons.push("query_lineage_unsupported");
        source.rows = [];
        source.coverage = unknownCoverage("该查询结果不满足当前证据条件，覆盖回执不作为事实展示。");
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
    let analysisDeclaration: AnalysisRecord["analysis_declaration"];
    if (input.declaration) {
      for (const excerpt of input.declaration.source_excerpts ?? []) {
        const asset = this.ctx.knowledge.by_id.get(excerpt.asset_id);
        if (!asset || asset.content_hash !== excerpt.content_hash || !asset.body.includes(excerpt.quote)) return fail("analysis_declaration_source_invalid", "工作记录摘录与当前可读的知识版本不一致。");
      }
      const cells: NonNullable<AnalysisRecord["analysis_declaration"]>["verified_cells"] = [];
      for (const ref of input.declaration.result_cells ?? []) {
        const source = resources.find((item): item is QueryResource => item.kind === "query_result" && item.resource_id === ref.resource_id);
        const contract = source && source.tables.length === 1 ? this.ctx.knowledge.contract_by_table.get(source.tables[0]!)?.contract : undefined;
        const evidence = source && this.evidenceSource(session, source);
        const table = evidence && source && contract && eligible.has(source.resource_id) && source.execution_id === ref.execution_id ? rawResultTable(evidence, contract) : null;
        const column = table?.columns.find((item) => item.name === ref.column);
        const row = table?.rows[ref.row];
        if (!source || !table || !column || !row || !Object.hasOwn(row, ref.column)) return fail("analysis_declaration_cell_invalid", "工作记录的结果引用不可验证：必须是当前任务、当前执行号的完整授权直接投影。");
        cells.push({ ...ref, field: column.label, unit: column.unit, value: row[ref.column]! });
      }
      analysisDeclaration = { provenance: "model_declared", declaration: structuredClone(input.declaration), excerpts_checked: input.declaration.source_excerpts?.length ?? 0, verified_cells: cells };
    }
    // A shared publication is not a ClickHouse snapshot. Detect observed
    // contradictions for the same table and coverage population rather than
    // either asserting atomicity or downgrading every ordinary observation.
    const observed = new Map<string, string>();
    for (const source of sources) {
      if (!source.evidence_eligible || source.engine !== "clickhouse-local" || source.tables.length !== 1 || !source.coverage.observation_hash) continue;
      const contract = this.ctx.knowledge.contract_by_table.get(source.tables[0]!)?.contract;
      const original = resources.find((item): item is QueryResource => item.kind === "query_result" && item.resource_id === source.resource_id);
      const evidence = original && this.evidenceSource(session, original);
      const scope = contract && evidence && provenCoverageScope(evidence.sql, contract, source.time_range);
      if (!scope) continue;
      const key = JSON.stringify([source.tables[0], source.time_range, Object.entries(scope.equalities).sort(([a], [b]) => a.localeCompare(b)), Object.entries(scope.inSets).sort(([a], [b]) => a.localeCompare(b))]);
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
    for (const resource of resources) {
      if (resource.kind !== "calculation") continue;
      const original = resources.find((item): item is QueryResource => item.kind === "query_result" && item.resource_id === resource.source_resource_id);
      const evidence = original && this.evidenceSource(session, original);
      const asset = original && original.tables.length === 1 ? this.ctx.knowledge.contract_by_table.get(original.tables[0] ?? "") : undefined;
      const contract = asset?.contract;
      const accepted: VerifiedCell[] = [];
      const acceptedDecimal: VerifiedDecimalCell[] = [];
      const acceptedGrouped: VerifiedGroupRollup[] = [];
      if (original && evidence && contract && eligible.has(original.resource_id) && resource.operations) {
        for (const [name, operation] of Object.entries(resource.operations)) {
          const stored = resource.cells[name];
          const cell = typeof stored === "number" ? verifyCell(evidence, contract, operation, stored) : null;
          if (cell) {
            accepted.push(cell); verified.push(cell);
            const cells = verifiedByCalculation.get(resource.resource_id) ?? new Map<string, VerifiedCell>();
            cells.set(name, cell);
            verifiedByCalculation.set(resource.resource_id, cells);
          }
          else {
            const decimal = typeof stored === "string" ? verifyDecimalCell(evidence, contract, operation, stored) : null;
            const grouped = !decimal && (typeof stored === "string" || typeof stored === "number") ? verifyGroupRollup(evidence, contract, operation, stored) : null;
            if (decimal) { acceptedDecimal.push(decimal); verifiedDecimal.push(decimal); }
            else if (grouped) { acceptedGrouped.push(grouped); verifiedGroupRollups.push(grouped); }
            else reasons.push("calculation_lineage_unsupported");
          }
        }
      } else reasons.push("calculation_lineage_unsupported");
      const cells = Object.fromEntries([...accepted, ...acceptedDecimal, ...acceptedGrouped].map((cell, index) => [`cell_${index + 1}`, cell.value]));
      calculations.push({ resource_id: resource.resource_id, source_resource_id: resource.source_resource_id, cells, verified_cells: accepted, verified_decimal_cells: acceptedDecimal, verified_group_rollups: acceptedGrouped, input_truncated: resource.input_truncated, complete_population: resource.complete_population });
    }
    const comparisons: VerifiedComparison[] = [];
    const aggregateComparisons: AggregateComparison[] = [];
    const noteUnprovenSnapshot = (ids: string[]) => {
      if (ids.some((id) => sources.some((source) => source.resource_id === id && source.engine === "clickhouse-local"))) {
        reasons.push("clickhouse_observation_nonatomic");
      }
    };
    for (const request of (input.comparisons ?? []).slice(0, 20)) {
      if (!request || !request.left || !request.right || typeof request.left.resource_id !== "string" || typeof request.left.cell !== "string" || typeof request.right.resource_id !== "string" || typeof request.right.cell !== "string") {
        reasons.push("comparison_unverifiable");
        continue;
      }
      const a = verifiedByCalculation.get(request.left.resource_id)?.get(request.left.cell);
      const b = verifiedByCalculation.get(request.right.resource_id)?.get(request.right.cell);
      const aSource = a && resources.find((item): item is QueryResource => item.kind === "query_result" && item.resource_id === a.sourceResourceId);
      const bSource = b && resources.find((item): item is QueryResource => item.kind === "query_result" && item.resource_id === b.sourceResourceId);
      const contract = a && this.ctx.knowledge.contract_by_table.get(a.table)?.contract;
      const comparison = a && b && aSource && bSource && contract && compareVerifiedIntegers(
        { calculation_id: request.left.resource_id, cell: request.left.cell, source: a },
        { calculation_id: request.right.resource_id, cell: request.right.cell, source: b }, aSource, bSource, contract,
      );
      if (comparison) { comparisons.push(comparison); noteUnprovenSnapshot([a!.sourceResourceId, b!.sourceResourceId]); }
      else {
        const left = aggregates.filter((item) => item.source_resource_id === request.left.resource_id && item.output_column === request.left.cell);
        const right = aggregates.filter((item) => item.source_resource_id === request.right.resource_id && item.output_column === request.right.cell);
        const decimal = left.length === 1 && right.length === 1 ? compareDecimalAggregates(left[0]!, right[0]!) : null;
        if (decimal) { aggregateComparisons.push(decimal); noteUnprovenSnapshot([decimal.left.source_resource_id, decimal.right.source_resource_id]); }
        else reasons.push("comparison_unverifiable");
      }
    }
    if (input.comparisons && input.comparisons.length > 20) reasons.push("comparison_unverifiable");
    if (reasons.includes("comparison_unverifiable") && status === "completed") status = "partial";
    const arithmeticResults: NonNullable<AnalysisRecord["arithmetic_results"]> = [];
    for (const resource of resources) {
      if (resource.kind !== "arithmetic") continue;
      const checked = liveFreshness && jobId ? await this.resolveArithmetic(session, jobId, { resource_id: resource.resource_id, cell: "result" }, liveFreshness, new Set()) : null;
      if (!checked || checked.leaves.some((id) => !eligible.has(id))) {
        reasons.push("arithmetic_lineage_unsupported");
        if (status === "completed") status = "partial";
        continue;
      }
      arithmeticResults.push({ resource_id: resource.resource_id, operation: resource.operation, left: resource.left, right: resource.right, result: checked.value });
      noteUnprovenSnapshot(checked.leaves);
      if (checked.value.value === null && status === "completed") status = "partial";
    }
    const transformResults: NonNullable<AnalysisRecord["transform_results"]> = [];
    const transformLines: string[] = [];
    for (const resource of resources) {
      if (resource.kind !== "transform") continue;
      const checked = liveFreshness && jobId ? await this.resolveTransform(session, jobId, resource.resource_id, liveFreshness, new Set()) : null;
      const source = liveFreshness && jobId ? await this.resolveTransform(session, jobId, resource.source_resource_id, liveFreshness, new Set()) : null;
      if (!checked || !source || checked.leaves.some((id) => !eligible.has(id))) {
        reasons.push("transform_lineage_unsupported");
        if (status === "completed") status = "partial";
        continue;
      }
      if (checked.partial) { reasons.push(checked.partial_reason ?? "transform_coverage_incomplete"); if (status === "completed") status = "partial"; }
      noteUnprovenSnapshot(checked.leaves);
      const preview = previewRows(checked.table.rows, 100);
      transformResults.push({ resource_id: resource.resource_id, source_resource_id: resource.source_resource_id, steps: resource.steps, result: { ...checked.table, rows: preview }, total_rows: checked.table.rows.length, preview_has_more: checked.table.rows.length > preview.length });
      transformLines.push(...renderTransform(resource, source.table, checked.table));
    }
    const alignmentResults: NonNullable<AnalysisRecord["alignment_results"]> = [];
    const alignmentLines: string[] = [];
    for (const resource of resources) {
      if (resource.kind !== "alignment") continue;
      const checked = liveFreshness && jobId ? await this.resolveAlignment(session, jobId, resource.spec, liveFreshness) : null;
      if (!checked || Boolean(resource.coverage_incomplete) !== checked.partial || checked.leaves.some((id) => !eligible.has(id)) || stableHashes(checked.hashes) !== stableHashes(resource.input_hashes) || JSON.stringify(checked.rows) !== JSON.stringify(resource.rows)) {
        reasons.push("alignment_lineage_unsupported");
        if (status === "completed") status = "partial";
        continue;
      }
      if (checked.partial) { reasons.push("transform_coverage_incomplete"); if (status === "completed") status = "partial"; }
      if (checked.rows.some((row) => row.status !== "matched" || Object.values(row.group).some((value) => value === null))) { reasons.push("alignment_incomplete"); if (status === "completed") status = "partial"; }
      noteUnprovenSnapshot(checked.leaves);
      const preview = previewRows(checked.rows, 100);
      alignmentResults.push({ resource_id: resource.resource_id, spec: resource.spec, rows: preview, total_rows: checked.rows.length, preview_has_more: checked.rows.length > preview.length, coverage_incomplete: checked.partial });
      alignmentLines.push(...renderAlignment(resource, checked.rows));
    }
    if (verified.some((cell) => cell.precision === "floating_point_approximate")) {
      reasons.push("floating_point_approximate");
      if (status === "completed") status = "partial";
    }
    if (verified.some((cell) => cell.operation === "count_null" && cell.value > 0 || cell.operation === "sum" && cell.excludedNulls > 0)) reasons.push("missing_values_disclosed");
    if (verified.some((cell) => cell.operation === "count_zero" && cell.value > 0)) reasons.push("true_zeros_disclosed");
    if (verified.some((cell) => cell.prediction.startsWith("预测"))) reasons.push("predicted_values_disclosed");
    if (reasons.includes("calculation_lineage_unsupported") && status === "completed") status = "partial";
    if (input.suggested_status === "completed" && status !== "completed") reasons.push("model_completion_was_not_authoritative");
    const limitations: string[] = [];
    if (reasons.includes("model_declared_unresolved")) limitations.push("模型工作记录仍有待解决问题；其范围、粒度和假设均为自报，不作为已验证事实。");
    if (input.findings?.length || input.limitations?.length) limitations.push("模型提供的标签、分组、单位、状态和自由文字未作为事实采用；数值与范围由服务端元数据生成。");
    if (reasons.includes("calculation_lineage_unsupported") || reasons.includes("query_lineage_unsupported")) limitations.push("部分表达式或计算缺少可证明的血缘，没有作为已验证数值展示。");
    if (reasons.includes("comparison_unverifiable")) limitations.push("部分比较的范围、覆盖、单位、预测状态或整数精度无法证明，没有展示比较结果。");
    if (reasons.includes("arithmetic_lineage_unsupported")) limitations.push("部分四则运算的递归来源、资源哈希、授权或新鲜度无法证明，没有展示结果。");
    if (reasons.includes("transform_lineage_unsupported")) limitations.push("部分结果变换的递归来源、资源哈希、授权或新鲜度无法证明，没有展示结果。");
    if (reasons.includes("alignment_lineage_unsupported")) limitations.push("部分分组对齐的完整来源、范围或口径无法证明，没有展示结果。");
    if (reasons.includes("alignment_incomplete")) limitations.push("对齐来源存在未出现的分组或零分母；变换未把未知结果当作零。");
    if (reasons.includes("transform_coverage_incomplete")) limitations.push("变换输入存在未覆盖日期、NULL 或无法确认的预测状态；聚合忽略 NULL，不代表完整总体。");
    if (reasons.includes("transform_undefined_division")) limitations.push("变换存在 NULL 输入或零分母，相关结果未知，没有补零。");
    if (reasons.includes("clickhouse_observation_nonatomic")) limitations.push("ClickHouse 查询和覆盖统计是独立读取；结果代表各次观测，不宣称跨查询原子快照或共同数据版本。");
    if (reasons.includes("coverage_observations_conflict")) limitations.push("相同范围的覆盖观测内容发生变化；跨次比较可能不一致，只能部分交付。");
    if (reasons.includes("alias_preview_hidden")) limitations.push("含模型自选列别名的结果预览已隐藏；正式数值按契约字段及单位展示。");
    if (reasons.includes("floating_point_approximate")) limitations.push("浮点字段及其派生值仅是近似数，尚未实现可验证的精确十进制金额计算。");
    if (reasons.includes("coverage_unknown")) limitations.push("预期覆盖范围无法确定，覆盖情况未知。");
    if (reasons.includes("freshness_version_changed")) limitations.push("新鲜度发布版本已变化或失效，受影响的数值没有作为已验证事实展示。");
    if (reasons.includes("truncated_result_is_not_population")) limitations.push("结果已截断，不能代表完整总体，受影响的数值没有作为已验证事实展示。");
    if (reasons.includes("missing_values_disclosed")) limitations.push("NULL 是缺失，没有当作零。");
    if (reasons.includes("true_zeros_disclosed")) limitations.push("结果包含数值为零的行；预测状态按契约单独标示。");
    if (reasons.includes("predicted_values_disclosed")) limitations.push("预测值和实际值分开列出。");
    if (aggregates.some((item) => Object.keys(item.group).length)) limitations.push("分组只展示查询中出现的取值，未出现的组合没有补零。");
    if (joinLines.length) limitations.push("JOIN 分组只证明实际匹配键在本次查询捕获数据中没有放大；未出现的分组未补零，跨表不具备原子快照。");
    limitations.push("数据来自本地合成库，不是生产数据。");
    const derivedLines = [...renderDerivedAndGroups(verified, resources, this.ctx.knowledge), ...verifiedDecimal.map(renderDecimalCell), ...verifiedGroupRollups.map(renderGroupRollup), ...comparisons.map(renderComparison), ...aggregates.slice(0, 100).map(renderAggregate), ...conditionalAggregates.slice(0, 100).map(renderConditionalAggregate), ...aggregateComparisons.map(renderAggregateComparison), ...arithmeticResults.map(renderArithmetic), ...transformLines];
    if (aggregates.length > 100) derivedLines.push(`已验证聚合共 ${aggregates.length} 个，此处展示前 100 个；其余结果保存在当前查询资源中。`);
    if (conditionalAggregates.length > 100) derivedLines.push(`已验证条件计数共 ${conditionalAggregates.length} 个，此处展示前 100 个；其余结果保存在当前查询资源中。`);
    derivedLines.push(...alignmentLines);
    if (reasons.includes("clickhouse_observation_nonatomic")) derivedLines.push("结果基于各次 ClickHouse 观测；查询和覆盖统计不是同一原子快照，未证明共同数据版本。");
    if (reasons.includes("coverage_observations_conflict")) derivedLines.push("相同范围的覆盖观测内容发生变化，跨次计算结果不能作为一致数据集的完整结论。");
    derivedLines.push(...joinLines);
    let answer = renderAnswer(status, verified, sources, input.clarification_question, derivedLines);
    const draftNumbers = input.draft_answer.match(/\d+(?:\.\d+)?/g) ?? [];
    if (draftNumbers.some((item) => !answer.includes(item))) {
      limitations.push("模型草稿里有正式答案没有引用到的数字，那些数字没有逐一验证。");
      if (status === "completed") status = "partial";
    }
    answer = renderAnswer(status, verified, sources, input.clarification_question, derivedLines);
    const analysis: AnalysisRecord = {
      analysis_id: newId("an"),
      job_id: jobId,
      session_id: sessionId,
      status,
      answer,
      limitations: unique(limitations),
      clarification_question: input.clarification_question ?? null,
      citations,
      resource_hashes: Object.fromEntries(resources.map((resource) => [resource.resource_id, createHash("sha256").update(JSON.stringify(resource)).digest("hex")])),
      sources: sources.map((source) => { const preview = previewRows(source.rows, 100); return { ...source, rows: preview, preview_has_more: source.rows.length > preview.length, coverage: coveragePreview(source.coverage) }; }),
      calculations,
      comparisons,
      aggregate_comparisons: aggregateComparisons,
      arithmetic_results: arithmeticResults,
      transform_results: transformResults,
      alignment_results: alignmentResults,
      aggregates: aggregates.slice(0, 100),
      conditional_aggregates: conditionalAggregates.slice(0, 100),
      aggregate_total: aggregates.length,
      aggregates_has_more: aggregates.length > 100,
      ...(analysisDeclaration ? { analysis_declaration: analysisDeclaration } : {}),
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

  private async nextRevision(sessionId: string, jobId: string): Promise<number | "lost"> {
    const persisted = await this.ctx.sessions.consumeRevision(jobId);
    if (persisted === "lost") return "lost";
    if (typeof persisted === "number") return persisted;
    const key = jobId || sessionId;
    const prior = revisionAttempts.get(key) ?? 0;
    revisionAttempts.set(key, prior + 1);
    return prior + 1;
  }

  private async tableColumns(table: string): Promise<string[]> {
    if (this.ctx.businessEngine === "clickhouse") {
      if (!this.ctx.clickhouse) throw new Error("ClickHouse 客户端没有配置");
      return clickHouseColumns(this.ctx.clickhouse, table);
    }
    return plainRows(this.ctx.db.prepare(`PRAGMA table_info(${table})`).all()).map((row) => String(row.name));
  }

  private async executeGuarded(sql: string, signal?: AbortSignal): Promise<Array<Record<string, unknown>>> {
    if (this.ctx.businessEngine === "clickhouse") {
      if (!this.ctx.clickhouse) throw new Error("ClickHouse 客户端没有配置");
      const result = await clickHouseQueryBounded(this.ctx.clickhouse, sql, this.ctx.config.maxResultRows, this.ctx.config.maxResultBytes, signal);
      return result.rows;
    }
    return plainRows(this.ctx.db.prepare(sql).all());
  }

  private async seriesRows(contract: DataContract, equalities: Record<string, string>, timeRange: { start: string; end: string }, signal?: AbortSignal, inSets: Record<string, string[]> = {}) {
    if (this.ctx.businessEngine === "clickhouse") {
      const series = contract.series;
      if (!series) return [];
      const names = [...new Set([series.date_column, ...series.dimensions, ...series.metrics, ...(series.predicted_column ? [series.predicted_column] : [])])];
      if (!this.ctx.clickhouse || names.some((name) => !/^[a-z_][a-z0-9_]*$/u.test(name))) return [];
      const filters = Object.entries(equalities)
        .filter(([column, value]) => /^[a-z_][a-z0-9_]*$/u.test(column) && /^[A-Za-z0-9_-]+$/u.test(value))
        .map(([column, value]) => ` AND ${column} = '${value}'`)
        .join("");
      if (Object.entries(inSets).some(([column, values]) => !series.dimensions.includes(column) || !Array.isArray(values) || values.length < 2 || values.length > 32 || values.some((value) => !/^[A-Za-z0-9_-]{1,64}$/u.test(value)))) return null;
      const setFilters = Object.entries(inSets).map(([column, values]) => ` AND ${column} IN (${values.map((value) => `'${value}'`).join(", ")})`).join("");
      const sql = `SELECT ${names.join(", ")} FROM ${contract.table} WHERE ${series.date_column} >= '${timeRange.start}' AND ${series.date_column} <= '${timeRange.end}'${filters}${setFilters}`;
      const result = await clickHouseQueryBounded(this.ctx.clickhouse, sql, this.ctx.config.maxResultRows, this.ctx.config.maxResultBytes, signal);
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
    if (!timeRange.start || !timeRange.end) return unknownCoverage("没有封闭日期范围，覆盖情况未知");
    if (tables.length !== 1) return unknownCoverage("多表查询的覆盖过滤尚不能证明与主查询一致。");
    const parts = await Promise.all(tables.map(async (table) => {
      const contract = this.ctx.knowledge.contract_by_table.get(table)?.contract;
      if (!contract?.series) return { table, report: unknownCoverage(`${table} 没有声明日期序列，覆盖情况未知`) };
      const applicable = provenCoverageScope(sql, contract, timeRange);
      if (!applicable) return { table, report: unknownCoverage("覆盖统计无法证明与查询筛选完全一致。") };
      const permitted = new Set(bindings.find((binding) => binding.table === table)?.allowed_columns ?? []);
      const needed = [contract.series.date_column, ...contract.series.dimensions, ...contract.series.metrics, ...(contract.series.predicted_column ? [contract.series.predicted_column] : [])];
      if (needed.some((column) => !permitted.has(column))) return { table, report: unknownCoverage("覆盖统计需要未授权字段，未读取这些字段。") };
      const rows = await this.seriesRows(contract, applicable.equalities, timeRange, signal, applicable.inSets);
      if (!rows) return { table, report: unknownCoverage("覆盖查询超过保存预算，未把预览当作完整覆盖。") };
      // Only a comparison of observed content, not a claim of an immutable
      // ClickHouse version. Sorting makes database row order irrelevant.
      const canonical = rows.map((row) => JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))).sort();
      const observation_hash = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
      return { table, report: { ...assessCoverage(contract, applicable.equalities, timeRange, rows, applicable.inSets), observation_hash } };
    }));
    return combineCoverage(parts);
  }

  private async authorizeRead(sessionId: string, assetId: string): Promise<{ ok: true; asset: KnowledgeBase["assets"][number] } | ToolFailure> {
    const session = await this.ctx.sessions.requireAsync(sessionId);
    const asset = this.ctx.knowledge.by_id.get(assetId);
    if (!asset) return fail("asset_not_found", "没有这个资产", { asset_id: assetId });
    if (asset.status !== "published") return fail("asset_not_published", "资产尚未发布", { asset_id: assetId });
    if (!canRead(this.ctx.knowledge, session.role, assetId)) {
      return fail("asset_not_authorized", "当前角色不能读取这个资产", { asset_id: assetId });
    }
    if (!await validateKnowledgeSources(this.ctx.knowledge, [assetId])) return fail("knowledge_source_changed", "知识来源或权限已变化，请重新加载。", { asset_id: assetId });
    return { ok: true, asset };
  }

  /** Before terminal commit, including after a restored Pi receipt, recheck
   * current authority and exact saved resources instead of trusting the old
   * tool response or model-provided notes. */
  async revalidateAnalysis(sessionId: string, jobId: string, analysis: AnalysisRecord): Promise<boolean> {
    if (analysis.session_id !== sessionId || analysis.job_id !== jobId || !Array.isArray(analysis.citations) || !Array.isArray(analysis.sources) || !analysis.resource_hashes || !await validateKnowledgeSources(this.ctx.knowledge)) return false;
    const session = await this.ctx.sessions.requireAsync(sessionId);
    for (const citation of analysis.citations) {
      const found = await this.ctx.sessions.lookupResourceAsync(sessionId, citation.resource_id);
      if (!found.ok || found.resource.job_id !== jobId || analysis.resource_hashes[citation.resource_id] !== createHash("sha256").update(JSON.stringify(found.resource)).digest("hex") || !await this.resourceReadable(sessionId, found.resource, new Set())) return false;
    }
    const excerpts = analysis.analysis_declaration?.declaration.source_excerpts ?? [];
    for (const excerpt of excerpts) {
      const asset = this.ctx.knowledge.by_id.get(excerpt.asset_id);
      if (!asset || !canRead(this.ctx.knowledge, session.role, excerpt.asset_id) || asset.content_hash !== excerpt.content_hash || !asset.body.includes(excerpt.quote)) return false;
    }
    if (!await validateKnowledgeSources(this.ctx.knowledge, excerpts.map((item) => item.asset_id))) return false;
    const verifiedSources = analysis.sources.filter((source) => source.evidence_eligible);
    if (verifiedSources.length) {
      const current = await this.currentFreshness();
      if (!current.ok || !current.publication || current.publication.valid_until < currentCalendarDate(this.ctx.config, this.ctx.knowledge.timezone)) return false;
      if (verifiedSources.some((source) => source.freshness_receipts.length !== source.tables.length || source.freshness_receipts.some((receipt) => receipt.publication_id !== current.publication!.publication_id || receipt.version !== current.publication!.version || current.publication!.tables[receipt.table]?.status !== "fresh"))) return false;
    }
    return true;
  }

  /** Access to a settled historical answer also follows current permissions.
   * This is an access check, not a claim that historical data is still fresh. */
  async canReadStoredAnalysis(sessionId: string, analysis: AnalysisRecord): Promise<boolean> {
    try {
      if (analysis.session_id !== sessionId || !Array.isArray(analysis.sources)) return false;
      const session = await this.ctx.sessions.requireAsync(sessionId); const ids: string[] = [];
      for (const source of analysis.sources) {
        if (!Array.isArray(source.tables)) return false;
        for (const table of source.tables) {
          const asset = this.ctx.knowledge.contract_by_table.get(table); const contract = asset?.contract;
          if (!asset || !contract || !canRead(this.ctx.knowledge, session.role, asset.asset_id) || !canQueryTable(this.ctx.knowledge, session.role, table) || source.contract_revisions?.[table] !== contract.revision || source.asset_hashes?.[asset.asset_id] !== asset.content_hash) return false;
          ids.push(asset.asset_id);
        }
      }
      for (const excerpt of analysis.analysis_declaration?.declaration.source_excerpts ?? []) {
        const asset = this.ctx.knowledge.by_id.get(excerpt.asset_id);
        if (!asset || !canRead(this.ctx.knowledge, session.role, excerpt.asset_id) || asset.content_hash !== excerpt.content_hash || !asset.body.includes(excerpt.quote)) return false;
        ids.push(excerpt.asset_id);
      }
      return validateKnowledgeSources(this.ctx.knowledge, ids);
    } catch { return false; }
  }

  /** Recheck each leaf after restart; historical resources remain readable only
   * while the current principal still has the contract and table permissions. */
  private async resourceReadable(sessionId: string, resource: SessionResource, path: Set<string>): Promise<boolean> {
    if (path.has(resource.resource_id) || path.size >= 32) return false;
    const next = new Set(path); next.add(resource.resource_id);
    if (resource.kind === "query_result") {
      const session = await this.ctx.sessions.requireAsync(sessionId);
      if (resource.registry_revision !== this.ctx.knowledge.registry_revision) return false;
      const ids: string[] = [];
      for (const table of resource.tables) {
        const asset = this.ctx.knowledge.contract_by_table.get(table); const contract = asset?.contract;
        if (!asset || !contract || !canRead(this.ctx.knowledge, session.role, asset.asset_id) || !canQueryTable(this.ctx.knowledge, session.role, table) || contractValidity(contract, currentCalendarDate(this.ctx.config, contract.timezone)) || resource.contract_revisions[table] !== contract.revision || resource.asset_hashes[asset.asset_id] !== asset.content_hash) return false;
        ids.push(asset.asset_id);
      }
      return validateKnowledgeSources(this.ctx.knowledge, ids);
    }
    const ids = resource.kind === "calculation" ? [resource.source_resource_id] : resource.kind === "arithmetic" ? [resource.left.resource_id, resource.right.resource_id] : resource.kind === "transform" ? [resource.source_resource_id] : [resource.spec.left.resource_id, resource.spec.right.resource_id];
    for (const id of new Set(ids)) {
      const parent = await this.ctx.sessions.lookupResourceAsync(sessionId, id);
      if (!parent.ok || (resource.job_id && parent.resource.job_id !== resource.job_id) || !await this.resourceReadable(sessionId, parent.resource, next)) return false;
    }
    return true;
  }

  /** Reconstruct an equivalent proof projection, never the SQL sent to ClickHouse. */
  private evidenceSource(session: SessionRecord, source: QueryResource): QueryResource | null {
    try {
      const ast = parseReadonlySql(source.sql).ast;
      const from = Array.isArray(ast.from) ? ast.from : [];
      const nested = Boolean(ast.with || from.some((item) => item && typeof item === "object" && "expr" in item && item.expr));
      if (!nested) return source;
      if (source.executed_sql !== source.sql) return null;
      const proof = inspectSingleSourceProjection(source.sql, source.tables.map((table) => this.ruleFor(session, table)));
      if (!proof || source.tables.length !== 1 || proof.table !== source.tables[0] || proof.time_range.start !== source.time_range.start || proof.time_range.end !== source.time_range.end) return null;
      return { ...source, sql: proof.proof_sql };
    } catch { return null; }
  }

  private ruleFor(session: SessionRecord, table: string): TableRule {
    if (table.startsWith("sqlite_")) throw new SqlRejected("system_table", `系统表 ${table} 不能查询`);
    const contractAsset = this.ctx.knowledge.contract_by_table.get(table);
    if (!contractAsset?.contract) {
      if (this.ctx.knowledge.table_mentions.has(table)) throw new SqlRejected("missing_data_contract", `${table} 没有可用契约`);
      throw new SqlRejected("unknown_table", `未知表 ${table}`);
    }
    const contract = contractAsset.contract;
    const validity = contractValidity(contract, currentCalendarDate(this.ctx.config, contract.timezone));
    if (validity === "expired") throw new SqlRejected("expired_contract", `${table} 的契约已过期`);
    if (validity === "not_yet_valid") throw new SqlRejected("contract_not_yet_valid", `${table} 的契约尚未生效`);
    if (validity === "invalid") throw new SqlRejected("invalid_contract_period", `${table} 的契约有效期无效`);
    if (!canQueryTable(this.ctx.knowledge, session.role, table)) throw new SqlRejected("table_not_authorized", `当前角色不能查询 ${table}`);
    const binding = session.bindings.find((item) => item.table === table);
    if (!binding) throw new SqlRejected("missing_data_contract_evidence", `${table} 还没有当前契约读取记录`);
    if (!binding.queryable) throw new SqlRejected(binding.deny_reason ?? "table_not_authorized", `${table} 的契约绑定不可查询`);
    if (binding.registry_revision !== this.ctx.knowledge.registry_revision) {
      throw new SqlRejected("stale_data_contract_binding", "契约绑定已过期");
    }
    return {
      table,
      allowed_columns: binding.allowed_columns,
      sensitive_columns: binding.sensitive_columns,
      must_filter: binding.must_filter,
      column_types: Object.fromEntries(contract.columns.map((column) => [column.name, column.type])),
    };
  }

  private queryableBinding(session: SessionRecord, table: string): ContractBinding {
    const binding = session.bindings.find((item) => item.table === table && item.queryable);
    if (!binding) throw new SqlRejected("missing_data_contract_evidence", `${table} 没有可查询绑定`);
    return binding;
  }

  private async gate(sessionId: string, signal?: AbortSignal): Promise<ToolFailure | undefined> {
    // Let timers and cancellation run between tools.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (signal?.aborted) return fail("tool_cancelled", "工具已取消");
    const delay = this.ctx.config.toolDelayMs;
    if (delay > 0) {
      const aborted = await delayUnlessAborted(delay, signal);
      if (aborted) return fail("tool_cancelled", "工具已取消");
    }
    await this.ctx.sessions.requireAsync(sessionId);
    return undefined;
  }

  private async currentFreshness(): Promise<{ ok: true; publication: FreshnessPublication | null } | ToolFailure> {
    if (this.ctx.config.stateMode !== "mysql") {
      const publication = readPublication(this.ctx.config.freshnessPath);
      try {
        const clock = { now: new Date(), simulatedToday: this.ctx.config.simulatedToday };
        const period = freshnessPeriodKey(this.ctx.config.freshnessTargetsPath, clock);
        if (period) freshnessManifest(this.ctx.knowledge, this.ctx.config.freshnessTargetsPath, clock);
        if (publication && period && publication.period_key !== period) return fail("freshness_manifest_changed", "本机演示的新鲜度周期已变化，需要重新探测。");
        return { ok: true, publication };
      } catch { return fail("freshness_authority_unavailable", "本机演示的新鲜度周期配置无效。"); }
    }
    try {
      const store = await this.ctx.mysqlFreshness?.();
      if (!store) return fail("freshness_authority_unavailable", "MySQL 新鲜度权威状态不可用，不能回退本机文件。");
      const current = await store.current();
      if (!current) return { ok: true, publication: null };
      if (!matchesFreshnessManifest(current.manifest, freshnessManifest(this.ctx.knowledge, this.ctx.config.freshnessTargetsPath, { simulatedToday: this.ctx.config.simulatedToday }))) return fail("freshness_manifest_changed", "已发布新鲜度与当前契约、探测目标或业务周期不一致，需要重新探测。");
      return { ok: true, publication: current };
    } catch {
      // Never fall back to the local file when the authoritative database fails.
      return fail("freshness_authority_unavailable", "MySQL 新鲜度权威状态不可用，不能回退本机文件。");
    }
  }
}

const sessionAnalysisMap = new Map<string, AnalysisRecord[]>();
const revisionAttempts = new Map<string, number>();

export function sessionAnalyses(session: { session_id: string }): AnalysisRecord[] {
  let list = sessionAnalysisMap.get(session.session_id);
  if (!list) {
    list = [];
    sessionAnalysisMap.set(session.session_id, list);
  }
  return list;
}

export type { CellOperation } from "./evidence.js";

export interface AnalysisFinding {
  label: string;
  value: number | null;
  kind: "actual" | "missing" | "absent" | "zero" | "predicted";
  resource_id: string;
  cell?: string;
  group?: Record<string, string>;
  time_range?: { start: string; end: string };
}

export interface AnalysisInput {
  suggested_status: AnalysisStatus;
  draft_answer: string;
  resource_ids?: string[];
  clarification_question?: string;
  limitations?: string[];
  findings?: AnalysisFinding[];
  comparisons?: Array<{ left: { resource_id: string; cell: string }; right: { resource_id: string; cell: string } }>;
  declaration?: AnalysisDeclaration;
}

/** The proof contains values already authorized in the original SQL, but is
 * internal metadata and is never returned as model-visible resource rows. */
function verifyJoinResource(resource: JoinQueryResource, session: SessionRecord, knowledge: KnowledgeBase, config: AppConfig, publication: FreshnessPublication): { plan: JoinEvidencePlan; values: VerifiedJoinValue[] } | null {
  if (resource.engine !== "clickhouse-local" || !resource.execution_id || resource.tables.length !== 2 || resource.truncated || resource.sql_limited || !resource.complete_population || resource.total_rows_exact !== true || !resource.join_proof || resource.registry_revision !== knowledge.registry_revision || publication.valid_until < currentCalendarDate(config, knowledge.timezone)) return null;
  const assets = resource.tables.map((table) => knowledge.contract_by_table.get(table));
  if (assets.some((asset) => !asset?.contract || resource.contract_revisions[asset.contract.table] !== asset.contract.revision || resource.asset_hashes[asset.asset_id] !== asset.content_hash || !canQueryTable(knowledge, session.role, asset.contract.table) || contractValidity(asset.contract, currentCalendarDate(config, asset.contract.timezone)))) return null;
  const fact = assets.find((asset) => asset?.contract?.series)?.contract;
  const dimension = assets.find((asset) => asset?.contract && !asset.contract.series)?.contract;
  if (!fact || !dimension) return null;
  const receipts = resource.freshness_receipts;
  if (receipts.length !== 2 || resource.tables.some((table) => !receipts.some((receipt) => receipt.table === table && receipt.status === "fresh" && receipt.publication_id === publication.publication_id && receipt.version === publication.version && publication.tables[table]?.status === "fresh"))) return null;
  const plan = [prepareJoinEvidence(resource.sql, fact, dimension, knowledge.joins), prepareJoinCoverageEvidence(resource.sql, fact, dimension, knowledge.joins), prepareJoinAggregateEvidence(resource.sql, fact, dimension, knowledge.joins)].find((candidate) => candidate?.executionSql === resource.executed_sql);
  if (!plan || plan.range.start !== resource.time_range.start || plan.range.end !== resource.time_range.end || plan.range.timezone !== resource.time_range.timezone || !verifyJoinExecutionSchema(plan, fact, dimension, resource.join_proof.column_types)) return null;
  if (plan.joinType === "left" && resource.execution_settings?.join_use_nulls !== true) return null;
  if (resource.executed_sql !== plan.executionSql || resource.join_proof.capture_hash !== joinCaptureHash(resource.sql, resource.executed_sql, resource.execution_id, resource.join_proof.rows, resource.join_proof.column_types)) return null;
  const visible = resource.join_proof.rows.map(({ __da_join_proof: _proof, ...row }) => row);
  if (JSON.stringify(visible) !== JSON.stringify(resource.rows)) return null;
  const values = verifyJoinEvidence(plan, resource.join_proof.rows);
  if (!values || !joinDimensionMatchesPublication(plan, resource.join_proof.rows, publication.tables[dimension.table])) return null;
  return { plan, values };
}

function joinDimensionMatchesPublication(plan: JoinEvidencePlan, rows: Array<Record<string, unknown>>, state: FreshnessPublication["tables"][string] | undefined): boolean {
  if (!dimensionSnapshotStatusValid(state, plan.dimension) || state.status !== "fresh") return false;
  if (JSON.stringify(state.key_columns) !== JSON.stringify(plan.joinKeys) || plan.joinKeys.some((name) => !state.snapshot_columns.includes(name))) return false;
  const observations = joinDimensionObservations(plan, rows);
  const missing = joinMissingDimensionKeys(plan, rows);
  if (!observations || !missing || observations.some((item) => !dimensionSnapshotMatches(state, plan.dimension, item.keys, item.column, item.value))) return false;
  // An unmatched key is meaningful only if the valid current publication also
  // proves absence; missing or malformed publication is never evidence of it.
  return missing.every((key) => plan.joinKeys.every((name) => !dimensionSnapshotMatches(state, plan.dimension, key, name, key[name]!)));
}

function joinCaptureHash(sql: string, executedSql: string, executionId: string, rows: Array<Record<string, unknown>>, columnTypes: Record<string, string>): string {
  return createHash("sha256").update(JSON.stringify({ sql, executed_sql: executedSql, execution_id: executionId, settings: { join_use_nulls: true }, rows, column_types: columnTypes })).digest("hex");
}

function joinCoverage(plan: JoinEvidencePlan, rows: Array<Record<string, unknown>>, fact?: DataContract): QueryResource["coverage"] {
  if (plan.coverageExpectedRows !== undefined) return joinClosedCoverage(plan, rows) ?? unknownCoverage("契约封闭范围的分组或日期不完整，无法证明整体覆盖。");
  if (fact?.series?.coverage_domains !== undefined) return unknownCoverage("契约声明了封闭域，但此查询无法核验完整范围。");
  if (plan.aggregateProof) return unknownCoverage("数据库全量聚合已检查本次观察的粒度与关联，但未证明每个业务日期和未出现分组的覆盖。");
  const metricCount = new Set(plan.metrics.map((item) => item.column)).size;
  const zeros = new Set<string>();
  for (const row of rows) for (const tuple of row.__da_join_proof as unknown[][]) {
    if (tuple.slice(1, 1 + metricCount).some(isExactZero)) zeros.add(String(tuple[0]));
  }
  return { status: "known", reason: "本次 JOIN 查询捕获的已出现分组按完整事实粒度逐日验证；未出现的分组不补零。", table: plan.fact, expected_days: plan.expectedDates.length, absent_dates: [], null_dates: [], zero_dates: [...zeros].sort(), predicted_dates: [], actual_dates: [...plan.expectedDates], unknown_prediction_dates: [], groups: [] };
}

function renderVerifiedJoin(item: VerifiedJoinValue, resourceId: string): string {
  const fields = (value: Record<string, string | null>) => Object.entries(value).map(([key, part]) => `${key}=${part === null ? "NULL（维表未匹配）" : part}`).join("，") || "无";
  return `${item.fact}.${item.column}（${item.description}）：已核验 JOIN ${item.operation === "sum" ? "求和" : "非 NULL 计数"} ${item.value}；单位 ${item.unit}；分组 ${fields(item.group)}；事实筛选 ${fields(item.factFilters)}；维表筛选 ${fields(item.dimensionFilters)}；${item.range.start} 到 ${item.range.end}（${item.range.timezone}）；来源 ${resourceId}。${item.unmatched_rows ? `未匹配维表 ${item.unmatched_rows} 行，维表字段保留 NULL。` : ""}结果与维表匹配证明来自同次查询，非跨表原子快照。`;
}

function renderComparison(comparison: VerifiedComparison): string {
  const { left, right, difference, change_percent } = comparison;
  const scope = (cell: VerifiedCell) => `${Object.entries(cell.filters).map(([key, value]) => `${key}=${value}`).join("，")}；${cell.range.start} 到 ${cell.range.end}（${cell.range.timezone}）；来源 ${cell.sourceResourceId}`;
  return `${left.source.table}.${left.source.column} 比较：${left.source.value}（${scope(left.source)}）减 ${right.source.value}（${scope(right.source)}）= ${difference} ${left.source.unit}；${change_percent === null ? "基准为零，变化率不可计算" : `相对基准变化 ${change_percent}%（四舍五入到小数点后两位）`}；${left.source.prediction}。`;
}

function renderAggregate(item: VerifiedAggregate): string {
  const filters = Object.entries(item.filters).map(([key, value]) => `${key}=${value}`).join("，") || "无";
  const group = Object.entries(item.group).map(([key, value]) => `${key}=${value}`).join("，");
  return `${item.table}.${item.column}（${item.description}）：数据库${item.operation === "sum" ? "求和" : "非 NULL 计数"} ${item.value}；单位 ${item.unit}；实际（契约声明仅观察值）；筛选 ${filters}${group ? `；分组 ${group}` : ""}；${item.range.start} 到 ${item.range.end}（${item.range.timezone}）；来源 ${item.source_resource_id}。`;
}

function renderConditionalAggregate(item: VerifiedConditionalAggregate): string {
  const filters = Object.entries(item.filters).map(([key, value]) => `${key}=${value}`).join("，") || "无";
  const group = Object.entries(item.group).map(([key, value]) => `${key}=${value}`).join("，");
  const condition = item.operation === "count_null" ? "为 NULL" : item.operation === "count_nonnull" ? "非 NULL" : "等于零";
  return `${item.table}.${item.column}：数据库条件计数（${condition}）${item.value}；单位 行；实际（契约声明仅观察值）；筛选 ${filters}${group ? `；分组 ${group}` : ""}；${item.range.start} 到 ${item.range.end}（${item.range.timezone}）；来源 ${item.source_resource_id}。${item.coverage_incomplete ? "覆盖不完整，此计数仅描述已观测行；NULL 和未出现的行没有补零。" : "此计数描述查询中已观测的行，未出现的分组没有补零。"}`;
}

function renderAggregateComparison(item: AggregateComparison): string {
  const scope = (value: VerifiedAggregate) => `${Object.entries({ ...value.filters, ...value.group }).map(([key, part]) => `${key}=${part}`).join("，")}；${value.range.start} 到 ${value.range.end}（${value.range.timezone}）；来源 ${value.source_resource_id}`;
  return `${item.left.table}.${item.left.column} 精确十进制比较：${item.left.value}（${scope(item.left)}）减 ${item.right.value}（${scope(item.right)}）= ${item.difference} ${item.left.unit}；${item.ratio === null ? "基准为零，比例和变化率不可计算" : `比例 ${item.ratio}，变化率 ${item.change_percent}%（四舍五入，半数远离零）`}；实际（契约声明仅观察值）。`;
}

function renderArithmetic(item: NonNullable<AnalysisRecord["arithmetic_results"]>[number]): string {
  const value = item.result.value === null ? "除数为零，结果不可计算" : `${item.result.value} ${item.result.unit}`;
  const scope = item.result.scopes.map((entry) => `${Object.entries(entry.filters).map(([key, part]) => `${key}=${part}`).join("，")}；${entry.start} 到 ${entry.end}`).join(" / ");
  return `${item.result.formula ?? `${item.result.basis.table}.${item.result.basis.column}`} 可复核四则运算 ${item.operation}：${value}；范围 ${scope}（${item.result.basis.timezone}）；输入 ${item.left.resource_id}、${item.right.resource_id}；计算资源 ${item.resource_id}。除法保留 18 位，半数远离零。`;
}

function stableHashes(value: Record<string, string>): string {
  return JSON.stringify(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

/** Reconstruct rows solely from verified aggregate outputs and contract labels,
 * never from model-chosen aliases as semantic descriptions. */
/** Convert only a complete direct projection of an observed-only contract.
 * SQL admission alone is insufficient evidence of column lineage or exactness. */
function rawResultTable(source: QueryResource, contract: DataContract): ResultTable | null {
  if (!contract.series || contract.series.prediction_mode !== "observed_only" || contract.series.predicted_column || source.truncated || source.sql_limited || !source.complete_population || source.total_rows_exact !== true || source.rows.length > RESULT_CALCULATION_MAX_ROWS || source.rows.length !== source.returned_rows || source.rows.length !== source.total_rows || (source.engine === "clickhouse-local" && !source.execution_id)) return null;
  if (!verifyCell(source, contract, { op: "count_rows", as: "shape" }, source.rows.length)) return null;
  const projections = parseReadonlySql(source.sql).ast.columns;
  if (!Array.isArray(projections) || projections.length !== source.columns.length || projections.length > 40) return null;
  const fields: Array<{ column: ResultColumn; field: string; declared: DataContract["columns"][number]; kind: "integer" | "decimal" | "text" }> = [];
  for (const projection of projections) {
    if (!projection || typeof projection !== "object") return null;
    const item = projection as { as?: string | null; expr?: { type?: string; column?: string } };
    const field = item.expr?.column, name = item.as ?? field;
    if (item.expr?.type !== "column_ref" || !field || !name || !source.columns.includes(name) || !/^[a-z_][a-z0-9_]{0,63}$/u.test(name) || ["__proto__", "constructor", "prototype"].includes(name)) return null;
    const declared = contract.columns.find((candidate) => candidate.name === field);
    if (!declared || contract.sensitive_columns.includes(field)) return null;
    const type = declared.type.replace(/\s/gu, "").toLowerCase();
    const decimal = /^(?:nullable\()?decimal\((\d+),(\d+)\)\)?$/u.exec(type);
    const integer = /^(?:nullable\()?(?:u?int\d*|integer)\)?$/u.test(type);
    const text = /^(?:nullable\()?(?:lowcardinality\()?string\)?\)?$/u.test(type) || /^(?:nullable\()?date\)?$/u.test(type);
    if (!decimal && !integer && !text) return null;
    const kind = decimal ? "decimal" : integer ? "integer" : "text";
    const isMetric = contract.series.metrics.includes(field);
    if (isMetric && (!declared.unit || kind === "text")) return null;
    if (decimal && (Number(decimal[1]) > 28 || Number(decimal[2]) > 28 || source.engine !== "clickhouse-local" || source.decimal_types?.[`${contract.table}.${field}`]?.replace(/\s/gu, "").toLowerCase() !== type || source.column_types?.[name]?.replace(/\s/gu, "").toLowerCase() !== type)) return null;
    if (source.engine === "clickhouse-local" && integer && source.column_types?.[name]?.replace(/\s/gu, "").toLowerCase() !== type) return null;
    const column: ResultColumn = { name, type: kind === "text" ? "text" : "decimal", unit: isMetric ? declared.unit! : `维度 ${contract.table}.${field}`, label: `${contract.table}.${field}${isMetric ? "（实际观察）" : ""}`, ...(kind === "text" ? {} : { scale: decimal ? Number(decimal[2]) : 0 }) };
    fields.push({ column, field, declared, kind });
  }
  const rows: Array<Record<string, ResultValue>> = [];
  for (const row of source.rows) {
    if (Object.keys(row).length !== fields.length || fields.some(({ column }) => !Object.hasOwn(row, column.name))) return null;
    const result: Record<string, ResultValue> = Object.create(null) as Record<string, ResultValue>;
    for (const { column, declared, kind } of fields) {
      const value = row[column.name];
      if (value === null) { if (!declared.nullable && !declared.type.toLowerCase().startsWith("nullable(")) return null; result[column.name] = null; continue; }
      if (kind === "text") { if (typeof value !== "string" || value.length > 256) return null; result[column.name] = value; continue; }
      if (kind === "integer") {
        if (typeof value === "number" && Number.isSafeInteger(value)) result[column.name] = String(value);
        else if (typeof value === "string" && /^-?\d{1,76}$/u.test(value)) result[column.name] = value;
        else return null;
      } else {
        const exact = sumDecimalStrings([value], column.scale!);
        if (exact === null) return null;
        result[column.name] = exact;
      }
    }
    rows.push(result);
  }
  const result = { columns: fields.map(({ column }) => column), rows };
  return fitsResultCalculationBytes(result) ? result : null;
}

function aggregateTable(items: VerifiedAggregate[]): ResultTable | null {
  if (!items.length) return null;
  const first = items[0]!;
  const groupKeys = Object.keys(first.group).sort();
  const columns: ResultColumn[] = groupKeys.map((name) => ({ name, type: "text", unit: `维度 ${first.table}.${name}`, label: `${first.table}.${name}` }));
  const grouped = new Map<string, Record<string, ResultValue>>();
  const metrics = new Map<string, ResultColumn>();
  for (const item of items) {
    if (item.table !== first.table || item.source_resource_id !== first.source_resource_id || JSON.stringify(Object.keys(item.group).sort()) !== JSON.stringify(groupKeys)) return null;
    const metric: ResultColumn = { name: item.output_column, type: "decimal", unit: item.unit, label: `${item.table}.${item.column} ${item.operation === "sum" ? "合计" : "非 NULL 计数"}`, scale: item.scale };
    const previous = metrics.get(metric.name);
    if (previous && JSON.stringify(previous) !== JSON.stringify(metric)) return null;
    if (groupKeys.includes(metric.name)) return null;
    metrics.set(metric.name, metric);
    const key = JSON.stringify(groupKeys.map((name) => item.group[name]));
    let row = grouped.get(key);
    if (!row) {
      row = Object.create(null) as Record<string, ResultValue>;
      for (const name of groupKeys) row[name] = item.group[name]!;
      grouped.set(key, row);
    }
    if (Object.hasOwn(row, metric.name)) return null;
    row[metric.name] = item.value;
  }
  columns.push(...metrics.values());
  const rows = [...grouped.values()];
  if (rows.some((row) => Object.keys(row).length !== columns.length)) return null;
  return { columns, rows };
}

function alignmentTable(spec: AlignmentSpec, rows: AlignedRow[]): ResultTable | null {
  const left = rows.find((row) => row.left)?.left;
  const right = rows.find((row) => row.right)?.right;
  const sample = (item: ArithmeticValue) => ({ ...item, value: item.scale ? `1.${"0".repeat(item.scale)}` : "1" });
  const output = rows.find((row) => row.result)?.result ?? (left && right ? computeArithmetic(spec.op, sample(left), { ...sample(right), scopes: left.scopes }, true) : null);
  const reserved = ["left_value", "right_value", "result_value", "alignment_status"];
  if (!left || !right || !output || spec.keys.some((key) => reserved.includes(key))) return null;
  const leftLabel = `${left.basis.table}.${left.basis.column}`; const rightLabel = `${right.basis.table}.${right.basis.column}`;
  const columns: ResultColumn[] = [
    ...[...spec.keys].sort().map((name) => ({ name, type: "text" as const, unit: `维度 ${name}`, label: name })),
    { name: "left_value", type: "decimal", unit: left.unit, label: `左侧 ${leftLabel}`, scale: left.scale },
    { name: "right_value", type: "decimal", unit: right.unit, label: `右侧 ${rightLabel}`, scale: right.scale },
    { name: "result_value", type: "decimal", unit: output.unit, label: `${leftLabel} ${spec.op} ${rightLabel}`, scale: output.scale },
    { name: "alignment_status", type: "text", unit: "状态", label: "对齐状态" },
  ];
  for (const row of rows) {
    if (row.left && (row.left.unit !== left.unit || row.left.scale !== left.scale || row.left.basis.table !== left.basis.table || row.left.basis.column !== left.basis.column)) return null;
    if (row.right && (row.right.unit !== right.unit || row.right.scale !== right.scale || row.right.basis.table !== right.basis.table || row.right.basis.column !== right.basis.column)) return null;
    if (row.result && (row.result.unit !== output.unit || row.result.scale !== output.scale)) return null;
  }
  return { columns, rows: rows.map((row) => ({ ...row.group, left_value: row.left?.value ?? null, right_value: row.right?.value ?? null, result_value: row.result?.value ?? null, alignment_status: row.status })) };
}

function renderTransform(resource: TransformResource, input: ResultTable, result: ResultTable): string[] {
  const descriptions: string[] = [];
  let current = input;
  const label = (name: string) => current.columns.find((column) => column.name === name)?.label ?? "未知字段";
  for (const step of resource.steps) {
    if (step.op === "filter") descriptions.push(`筛选 ${label(step.column)} ${step.comparison}${"other_column" in step && step.other_column ? ` ${label(step.other_column)}` : "value" in step ? ` ${JSON.stringify(step.value)}` : ""}`);
    else if (step.op === "compare") descriptions.push(`比较 ${label(step.left)} ${step.comparison} ${label(step.right)}`);
    else if (step.op === "add" || step.op === "subtract" || step.op === "multiply" || step.op === "divide") descriptions.push(`计算 ${label(step.left)} ${{ add: "+", subtract: "−", multiply: "×", divide: "/" }[step.op]} ${label(step.right)}（${step.op === "divide" ? "除法保留 18 位，半数远离零；" : ""}NULL 或零分母结果未知）`);
    else if (step.op === "sort") descriptions.push(`排序 ${step.keys.map((key) => `${label(key.column)} ${key.direction}（NULL ${key.nulls}）`).join("、")}`);
    else if (step.op === "group") descriptions.push(`按 ${step.by.map(label).join("、") || "全部结果"} 分组；${step.aggregates.map((item) => item.op === "count_all" ? "输入结果行数" : `${label(item.column!)} ${item.op}`).join("、")}`);
    const next = transformResult(current, [step], () => true);
    if (next) current = next;
  }
  const lines = [`结果变换：${descriptions.join(" → ")}；输入 ${resource.source_resource_id}；计算资源 ${resource.resource_id}。计数指输入结果行，不自动代表业务明细行；聚合忽略 NULL，未知值没有补零。`];
  if (!result.rows.length) lines.push("变换后无结果行；不补零。");
  let shown = 0; let bytes = 0;
  for (const row of result.rows.slice(0, 100)) {
    const line = result.columns.map((column) => {
      const value = row[column.name];
      return `${column.label}=${value === null ? "NULL（空值）" : value === "NULL" ? '"NULL"（字符串）' : String(value)}（${column.unit}）`;
    }).join("；") + "。";
    const size = Buffer.byteLength(line); if (bytes + size > 32_000) break;
    lines.push(line); bytes += size; shown += 1;
  }
  if (result.rows.length > shown) lines.push(`已验证结果共 ${result.rows.length} 行，此处展示 ${shown} 行；可按资源分页回读其余行。`);
  return lines;
}

function renderAlignment(resource: AlignmentResource, rows: AlignedRow[]): string[] {
  const lines = [`按分组键全集对齐并执行 ${resource.spec.op}；输入 ${resource.spec.left.resource_id}、${resource.spec.right.resource_id}；计算资源 ${resource.resource_id}。未出现的组不补零。`];
  if (resource.coverage_incomplete) lines.push("来源覆盖不完整或未知；以下各组计算仅基于已观察记录，不能代表完整周期。");
  if (rows.some((row) => Object.values(row.group).some((value) => value === null))) lines.push("NULL 键作为独立分组保留；当前覆盖回执不证明 NULL 键的周期完整性，因此只能部分交付。");
  for (const row of rows.slice(0, 100)) {
    const group = Object.entries(row.group).map(([key, value]) => `${key}=${value === null ? "NULL（空键）" : value === "NULL" ? '"NULL"（字符串）' : value}`).join("，");
    const show = (value: ArithmeticValue | null, count?: number, nullCount?: number) => value ? `${value.basis.table}.${value.basis.column} ${value.value === null ? "全 NULL" : value.value} ${value.unit}${count === undefined ? "" : `（${count} 行，${nullCount} 行 NULL）`}` : "该查询结果未出现此组";
    const result = row.status === "zero_divisor" ? "除数为零，结果不可计算" : row.status === "null_input" ? "至少一侧全 NULL，结果未知" : row.status === "empty_inputs" ? "两侧无输入，结果未知" : row.result ? `${row.result.value} ${row.result.unit}${row.status === "partial_nulls" ? "（仅非 NULL 部分，不能代表完整分组）" : ""}` : "缺少一侧分组，结果未知";
    lines.push(`${group}：左侧 ${show(row.left, row.left_count, row.left_null_count)}；右侧 ${show(row.right, row.right_count, row.right_null_count)}；结果 ${result}${row.result && resource.coverage_incomplete ? "（来源覆盖不完整，仅为已观察记录的计算）" : ""}。`);
  }
  if (rows.length > 100) lines.push(`已验证对齐结果共 ${rows.length} 行，此处展示 100 行；可按资源分页回读其余行。`);
  return lines;
}

function renderDecimalCell(item: VerifiedDecimalCell): string {
  const filters = Object.entries(item.filters).map(([key, value]) => `${key}=${value}`).join("，") || "无";
  return `${item.table}.${item.column}（${item.description}）：完整资源精确十进制合计 ${item.value}；单位 ${item.unit}；实际（契约声明仅观察值）；筛选 ${filters}；${item.range.start} 到 ${item.range.end}（${item.range.timezone}）；来源 ${item.source_resource_id}。`;
}

function renderGroupRollup(item: VerifiedGroupRollup): string {
  const restrictions = [
    ...Object.entries(item.filters).map(([key, value]) => `${key}=${value}`),
    ...Object.entries(item.in_sets).map(([key, values]) => `${key} IN (${values.join("、")})`),
  ].join("，") || "未限定维度";
  const metric = `${item.table}.${item.column}（${item.description}）`;
  const input = item.input_operation === "sum" ? "求和" : "非 NULL 计数";
  const action = item.operation === "sum" ? `分组${input}结果再求和` : item.operation === "count_rows" ? "查询返回的结果分组数" : item.operation === "count_null" ? "分组聚合输出为 NULL 的分组数" : "分组聚合输出为零的分组数";
  return `${metric}：${action} ${item.value}；单位 ${item.unit}；实际（契约声明仅观察值）；筛选 ${restrictions}；原查询按 ${item.grouped_by.join("、")} 分组；${item.range.start} 到 ${item.range.end}（${item.range.timezone}）；来源 ${item.source_resource_id}。${item.operation === "sum" ? "仅汇总查询已返回的分组，未出现的组合没有补零。" : "这是结果分组的计数，不是底层业务明细的计数。"}`;
}

function computeCell(source: QueryResource, contract: DataContract | undefined, operation: CellOperation, notes: string[]): number | string | null {
  const series = contract?.series; const predicted = operation.predicted ?? "any";
  let rows = source.rows;
  if (series?.predicted_column) {
    const flag = series.predicted_column; const mapping = series.prediction_values;
    const valid = mapping && mapping.actual !== mapping.predicted && source.columns.includes(flag) && rows.every((row) => (typeof row[flag] === "number" || typeof row[flag] === "string") && [mapping.actual, mapping.predicted].includes(Number(row[flag])));
    if (!valid && (predicted !== "any" || operation.op === "sum")) { notes.push("预测状态或映射未知，不能计算该筛选或合计。"); return null; }
    if (valid && mapping) {
      if (predicted !== "any") rows = rows.filter((row) => Number(row[flag]) === (predicted === "actual_only" ? mapping.actual : mapping.predicted));
      else if (operation.op === "sum" && new Set(rows.map((row) => Number(row[flag]))).size > 1) { notes.push("实际与预测混合，不能合计。"); return null; }
    }
  } else if (predicted !== "any") {
    if (series?.prediction_mode !== "observed_only") { notes.push("契约未证明实际或预测状态。"); return null; }
    if (predicted === "predicted_only") rows = [];
  }
  if (operation.op === "count_rows") return rows.length;
  const column = operation.column ?? "";
  if (rows.some((row) => !Object.hasOwn(row, column))) { notes.push("保存结果缺少计算字段。"); return null; }
  if (operation.op === "count_null") return rows.filter((row) => row[column] === null).length;
  if (operation.op === "count_zero") {
    const numericString = /^(?:nullable\()?\s*(?:decimal\(|u?int(?:64|128|256))/iu.test(source.column_types?.[column] ?? "");
    return rows.filter((row) => row[column] === 0 || numericString && typeof row[column] === "string" && /^-?0+(?:\.0+)?$/u.test(row[column] as string)).length;
  }
  const values = rows.map((row) => row[column]).filter((value) => value !== null);
  if (!values.length) { notes.push("没有非 NULL 值，合计不是零。"); return null; }
  const type = source.column_types?.[column] ?? "";
  const decimal = /^(?:nullable\()?\s*decimal\(\s*\d+\s*,\s*(\d+)\s*\)\s*\)?$/iu.exec(type);
  const integerString = /^(?:nullable\()?\s*u?int(?:64|128|256)\s*\)?$/iu.test(type);
  if (decimal || integerString) {
    const scale = decimal ? Number(decimal[1]) : 0;
    const result = sumDecimalStrings(values, scale);
    if (result === null) notes.push("精确数值不可解析或超过限制，未转换为浮点。");
    return result;
  }
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) { notes.push("字段不是可计算的数值，不能强制转换。"); return null; }
  const numbers = values as number[]; const sum = numbers.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(sum) || numbers.every(Number.isInteger) && (!numbers.every(Number.isSafeInteger) || !Number.isSafeInteger(sum))) { notes.push("整数超过安全精度，未计算。"); return null; }
  if (numbers.some((value) => !Number.isInteger(value))) notes.push("浮点结果为近似值，不是精确十进制。");
  return sum;
}

function renderAnswer(
  status: AnalysisStatus,
  cells: VerifiedCell[],
  sources: AnalysisRecord["sources"],
  clarification: string | undefined,
  derivedLines: string[],
): string {
  const lines: string[] = [];
  if (status === "partial") lines.push("这个回答不完整。");
  if (status === "completed") lines.push("以下数字由当前任务的已授权查询和计算生成。");
  if (status === "needs_clarification") lines.push(clarification || "还需要补充问题范围。");
  if (status === "failed") lines.push(clarification || "这次没有取得可引用的查询结果。");
  const operations: Record<VerifiedCell["operation"], string> = { sum: "非 NULL 值合计", count_null: "值为 NULL 的行数", count_zero: "数值为零的行数", count_rows: "查询结果行数" };
  for (const cell of cells) {
    const filters = Object.entries(cell.filters).map(([key, value]) => `${key}=${value}`).join("，") || "未限定维度";
    const metric = cell.column ? `${cell.table}.${cell.column}（${cell.description}）` : `${cell.table} 查询行`;
    lines.push(`${metric}：${operations[cell.operation]}${cell.precision === "floating_point_approximate" ? "（浮点近似，非精确十进制）" : ""} ${formatNumber(cell.value)}；单位 ${cell.unit}；${cell.prediction}；筛选 ${filters}；${cell.range.start} 到 ${cell.range.end}（${cell.range.timezone}）；来源 ${cell.sourceResourceId}。${cell.operation === "sum" && cell.excludedNulls ? `排除了 ${cell.excludedNulls} 行 NULL；无记录没有补成零。` : ""}`);
  }
  lines.push(...derivedLines);
  for (const source of sources) {
    if (source.evidence_eligible) appendCoverage(lines, source);
    else lines.push(`${source.tables.join(",")} 的证据当前不可验证，未展示其数值。`);
  }
  if (!cells.length && !derivedLines.length && sources.length) lines.push("没有可证明血缘的计算数值。");
  return lines.join("\n");
}

function renderDerivedAndGroups(cells: VerifiedCell[], resources: SessionResource[], knowledge: KnowledgeBase): string[] {
  const lines: string[] = [];
  const sourceIds = [...new Set(cells.map((cell) => cell.sourceResourceId))];
  for (const id of sourceIds) {
    const source = resources.find((item): item is QueryResource => item.kind === "query_result" && item.resource_id === id);
    const asset = source && knowledge.contract_by_table.get(source.tables[0] ?? "");
    const contract = asset?.contract;
    if (!source || !contract?.series) continue;
    const related = cells.filter((cell) => cell.sourceResourceId === id && cell.operation === "sum");
    for (const definition of contract.derived_metrics ?? []) {
      if (definition.operation !== "divide" || definition.prediction !== "actual_only") continue;
      const numerator = related.find((cell) => cell.column === definition.numerator && cell.predictionFilter === "actual_only" && cell.prediction.startsWith("实际（"));
      const denominator = related.find((cell) => cell.column === definition.denominator && cell.predictionFilter === "actual_only" && cell.prediction.startsWith("实际（"));
      if (!numerator || !denominator || numerator.unit !== denominator.unit || numerator.unit === "契约未声明") continue;
      const scope = `${Object.entries(numerator.filters).map(([key, value]) => `${key}=${value}`).join("，") || "未限定维度"}；${numerator.range.start} 到 ${numerator.range.end}（${numerator.range.timezone}）`;
      if (denominator.value === 0) lines.push(`${definition.label}：分母为零，不能计算。${scope}；来源 ${id}。`);
      else lines.push(`${definition.label}：${formatNumber(numerator.value)} / ${formatNumber(denominator.value)} = ${formatNumber(numerator.value / denominator.value)}（${definition.unit}，浮点近似）。${scope}；来源 ${id}；只使用契约声明的实际值，预测行不进入结果。`);
    }
    // Group only already-authorized raw rows on a declared and selected dimension.
    for (const cell of related) {
      const calc = resources.find((item): item is CalculationResource => item.kind === "calculation" && item.source_resource_id === id && Object.values(item.operations ?? {}).some((op) => op.op === "sum" && op.column === cell.outputColumn && (op.predicted ?? "any") === cell.predictionFilter));
      const op = calc && Object.values(calc.operations ?? {}).find((item) => item.op === "sum" && item.column === cell.outputColumn && (item.predicted ?? "any") === cell.predictionFilter);
      if (!op || !cell.column) continue;
      for (const dimension of contract.series.dimensions) {
        if (Object.hasOwn(cell.filters, dimension) || !source.columns.includes(dimension)) continue;
        if (source.rows.some((row) => typeof row[dimension] !== "string")) continue;
        const values = [...new Set(source.rows.map((row) => row[dimension] as string))];
        if (values.length < 2) continue;
        const parts: string[] = [];
        for (const value of values.slice(0, 100)) {
          const subset = source.rows.filter((row) => row[dimension] === value);
          const mapping = contract.series.prediction_values;
          const flag = contract.series.predicted_column;
          const selected = flag && mapping && op.predicted === "actual_only" ? subset.filter((row) => Number(row[flag]) === mapping.actual) : flag && mapping && op.predicted === "predicted_only" ? subset.filter((row) => Number(row[flag]) === mapping.predicted) : subset;
          const numbers = selected.map((row) => row[cell.outputColumn!]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
          if (!numbers.length) continue;
          const total = numbers.reduce((a, b) => a + b, 0);
          if (!verifyCell({ ...source, rows: subset }, contract, op, total)) continue;
          parts.push(`${value}=${formatNumber(total)}`);
        }
        if (parts.length) lines.push(`${cell.table}.${cell.column} 按 ${dimension} 分组：${parts.join("，")}${values.length > 100 ? `（共 ${values.length} 组，此处展示前 100 组）` : ""}${cell.precision === "floating_point_approximate" ? "（浮点近似）" : ""}；单位 ${cell.unit}；${cell.prediction}；其他筛选 ${Object.entries(cell.filters).map(([key, value]) => `${key}=${value}`).join("，") || "无"}；${cell.range.start} 到 ${cell.range.end}（${cell.range.timezone}）；来源 ${id}。NULL 与无记录没有补零。`);
      }
    }
  }
  return lines;
}

function appendCoverage(lines: string[], source: AnalysisRecord["sources"][number]): void {
  const report = source.coverage;
  if (!report) {
    lines.push(`${source.tables.join(",")} 的覆盖情况未知。`);
    return;
  }
  const reports = report.per_table?.length ? report.per_table : [report];
  for (const item of reports) appendOneCoverage(lines, item.table ?? source.tables.join(","), item);
  const receipt = source.freshness_receipts[0];
  if (receipt) lines.push(`新鲜度发布 ${receipt.publication_id} 版本 ${receipt.version}。`);
}

function appendOneCoverage(lines: string[], label: string, report: NonNullable<AnalysisRecord["sources"][number]["coverage"]>): void {
  if (report.status === "unknown") {
    lines.push(`${label} 的覆盖情况未知。${report.reason}`);
    return;
  }
  if (report.absent_dates.length) lines.push(`${label} 无记录 ${report.absent_dates.length} 天：${report.absent_dates.join("、")}。这些天没有补成 0。`);
  if (report.null_dates.length) lines.push(`${label} 有记录但值为 NULL 的日期：${report.null_dates.join("、")}。`);
  if (report.zero_dates.length) lines.push(`${label} 数值为零的日期：${report.zero_dates.join("、")}。`);
  if (report.predicted_dates.length) lines.push(`${label} 含预测标记的日期：${report.predicted_dates.join("、")}，没有当成实际值。`);
  if (report.unknown_prediction_dates?.length) lines.push(`${label} 的部分日期未声明实际/预测状态。`);
  for (const group of report.groups) {
    if (!group.absent_dates.length && !group.null_dates.length && !group.predicted_dates.length && !group.zero_dates.length) continue;
    lines.push(
      `${group.dimension}=${group.value}：无记录 ${group.absent_dates.length} 天，NULL ${group.null_dates.length} 天，数值为零 ${group.zero_dates.length} 天，含预测标记 ${group.predicted_dates.length} 天。未出现的维度组合不算缺失。`,
    );
  }
}

function formatNumber(value: number): string {
  return String(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
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
  const names = [...new Set([series.date_column, ...series.dimensions, ...series.metrics, ...(series.predicted_column ? [series.predicted_column] : [])])];
  if (names.some((name) => !/^[a-z_][a-z0-9_]*$/u.test(name)) || !/^[a-z_][a-z0-9_]*$/u.test(contract.table)) return [];
  const where = [`${series.date_column} >= ?`, `${series.date_column} <= ?`];
  const params = [timeRange.start, timeRange.end];
  for (const [column, value] of Object.entries(equalities)) {
    if (!/^[a-z_][a-z0-9_]*$/u.test(column)) continue;
    where.push(`${column} = ?`);
    params.push(value);
  }
  for (const [column, values] of Object.entries(inSets)) {
    if (!series.dimensions.includes(column) || !Array.isArray(values) || values.length < 2 || values.length > 32 || values.some((value) => !/^[A-Za-z0-9_-]{1,64}$/u.test(value))) throw new Error("coverage_scope_invalid");
    where.push(`${column} IN (${values.map(() => "?").join(", ")})`);
    params.push(...values);
  }
  return plainRows(db.prepare(`SELECT ${names.join(", ")} FROM ${contract.table} WHERE ${where.join(" AND ")}`).all(...params));
}

function fail(code: string, message: string, extra: Record<string, unknown> = {}): ToolFailure {
  return { ok: false, code, message, ...extra };
}

function waitForQuery(latencyMs: number, timeoutMs: number, signal?: AbortSignal): Promise<"ok" | "timeout" | "cancelled"> {
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

function delayUnlessAborted(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

