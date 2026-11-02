import { createHash, randomUUID } from "node:crypto";
import { currentCalendarDate, type AppConfig } from "./config.js";
import { assessCoverage, combineCoverage, coverageHasGap, provenCoverageFilters, unknownCoverage } from "./coverage.js";
import { plainRows } from "./database.js";
import { verifyCell, type CellOperation, type VerifiedCell } from "./evidence.js";
import { compareVerifiedIntegers, type VerifiedComparison } from "./evidence-comparison.js";
import { freshnessManifest, matchesFreshnessManifest, readPublication, type FreshnessPublication } from "./freshness.js";
import type { MysqlFreshnessStore } from "./mysql-freshness.js";
import { canQueryTable, canRead, contractValidity, tableGrain } from "./knowledge.js";
import { newId, type SessionStore } from "./session.js";
import type {
  AnalysisRecord,
  AnalysisStatus,
  CalculationResource,
  ContractBinding,
  DataContract,
  FreshnessReceipt,
  KnowledgeBase,
  QueryResource,
  SessionResource,
  ToolFailure,
} from "./types.js";
import { clickHouseColumns, clickHouseQuery } from "./clickhouse-client.js";
import { assertJoinKeys, guardSql, parseReadonlySql, SqlRejected, type TableRule } from "./sql.js";
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

export class ToolService {
  private readonly assetBytesRead = new Map<string, number>();

  constructor(private readonly ctx: ToolContext) {}

  reserveToolCall(sessionId: string): "ok" | "budget_exhausted" | "lost" {
    return this.ctx.sessions.reserveToolCall(sessionId, this.ctx.config.maxToolCalls);
  }

  async searchAssets(sessionId: string, input: { query?: string; kinds?: string[] }, signal?: AbortSignal): Promise<ToolResult> {
    const cancelled = await this.gate(sessionId, signal);
    if (cancelled) return cancelled;
    const session = this.ctx.sessions.require(sessionId);
    const query = (input.query ?? "").trim().toLowerCase();
    const kinds = new Set(input.kinds ?? []);
    const hits = this.ctx.knowledge.assets
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
      .map((asset) => ({
        asset_id: asset.asset_id,
        kind: asset.kind,
        title: asset.title,
        summary: asset.summary,
        revision: asset.revision,
        content_hash: asset.content_hash,
        path: asset.path,
        status: asset.status,
        ...(asset.table ? { table: asset.table } : {}),
      }));
    return {
      ok: true,
      hits,
      role: session.role,
      notice: "搜索只用于发现资产，不授予读取正文或查询数据的权限。",
    };
  }

  async readAsset(sessionId: string, input: { asset_id?: string; body_offset?: number; body_limit?: number; expected_content_hash?: string }, signal?: AbortSignal): Promise<ToolResult> {
    const cancelled = await this.gate(sessionId, signal);
    if (cancelled) return cancelled;
    const decision = this.authorizeRead(sessionId, input.asset_id ?? "");
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

  async readAssets(sessionId: string, input: { asset_ids?: string[]; offset?: number; limit?: number }, signal?: AbortSignal): Promise<ToolResult> {
    const cancelled = await this.gate(sessionId, signal);
    if (cancelled) return cancelled;
    const ids = input.asset_ids ?? [];
    const offset = Number.isInteger(input.offset) && (input.offset ?? 0) > 0 ? (input.offset as number) : 0;
    const limit = Number.isInteger(input.limit) && (input.limit ?? 0) >= 0 ? (input.limit as number) : ids.length;
    const page = ids.slice(offset, offset + limit);
    const results = [];
    for (const assetId of page) {
      const result = await this.readAsset(sessionId, { asset_id: assetId }, signal);
      results.push({ ...result, asset_id: assetId });
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
        total: ids.length,
        notice: "批量读取逐个授权。成功读取不会创建查询绑定。",
      };
    }
    return {
      ok: true,
      results,
      offset,
      limit,
      total: ids.length,
      notice: "批量读取逐个授权；每项返回正文首页，后续使用 read_asset 和内容哈希续读。成功读取不会创建查询绑定。",
    };
  }

