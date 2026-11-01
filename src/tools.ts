import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { assessCoverage, combineCoverage, coverageHasGap, unknownCoverage } from "./coverage.js";
import { plainRows } from "./database.js";
import { readPublication } from "./freshness.js";
import { canQueryTable, canRead, contractExpired, tableGrain } from "./knowledge.js";
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
}

type ToolResult = ToolFailure | { ok: true; [key: string]: unknown };

export class ToolService {
  private readonly assetBytesRead = new Map<string, number>();

  constructor(private readonly ctx: ToolContext) {}

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
        const haystack = [asset.asset_id, asset.kind, asset.title, asset.summary, asset.table ?? ""].join("\n").toLowerCase();
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

  async readAsset(sessionId: string, input: { asset_id?: string }, signal?: AbortSignal): Promise<ToolResult> {
    const cancelled = await this.gate(sessionId, signal);
    if (cancelled) return cancelled;
    const decision = this.authorizeRead(sessionId, input.asset_id ?? "");
    if (!decision.ok) return decision;
    const used = this.assetBytesRead.get(sessionId) ?? 0;
    const bodyBytes = Buffer.byteLength(decision.asset.body);
    if (used + bodyBytes > this.ctx.config.maxAssetReadBytes) {
      return fail("asset_read_budget_exceeded", "本次会话的知识正文读取超过上限。正文不会返回，也不能据此形成正式结论。", { asset_id: decision.asset.asset_id });
    }
    this.assetBytesRead.set(sessionId, used + bodyBytes);
    return {
      ok: true,
      asset_id: decision.asset.asset_id,
      kind: decision.asset.kind,
      revision: decision.asset.revision,
      title: decision.asset.title,
      body: decision.asset.body,
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
    let used = this.assetBytesRead.get(sessionId) ?? 0;
    for (const assetId of page) {
      const decision = this.authorizeRead(sessionId, assetId);
      if (!decision.ok) {
        results.push({ ok: false as const, asset_id: assetId, code: decision.code, message: decision.message });
        continue;
      }
      const bodyBytes = Buffer.byteLength(decision.asset.body);
      if (used + bodyBytes > this.ctx.config.maxAssetReadBytes) {
        results.push({
          ok: false as const,
          asset_id: assetId,
          code: "asset_read_budget_exceeded",
          message: "本次会话的知识正文读取超过上限。正文不会返回，也不能据此形成正式结论。",
        });
        continue;
      }
      used += bodyBytes;
      results.push({
        ok: true as const,
        asset_id: decision.asset.asset_id,
        kind: decision.asset.kind,
        revision: decision.asset.revision,
        title: decision.asset.title,
        body: decision.asset.body,
      });
    }
    this.assetBytesRead.set(sessionId, used);
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
      notice: "批量读取逐个授权。成功读取不会创建查询绑定。",
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
    const expired = contractExpired(contract, this.ctx.config.simulatedToday);
    const allowed = canQueryTable(this.ctx.knowledge, session.role, contract.table);
    const queryable = !expired && allowed;
    const denyReason = expired ? "expired_contract" : !allowed ? "table_not_authorized" : undefined;
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
      columns: contract.columns.map((column) => ({
        name: column.name,
        type: column.type,
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
    const published = readPublication(this.ctx.config.freshnessPath);
    if (!published) return fail("freshness_not_published", "没有已发布的新鲜度。查询不会用数据库连通或最大日期代替发布状态。");
    if (published.valid_until < this.ctx.config.simulatedToday) {
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
      return fail("query_execution_failed", message);
    }
    const elapsedMs = Date.now() - started;
    const after = readPublication(this.ctx.config.freshnessPath);
    if (!after || after.publication_id !== published.publication_id || after.version !== freshnessVersion) {
      return fail("freshness_version_changed", "查询执行期间新鲜度发布变了，这次没有留下可引用结果。");
    }
    const coverage = await this.coverageForTables(guarded.tables, guarded.equalities, guarded.time_range);
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
    const cells: Record<string, number> = {};
    const notes: string[] = [];
    for (const operation of input.operations ?? []) {
      cells[operation.as] = computeCell(source, operation, notes);
    }
    const resource: CalculationResource = {
      resource_id: newId("res"),
      session_id: sessionId,
      kind: "calculation",
      created_at: new Date().toISOString(),
      ...(sessionId && this.ctx.sessions.require(sessionId).active_job_id ? { job_id: this.ctx.sessions.require(sessionId).active_job_id } : {}),
      source_resource_id: source.resource_id,
      cells,
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

  async readSessionResource(sessionId: string, input: { resource_id?: string }, signal?: AbortSignal): Promise<ToolResult> {
    const cancelled = await this.gate(sessionId, signal);
    if (cancelled) return cancelled;
    const found = this.ctx.sessions.lookupResource(sessionId, input.resource_id ?? "");
    if (!found.ok) return fail(found.code, found.message);
    return { ok: true, resource: found.resource };
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
      if (found.resource.job_id && jobId && found.resource.job_id !== jobId) {
        reasons.push("resource_from_other_execution");
        continue;
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
      } else {
        calculations.push({
          resource_id: found.resource.resource_id,
          source_resource_id: found.resource.source_resource_id,
          cells: found.resource.cells,
          input_truncated: found.resource.input_truncated,
          complete_population: found.resource.complete_population,
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
    const cells = Object.assign({}, ...calculations.map((item) => item.cells)) as Record<string, number>;
    let status: AnalysisStatus = input.suggested_status;
    if (input.clarification_question) {
      status = "needs_clarification";
      reasons.push("clarification_requested");
    }
    if ((status === "completed" || status === "partial") && sources.length === 0) {
      status = input.clarification_question ? "needs_clarification" : "failed";
      reasons.push("insufficient_evidence");
    }
    const missing = (cells.new_users_missing ?? 0) + (cells.revenue_missing ?? 0) + (cells.spend_missing ?? 0);
    if (missing > 0) reasons.push("missing_values_disclosed");
    if ((cells.revenue_predicted ?? 0) > 0 || (cells.predicted_payback ?? 0) > 0) reasons.push("predicted_values_disclosed");
    if ((cells.new_users_zero ?? 0) + (cells.revenue_zero ?? 0) + (cells.spend_zero ?? 0) > 0) reasons.push("true_zeros_disclosed");
    if (status === "completed" && (sources.some((source) => source.truncated) || calculations.some((item) => item.input_truncated))) {
      status = "partial";
      reasons.push("truncated_result_is_not_population");
    }
    const liveFreshness = readPublication(this.ctx.config.freshnessPath);
    for (const source of sources) {
      if (!source.coverage || source.coverage.status === "unknown") {
        if (status === "completed") status = "partial";
        reasons.push("coverage_unknown");
      } else if (coverageHasGap(source.coverage)) {
        if (status === "completed") status = "partial";
        reasons.push("completeness_gap");
      }
      for (const receipt of source.freshness_receipts) {
        if (!liveFreshness || liveFreshness.publication_id !== receipt.publication_id || liveFreshness.version !== receipt.version) {
          if (status === "completed") status = "partial";
          reasons.push("freshness_version_changed");
        }
      }
    }
    if (input.suggested_status === "completed" && status !== "completed") reasons.push("model_completion_was_not_authoritative");
    if (input.suggested_status === "failed" && sources.length === 0 && !input.clarification_question) {
      status = "failed";
      reasons.push("no_authorized_result");
    }
    const verifiedFindingLines: string[] = [];
    for (const finding of input.findings ?? []) {
      const matched = resources.find((item) => item.resource_id === finding.resource_id);
      const cells = matched && matched.kind === "calculation" ? matched.cells : null;
      const cited = Boolean(finding.cell && cells && Object.prototype.hasOwnProperty.call(cells, finding.cell) && finding.value !== null && Number(cells[finding.cell]) === finding.value);
      const source = matched && matched.kind === "calculation" ? this.ctx.sessions.lookupResource(sessionId, matched.source_resource_id) : { ok: false as const, code: "resource_not_found", message: "" };
      const aligned = cited && source.ok && source.resource.kind === "query_result"
        && (!source.resource.job_id || !jobId || source.resource.job_id === jobId)
        && (!finding.time_range || (finding.time_range.start === source.resource.time_range.start && finding.time_range.end === source.resource.time_range.end))
        && (!finding.group || Object.entries(finding.group).every(([key, value]) => source.resource.kind === "query_result" && source.resource.rows.some((row) => String(row[key]) === value)));
      if (!aligned) {
        reasons.push("unverified_finding");
        continue;
      }
      if (source.ok && source.resource.kind === "query_result" && source.resource.truncated && status === "completed") {
        status = "partial";
        reasons.push("truncated_result_is_not_population");
      }
      const group = finding.group ? Object.entries(finding.group).map(([key, value]) => `${key}=${value}`).join("，") : "";
      const range = finding.time_range ? `${finding.time_range.start} 到 ${finding.time_range.end}` : "";
      verifiedFindingLines.push(`${finding.label}${group ? `（${group}）` : ""}${range ? ` ${range}` : ""}：${finding.kind} ${finding.value}。引用计算单元格 ${finding.cell}。`);
    }
    if (reasons.includes("unverified_finding") && status === "completed") {
      status = "partial";
      reasons.push("model_completion_was_not_authoritative");
    }
    const limitations = [...(input.limitations ?? [])];
    if (missing > 0) limitations.push("值为 NULL 的记录没有当作零。");
    if (sources.some((source) => source.coverage?.absent_dates.length || source.coverage?.groups.some((group) => group.absent_dates.length))) {
      limitations.push("没有落成行的日期按无记录处理，没有补成零。");
    }
    if (reasons.includes("coverage_unknown")) limitations.push("预期覆盖范围无法确定，覆盖情况未知。");
    if (reasons.includes("freshness_version_changed")) limitations.push("查询使用的新鲜度发布版本已经变化，这些数字不能当成已验证事实。");
    if ((cells.new_users_zero ?? 0) + (cells.revenue_zero ?? 0) > 0) limitations.push("结果中的 0 是观测到的真实零。");
    if ((cells.revenue_predicted ?? 0) > 0 || (cells.predicted_payback ?? 0) > 0) limitations.push("预测值单独列出，没有计入实际收入或实际 ROI。");
    if (sources.some((source) => source.truncated)) limitations.push("结果已截断，不能代表完整总体。");
    limitations.push("数据来自本地合成库，不是生产数据。");
    const answer = [renderAnswer(status, cells, sources, input.clarification_question), ...verifiedFindingLines].filter((line) => line.length > 0).join("\n");
    const draftNumbers = input.draft_answer.match(/\d+(?:\.\d+)?/g) ?? [];
    if (draftNumbers.some((item) => !answer.includes(item))) {
      limitations.push("模型草稿里有正式答案没有引用到的数字，那些数字没有逐一验证。");
      if (status === "completed") status = "partial";
    }
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

  private async seriesRows(contract: DataContract, equalities: Record<string, string>, timeRange: { start: string; end: string }) {
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
      return clickHouseQuery(this.ctx.clickhouse, sql);
    }
    return readSeriesRows(this.ctx.db, contract, equalities, timeRange);
  }

  private async coverageForTables(
    tables: string[],
    equalities: Record<string, string>,
    timeRange: { start: string; end: string },
  ) {
    if (!timeRange.start || !timeRange.end) return unknownCoverage("没有封闭日期范围，覆盖情况未知");
    const parts = await Promise.all(tables.map(async (table) => {
      const contract = this.ctx.knowledge.contract_by_table.get(table)?.contract;
      if (!contract?.series) return { table, report: unknownCoverage(`${table} 没有声明日期序列，覆盖情况未知`) };
      const applicable: Record<string, string> = {};
      const columns = new Set(contract.columns.map((column) => column.name));
      for (const [column, value] of Object.entries(equalities)) {
        if (columns.has(column)) applicable[column] = value;
      }
      return { table, report: assessCoverage(contract, applicable, timeRange, await this.seriesRows(contract, applicable, timeRange)) };
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
    if (contractExpired(contract, this.ctx.config.simulatedToday)) throw new SqlRejected("expired_contract", `${table} 的契约已过期`);
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
    if (signal?.aborted) return fail("tool_cancelled", "工具已取消");
    const delay = this.ctx.config.toolDelayMs;
    if (delay > 0) {
      const aborted = await delayUnlessAborted(delay, signal);
      if (aborted) return fail("tool_cancelled", "工具已取消");
    }
    this.ctx.sessions.require(sessionId);
    return undefined;
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

export interface CellOperation {
  op: "sum" | "count_null" | "count_zero" | "count_rows";
  column?: string;
  predicted?: "actual_only" | "predicted_only" | "any";
  as: string;
}

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
  cells: Record<string, number>,
  sources: AnalysisRecord["sources"],
  clarification: string | undefined,
): string {
  const lines: string[] = [];
  if (status === "partial") lines.push("这个回答不完整。");
  if (status === "completed") lines.push("问题已按本会话证据回答。缺失、真实零和预测值分开列出，没有互相填补。");
  if (status === "needs_clarification") lines.push(clarification || "还需要补充问题范围。");
  if (status === "failed") lines.push(clarification || "这次没有取得可引用的查询结果。");
  if (cells.new_users_sum !== undefined) {
    lines.push(
      `新增用户合计 ${formatNumber(cells.new_users_sum)}。值为 NULL ${cells.new_users_missing ?? 0} 天，真实为零 ${cells.new_users_zero ?? 0} 天。NULL 和无记录都没有计入合计。`,
    );
  }
  if (cells.revenue_actual !== undefined) {
    lines.push(
      `广告实际收入合计 ${formatNumber(cells.revenue_actual)}。预测值合计 ${formatNumber(cells.revenue_predicted ?? 0)}，没有并入实际。值为 NULL ${cells.revenue_missing ?? 0} 天，真实为零 ${cells.revenue_zero ?? 0} 天。`,
    );
  }
  if (cells.new_users_sum_previous !== undefined && cells.new_users_sum !== undefined) {
    const current = cells.new_users_sum;
    const previous = cells.new_users_sum_previous;
    const delta = current - previous;
    const ratio = previous === 0 ? "上期合计为 0，不能计算环比比率" : `环比差额除以上期等于 ${formatNumber(delta / previous)}`;
    const incomplete = sources.some((source) => source.coverage && (source.coverage.status === "unknown" || coverageHasGap(source.coverage)));
    lines.push(
      `新增环比：本期 ${formatNumber(current)}，上一等长窗口 ${formatNumber(previous)}，差额 ${formatNumber(delta)}。${ratio}。${incomplete ? "窗口里存在无记录、NULL 或预测，差额没有用 0 填补这些天。" : ""}这是相邻窗口的观察，不是原因，也不会触发投放操作。`,
    );
  }
  if (cells.actual_spend !== undefined && cells.actual_payback === undefined) {
    lines.push(
      `实际投放成本合计 ${formatNumber(cells.actual_spend)}。值为 NULL 的成本 ${cells.spend_missing ?? 0} 天，真实零成本 ${cells.spend_zero ?? 0} 天。无记录和 NULL 都没有补成 0。`,
    );
  }
  if (cells.actual_spend !== undefined && cells.actual_payback !== undefined) {
    const spend = cells.actual_spend;
    const payback = cells.actual_payback;
    if (spend === 0) lines.push("实际投放成本合计为 0，ROI 分母为零，不能计算比率。预测回收没有拿来填充分母。");
    else lines.push(`实际 ROI = 实际回收 ${formatNumber(payback)} / 实际成本 ${formatNumber(spend)} = ${formatNumber(payback / spend)}。预测回收 ${formatNumber(cells.predicted_payback ?? 0)} 没有进入分子。成本为 NULL ${cells.spend_missing ?? 0} 天，真实零成本 ${cells.spend_zero ?? 0} 天。`);
  }
  for (const source of sources) {
    for (const group of ["channel", "channel_id", "platform", "country_code", "product_id", "title_id"]) {
      const values = new Set(source.rows.map((row) => row[group]).filter((value) => value !== undefined));
      if (values.size < 2) continue;
      const names = new Set(source.rows[0] ? Object.keys(source.rows[0]) : []);
      const metric = names.has("new_users") ? "new_users" : names.has("spend_usd") ? "spend_usd" : "";
      if (!metric) continue;
      const parts = [...values].map((value) => {
        const sum = source.rows.reduce((total, row) => {
          if (row[group] !== value) return total;
          if (metric === "spend_usd" && Number(row.is_predicted) === 1) return total;
          const amount = row[metric];
          return amount === null || amount === undefined ? total : total + Number(amount);
        }, 0);
        return `${String(value)}=${formatNumber(sum)}`;
      });
      lines.push(`${source.tables.join(",")} 按 ${group} 的观察合计：${parts.join("，")}。无记录和 NULL 没有加进去。`);
    }
    appendCoverage(lines, source);
  }
  if (sources.some((source) => source.truncated)) lines.push("查询结果已截断，上面的数字不是完整总体。");
  if (sources.length) {
    const source = sources[0];
    lines.push(
      `来源是本地合成库 ${source?.tables.join(", ")}，时间范围 ${source?.time_range.start} 到 ${source?.time_range.end}（${source?.time_range.timezone}）。`,
    );
  }
  lines.push("结论只使用本会话里可追溯的已授权资源。");
  return lines.join("\n");
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
  if (report.zero_dates.length) lines.push(`${label} 观测值为零的日期：${report.zero_dates.join("、")}。`);
  if (report.predicted_dates.length) lines.push(`${label} 预测值日期：${report.predicted_dates.join("、")}，没有当成实际值。`);
  for (const group of report.groups) {
    if (!group.absent_dates.length && !group.null_dates.length && !group.predicted_dates.length && !group.zero_dates.length) continue;
    lines.push(
      `${group.dimension}=${group.value}：无记录 ${group.absent_dates.length} 天，NULL ${group.null_dates.length} 天，真实零 ${group.zero_dates.length} 天，预测 ${group.predicted_dates.length} 天。未出现的维度组合不算缺失。`,
    );
  }
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
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

