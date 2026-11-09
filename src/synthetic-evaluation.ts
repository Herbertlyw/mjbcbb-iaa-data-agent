import { createHash } from 'node:crypto';
import { normalizeDecimal, sumDecimals } from './decimal-kernel.js';
import { coverageHasGap } from './coverage.js';

/** An aborted runner must not leave unstarted tasks looking permanently active. */
export function markInterruptedEvaluations(records: Array<Record<string, any>>): void {
  for (const record of records) {
    if (record.verdict !== 'pending' && record.verdict !== 'running') continue;
    const mayHaveStarted = record.verdict === 'running';
    record.verdict = mayHaveStarted ? 'failed' : 'not_started';
    record.judgement = mayHaveStarted
      ? '评测运行中断，派发和用量以持久账本为准；未知结果不得自动重试。'
      : '评测在此题启动前中断，未创建此题任务。';
    if (mayHaveStarted) record.dispatched = null;
  }
}

/** Give an already-finished/cancelled job a bounded chance to persist the
 * provider settlement before shutting down its worker. Unknown is never
 * treated as a zero usage or a reason to redispatch. */
export async function waitForProviderSettlements<T extends { status?: string; settlement?: string; global_state?: string | null }>(read: () => Promise<T[]>, timeoutMs: number, intervalMs = 250): Promise<{ steps: T[]; timedOut: boolean }> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000 || !Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 10_000) throw new Error('settlement_wait_invalid');
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const steps = await read();
    const pending = steps.some((step) => step.settlement === 'pending' || step.global_state === 'reserved' || step.global_state === 'dispatched');
    if (!pending) return { steps, timedOut: false };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { steps, timedOut: true };
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
}

/** Stop unproductive loops, not just immediately consecutive failures.
 * A few other tool calls cannot hide four repeats in the last ten results. */
export function repeatedToolFailure(events: unknown): string | null {
  if (!Array.isArray(events)) return null;
  const finished = events.filter((event) => event?.type === 'tool_finished').slice(-10);
  const last = finished.at(-1)?.payload;
  if (!last || last.is_error !== true || typeof last.tool_name !== 'string' || typeof last.code !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/u.test(last.code)) return null;
  const matches = (event: any) => event?.payload?.is_error === true && event.payload.tool_name === last.tool_name && event.payload.code === last.code;
  const consecutive = finished.length >= 3 && finished.slice(-3).every(matches);
  return consecutive || finished.filter(matches).length >= 4 ? last.code : null;
}

/** Check that the independent oracle checked every date or group in the exact
 * frozen case file. This receipt is not model evidence or a financial limit. */
export function validateSyntheticEvaluationAttestation(caseBytes: Uint8Array, report: unknown): { cases: Array<{ id: string; question: string; oracle: Record<string, unknown> }>; dataset_version: string; as_of: string } {
  const fixture = JSON.parse(Buffer.from(caseBytes).toString('utf8')) as Record<string, any>;
  const receipt = report as Record<string, any> | null;
  if (fixture.schema !== 'synthetic-eval-cases-v1' || typeof fixture.dataset_version !== 'string' || !/^sv_[a-f0-9]{20}$/u.test(fixture.dataset_version) || typeof fixture.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(fixture.as_of) || !Array.isArray(fixture.cases) || !fixture.cases.length || !receipt || receipt.schema !== 'synthetic-eval-check-v1' || receipt.dataset_version !== fixture.dataset_version || receipt.cases_sha256 !== createHash('sha256').update(caseBytes).digest('hex') || !Array.isArray(receipt.checks)) throw new Error('synthetic_attestation_invalid');
  const expected = new Set<string>();
  const ids = new Set<string>();
  for (const item of fixture.cases) {
    if (!item || typeof item.id !== 'string' || !/^[a-z0-9_-]{1,80}$/u.test(item.id) || ids.has(item.id) || typeof item.question !== 'string' || !item.question || item.question.length > 4000 || !item.oracle || typeof item.oracle !== 'object') throw new Error('synthetic_case_invalid');
    ids.add(item.id);
    const o = item.oracle;
    const dates = o.kind === 'clarification' ? [] : o.kind === 'daily_comparison' ? [o.first_date, o.second_date] : ['daily_sum', 'dimension_cost_group', 'channel_cpi', 'cohort_retention'].includes(o.kind) ? [o.date] : null;
    if (!dates || dates.some((day: unknown) => typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(day)) || new Set(dates).size !== dates.length) throw new Error('synthetic_case_scope_invalid');
    for (const day of dates) expected.add(JSON.stringify([item.id, day]));
  }
  const actual = new Set<string>();
  for (const check of receipt.checks) {
    const key = JSON.stringify([check?.id, check?.date]);
    if (check?.matched !== true || !expected.has(key) || actual.has(key)) throw new Error('synthetic_attestation_invalid');
    actual.add(key);
  }
  if (actual.size !== expected.size) throw new Error('synthetic_attestation_incomplete');
  return fixture as { cases: Array<{ id: string; question: string; oracle: Record<string, unknown> }>; dataset_version: string; as_of: string };
}

