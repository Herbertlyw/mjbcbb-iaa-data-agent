// Independent, conservative scoring of the generated channel-ratio oracle.
// This is evaluation code: it never changes a model prompt or authorizes data.
import { createHash } from "node:crypto";
import { decimalOperation, normalizeDecimal } from "./decimal-kernel.js";
import { coverageHasGap } from "./coverage.js";
import { joinMetricColumns, prepareJoinEvidence, prepareJoinAggregateEvidence, verifyJoinEvidence, verifyJoinExecutionSchema } from "./join-evidence.js";
import { joinCaptureHash } from "./join-resource-proof.js";
import type { KnowledgeBase } from "./types.js";

type Assessment = { verdict: "correct" | "incorrect" | "partial" | "pending"; reason: string };
const pending = (): Assessment => ({ verdict: "pending", reason: "分组来源或计算形状未能独立核对，需人工检查。" });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const decimal = (value: unknown) => typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value) ? normalizeDecimal(String(value)) : null;

/** Only one complete, same-query fact/dimension JOIN with physical group and
 * metric provenance is scored. Other shapes remain pending, never presumed OK. */
export function assessSyntheticGroupedRatio(oracle: Record<string, any>, job: Record<string, any>, resources: Array<Record<string, any>>, knowledge: KnowledgeBase, datasetVersion: string): Assessment {
  try { return assess(oracle, job, resources, knowledge, datasetVersion); } catch { return pending(); }
}