  async readDataContractView(sessionId: string, input: { asset_id?: string }, signal?: AbortSignal): Promise<ToolResult> {
    const cancelled = await this.gate(sessionId, signal);
    if (cancelled) return cancelled;
    const decision = this.authorizeRead(sessionId, input.asset_id ?? "");
    if (!decision.ok) return { ...decision, asset_id: input.asset_id ?? "" };
    const asset = decision.asset;
    if (asset.kind !== "data_contract" || !asset.contract) {
      return fail("missing_data_contract", "这个资产没有数据契约", { asset_id: asset.asset_id });
    }
    const contract = asset.contract;
    const session = this.ctx.sessions.require(sessionId);
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
    this.ctx.sessions.save(session);
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
      columns: contract.columns.map((column) => ({
        name: column.name,
        type: column.type,
        unit: column.unit ?? null,
        description: column.description,
        sensitive: contract.sensitive_columns.includes(column.name),
        nullable: column.nullable === true,
        null_means: column.null_means ?? null,
        zero_means: column.zero_means ?? null,
      })),
      freshness: contract.freshness,
      valid_until: contract.valid_until,
      simulated: true,
      notice: queryable ? "服务端已记录当前契约绑定。模型提交的资产 ID 本身不是授权。" : "契约已读取，但不能用于查询。",
    };
  }

  async query(sessionId: string, input: { sql?: string; purpose?: string }, signal?: AbortSignal): Promise<ToolResult> {
    const cancelled = await this.gate(sessionId, signal);
    if (cancelled) return cancelled;
    const session = this.ctx.sessions.require(sessionId);
    const sql = input.sql ?? "";
    let guarded;
    try {
      const parsed = parseReadonlySql(sql);
      const rules = parsed.tables.map((table) => this.ruleFor(session.session_id, session.role, table));
      guarded = guardSql(sql, rules, this.ctx.businessEngine === "clickhouse" ? "clickhouse" : "sqlite");
    } catch (error) {
      if (error instanceof SqlRejected) return fail(error.code, error.message);
      throw error;
    }
    const bindings = guarded.tables.map((table) => this.queryableBinding(session.session_id, table));
    const timezones = new Set(bindings.map((binding) => binding.timezone));
    if (timezones.size !== 1) return fail("timezone_conflict", "一张查询里的契约时区不一致");
    const revisions = new Set(bindings.map((binding) => binding.registry_revision));
    if (revisions.size !== 1 || !revisions.has(this.ctx.knowledge.registry_revision)) {
      return fail("stale_data_contract_binding", "契约绑定不是当前目录修订");
    }
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
    }
    try {
      const grains = new Map(guarded.tables.map((table) => [table, tableGrain(this.ctx.knowledge, table)]));
      assertJoinKeys(sql, this.ctx.knowledge.joins, grains);
    } catch (error) {
      if (error instanceof SqlRejected) return fail(error.code, error.message);
      throw error;
    }
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
      if (!contract?.series && contract?.must_filter.length === 0) continue;
      const tableState = published.tables[table];
      if (!tableState) return fail("freshness_table_missing", `${table} 不在已发布新鲜度里。`);
      if (tableState.status === "probe_failed") return fail("freshness_probe_failed", `${table} 的离线探测失败，不能当成可查询事实。`);
      if (tableState.status !== "fresh") return fail("freshness_not_fresh", `${table} 的已发布状态是 ${tableState.status}。`);
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
    const started = Date.now();
    try {
      rows = await this.executeGuarded(guarded.sql, signal);
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
      coverage = await this.coverageForTables(guarded.sql, guarded.tables, guarded.time_range, bindings, signal);
    } catch {
      if (signal?.aborted) return fail("query_cancelled", "查询已取消");
      return fail("coverage_query_failed", "覆盖统计无法完成，查询结果没有保存。");
    }
    // Coverage can itself be a separate database query. It must be included in
    // the freshness interval, rather than checking only the first SELECT.
    const afterCoverage = await this.currentFreshness();
    if (!afterCoverage.ok) return afterCoverage;
    if (!afterCoverage.publication || afterCoverage.publication.publication_id !== published.publication_id || afterCoverage.publication.version !== freshnessVersion) {
      return fail("freshness_version_changed", "覆盖统计期间新鲜度发布变了，这次没有留下可引用结果。");
    }
    const total = rows.length;
    let returned = rows;
    let truncated = false;
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
    const resource: QueryResource = {
      resource_id: newId("res"),
      session_id: session.session_id,
      kind: "query_result",
      created_at: new Date().toISOString(),
      ...(session.active_job_id ? { job_id: session.active_job_id } : {}),
      engine: this.ctx.businessEngine === "clickhouse" ? "clickhouse-local" : "sqlite-local",
      elapsed_ms: elapsedMs,
      simulated: true,
      sql: guarded.sql,
      tables: guarded.tables,
      contract_revisions: Object.fromEntries(bindings.map((binding) => [binding.table, binding.contract_revision])),
      asset_hashes: Object.fromEntries(bindings.map((binding) => [binding.asset_id, binding.content_hash])),
      registry_revision: this.ctx.knowledge.registry_revision,
      receipt_ids: bindings.map((binding) => binding.receipt_id),
      time_range: { ...guarded.time_range, timezone },
      freshness: bindings.map((binding) => binding.freshness),
      truncated,
      total_rows: total,
      returned_rows: returned.length,
      complete_population: !truncated,
      value_semantics: { null: "missing", zero: "observed_zero", predicted_flag: "is_predicted" },
      columns: returned[0] ? Object.keys(returned[0]) : guarded.columns,
      rows: returned,
      coverage,
      freshness_receipts: freshnessReceipts,
    };
    this.ctx.sessions.saveResource(resource);
    return {
      ok: true,
      resource_id: resource.resource_id,
      sql: resource.sql,
      tables: resource.tables,
      contract_revisions: resource.contract_revisions,
      asset_hashes: resource.asset_hashes,
      purpose: input.purpose ?? "",
      time_range: resource.time_range,
      timezone: resource.time_range.timezone,
      freshness: resource.freshness,
      truncated: resource.truncated,
      total_rows: resource.total_rows,
      returned_rows: resource.returned_rows,
      complete_population: resource.complete_population,
      value_semantics: resource.value_semantics,
      simulated: true,
      engine: resource.engine,
      elapsed_ms: resource.elapsed_ms,
      rows: resource.rows,
      coverage: resource.coverage,
      freshness_receipts: resource.freshness_receipts,
      notice: truncated ? `结果已截断，不能当作完整总体。resource_id=${resource.resource_id}` : `结果来自本地合成 ${resource.engine}。resource_id=${resource.resource_id}`,
    };
  }

  async calculateSessionCells(
    sessionId: string,
    input: { resource_id?: string; operations?: CellOperation[] },
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const cancelled = await this.gate(sessionId, signal);
    if (cancelled) return cancelled;
    const found = this.ctx.sessions.lookupResource(sessionId, input.resource_id ?? "");
    if (!found.ok) return fail(found.code, found.message);
    if (found.resource.kind !== "query_result") return fail("resource_not_calculable", "只能计算查询结果资源");
    const source = found.resource;
    const activeJob = this.ctx.sessions.require(sessionId).active_job_id;
    if (activeJob && source.job_id !== activeJob) return fail("resource_from_other_execution", "只能计算当前任务的查询结果；请重新查询并复核契约与新鲜度。");
    const cells: Record<string, number> = {};
    const notes: string[] = [];
    const operations: Record<string, CellOperation> = Object.create(null) as Record<string, CellOperation>;
    for (const operation of input.operations ?? []) {
      if (!operation.as || Object.hasOwn(operations, operation.as)) return fail("duplicate_cell", "计算单元格名称必须非空且不重复。");
      operations[operation.as] = { ...operation };
      Object.defineProperty(cells, operation.as, { value: computeCell(source, operation, notes), enumerable: true, configurable: true, writable: true });
    }
    const resource: CalculationResource = {
      resource_id: newId("res"),
      session_id: sessionId,
      kind: "calculation",
      created_at: new Date().toISOString(),
      ...(sessionId && this.ctx.sessions.require(sessionId).active_job_id ? { job_id: this.ctx.sessions.require(sessionId).active_job_id } : {}),
      source_resource_id: source.resource_id,
      cells,
      operations,
      input_truncated: source.truncated,
      complete_population: source.complete_population && !source.truncated,
      null_means: "missing",
      zero_means: "observed_zero",
      predicted_means: "forecast_not_actual",
      notes,
    };
    this.ctx.sessions.saveResource(resource);
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

  async readSessionResource(sessionId: string, input: { resource_id?: string; row_offset?: number; row_limit?: number; columns?: string[]; expected_resource_hash?: string }, signal?: AbortSignal): Promise<ToolResult> {
    const cancelled = await this.gate(sessionId, signal);
    if (cancelled) return cancelled;
    const found = this.ctx.sessions.lookupResource(sessionId, input.resource_id ?? "");
    if (!found.ok) return fail(found.code, found.message);
    const hash = createHash("sha256").update(JSON.stringify(found.resource)).digest("hex");
    const offset = input.row_offset ?? 0;
    const limit = input.row_limit ?? 50;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) return fail("invalid_resource_page", "行偏移须为非负整数，每页限 1 到 100 行。");
    if ((offset > 0 && !input.expected_resource_hash) || (input.expected_resource_hash && input.expected_resource_hash !== hash)) return fail("resource_version_changed", "续读须携带首页的资源哈希，资源变化后请从头读取。");
    if (found.resource.kind !== "query_result") {
      if (offset !== 0 || input.columns) return fail("invalid_resource_page", "计算资源没有可分页的表格行。");
      return { ok: true, resource: found.resource, resource_hash: hash, has_more: false, resource_truncated: found.resource.input_truncated };
    }
    const source = found.resource;
    if (offset > source.rows.length) return fail("invalid_resource_page", "行偏移超出已保存的结果。");
    const columns = input.columns ?? source.columns;
    if (!Array.isArray(columns) || columns.some((column) => typeof column !== "string" || !source.columns.includes(column)) || new Set(columns).size !== columns.length) return fail("invalid_resource_columns", "只能选择资源中已有且不重复的列。");
    const rows = source.rows.slice(offset, offset + limit).map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
    const next = offset + rows.length;
    return {
      ok: true,
      resource: { ...source, columns, rows },
      resource_hash: hash,
      row_offset: offset,
      row_limit: limit,
      has_more: next < source.rows.length,
      next_row_offset: next < source.rows.length ? next : null,
      resource_truncated: source.truncated,
      notice: "has_more 仅表示已保存资源还有页面；resource_truncated 表示源查询结果不完整。历史资源可回读，但不能当作当前任务的证据。",
    };
  }

  async updateAnalysis(sessionId: string, input: AnalysisInput, signal?: AbortSignal): Promise<ToolResult> {
    const cancelled = await this.gate(sessionId, signal);
    if (cancelled) return cancelled;
    const session = this.ctx.sessions.require(sessionId);
    const jobId = session.active_job_id ?? "";
    const citations: AnalysisRecord["citations"] = [];
    const sources: AnalysisRecord["sources"] = [];
    const calculations: AnalysisRecord["calculations"] = [];
    const reasons: string[] = [];
    const resources: SessionResource[] = [];
    for (const resourceId of input.resource_ids ?? []) {
      const found = this.ctx.sessions.lookupResource(sessionId, resourceId);
      if (!found.ok) {
        reasons.push(found.code);
        continue;
      }
      if (jobId && found.resource.job_id !== jobId) {
        reasons.push("resource_from_other_execution");
        continue;
      }
      if (found.resource.kind === "calculation" && jobId) {
        const source = this.ctx.sessions.lookupResource(sessionId, found.resource.source_resource_id);
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
          tables: found.resource.tables,
          contract_revisions: found.resource.contract_revisions,
          asset_hashes: found.resource.asset_hashes,
          time_range: found.resource.time_range,
          freshness: found.resource.freshness,
          truncated: found.resource.truncated,
          total_rows: found.resource.total_rows,
          returned_rows: found.resource.returned_rows,
          complete_population: found.resource.complete_population,
          simulated: true,
          engine: found.resource.engine,
          rows: found.resource.rows,
          coverage: found.resource.coverage ?? unknownCoverage("资源没有覆盖回执，覆盖情况未知。"),
          freshness_receipts: found.resource.freshness_receipts ?? [],
        });
      }
    }
    const claimsNumbers = input.suggested_status === "completed" || input.suggested_status === "partial";
    const verifiedQueries = sources.filter((source) => source.sql && source.freshness_receipts.length > 0);
    if (claimsNumbers && !input.clarification_question && verifiedQueries.length === 0) {
      const attempt = this.nextRevision(sessionId, jobId);
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
    for (const source of sources) {
      const original = resources.find((item): item is QueryResource => item.kind === "query_result" && item.resource_id === source.resource_id);
      const asset = original && original.tables.length === 1 ? this.ctx.knowledge.contract_by_table.get(original.tables[0] ?? "") : undefined;
      const contract = asset?.contract;
      const currentContract = Boolean(original && asset && contract && original.registry_revision === this.ctx.knowledge.registry_revision && original.contract_revisions[contract.table] === contract.revision && original.asset_hashes[asset.asset_id] === asset.content_hash && canQueryTable(this.ctx.knowledge, session.role, contract.table) && !contractValidity(contract, currentCalendarDate(this.ctx.config, contract.timezone)));
      const currentFresh = Boolean(liveFreshness && liveFreshness.valid_until >= currentCalendarDate(this.ctx.config, this.ctx.knowledge.timezone) && source.freshness_receipts.length === source.tables.length && source.tables.every((table) => source.freshness_receipts.some((receipt) => receipt.table === table)) && source.freshness_receipts.every((receipt) => receipt.publication_id === liveFreshness.publication_id && receipt.version === liveFreshness.version && liveFreshness.tables[receipt.table]?.status === "fresh"));
      const shape = original && contract && verifyCell(original, contract, { op: "count_rows", as: "internal" }, original.rows.length);
      source.evidence_eligible = Boolean(currentContract && currentFresh && shape && !source.truncated && source.complete_population);
      if (source.evidence_eligible) eligible.add(source.resource_id);
      else {
        if (!currentFresh) reasons.push("freshness_version_changed");
        if (!currentContract) reasons.push("contract_or_authorization_changed");
        if (source.truncated || !source.complete_population) reasons.push("truncated_result_is_not_population");
        if (!shape && currentContract) reasons.push("query_lineage_unsupported");
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
    const verified: VerifiedCell[] = [];
    const verifiedByCalculation = new Map<string, Map<string, VerifiedCell>>();
    for (const resource of resources) {
      if (resource.kind !== "calculation") continue;
      const original = resources.find((item): item is QueryResource => item.kind === "query_result" && item.resource_id === resource.source_resource_id);
      const asset = original && original.tables.length === 1 ? this.ctx.knowledge.contract_by_table.get(original.tables[0] ?? "") : undefined;
      const contract = asset?.contract;
      const accepted: VerifiedCell[] = [];
      if (original && contract && eligible.has(original.resource_id) && resource.operations) {
        for (const [name, operation] of Object.entries(resource.operations)) {
          const cell = verifyCell(original, contract, operation, resource.cells[name] ?? Number.NaN);
          if (cell) {
            accepted.push(cell); verified.push(cell);
            const cells = verifiedByCalculation.get(resource.resource_id) ?? new Map<string, VerifiedCell>();
            cells.set(name, cell);
            verifiedByCalculation.set(resource.resource_id, cells);
          }
          else reasons.push("calculation_lineage_unsupported");
        }
      } else reasons.push("calculation_lineage_unsupported");
      const cells = Object.fromEntries(accepted.map((cell, index) => [`cell_${index + 1}`, cell.value]));
      calculations.push({ resource_id: resource.resource_id, source_resource_id: resource.source_resource_id, cells, verified_cells: accepted, input_truncated: resource.input_truncated, complete_population: resource.complete_population });
    }
    const comparisons: VerifiedComparison[] = [];
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
      if (comparison) comparisons.push(comparison);
      else reasons.push("comparison_unverifiable");
    }
    if (input.comparisons && input.comparisons.length > 20) reasons.push("comparison_unverifiable");
    if (reasons.includes("comparison_unverifiable") && status === "completed") status = "partial";
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
    if (input.findings?.length || input.limitations?.length) limitations.push("模型提供的标签、分组、单位、状态和自由文字未作为事实采用；数值与范围由服务端元数据生成。");
    if (reasons.includes("calculation_lineage_unsupported") || reasons.includes("query_lineage_unsupported")) limitations.push("部分表达式或计算缺少可证明的血缘，没有作为已验证数值展示。");
    if (reasons.includes("comparison_unverifiable")) limitations.push("部分比较的范围、覆盖、单位、预测状态或整数精度无法证明，没有展示比较结果。");
    if (reasons.includes("floating_point_approximate")) limitations.push("浮点字段及其派生值仅是近似数，尚未实现可验证的精确十进制金额计算。");
    if (reasons.includes("coverage_unknown")) limitations.push("预期覆盖范围无法确定，覆盖情况未知。");
    if (reasons.includes("freshness_version_changed")) limitations.push("新鲜度发布版本已变化或失效，受影响的数值没有作为已验证事实展示。");
    if (reasons.includes("truncated_result_is_not_population")) limitations.push("结果已截断，不能代表完整总体，受影响的数值没有作为已验证事实展示。");
    if (reasons.includes("missing_values_disclosed")) limitations.push("NULL 是缺失，没有当作零。");
    if (reasons.includes("true_zeros_disclosed")) limitations.push("结果包含数值为零的行；预测状态按契约单独标示。");
    if (reasons.includes("predicted_values_disclosed")) limitations.push("预测值和实际值分开列出。");
    limitations.push("数据来自本地合成库，不是生产数据。");
    const derivedLines = [...renderDerivedAndGroups(verified, resources, this.ctx.knowledge), ...comparisons.map(renderComparison)];
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
      sources,
      calculations,
      comparisons,
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

  private nextRevision(sessionId: string, jobId: string): number | "lost" {
    const persisted = this.ctx.sessions.consumeRevision(jobId);
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
      return clickHouseQuery(this.ctx.clickhouse, sql, signal);
    }
    return plainRows(this.ctx.db.prepare(sql).all());
  }

  private async seriesRows(contract: DataContract, equalities: Record<string, string>, timeRange: { start: string; end: string }, signal?: AbortSignal) {
    if (this.ctx.businessEngine === "clickhouse") {
      const series = contract.series;
      if (!series) return [];
      const names = [...new Set([series.date_column, ...series.dimensions, ...series.metrics, ...(series.predicted_column ? [series.predicted_column] : [])])];
      if (!this.ctx.clickhouse || names.some((name) => !/^[a-z_][a-z0-9_]*$/u.test(name))) return [];
      const filters = Object.entries(equalities)
        .filter(([column, value]) => /^[a-z_][a-z0-9_]*$/u.test(column) && /^[A-Za-z0-9_-]+$/u.test(value))
        .map(([column, value]) => ` AND ${column} = '${value}'`)
        .join("");
      const sql = `SELECT ${names.join(", ")} FROM ${contract.table} WHERE ${series.date_column} >= '${timeRange.start}' AND ${series.date_column} <= '${timeRange.end}'${filters}`;
      return clickHouseQuery(this.ctx.clickhouse, sql, signal);
    }
    return readSeriesRows(this.ctx.db, contract, equalities, timeRange);
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
      const applicable = provenCoverageFilters(sql, contract, timeRange);
      if (!applicable) return { table, report: unknownCoverage("覆盖统计无法证明与查询筛选完全一致。") };
      const permitted = new Set(bindings.find((binding) => binding.table === table)?.allowed_columns ?? []);
      const needed = [contract.series.date_column, ...contract.series.dimensions, ...contract.series.metrics, ...(contract.series.predicted_column ? [contract.series.predicted_column] : [])];
      if (needed.some((column) => !permitted.has(column))) return { table, report: unknownCoverage("覆盖统计需要未授权字段，未读取这些字段。") };
      return { table, report: assessCoverage(contract, applicable, timeRange, await this.seriesRows(contract, applicable, timeRange, signal)) };
    }));
    return combineCoverage(parts);
  }

  private authorizeRead(sessionId: string, assetId: string): { ok: true; asset: KnowledgeBase["assets"][number] } | ToolFailure {
    const session = this.ctx.sessions.require(sessionId);
    const asset = this.ctx.knowledge.by_id.get(assetId);
    if (!asset) return fail("asset_not_found", "没有这个资产", { asset_id: assetId });
    if (asset.status !== "published") return fail("asset_not_published", "资产尚未发布", { asset_id: assetId });
    if (!canRead(this.ctx.knowledge, session.role, assetId)) {
      return fail("asset_not_authorized", "当前角色不能读取这个资产", { asset_id: assetId });
    }
    return { ok: true, asset };
  }

  private ruleFor(sessionId: string, role: string, table: string): TableRule {
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
    if (!canQueryTable(this.ctx.knowledge, role, table)) throw new SqlRejected("table_not_authorized", `当前角色不能查询 ${table}`);
    const session = this.ctx.sessions.require(sessionId);
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
    };
  }

  private queryableBinding(sessionId: string, table: string): ContractBinding {
    const binding = this.ctx.sessions.require(sessionId).bindings.find((item) => item.table === table && item.queryable);
    if (!binding) throw new SqlRejected("missing_data_contract_evidence", `${table} 没有可查询绑定`);
    return binding;
  }

  private async gate(sessionId: string, signal?: AbortSignal): Promise<ToolFailure | undefined> {
    // Let timers and cancellation run between tools. This does not make an
    // individual synchronous MySQL bridge call non-blocking.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (signal?.aborted) return fail("tool_cancelled", "工具已取消");
    const delay = this.ctx.config.toolDelayMs;
    if (delay > 0) {
      const aborted = await delayUnlessAborted(delay, signal);
      if (aborted) return fail("tool_cancelled", "工具已取消");
    }
    this.ctx.sessions.require(sessionId);
    return undefined;
  }

  private async currentFreshness(): Promise<{ ok: true; publication: FreshnessPublication | null } | ToolFailure> {
    if (this.ctx.config.stateMode !== "mysql") return { ok: true, publication: readPublication(this.ctx.config.freshnessPath) };
    try {
      const store = await this.ctx.mysqlFreshness?.();
      if (!store) return fail("freshness_authority_unavailable", "MySQL 新鲜度权威状态不可用，不能回退本机文件。");
      const current = await store.current();
      if (!current) return { ok: true, publication: null };
      if (!matchesFreshnessManifest(current.manifest, freshnessManifest(this.ctx.knowledge, this.ctx.config.freshnessTargetsPath))) return fail("freshness_manifest_changed", "已发布新鲜度与当前契约或探测目标不一致，需要重新探测。");
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
}

function renderComparison(comparison: VerifiedComparison): string {
  const { left, right, difference, change_percent } = comparison;
  const scope = (cell: VerifiedCell) => `${Object.entries(cell.filters).map(([key, value]) => `${key}=${value}`).join("，")}；${cell.range.start} 到 ${cell.range.end}（${cell.range.timezone}）；来源 ${cell.sourceResourceId}`;
  return `${left.source.table}.${left.source.column} 比较：${left.source.value}（${scope(left.source)}）减 ${right.source.value}（${scope(right.source)}）= ${difference} ${left.source.unit}；${change_percent === null ? "基准为零，变化率不可计算" : `相对基准变化 ${change_percent}%（四舍五入到小数点后两位）`}；${left.source.prediction}。`;
}

function computeCell(source: QueryResource, operation: CellOperation, notes: string[]): number {
  if (operation.op === "count_rows") return source.rows.length;
  const column = operation.column ?? "";
  if (!source.columns.includes(column) && source.rows.some((row) => !(column in row))) {
    notes.push(`${column} 不在结果中`);
  }
  const rows = source.rows.filter((row) => matchesPredicted(row, operation.predicted ?? "any", notes));
  if (operation.op === "count_null") return rows.filter((row) => row[column] === null || row[column] === undefined).length;
  if (operation.op === "count_zero") return rows.filter((row) => row[column] === 0).length;
  return rows.reduce((total, row) => {
    const value = row[column];
    if (value === null || value === undefined) return total;
    return total + Number(value);
  }, 0);
}

function matchesPredicted(row: Record<string, unknown>, predicted: "actual_only" | "predicted_only" | "any", notes: string[]): boolean {
  if (predicted === "any") return true;
  if (!("is_predicted" in row)) {
    if (predicted === "predicted_only") {
      notes.push("结果没有预测标记，预测合计按 0 处理。");
      return false;
    }
    return true;
  }
  const flag = Number(row.is_predicted);
  return predicted === "predicted_only" ? flag === 1 : flag !== 1;
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
  if (!cells.length && sources.length) lines.push("没有可证明血缘的计算数值。");
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
      const calc = resources.find((item): item is CalculationResource => item.kind === "calculation" && item.source_resource_id === id && Object.values(item.operations ?? {}).some((op) => op.op === "sum" && op.column === cell.column && (op.predicted ?? "any") === cell.predictionFilter));
      const op = calc && Object.values(calc.operations ?? {}).find((item) => item.op === "sum" && item.column === cell.column && (item.predicted ?? "any") === cell.predictionFilter);
      if (!op || !cell.column) continue;
      for (const dimension of contract.series.dimensions) {
        if (Object.hasOwn(cell.filters, dimension) || !source.columns.includes(dimension)) continue;
        if (source.rows.some((row) => typeof row[dimension] !== "string")) continue;
        const values = [...new Set(source.rows.map((row) => row[dimension] as string))];
        if (values.length < 2) continue;
        const parts: string[] = [];
        for (const value of values) {
          const subset = source.rows.filter((row) => row[dimension] === value);
          const mapping = contract.series.prediction_values;
          const flag = contract.series.predicted_column;
          const selected = flag && mapping && op.predicted === "actual_only" ? subset.filter((row) => Number(row[flag]) === mapping.actual) : flag && mapping && op.predicted === "predicted_only" ? subset.filter((row) => Number(row[flag]) === mapping.predicted) : subset;
          const numbers = selected.map((row) => row[cell.column!]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
          if (!numbers.length) continue;
          const total = numbers.reduce((a, b) => a + b, 0);
          if (!verifyCell({ ...source, rows: subset }, contract, op, total)) continue;
          parts.push(`${value}=${formatNumber(total)}`);
        }
        if (parts.length) lines.push(`${cell.table}.${cell.column} 按 ${dimension} 分组：${parts.join("，")}${cell.precision === "floating_point_approximate" ? "（浮点近似）" : ""}；单位 ${cell.unit}；${cell.prediction}；其他筛选 ${Object.entries(cell.filters).map(([key, value]) => `${key}=${value}`).join("，") || "无"}；${cell.range.start} 到 ${cell.range.end}（${cell.range.timezone}）；来源 ${id}。NULL 与无记录没有补零。`);
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

function readSeriesRows(
  db: ToolContext["db"],
  contract: DataContract,
  equalities: Record<string, string>,
  timeRange: { start: string; end: string },
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

