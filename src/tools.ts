// Domain-tool facade. Each service owns one stage; authority is shared, not duplicated.
import { AnalysisDelivery } from "./analysis-delivery.js";
import { KnowledgeTools } from "./knowledge-tools.js";
import { QueryTools } from "./query-tools.js";
import { ResultEvaluator } from "./result-evaluator.js";
import { ResultTools } from "./result-tools.js";
import { ToolAccess } from "./tool-access.js";
import type { ToolContext } from "./tool-context.js";
import type { AnalysisDeclaration } from "./analysis-declaration.js";
import { fail } from "./tool-context.js";

export { sessionAnalyses, type AnalysisFinding, type AnalysisInput } from "./analysis-records.js";
export type { CellOperation } from "./evidence.js";
export type { ToolContext } from "./tool-context.js";

export class ToolService {
  private readonly ctx: ToolContext;
  private readonly knowledge: KnowledgeTools;
  private readonly queries: QueryTools;
  private readonly results: ResultTools;
  private readonly evaluator: ResultEvaluator;
  private readonly delivery: AnalysisDelivery;
  private readonly access: ToolAccess;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
    this.access = new ToolAccess(ctx);
    this.knowledge = new KnowledgeTools(ctx, this.access);
    this.queries = new QueryTools(ctx, this.access);
    this.evaluator = new ResultEvaluator(ctx, this.access);
    this.results = new ResultTools(ctx, this.access, this.evaluator);
    this.delivery = new AnalysisDelivery(ctx, this.access, this.evaluator);
  }

  async reserveToolCall(sessionId: string): Promise<"ok" | "budget_exhausted" | "lost"> {
    return this.ctx.sessions.reserveToolCall(sessionId, this.ctx.config.maxToolCalls);
  }

  searchAssets(
    ...args: Parameters<KnowledgeTools["searchAssets"]>
  ): ReturnType<KnowledgeTools["searchAssets"]> {
    return this.knowledge.searchAssets(...args);
  }

  readAsset(...args: Parameters<KnowledgeTools["readAsset"]>): ReturnType<KnowledgeTools["readAsset"]> {
    return this.knowledge.readAsset(...args);
  }

  readAssets(...args: Parameters<KnowledgeTools["readAssets"]>): ReturnType<KnowledgeTools["readAssets"]> {
    return this.knowledge.readAssets(...args);
  }

  readDataContractView(
    ...args: Parameters<KnowledgeTools["readDataContractView"]>
  ): ReturnType<KnowledgeTools["readDataContractView"]> {
    return this.knowledge.readDataContractView(...args);
  }

  /** Reject unverifiable excerpts when a working note is written, so the
   * model can correct it before delivery. Delivery still rechecks them. */
  async validateWorkingExcerpts(sessionId: string, excerpts: NonNullable<AnalysisDeclaration["source_excerpts"]>, signal?: AbortSignal) {
    const cancelled = await this.access.gate(sessionId, signal);
    if (cancelled) return cancelled;
    for (const excerpt of excerpts) {
      const checked = await this.access.authorizeRead(sessionId, excerpt.asset_id);
      if (!checked.ok || checked.asset.content_hash !== excerpt.content_hash || !checked.asset.body.includes(excerpt.quote)) {
        return fail("analysis_declaration_source_invalid", "工作记录的摘录不可验证：请使用当前有权读取资产的逐字原文和内容哈希，或省略摘录；不要将概述写成原文。" );
      }
    }
    return { ok: true as const };
  }

  /** Working notes can reference proven query cells, not calculation resources.
   * Delivery independently revalidates evidence and freshness. */
  async validateWorkingCells(sessionId: string, cells: NonNullable<AnalysisDeclaration["result_cells"]>, signal?: AbortSignal) {
    const cancelled = await this.access.gate(sessionId, signal);
    if (cancelled) return cancelled;
    const session = await this.ctx.sessions.requireAsync(sessionId);
    for (const cell of cells) {
      const found = await this.ctx.sessions.lookupResourceAsync(sessionId, cell.resource_id);
      if (!found.ok || found.resource.kind !== "query_result" || found.resource.job_id !== session.active_job_id ||
          found.resource.execution_id !== cell.execution_id || !found.resource.rows[cell.row] ||
          !Object.hasOwn(found.resource.rows[cell.row]!, cell.column) || !(await this.access.resourceReadable(sessionId, found.resource))) {
        return fail("analysis_declaration_cell_invalid", "工作记录的结果单元必须引用当前任务的原始查询资源和执行号；计算结果请在最终回答中引用其资源，或省略工作记录单元。" );
      }
      const source = found.resource;
      if (!(await this.access.workingCell(session, source, cell.row, cell.column))) {
        return fail("analysis_declaration_cell_invalid", "工作记录单元需来自可验证的直接字段、分组求和或已证明的 JOIN 求和；计算资源及无法证明的表达式请在最终回答中引用资源，或清空 result_cells 后继续。" );
      }
    }
    return { ok: true as const };
  }

  query(...args: Parameters<QueryTools["query"]>): ReturnType<QueryTools["query"]> {
    return this.queries.query(...args);
  }

  calculateFromProtocol(
    ...args: Parameters<ResultTools["calculateFromProtocol"]>
  ): ReturnType<ResultTools["calculateFromProtocol"]> {
    return this.results.calculateFromProtocol(...args);
  }

  calculateSessionCells(
    ...args: Parameters<ResultTools["calculateSessionCells"]>
  ): ReturnType<ResultTools["calculateSessionCells"]> {
    return this.results.calculateSessionCells(...args);
  }

  readSessionResource(
    ...args: Parameters<ResultTools["readSessionResource"]>
  ): ReturnType<ResultTools["readSessionResource"]> {
    return this.results.readSessionResource(...args);
  }

  updateAnalysis(
    ...args: Parameters<AnalysisDelivery["updateAnalysis"]>
  ): ReturnType<AnalysisDelivery["updateAnalysis"]> {
    return this.delivery.updateAnalysis(...args);
  }

  revalidateAnalysis(
    ...args: Parameters<ToolAccess["revalidateAnalysis"]>
  ): ReturnType<ToolAccess["revalidateAnalysis"]> {
    return this.access.revalidateAnalysis(...args);
  }

  canReadStoredAnalysis(
    ...args: Parameters<ToolAccess["canReadStoredAnalysis"]>
  ): ReturnType<ToolAccess["canReadStoredAnalysis"]> {
    return this.access.canReadStoredAnalysis(...args);
  }
}
