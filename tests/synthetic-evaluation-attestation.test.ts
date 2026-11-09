import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assessSyntheticDaily, markInterruptedEvaluations, repeatedToolFailure, validateSyntheticEvaluationAttestation, waitForProviderSettlements } from '../src/synthetic-evaluation.js';

test('取消后的账本结算有界等待，不把未知结算当成零', async () => {
  let calls = 0;
  const settled = await waitForProviderSettlements(async () => ++calls === 1 ? [{ status: 'dispatched', settlement: 'pending', global_state: 'dispatched' }] : [{ status: 'completed', settlement: 'settled', global_state: 'settled' }], 100, 1);
  assert.equal(settled.timedOut, false); assert.equal(calls, 2);
  const timeout = await waitForProviderSettlements(async () => [{ status: 'dispatched', settlement: 'pending', global_state: 'dispatched' }], 0);
  assert.equal(timeout.timedOut, true); assert.equal(timeout.steps[0]!.settlement, 'pending');
  const unknown = await waitForProviderSettlements(async () => [{ status: 'outcome_unknown', settlement: 'held_unknown', global_state: 'held_unknown' }], 0);
  assert.equal(unknown.timedOut, false); assert.equal(unknown.steps[0]!.global_state, 'held_unknown');
});

test('评测意外退出时未启动与用量未知任务明确标记，不覆盖已完成结果', () => {
  const records = [{ verdict: 'pending', dispatched: 0 }, { verdict: 'running', dispatched: 2 }, { verdict: 'correct', dispatched: 1 }];
  markInterruptedEvaluations(records);
  assert.deepEqual(records.map((record) => record.verdict), ['not_started', 'failed', 'correct']);
  assert.deepEqual(records.map((record) => record.dispatched), [0, null, 1]);
});

test('连续三次或近期四次同工具同错误触发停止，少量错误或不同工具不触发', () => {
  const failure = (code: string, name = 'query') => ({ type: 'tool_finished', payload: { tool_name: name, is_error: true, code } });
  const bad = failure('column_not_in_contract');
  assert.equal(repeatedToolFailure([bad, { type: 'model_context' }, bad, bad]), 'column_not_in_contract');
  assert.equal(repeatedToolFailure([bad, failure('other'), bad]), null);
  assert.equal(repeatedToolFailure([bad, { type: 'tool_finished', payload: { tool_name: 'query', is_error: false } }, bad]), null);
  assert.equal(repeatedToolFailure([bad, bad, failure('column_not_in_contract', 'other')]), null);
  assert.equal(repeatedToolFailure([bad, bad, failure('not safe')]), null);
  const success = { type: 'tool_finished', payload: { tool_name: 'read_session_resource', is_error: false } };
  assert.equal(repeatedToolFailure([bad, success, bad, success, bad, success, bad]), 'column_not_in_contract');
  assert.equal(repeatedToolFailure([bad, success, bad, success, bad, success]), null, '最后一次成功不应中断');
  assert.equal(repeatedToolFailure([bad, bad, bad, ...Array(10).fill(success), bad]), null, '久远错误不应被无限累计');
});

test('评测只接受完整覆盖且绑定精确题目文件的独立对账回执', () => {
  const fixture = { schema: 'synthetic-eval-cases-v1', dataset_version: 'sv_0123456789abcdef0123', as_of: '2026-11-08', cases: [
    { id: 'daily-1', question: '虚构日活？', oracle: { kind: 'daily_sum', date: '2026-11-01' } },
    { id: 'compare-1', question: '虚构比较？', oracle: { kind: 'daily_comparison', first_date: '2026-11-01', second_date: '2026-11-03' } },
    { id: 'retention-1', question: '虚构留存？', oracle: { kind: 'cohort_retention', date: '2026-10-20' } },
    { id: 'clarify-1', question: '收入？', oracle: { kind: 'clarification' } },
  ] };
  const bytes = Buffer.from(JSON.stringify(fixture));
  const report = { schema: 'synthetic-eval-check-v1', dataset_version: fixture.dataset_version, cases_sha256: createHash('sha256').update(bytes).digest('hex'), checks: [
    { id: 'daily-1', date: '2026-11-01', matched: true }, { id: 'compare-1', date: '2026-11-01', matched: true }, { id: 'compare-1', date: '2026-11-03', matched: true },
    { id: 'retention-1', date: '2026-10-20', matched: true },
  ] };
  assert.equal(validateSyntheticEvaluationAttestation(bytes, report).cases.length, 4);
  assert.throws(() => validateSyntheticEvaluationAttestation(Buffer.from(bytes.toString()+' '), report), /attestation_invalid/);
  assert.throws(() => validateSyntheticEvaluationAttestation(bytes, { ...report, checks: report.checks.slice(0, 2) }), /attestation_incomplete/);
  assert.throws(() => validateSyntheticEvaluationAttestation(bytes, { ...report, checks: [...report.checks, report.checks[0]] }), /attestation_invalid/);
  assert.throws(() => validateSyntheticEvaluationAttestation(bytes, { ...report, checks: report.checks.map((c, i) => i ? c : { ...c, matched: false }) }), /attestation_invalid/);
});

