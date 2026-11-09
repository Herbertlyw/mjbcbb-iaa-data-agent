import { readResultResource } from "./resource-reader.js";
import { ResultEvaluator } from "./result-evaluator.js";
import { ResultPolicy } from "./result-policy.js";
// Recompute result resources and their dependencies before use.
import { createHash } from "node:crypto";
import { normalizeCalculation } from "./calculation-protocol.js";
import { type CellOperation } from "./evidence.js";
import { type ArithmeticOp } from "./exact-arithmetic.js";
import { validateKnowledgeSources } from "./knowledge.js";
import { queryCellInput } from "./query-cell-input.js";
import { ResourceGraph } from "./resource-graph.js";
import { persistedCells } from "./result-adapters.js";
import { type AlignmentSpec } from "./result-alignment.js";
import { calculateResultCells } from "./result-cells.js";
import { evaluationContext } from "./result-evaluation-context.js";
import {
  RESULT_CALCULATION_MAX_BYTES,
  RESULT_CALCULATION_MAX_ROWS,
  type TransformStep,
} from "./result-transform.js";
import { newId } from "./session.js";
import { fail, type ToolContext, type ToolResult } from "./tool-context.js";
import { previewRows } from "./tool-preview.js";
import type {
  AlignmentResource,
  ArithmeticRef,
  ArithmeticResource,
  CalculationResource,
  SessionResource,
  TransformResource,
} from "./types.js";

import { ToolAccess } from "./tool-access.js";

/** Fixed branch guidance only: never reflect arbitrary model parameters. */
function calculationShapeHint(value: unknown): string {
  const operation = value && typeof value === "object" && !Array.isArray(value)
    ? (value as { operation?: unknown }).operation : undefined;
  if (operation === "divide") return "divide 必须提供 numerator 和 denominator；每个引用都要包含 resource_id、execution_id、column，并在 row 与 aggregate=sum 中恰选一个。单行计算资源使用 row=0；不要混入 left/right 或 steps。";
  if (operation === "add" || operation === "subtract" || operation === "multiply") return "四则计算须提供 left 和 right；每个引用包含 resource_id、execution_id、column，并在 row 与 aggregate=sum 中恰选一个。单行计算资源使用 row=0。";
  if (operation === "cells") return "cells 须提供 input 的 resource_id、execution_id，以及 operations 操作列表；不要同时传入 steps。";
  if (operation === "transform") return "transform 须提供 input 的 resource_id、execution_id，以及 steps 变换列表；不要同时传入 operations。";
  if (operation === "align") return "align 须提供 left、right、keys 和 align_op；两侧引用均须包含 resource_id、execution_id、column。";
  return "计算参数与 operation 分支不匹配；请按工具参数定义选择计算方式。";
}

export class ResultTools {
  private readonly ctx: ToolContext;
  private readonly evaluator: ResultEvaluator;
  private readonly policy: ResultPolicy;
  private readonly access: ToolAccess;

  constructor(ctx: ToolContext, access: ToolAccess, evaluator: ResultEvaluator) {
    this.ctx = ctx;
    this.evaluator = evaluator;
    this.policy = new ResultPolicy(ctx.knowledge);
    this.access = access;
  }
  async calculateFromProtocol(sessionId: string, value: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const cancelled = await this.access.gate(sessionId, signal);
    if (cancelled) return cancelled;
    const session = await this.ctx.sessions.requireAsync(sessionId);
    if (!session.active_job_id) return fail("missing_active_job", "计算需要当前任务及其独立证据。");
    const normalized = await normalizeCalculation(value, async (id) => {
      const found = await this.ctx.sessions.lookupResourceAsync(sessionId, id);
      return found.ok && found.resource.job_id !== session.active_job_id
        ? { ok: false as const, code: "resource_from_other_execution" }
        : found;
    });
    if (!normalized.ok)
      return fail(
        normalized.code,
        normalized.code === "invalid_calculation_shape"
          ? calculationShapeHint(value)
          : normalized.code === "resource_from_other_execution"
            ? "资源不属于当前任务；请重新查询或计算。"
            : "资源不存在、不可访问或执行 ID 不匹配；请使用本次回执中的身份。",
      );
    return this.calculateSessionCells(sessionId, normalized.input, signal, normalized.hashes);
  }

