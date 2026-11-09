// Current authorization, freshness and cancellation shared by all tools.
import { createHash } from "node:crypto";
import { verifyWideAggregateProof } from "./wide-aggregate-proof.js";
import { workingQueryCell } from "./working-query-cell.js";
import { verifyJoinResource, type JoinQueryResource } from "./join-resource-proof.js";
import { joinResultTable } from "./join-result-table.js";
import { planClickHouse } from "./clickhouse-plan.js";
import { currentCalendarDate } from "./config.js";
import { verifyDimensionObservations } from "./dimension-observation.js";
import {
  freshnessManifest,
  freshnessPeriodKey,
  matchesFreshnessManifest,
  readPublication,
  type FreshnessPublication,
} from "./freshness.js";
import {
  canQueryTable,
  canRead,
  contractValidity,
  validateKnowledgeSources,
} from "./knowledge.js";
import { ResourceGraph } from "./resource-graph.js";
import { type SessionRecord } from "./session.js";
import {
  inspectSingleSourceProjection,
  parseReadonlySql,
  SqlRejected,
  type TableRule,
} from "./sql.js";
import { fail, type ToolContext } from "./tool-context.js";
import type {
  AnalysisRecord,
  ContractBinding,
  DataContract,
  KnowledgeBase,
  QueryResource,
  SessionResource,
  ToolFailure,
} from "./types.js";