test('自动判题要求正式证据与独立数值、范围、单位和当前任务同时匹配', () => {
  const oracle = { kind: 'daily_sum', table: 'fact_activity_daily', column: 'active_devices', unit: '设备×App', app_id: 'demo_ios', date: '2026-11-01', value: '3', rows: 2 };
  const cell = { table: oracle.table, column: oracle.column, unit: oracle.unit, filters: { app_id: oracle.app_id }, range: { start: oracle.date, end: oracle.date, timezone: 'UTC' }, prediction: 'actual_observed_only', value: '3', source_resource_id: 'source' };
  const source = { resource_id: 'source', kind: 'query_result', job_id: 'job', session_id: 'session', truncated: false, complete_population: true, time_range: { start: oracle.date, end: oracle.date }, rows: [{ active_devices: '1' }, { active_devices: '2' }], coverage: { status: 'known', absent_dates: [], null_dates: [], predicted_dates: [], unknown_prediction_dates: [], groups: [] }, freshness_receipts: [{ table: oracle.table, status: 'fresh' }] };
  const job = { job_id: 'job', session_id: 'session', status: 'completed', analysis: { answer: 'fact_activity_daily.active_devices 合计 3；来源 source', sources: [{ resource_id: 'source', evidence_eligible: true }], calculations: [{ verified_decimal_cells: [cell] }] } };
  assert.equal(assessSyntheticDaily(oracle, job, [source]).verdict, 'correct');
  assert.equal(assessSyntheticDaily(oracle, { ...job, status: 'partial' }, [source]).verdict, 'partial');
  for (const changed of [
    { ...source, job_id: 'other' }, { ...source, truncated: true }, { ...source, rows: [{ active_devices: '1' }, { active_devices: null }] },
    { ...source, rows: [{ active_devices: '1' }, { active_devices: '3' }] }, { ...source, freshness_receipts: [] },
  ]) assert.equal(assessSyntheticDaily(oracle, job, [changed]).verdict, 'pending');
  assert.equal(assessSyntheticDaily({ ...oracle, unit: '人' }, job, [source]).verdict, 'pending');
  assert.equal(assessSyntheticDaily(oracle, { ...job, analysis: { ...job.analysis, answer: '模型草稿说 3' } }, [source]).verdict, 'pending');
  assert.equal(assessSyntheticDaily(oracle, { ...job, analysis: { ...job.analysis, calculations: [{ verified_decimal_cells: [{ ...cell, filters: { app_id: oracle.app_id, country: 'JP' } }] }] } }, [source]).verdict, 'pending');
  const version = 'sv_0123456789abcdef0123';
  const withVersion = { ...job, analysis: { ...job.analysis, calculations: [{ verified_decimal_cells: [{ ...cell, filters: { app_id: oracle.app_id, dataset_version: version } }] }] } };
  assert.equal(assessSyntheticDaily(oracle, withVersion, [source], version).verdict, 'correct');
  assert.equal(assessSyntheticDaily(oracle, withVersion, [source]).verdict, 'pending');
  assert.equal(assessSyntheticDaily(oracle, withVersion, [source], 'sv_aaaaaaaaaaaaaaaaaaaa').verdict, 'pending');
  assert.equal(assessSyntheticDaily(oracle, withVersion, [source], 'not-a-synthetic-version').verdict, 'pending');
  const narrowed = { ...job, analysis: { ...job.analysis, calculations: [{ verified_decimal_cells: [{ ...cell, filters: { app_id: oracle.app_id, dataset_version: version, country: 'JP' } }] }] } };
  assert.equal(assessSyntheticDaily(oracle, narrowed, [source], version).verdict, 'pending');
});