function assess(oracle: Record<string, any>, job: Record<string, any>, resources: Array<Record<string, any>>, knowledge: KnowledgeBase, datasetVersion: string): Assessment {
  if (oracle.kind !== "channel_cpi" || typeof oracle.app_id !== "string" || typeof oracle.date !== "string" || !["completed", "partial"].includes(job.status) || !/^sv_[a-f0-9]{20}$/u.test(datasetVersion) || !Array.isArray(oracle.groups) || !oracle.groups.length || oracle.groups.length > 20 || !job.analysis || !Array.isArray(job.analysis.sources) || !Array.isArray(job.analysis.join_results) || !Array.isArray(job.analysis.arithmetic_results) || !Array.isArray(job.analysis.citations)) return pending();
  const expected = new Map<string, { cost: string; registrations: string; ratio: string | null }>();
  for (const group of oracle.groups) {
    if (!group || typeof group.ua_channel_id !== "string" || expected.has(group.ua_channel_id)) return pending();
    const cost = decimal(group.discounted_cost_usd), registrations = decimal(group.af_registers);
    if (cost === null || registrations === null) return pending();
    const six = decimalOperation("divide", cost, registrations, 6);
    if (six === undefined || (six === null ? group.cpi_usd_per_register !== null : decimal(group.cpi_usd_per_register) !== decimal(six))) return pending();
    const ratio = decimalOperation("divide", cost, registrations, 18);
    if (ratio === undefined) return pending();
    expected.set(group.ua_channel_id, { cost, registrations, ratio });
  }
  const selected = new Set(job.analysis.citations.map((item: any) => item.resource_id));
  const sourceRows = resources.filter((item) => item.kind === "query_result" && item.sql_review_engine === "clickhouse_ast_join" && item.tables?.includes("fact_delivery_daily") && selected.has(item.resource_id));
  if (sourceRows.length !== 1 || ["transform_results", "alignment_results", "calculations", "comparisons", "aggregate_comparisons", "conditional_aggregates"].some((key) => (job.analysis[key]?.length ?? 0) > 0)) return pending();
  const source = sourceRows[0]!;
  if (resources.some((item) => item.kind === "query_result" && item.resource_id !== source.resource_id && selected.has(item.resource_id))) return pending();
  const selectedSource = job.analysis.sources.find((item: any) => item.resource_id === source.resource_id && item.evidence_eligible === true);
  if (!selectedSource || source.job_id !== job.job_id || source.session_id !== job.session_id || source.truncated || source.sql_limited || !source.complete_population || source.total_rows_exact !== true || source.time_range?.start !== oracle.date || source.time_range?.end !== oracle.date || source.time_range?.timezone !== "UTC" || !Array.isArray(source.rows) || source.rows.length !== expected.size || source.rows.length !== source.total_rows || source.returned_rows !== source.rows.length || job.analysis.resource_hashes?.[source.resource_id] !== hash(source) || !source.join_proof || !Array.isArray(source.join_proof.rows)) return pending();
  if (!Array.isArray(source.tables) || new Set(source.tables).size !== 2 || source.tables.length !== 2 || !Array.isArray(source.freshness_receipts) || source.freshness_receipts.length !== 2 || new Set(source.freshness_receipts.map((receipt: any) => receipt.table)).size !== 2 || source.freshness_receipts.some((receipt: any) => receipt.status !== "fresh" || !source.tables.includes(receipt.table)) || new Set(source.freshness_receipts.map((receipt: any) => `${receipt.publication_id}:${receipt.version}`)).size !== 1) return pending();
  const fact = knowledge.contract_by_table.get("fact_delivery_daily");
  const dimension = source.tables.length === 2 ? knowledge.contract_by_table.get(source.tables.find((table: string) => table !== "fact_delivery_daily")) : undefined;
  if (!fact?.contract || !dimension?.contract || source.contract_revisions?.[fact.contract.table] !== fact.contract.revision || source.contract_revisions?.[dimension.contract.table] !== dimension.contract.revision || source.asset_hashes?.[fact.asset_id] !== fact.content_hash || source.asset_hashes?.[dimension.asset_id] !== dimension.content_hash || source.registry_revision !== knowledge.registry_revision) return pending();
  const plan = [prepareJoinEvidence(source.sql, fact.contract, dimension.contract, knowledge.joins, true), prepareJoinAggregateEvidence(source.sql, fact.contract, dimension.contract, knowledge.joins, true)].find((candidate) => candidate?.executionSql === source.executed_sql);
  if (!plan || plan.range.start !== oracle.date || plan.range.end !== oracle.date || plan.factFilters.app_id !== oracle.app_id || Object.keys(plan.factFilters).some((key) => key !== "app_id" && key !== "dataset_version") || (plan.factFilters.dataset_version !== undefined && plan.factFilters.dataset_version !== datasetVersion) || Object.keys(plan.dimensionFilters).length || !verifyJoinExecutionSchema(plan, fact.contract, dimension.contract, source.join_proof.column_types) || source.join_proof.capture_hash !== joinCaptureHash(source.sql, source.executed_sql, source.execution_id, source.join_proof.rows, source.join_proof.column_types)) return pending();
  // The immutable release must be established by captured physical keys, not
  // inferred from the fixture name or coincidentally matching result numbers.
  if (plan.aggregateProof || (plan.joinType === "left" && source.execution_settings?.join_use_nulls !== true)) return pending();
  const versionFields = plan.proofFields.map((field, index) => field.column === "dataset_version" ? { table: field.table, index } : null).filter((field) => field !== null);
  if (!versionFields.some((field) => field.table === "fact") || !versionFields.some((field) => field.table === "dimension")) return pending();
  const proofOffset = 1 + joinMetricColumns(plan).length;
  if (source.join_proof.rows.some((row: any) => !row || !Array.isArray(row.__da_join_proof) || !row.__da_join_proof.length || row.__da_join_proof.some((tuple: unknown) => !Array.isArray(tuple) || versionFields.some((field) => tuple[proofOffset + field.index] !== datasetVersion)))) return pending();
  const groups = plan.groups.filter((group) => group.column === "ua_channel_id");
  const cost = plan.metrics.filter((metric) => metric.column === "discounted_cost_usd" && metric.operation === "sum");
  const regs = plan.metrics.filter((metric) => metric.column === "af_registers" && metric.operation === "sum");
  if (groups.length !== 1 || cost.length !== 1 || regs.length !== 1) return pending();
  const values = verifyJoinEvidence(plan, source.join_proof.rows);
  const delivered = job.analysis.join_results.filter((item: any) => item.resource_id === source.resource_id && item.execution_id === source.execution_id);
  if (!values || delivered.length !== 1 || JSON.stringify(values) !== JSON.stringify(delivered[0].values)) return pending();
  const visible = source.join_proof.rows.map(({ __da_join_proof: _proof, ...row }: Record<string, unknown>) => row);
  if (JSON.stringify(visible) !== JSON.stringify(source.rows)) return pending();
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const [rowIndex, row] of source.rows.entries()) {
    const channel = row[groups[0]!.output];
    if (typeof channel !== "string" || seen.has(channel) || !expected.has(channel)) return pending();
    seen.add(channel);
    const want = expected.get(channel)!;
    if (decimal(row[cost[0]!.output]) !== want.cost || decimal(row[regs[0]!.output]) !== want.registrations) return pending();
    const sameGroup = (value: any) => plan.groups.every((group) => value.group?.[`${group.table === "fact" ? plan.fact : plan.dimension}.${group.column}`] === row[group.output]);
    for (const [metric, wanted] of [[cost[0]!, want.cost], [regs[0]!, want.registrations]] as const) {
      if (!values.some((value) => value.column === metric.column && value.operation === "sum" && sameGroup(value) && decimal(value.value) === wanted)) return pending();
    }
    const matching = job.analysis.arithmetic_results.filter((item: any) => item.operation === "divide" && item.left?.resource_id === source.resource_id && item.right?.resource_id === source.resource_id && item.left?.execution_id === source.execution_id && item.right?.execution_id === source.execution_id && item.left?.row === rowIndex && item.right?.row === rowIndex && item.left?.cell === cost[0]!.output && item.right?.cell === regs[0]!.output);
    if (matching.length > 1) return pending();
    if (!matching.length) { missing.push(channel); continue; }
    const ar = matching[0], saved = resources.find((item) => item.resource_id === ar.resource_id);
    if (!saved || saved.kind !== "arithmetic" || saved.job_id !== job.job_id || saved.session_id !== job.session_id || !selected.has(saved.resource_id) || job.analysis.resource_hashes?.[saved.resource_id] !== hash(saved) || saved.input_hashes?.[source.resource_id] !== hash(source) || saved.operation !== ar.operation || JSON.stringify(saved.left) !== JSON.stringify(ar.left) || JSON.stringify(saved.right) !== JSON.stringify(ar.right) || JSON.stringify(saved.result) !== JSON.stringify(ar.result) || ar.result?.unit !== "(USD)/(报表注册)" || (want.ratio === null ? ar.result.value !== null || ar.result.undefined_reason !== "zero_divisor" : decimal(ar.result.value) !== decimal(want.ratio))) return pending();
    const line = String(job.analysis.answer ?? "").split("\n").find((text: string) => text.includes(ar.resource_id));
    if (!line || (want.ratio === null ? !/除数为零|零分母/u.test(line) : !line.includes(String(ar.result.value)))) return pending();
  }
  if (seen.size !== expected.size) return pending();
  // Unsupported arithmetic or an unselected transform could otherwise contain
  // a missing group; do not misclassify such cases as incorrect.
  if (job.analysis.arithmetic_results.some((item: any) => item.operation !== "divide" || item.left?.resource_id !== source.resource_id || item.right?.resource_id !== source.resource_id || item.left?.execution_id !== source.execution_id || item.right?.execution_id !== source.execution_id || !Number.isInteger(item.left?.row) || item.left.row < 0 || item.left.row >= source.rows.length || item.left.row !== item.right?.row || item.left?.cell !== cost[0]!.output || item.right?.cell !== regs[0]!.output)) return pending();
  if (missing.length) return job.status === "completed" ? { verdict: "incorrect", reason: `正式结果没有逐组交付全部请求的比率；缺少 ${missing.length} 个观察分组。` } : { verdict: "partial", reason: `部分分组的正式比率尚未交付；缺少 ${missing.length} 个观察分组。` };
  if (job.status !== "completed" || source.coverage?.status !== "known" || coverageHasGap(source.coverage)) return { verdict: "partial", reason: "已展示分组的成本、注册和比率与独立算式一致；完整范围或任务终态仍受限制。" };
  return { verdict: "correct", reason: "每个已观察分组的成本、注册、比率及零分母未知均与独立算式和当前任务证据一致。" };
}