/** Conservative automatic review of generated single-day questions. It never
 * accepts model prose as evidence, and leaves unsupported shapes for review. */
export function assessSyntheticDaily(oracle: Record<string, any>, job: Record<string, any>, resources: Array<Record<string, any>>, datasetVersion?: string): { verdict: 'correct' | 'partial' | 'pending'; reason: string } {
  if (oracle.kind !== 'daily_sum' || !job.analysis || !Array.isArray(job.analysis.calculations) || !Array.isArray(job.analysis.sources)) return { verdict: 'pending', reason: '此题型或结果需要人工核对。' };
  const expected = normalizeDecimal(String(oracle.value));
  if (expected === null) return { verdict: 'pending', reason: '独立预期不是有效的精确数值。' };
  const cells = job.analysis.calculations.flatMap((calculation: any) => calculation.verified_decimal_cells ?? []);
  for (const cell of cells) {
    const filters = cell.filters ?? {};
    const versionMatches = filters.dataset_version === undefined ||
      (typeof datasetVersion === 'string' && /^sv_[a-f0-9]{20}$/u.test(datasetVersion) && filters.dataset_version === datasetVersion);
    if (cell.table !== oracle.table || cell.column !== oracle.column || cell.unit !== oracle.unit || filters.app_id !== oracle.app_id || !versionMatches || Object.keys(filters).some((key) => key !== 'app_id' && key !== 'dataset_version') || cell.range?.start !== oracle.date || cell.range?.end !== oracle.date || cell.range?.timezone !== 'UTC' || cell.prediction !== 'actual_observed_only' || normalizeDecimal(String(cell.value)) !== expected) continue;
    const source = resources.find((item) => item.resource_id === cell.source_resource_id);
    const deliverySource = job.analysis.sources.find((item: any) => item.resource_id === cell.source_resource_id && item.evidence_eligible);
    if (!source || !deliverySource || source.kind !== 'query_result' || source.job_id !== job.job_id || source.session_id !== job.session_id || source.truncated || !source.complete_population || source.time_range?.start !== oracle.date || source.time_range?.end !== oracle.date || !Array.isArray(source.rows) || !source.rows.length || source.rows.length !== oracle.rows || !source.coverage || coverageHasGap(source.coverage) || source.coverage.unknown_prediction_dates?.length || !source.freshness_receipts?.some((receipt: any) => receipt.table === oracle.table && receipt.status === 'fresh')) continue;
    const values = source.rows.map((row: Record<string, unknown>) => row[oracle.column]);
    if (values.some((value: unknown) => value === null || value === undefined || (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))))) continue;
    const scale = String(oracle.value).split('.')[1]?.length ?? 0;
    const total = sumDecimals(values.map(String), scale);
    if (total === null || normalizeDecimal(total) !== expected) continue;
    const line = String(job.analysis.answer ?? '').split('\n').find((text: string) => text.includes(cell.source_resource_id) && text.includes(cell.column) && text.includes(String(cell.value)));
    if (!line) continue;
    return job.status === 'completed' ? { verdict: 'correct', reason: '独立合成数据、当前任务完整来源和正式证据的指标、范围、单位与数值一致。' } : { verdict: 'partial', reason: '已核验数值与独立预期一致；任务仍有其他限制，保留部分完成。' };
  }
  return { verdict: job.status === 'partial' ? 'partial' : 'pending', reason: '尚未找到与独立预期及当前任务完整来源一致的正式证据。' };
}