  async calculateSessionCells(
    sessionId: string,
    input: {
      resource_id?: string;
      operations?: CellOperation[];
      arithmetic?: { op: ArithmeticOp; left: ArithmeticRef; right: ArithmeticRef };
      transform?: { resource_id: string; steps: TransformStep[] };
      align?: AlignmentSpec;
    },
    signal?: AbortSignal,
    expectedHashes?: Record<string, string>,
  ): Promise<ToolResult> {
    const cancelled = await this.access.gate(sessionId, signal);
    if (cancelled) return cancelled;
    if (!(await validateKnowledgeSources(this.ctx.knowledge)))
      return fail("knowledge_source_changed", "权限或知识目录已变化，请重新加载。");
    const references = input.align
      ? [input.align.left?.resource_id, input.align.right?.resource_id]
      : input.transform
        ? [input.transform.resource_id]
        : input.arithmetic
          ? [input.arithmetic.left?.resource_id, input.arithmetic.right?.resource_id]
          : [input.resource_id];
    for (const id of references) {
      if (typeof id !== "string") continue;
      const resource = await this.ctx.sessions.lookupResourceAsync(sessionId, id);
      if (!resource.ok) return fail(resource.code, resource.message);
      if (
        expectedHashes &&
        expectedHashes[id] !== createHash("sha256").update(JSON.stringify(resource.resource)).digest("hex")
      )
        return fail("resource_version_changed", "输入资源在校验后发生变化，请重新读取。");
      if (!(await this.access.resourceReadable(sessionId, resource.resource)))
        return fail(
          "resource_authorization_changed",
          "资源引用的授权、契约或来源发生变化，不能继续读取或计算。",
        );
    }
    if (input.align) {
      if (input.transform || input.arithmetic || input.resource_id || input.operations)
        return fail("invalid_alignment", "分组对齐须单独提交。");
      return this.calculateAlignment(sessionId, input.align, expectedHashes);
    }
    if (input.transform) {
      if (
        input.arithmetic ||
        input.operations ||
        (input.resource_id !== undefined && input.resource_id !== input.transform.resource_id)
      )
        return fail("invalid_transform", "表格变换须单独提交；如提供顶层 resource_id，必须与变换输入一致。");
      return this.calculateTransform(sessionId, input.transform, expectedHashes);
    }
    if (input.arithmetic) {
      if (
        input.operations ||
        (input.resource_id !== undefined &&
          (input.resource_id !== input.arithmetic.left?.resource_id ||
            input.resource_id !== input.arithmetic.right?.resource_id))
      )
        return fail(
          "invalid_arithmetic",
          "四则运算与单资源汇总须分开提交；顶层 resource_id 如存在，必须与两个输入一致。",
        );
      return this.calculateArithmetic(sessionId, input.arithmetic, expectedHashes);
    }
    if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 40)
      return fail("invalid_calculation", "每次须提供 1 到 40 个计算操作。");
    const found = await this.ctx.sessions.lookupResourceAsync(sessionId, input.resource_id ?? "");
    if (!found.ok) return fail(found.code, found.message);
    const activeJob = (await this.ctx.sessions.requireAsync(sessionId)).active_job_id;
    if (activeJob)
      return this.calculateTableCells(sessionId, found.resource, input.operations, expectedHashes);
    // Unscoped SQLite test/demo callers have no job receipts. They use the
    // same numeric engine, but cannot create evidence for a later task.
    if (found.resource.kind !== "query_result" || this.ctx.config.stateMode !== "sqlite")
      return fail("missing_active_job", "计算需要当前任务。");
    const source = found.resource;
    if (
      expectedHashes &&
      expectedHashes[source.resource_id] !== createHash("sha256").update(JSON.stringify(source)).digest("hex")
    )
      return fail("resource_version_changed", "输入已变化。");
    const contract =
      source.tables.length === 1
        ? this.ctx.knowledge.contract_by_table.get(source.tables[0]!)?.contract
        : undefined;
    const table = queryCellInput(source, contract);
    const calculated = table && calculateResultCells(table, input.operations);
    if (!calculated) return fail("invalid_calculation", "计算类型或预测范围无法证明。");
    const cells = persistedCells(source, calculated.table, input.operations);
    const resource: CalculationResource = {
      resource_id: newId("res"),
      execution_id: newId("calc"),
      session_id: sessionId,
      kind: "calculation",
      created_at: new Date().toISOString(),
      source_resource_id: source.resource_id,
      source_resource_hash: createHash("sha256").update(JSON.stringify(source)).digest("hex"),
      cells,
      operations: Object.fromEntries(input.operations.map((operation) => [operation.as, { ...operation }])),
      input_truncated: source.truncated || Boolean(source.sql_limited),
      complete_population: source.complete_population && !source.truncated,
      null_means: "missing",
      zero_means: "observed_zero",
      predicted_means: "forecast_not_actual",
      notes: [],
    };
    await this.ctx.sessions.saveResourceAsync(resource);
    return { ok: true, ...resource, notice: `resource_id=${resource.resource_id}` };
  }

  private async calculateTableCells(
    sessionId: string,
    source: SessionResource,
    operations: CellOperation[],
    expectedHashes?: Record<string, string>,
  ): Promise<ToolResult> {
    const session = await this.ctx.sessions.requireAsync(sessionId);
    const jobId = session.active_job_id;
    if (!jobId || source.job_id !== jobId)
      return fail("resource_from_other_execution", "只能使用当前任务的结果。");
    const fresh = await this.access.currentFreshness();
    if (!fresh.ok) return fresh;
    if (!fresh.publication) return fail("freshness_not_published", "没有已发布新鲜度。");
    const graph = new ResourceGraph(
      (id) => this.ctx.sessions.lookupResourceAsync(sessionId, id),
      sessionId,
      jobId,
    );
    const graphError = await graph.add(source.resource_id);
    if (graphError) return fail(graphError, "计算来源依赖无法复核。");
    if (
      graph
        .nodes()
        .some(
          (node) =>
            node.kind === "query_result" &&
            (node.freshness_receipts.length !== node.tables.length ||
              node.freshness_receipts.some(
                (receipt) =>
                  receipt.publication_id !== fresh.publication!.publication_id ||
                  receipt.version !== fresh.publication!.version ||
                  fresh.publication!.tables[receipt.table]?.status !== "fresh",
              )),
        )
    )
      return fail("freshness_version_changed", "来源的新鲜度已变化，请重新查询。");
    const input = await this.evaluator.evaluateVerifiedResult(
      session,
      jobId,
      source.resource_id,
      fresh.publication,
      new Set(),
    );
    // A truncated query may still be inspected as a bounded sample, but it
    // must never receive a verified result-table receipt or certify a total.
    // For ClickHouse, recheck the native plan before exposing even that
    // sample; identity, current permissions and freshness were checked above.
    const demoSource = !input && source.kind === "query_result" && (
      source.engine === "sqlite-local" ||
      source.engine === "clickhouse-local" && Boolean(source.truncated || source.sql_limited) &&
        Boolean(source.review_plan) && Boolean(this.access.evidenceSource(session, source))
    ) ? source : null;
    const table =
      input?.table ??
      (demoSource
        ? queryCellInput(
            demoSource,
            this.ctx.knowledge.contract_by_table.get(demoSource.tables[0]!)?.contract,
          )
        : null);
    if (!table)
      return fail("calculation_lineage_unsupported", "输入结果的身份、来源、权限或新鲜度无法复核。");
    const hashes = input?.hashes ?? {
      [source.resource_id]: createHash("sha256").update(JSON.stringify(source)).digest("hex"),
    };
    if (expectedHashes && expectedHashes[source.resource_id] !== hashes[source.resource_id])
      return fail("resource_version_changed", "计算输入在校验后发生变化，请重新读取。");
    const result = calculateResultCells(table, operations);
    if (!result) return fail("invalid_calculation", "计算字段、类型、预测筛选或资源边界不受支持。");
    const cells: Record<string, number | string | null> = {};
    const recipe: Record<string, CellOperation> = Object.create(null) as Record<string, CellOperation>;
    Object.assign(cells, persistedCells(source, result.table, operations));
    for (const operation of operations) recipe[operation.as] = { ...operation };
    const truncated = Boolean(demoSource && (demoSource.truncated || demoSource.sql_limited));
    const resource: CalculationResource = {
      resource_id: newId("res"),
      execution_id: newId("calc"),
      session_id: sessionId,
      job_id: jobId,
      kind: "calculation",
      created_at: new Date().toISOString(),
      source_resource_id: source.resource_id,
      source_resource_hash: hashes[source.resource_id],
      cells,
      operations: recipe,
      ...(input
        ? { evaluated_table_v1: { table: result.table, incomplete: result.incomplete, input_hashes: hashes } }
        : {}),
      input_truncated: truncated,
      complete_population: !truncated,
      null_means: "missing",
      zero_means: "observed_zero",
      predicted_means: "forecast_not_actual",
      notes: [],
    };
    await this.ctx.sessions.saveResourceAsync(resource);
    return {
      ok: true,
      resource_id: resource.resource_id,
      execution_id: resource.execution_id,
      source_resource_id: resource.source_resource_id,
      cells,
      columns: result.table.columns,
      input_truncated: truncated,
      complete_population: !truncated,
      notes: [],
      notice: truncated
        ? `仅基于截断或受 LIMIT 限制的已保存行计算，不能作为完整总体结论。resource_id=${resource.resource_id}`
        : `基于本任务保存结果的数学计算；业务名称和完整性仍须单独证明。resource_id=${resource.resource_id}`,
    };
  }

  private async calculateArithmetic(
    sessionId: string,
    expression: { op: ArithmeticOp; left: ArithmeticRef; right: ArithmeticRef },
    expectedHashes?: Record<string, string>,
  ): Promise<ToolResult> {
    if (!expression || !["add", "subtract", "multiply", "divide"].includes(expression.op))
      return fail("invalid_arithmetic", "未支持的运算。");
    const session = await this.ctx.sessions.requireAsync(sessionId);
    const jobId = session.active_job_id;
    if (!jobId) return fail("missing_active_job", "四则运算需要当前任务及其证据资源。");
    const fresh = await this.access.currentFreshness();
    if (!fresh.ok) return fresh;
    if (!fresh.publication) return fail("freshness_not_published", "没有已发布新鲜度。");
    const evaluation = evaluationContext();
    const left = await this.evaluator.resolveArithmetic(
      session,
      jobId,
      expression.left,
      fresh.publication,
      new Set(),
      evaluation,
    );
    const right = await this.evaluator.resolveArithmetic(
      session,
      jobId,
      expression.right,
      fresh.publication,
      new Set(),
      evaluation,
    );
    if (!left || !right)
      return fail(
        "arithmetic_lineage_unsupported",
        "输入不属于当前任务、已变化或不能证明完整血缘。引用多行结果中的明细行时请提供查询结果中的 execution_id、row 和列名；单行资源可使用其保存的执行 ID。不要使用历史任务资源。",
      );
    if (
      expectedHashes &&
      (expectedHashes[expression.left.resource_id] !== left.hashes[expression.left.resource_id] ||
        expectedHashes[expression.right.resource_id] !== right.hashes[expression.right.resource_id])
    )
      return fail("resource_version_changed", "计算输入在校验后发生变化，请重新读取。");
    const result = this.policy.computeProvenArithmetic(expression.op, left.value, right.value);
    if (!result)
      return fail(
        "arithmetic_scope_incompatible",
        "指标关系须由契约声明，且单位、粒度、实际/预测状态及范围须兼容。",
      );
    const resource: ArithmeticResource = {
      resource_id: newId("res"),
      execution_id: newId("calc"),
      session_id: sessionId,
      job_id: jobId,
      kind: "arithmetic",
      created_at: new Date().toISOString(),
      operation: expression.op,
      left: expression.left,
      right: expression.right,
      input_hashes: { ...left.hashes, ...right.hashes },
      result,
      input_truncated: false,
      complete_population: true,
    };
    await this.ctx.sessions.saveResourceAsync(resource);
    return {
      ok: true,
      resource_id: resource.resource_id,
      execution_id: resource.execution_id,
      result: resource.result,
      dependencies: Object.keys(resource.input_hashes),
      notice: `${result.value === null ? (result.undefined_reason === "null_input" ? "输入为空或 NULL，结果未知；没有补成零。" : "除数为零，结果不可计算；没有补成零。") : "定点计算；除法保留 18 位小数、半数远离零。正式结论须经服务端复核。"}${result.interpretation === "mathematical_only" ? " 这是基于已验证结果单元的数学运算，不认证业务指标名称或范围。" : ""} resource_id=${resource.resource_id}`,
    };
  }

  private async calculateTransform(
    sessionId: string,
    input: { resource_id: string; steps: TransformStep[] },
    expectedHashes?: Record<string, string>,
  ): Promise<ToolResult> {
    if (!input || typeof input.resource_id !== "string" || !Array.isArray(input.steps))
      return fail("invalid_transform", "变换须指定输入资源和操作列表。");
    const session = await this.ctx.sessions.requireAsync(sessionId);
    const jobId = session.active_job_id;
    if (!jobId) return fail("missing_active_job", "表格变换需要当前任务。");
    const fresh = await this.access.currentFreshness();
    if (!fresh.ok) return fresh;
    if (!fresh.publication) return fail("freshness_not_published", "没有已发布新鲜度。");
    const inputTable = await this.evaluator.evaluateVerifiedResult(
      session,
      jobId,
      input.resource_id,
      fresh.publication,
      new Set(),
    );
    if (!inputTable)
      return fail(
        "transform_lineage_unsupported",
        `输入必须为当前任务完整、可验证的查询或变换资源；计算上限为 ${RESULT_CALCULATION_MAX_ROWS} 行和 ${RESULT_CALCULATION_MAX_BYTES} 字节。`,
      );
    if (expectedHashes && expectedHashes[input.resource_id] !== inputTable.hashes[input.resource_id])
      return fail("resource_version_changed", "变换输入在校验后发生变化，请重新读取。");
    const allowObservedPartial = await this.evaluator.canUseObservedTransform(session, jobId, inputTable.leaves, fresh.publication);
    const transformed = this.policy.applyProvenTransform(inputTable.table, input.steps, allowObservedPartial);
    if (!transformed) return fail("invalid_transform", "变换未通过字段类型、别名、契约指标关系或资源边界校验。可先用 read_session_resource 查看受支持的列及类型；若需要逐行比率，可对同一行的已验证分子和分母分别引用并使用 divide，零分母会返回未知。不要重复未改变的调用。");
    const result = transformed.table;
    const resource: TransformResource = {
      resource_id: newId("res"),
      execution_id: newId("calc"),
      session_id: sessionId,
      job_id: jobId,
      kind: "transform",
      created_at: new Date().toISOString(),
      source_resource_id: input.resource_id,
      steps: input.steps,
      input_hashes: inputTable.hashes,
      result,
      input_truncated: false,
      complete_population: true,
    };
    await this.ctx.sessions.saveResourceAsync(resource);
    const preview = previewRows(result.rows, 100);
    return {
      ok: true,
      resource_id: resource.resource_id,
      execution_id: resource.execution_id,
      result: { ...result, rows: preview },
      result_total_rows: result.rows.length,
      result_has_more: result.rows.length > preview.length,
      dependencies: Object.keys(resource.input_hashes),
      notice: `变换应用于完整已保存结果；预览限 100 行及 32 KB，可使用 read_session_resource 续读。${transformed.undefinedArithmetic ? "存在 NULL 输入或零分母，部分运算结果未知。" : ""}${transformed.observedPartialArithmetic ? "比率仅对应已观察分组，未证明完整业务总体。" : ""}正式交付时递归复核来源。resource_id=${resource.resource_id}`,
    };
  }

  private async calculateAlignment(
    sessionId: string,
    spec: AlignmentSpec,
    expectedHashes?: Record<string, string>,
  ): Promise<ToolResult> {
    const session = await this.ctx.sessions.requireAsync(sessionId);
    const jobId = session.active_job_id;
    if (!jobId) return fail("missing_active_job", "分组对齐需要当前任务。");
    const fresh = await this.access.currentFreshness();
    if (!fresh.ok) return fresh;
    if (!fresh.publication) return fail("freshness_not_published", "没有已发布新鲜度。");
    const checked = await this.evaluator.resolveAlignment(session, jobId, spec, fresh.publication);
    if (!checked) return fail("alignment_lineage_unsupported", "分组、指标口径、范围或完整来源无法证明。align 仅对数值指标按 keys 做四则运算，不能把产品编码等文本键当成 add 的指标，也不执行维表名称查找。名称请使用登记 JOIN，或在最终回答中分别用 [[result:资源ID]] 选择本任务的维表查询及事实/计算结果；不能只在模型草稿中提及维表。");
    if (
      expectedHashes &&
      [spec.left.resource_id, spec.right.resource_id].some((id) => expectedHashes[id] !== checked.hashes[id])
    )
      return fail("resource_version_changed", "对齐输入在校验后发生变化，请重新读取。");
    const resource: AlignmentResource = {
      resource_id: newId("res"),
      execution_id: newId("calc"),
      session_id: sessionId,
      job_id: jobId,
      kind: "alignment",
      key_lineage_version: 1,
      created_at: new Date().toISOString(),
      spec,
      input_hashes: checked.hashes,
      rows: checked.rows,
      coverage_incomplete: checked.partial,
      input_truncated: false,
      complete_population: true,
    };
    await this.ctx.sessions.saveResourceAsync(resource);
    const preview = previewRows(checked.rows, 100);
    return {
      ok: true,
      resource_id: resource.resource_id,
      execution_id: resource.execution_id,
      rows: preview,
      result_total_rows: checked.rows.length,
      result_has_more: checked.rows.length > preview.length,
      coverage_incomplete: checked.partial,
      dependencies: Object.keys(checked.hashes),
      notice: `按完整结果的分组键全集对齐；预览限 100 行及 32 KB，某侧未出现的组不补零。${checked.partial ? "来源覆盖不完整或未知，结果只能部分交付。" : ""}resource_id=${resource.resource_id}`,
    };
  }
  async readSessionResource(
    sessionId: string,
    input: {
      resource_id?: string;
      row_offset?: number;
      row_limit?: number;
      columns?: string[];
      expected_resource_hash?: string;
      format?: "result_view";
    },
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    return readResultResource(this.ctx, this.access, sessionId, input, signal);
  }
}