export class ToolAccess {
  private readonly ctx: ToolContext;
  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  /** A working note is not a delivery receipt. JOIN cells still need the
   * complete captured proof and the same current authority as final results. */
  async workingCell(session: SessionRecord, source: QueryResource, rowIndex: number, output: string, publication?: FreshnessPublication | null) {
    if (source.tables.length === 1) {
      const contract = this.ctx.knowledge.contract_by_table.get(source.tables[0]!)?.contract;
      const evidence = contract && this.evidenceSource(session, source);
      return evidence && contract ? workingQueryCell(evidence, contract, rowIndex, output) : null;
    }
    if (source.tables.length !== 2 || !Number.isSafeInteger(rowIndex) || rowIndex < 0 || !source.rows[rowIndex]) return null;
    if (publication === undefined) {
      const current = await this.currentFreshness();
      if (!current.ok) return null;
      publication = current.publication;
    }
    if (!publication) return null;
    const joined = verifyJoinResource(source as JoinQueryResource, session, this.ctx.knowledge, this.ctx.config, publication);
    if (!joined || !joined.plan.metrics.some((metric) => metric.output === output && metric.operation === "sum")) return null;
    const fact = this.ctx.knowledge.contract_by_table.get(joined.plan.fact)?.contract;
    const dimension = this.ctx.knowledge.contract_by_table.get(joined.plan.dimension)?.contract;
    const table = fact && dimension && joinResultTable(joined.plan, joined.values, fact, dimension);
    const column = table?.columns.find((item) => item.name === output && item.type === "decimal");
    const visible = source.rows[rowIndex]!;
    const matches = table?.rows.filter((row) => joined.plan.groups.every((group) => Object.hasOwn(visible, group.output) && visible[group.output] === row[group.output])) ?? [];
    if (!column || matches.length !== 1 || !Object.hasOwn(matches[0]!, output)) return null;
    return { field: column.label, unit: column.unit, value: matches[0]![output]! };
  }
  async gate(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<ToolFailure | undefined> {
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

  async currentFreshness(): Promise<
    { ok: true; publication: FreshnessPublication | null } | ToolFailure
  > {
    if (this.ctx.config.stateMode !== "mysql") {
      const publication = readPublication(this.ctx.config.freshnessPath);
      try {
        const clock = {
          now: new Date(),
          simulatedToday: this.ctx.config.simulatedToday,
        };
        const period = freshnessPeriodKey(
          this.ctx.config.freshnessTargetsPath,
          clock,
        );
        if (period)
          freshnessManifest(
            this.ctx.knowledge,
            this.ctx.config.freshnessTargetsPath,
            clock,
          );
        if (publication && period && publication.period_key !== period)
          return fail(
            "freshness_manifest_changed",
            "本机演示的新鲜度周期已变化，需要重新探测。",
          );
        return { ok: true, publication };
      } catch {
        return fail(
          "freshness_authority_unavailable",
          "本机演示的新鲜度周期配置无效。",
        );
      }
    }
    try {
      const store = await this.ctx.mysqlFreshness?.();
      if (!store)
        return fail(
          "freshness_authority_unavailable",
          "MySQL 新鲜度权威状态不可用，不能回退本机文件。",
        );
      const current = await store.current();
      if (!current) return { ok: true, publication: null };
      if (
        !matchesFreshnessManifest(
          current.manifest,
          freshnessManifest(
            this.ctx.knowledge,
            this.ctx.config.freshnessTargetsPath,
            {
              simulatedToday: this.ctx.config.simulatedToday,
            },
          ),
        )
      )
        return fail(
          "freshness_manifest_changed",
          "已发布新鲜度与当前契约、探测目标或业务周期不一致，需要重新探测。",
        );
      return { ok: true, publication: current };
    } catch {
      // Never fall back to the local file when the authoritative database fails.
      return fail(
        "freshness_authority_unavailable",
        "MySQL 新鲜度权威状态不可用，不能回退本机文件。",
      );
    }
  }

  async authorizeRead(
    sessionId: string,
    assetId: string,
  ): Promise<
    { ok: true; asset: KnowledgeBase["assets"][number] } | ToolFailure
  > {
    const session = await this.ctx.sessions.requireAsync(sessionId);
    const asset = this.ctx.knowledge.by_id.get(assetId);
    if (!asset)
      return fail("asset_not_found", "没有这个资产", { asset_id: assetId });
    if (asset.status !== "published")
      return fail("asset_not_published", "资产尚未发布", { asset_id: assetId });
    if (!canRead(this.ctx.knowledge, session.role, assetId)) {
      return fail("asset_not_authorized", "当前角色不能读取这个资产", {
        asset_id: assetId,
      });
    }
    if (!(await validateKnowledgeSources(this.ctx.knowledge, [assetId])))
      return fail(
        "knowledge_source_changed",
        "知识来源或权限已变化，请重新加载。",
        { asset_id: assetId },
      );
    return { ok: true, asset };
  }

  ruleFor(session: SessionRecord, table: string): TableRule {
    if (table.startsWith("sqlite_"))
      throw new SqlRejected("system_table", `系统表 ${table} 不能查询`);
    const contractAsset = this.ctx.knowledge.contract_by_table.get(table);
    if (!contractAsset?.contract) {
      if (this.ctx.knowledge.table_mentions.has(table))
        throw new SqlRejected("missing_data_contract", `${table} 没有可用契约`);
      throw new SqlRejected("unknown_table", `未知表 ${table}`);
    }
    const contract = contractAsset.contract;
    const validity = contractValidity(
      contract,
      currentCalendarDate(this.ctx.config, contract.timezone),
    );
    if (validity === "expired")
      throw new SqlRejected("expired_contract", `${table} 的契约已过期`);
    if (validity === "not_yet_valid")
      throw new SqlRejected(
        "contract_not_yet_valid",
        `${table} 的契约尚未生效`,
      );
    if (validity === "invalid")
      throw new SqlRejected(
        "invalid_contract_period",
        `${table} 的契约有效期无效`,
      );
    if (!canQueryTable(this.ctx.knowledge, session.role, table))
      throw new SqlRejected(
        "table_not_authorized",
        `当前角色不能查询 ${table}`,
      );
    const binding = session.bindings.find((item) => item.table === table);
    if (!binding)
      throw new SqlRejected(
        "missing_data_contract_evidence",
        `${table} 还没有当前契约读取记录`,
      );
    if (!binding.queryable)
      throw new SqlRejected(
        binding.deny_reason ?? "table_not_authorized",
        `${table} 的契约绑定不可查询`,
      );
    if (binding.registry_revision !== this.ctx.knowledge.registry_revision) {
      throw new SqlRejected("stale_data_contract_binding", "契约绑定已过期");
    }
    return {
      table,
      allowed_columns: binding.allowed_columns,
      sensitive_columns: binding.sensitive_columns,
      must_filter: binding.must_filter,
      column_types: Object.fromEntries(
        contract.columns.map((column) => [column.name, column.type]),
      ),
    };
  }

  queryableBinding(session: SessionRecord, table: string): ContractBinding {
    const binding = session.bindings.find(
      (item) => item.table === table && item.queryable,
    );
    if (!binding)
      throw new SqlRejected(
        "missing_data_contract_evidence",
        `${table} 没有可查询绑定`,
      );
    return binding;
  }

  /** Recheck each leaf after restart; historical resources remain readable only
   * while the current principal still has the contract and table permissions. */
  async resourceReadable(
    sessionId: string,
    resource: SessionResource,
  ): Promise<boolean> {
    const graph = new ResourceGraph(
      (id) =>
        id === resource.resource_id
          ? Promise.resolve({ ok: true as const, resource })
          : this.ctx.sessions.lookupResourceAsync(sessionId, id),
      sessionId,
      resource.job_id,
    );
    if (await graph.add(resource.resource_id)) return false;
    const session = await this.ctx.sessions.requireAsync(sessionId);
    for (const node of graph.nodes()) {
      if (node.kind !== "query_result") continue;
      if (node.registry_revision !== this.ctx.knowledge.registry_revision)
        return false;
      const ids: string[] = [];
      for (const table of node.tables) {
        const asset = this.ctx.knowledge.contract_by_table.get(table);
        const contract = asset?.contract;
        if (
          !asset ||
          !contract ||
          !canRead(this.ctx.knowledge, session.role, asset.asset_id) ||
          !canQueryTable(this.ctx.knowledge, session.role, table) ||
          contractValidity(
            contract,
            currentCalendarDate(this.ctx.config, contract.timezone),
          ) ||
          node.contract_revisions[table] !== contract.revision ||
          node.asset_hashes[asset.asset_id] !== asset.content_hash
        )
          return false;
        ids.push(asset.asset_id);
      }
      if (!(await validateKnowledgeSources(this.ctx.knowledge, ids)))
        return false;
    }
    return true;
  }

  /** Reconstruct an equivalent proof projection, never the SQL sent to ClickHouse. */
  evidenceSource(
    session: SessionRecord,
    source: QueryResource,
  ): QueryResource | null {
    try {
      if (source.engine === "clickhouse-local") {
        const contracts = source.tables.map(
          (table) => this.ctx.knowledge.contract_by_table.get(table)?.contract,
        );
        if (contracts.some((contract) => !contract)) return null;
        const plan = planClickHouse(
          source.sql,
          source.tables.map((table) => this.ruleFor(session, table)),
          contracts as DataContract[],
          this.ctx.knowledge.joins,
          this.ctx.config.clickhouseDatabase,
          this.ctx.config.maxResultRows,
        );
        if (
          source.review_plan &&
          JSON.stringify(plan.receipt) !== JSON.stringify(source.review_plan)
        )
          return null;
        if (
          plan.receipt.engine !== source.sql_review_engine ||
          plan.receipt.sql_limited !== Boolean(source.sql_limited) ||
          plan.guarded.time_range.start !== source.time_range.start ||
          plan.guarded.time_range.end !== source.time_range.end ||
          JSON.stringify(plan.guarded.time_range.selected_dates ?? null) !== JSON.stringify(source.time_range.selected_dates ?? null)
        )
          return null;
        if (plan.receipt.engine === "clickhouse_ast_join")
          return null;
        if (source.executed_sql !== source.sql &&
          (plan.receipt.engine !== "clickhouse_ast_direct" || contracts.length !== 1 || !verifyWideAggregateProof(source, contracts[0]!))) return null;
        return plan.receipt.proof_sql
          ? {
              ...source,
              sql: plan.receipt.proof_sql,
              sql_review_engine: "clickhouse_ast_direct",
            }
          : source;
      }
      const ast = parseReadonlySql(source.sql).ast;
      const from = Array.isArray(ast.from) ? ast.from : [];
      const nested = Boolean(
        ast.with ||
        from.some(
          (item) =>
            item && typeof item === "object" && "expr" in item && item.expr,
        ),
      );
      if (!nested) return source;
      if (source.executed_sql !== source.sql) return null;
      const proof = inspectSingleSourceProjection(
        source.sql,
        source.tables.map((table) => this.ruleFor(session, table)),
      );
      if (
        !proof ||
        source.tables.length !== 1 ||
        proof.table !== source.tables[0] ||
        proof.time_range.start !== source.time_range.start ||
        proof.time_range.end !== source.time_range.end
      )
        return null;
      return { ...source, sql: proof.proof_sql };
    } catch {
      return null;
    }
  }

  /** Before terminal commit, including after a restored Pi receipt, recheck
   * current authority and exact saved resources instead of trusting the old
   * tool response or model-provided notes. */
  async revalidateAnalysis(
    sessionId: string,
    jobId: string,
    analysis: AnalysisRecord,
  ): Promise<boolean> {
    if (
      analysis.session_id !== sessionId ||
      analysis.job_id !== jobId ||
      !Array.isArray(analysis.citations) ||
      !Array.isArray(analysis.sources) ||
      !analysis.resource_hashes ||
      !(await validateKnowledgeSources(this.ctx.knowledge))
    )
      return false;
    const session = await this.ctx.sessions.requireAsync(sessionId);
    for (const citation of analysis.citations) {
      const found = await this.ctx.sessions.lookupResourceAsync(
        sessionId,
        citation.resource_id,
      );
      if (
        !found.ok ||
        found.resource.job_id !== jobId ||
        analysis.resource_hashes[citation.resource_id] !==
          createHash("sha256")
            .update(JSON.stringify(found.resource))
            .digest("hex") ||
        !(await this.resourceReadable(sessionId, found.resource))
      )
        return false;
    }
    const declaration = analysis.analysis_declaration;
    if (declaration) {
      const references = declaration.declaration.result_cells ?? [];
      if (!Array.isArray(declaration.verified_cells) || references.length !== declaration.verified_cells.length) return false;
      for (const [index, ref] of references.entries()) {
        const found = await this.ctx.sessions.lookupResourceAsync(sessionId, ref.resource_id);
        if (!found.ok || found.resource.kind !== "query_result" || found.resource.job_id !== jobId ||
            found.resource.execution_id !== ref.execution_id || !analysis.citations.some((item) => item.resource_id === ref.resource_id)) return false;
        const cell = await this.workingCell(session, found.resource, ref.row, ref.column);
        if (!cell || JSON.stringify({ ...ref, ...cell }) !== JSON.stringify(declaration.verified_cells[index])) return false;
      }
    }
    const excerpts =
      analysis.analysis_declaration?.declaration.source_excerpts ?? [];
    for (const excerpt of excerpts) {
      const asset = this.ctx.knowledge.by_id.get(excerpt.asset_id);
      if (
        !asset ||
        !canRead(this.ctx.knowledge, session.role, excerpt.asset_id) ||
        asset.content_hash !== excerpt.content_hash ||
        !asset.body.includes(excerpt.quote)
      )
        return false;
    }
    if (
      !(await validateKnowledgeSources(
        this.ctx.knowledge,
        excerpts.map((item) => item.asset_id),
      ))
    )
      return false;
    const verifiedSources = analysis.sources.filter(
      (source) => source.evidence_eligible,
    );
    if (verifiedSources.length) {
      const current = await this.currentFreshness();
      if (
        !current.ok ||
        !current.publication ||
        current.publication.valid_until <
          currentCalendarDate(this.ctx.config, this.ctx.knowledge.timezone)
      )
        return false;
      if (
        verifiedSources.some(
          (source) =>
            source.freshness_receipts.length !== source.tables.length ||
            source.freshness_receipts.some(
              (receipt) =>
                receipt.publication_id !==
                  current.publication!.publication_id ||
                receipt.version !== current.publication!.version ||
                current.publication!.tables[receipt.table]?.status !== "fresh",
            ),
        )
      )
        return false;
      for (const source of verifiedSources) {
        if (!source.dimension_snapshot) continue;
        const saved = await this.ctx.sessions.lookupResourceAsync(
          sessionId,
          source.resource_id,
        );
        const contract = this.ctx.knowledge.contract_by_table.get(
          source.dimension_snapshot.table,
        )?.contract;
        if (!saved.ok || saved.resource.kind !== "query_result" || !contract)
          return false;
        const evidence = this.evidenceSource(session, saved.resource);
        if (
          !evidence ||
          !verifyDimensionObservations(evidence, contract, current.publication)
            .ok
        )
          return false;
      }
    }
    return true;
  }

  /** Access to a settled historical answer also follows current permissions.
   * This is an access check, not a claim that historical data is still fresh. */
  async canReadStoredAnalysis(
    sessionId: string,
    analysis: AnalysisRecord,
  ): Promise<boolean> {
    try {
      if (analysis.session_id !== sessionId || !Array.isArray(analysis.sources))
        return false;
      const session = await this.ctx.sessions.requireAsync(sessionId);
      const ids: string[] = [];
      for (const source of analysis.sources) {
        if (!Array.isArray(source.tables)) return false;
        for (const table of source.tables) {
          const asset = this.ctx.knowledge.contract_by_table.get(table);
          const contract = asset?.contract;
          if (
            !asset ||
            !contract ||
            !canRead(this.ctx.knowledge, session.role, asset.asset_id) ||
            !canQueryTable(this.ctx.knowledge, session.role, table) ||
            source.contract_revisions?.[table] !== contract.revision ||
            source.asset_hashes?.[asset.asset_id] !== asset.content_hash
          )
            return false;
          ids.push(asset.asset_id);
        }
      }
      for (const excerpt of analysis.analysis_declaration?.declaration
        .source_excerpts ?? []) {
        const asset = this.ctx.knowledge.by_id.get(excerpt.asset_id);
        if (
          !asset ||
          !canRead(this.ctx.knowledge, session.role, excerpt.asset_id) ||
          asset.content_hash !== excerpt.content_hash ||
          !asset.body.includes(excerpt.quote)
        )
          return false;
        ids.push(excerpt.asset_id);
      }
      return validateKnowledgeSources(this.ctx.knowledge, ids);
    } catch {
      return false;
    }
  }
}

function delayUnlessAborted(
  ms: number,
  signal?: AbortSignal,
): Promise<boolean> {
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
