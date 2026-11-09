import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const run = promisify(execFile);

test('合成题目从公开行独立求和，NULL 和不完整行不会冒充标准答案', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vv-eval-generator-'));
  const write = (file: string, data: unknown) => writeFile(path.join(dir, file), typeof data === 'string' ? data : JSON.stringify(data));
  try {
    await write('manifest.json', { dataset_version: 'synthetic-test', as_of: '2026-11-08' });
    await write('dim_app.jsonl', JSON.stringify({ dataset_version: 'synthetic-test', app_id: 'demo_ios', game_name: '演示', game_id: 'demo', platform: 'ios' }) + '\n');
    const activity = [{ app_id: 'demo_ios', activity_date: '2026-11-01', active_devices: 2, ad_revenue_usd: '0.100001', sessions: 7, game_count: 4, gameplay_seconds: 120, completeness_state: 'complete' }, { app_id: 'demo_ios', activity_date: '2026-11-01', active_devices: 3, ad_revenue_usd: '0.200002', sessions: 11, game_count: 2, gameplay_seconds: 40, completeness_state: 'complete' }, { app_id: 'demo_ios', activity_date: '2026-11-02', active_devices: null, ad_revenue_usd: null, sessions: null, game_count: 999, gameplay_seconds: 999, completeness_state: 'partial' }];
    await write('fact_activity_daily.jsonl', activity.map(x => JSON.stringify(x)).join('\n') + '\n');
    await write('fact_acquisition_daily.jsonl', JSON.stringify({ app_id: 'demo_ios', cohort_date: '2026-11-01', first_install_devices: 4, unique_install_events: 5, reinstall_events: 1, late_install_events: 0, completeness_state: 'complete' }) + '\n');
    await write('fact_delivery_daily.jsonl', JSON.stringify({ app_id: 'demo_ios', business_date: '2026-11-01', ua_channel_id: 'fictional', af_registers: 0, discounted_cost_usd: '0.300003', completeness_state: 'complete' }) + '\n');
    const tables: Record<string, { sha256: string; bytes: number }> = {};
    for (const name of ['dim_app', 'fact_activity_daily', 'fact_acquisition_daily', 'fact_delivery_daily']) {
      const content = await readFile(path.join(dir, `${name}.jsonl`));
      tables[name] = { sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length };
    }
    await write('manifest.json', { dataset_version: 'synthetic-test', as_of: '2026-11-08', tables });
    const out = path.join(dir, 'output.json');
    const args = ['scripts/generate-synthetic-evals.py', '--dataset', dir, '--seed', '7', '--output', out];
    await run('python3', args);
    const result = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(result.cases[0].oracle.value, '5');
    assert.equal(result.cases[1].oracle.value, '0.300003');
    assert.equal(result.cases[2].oracle.value, '4');
    for (const [field, value, unit] of [['sessions', '18', '计数'], ['game_count', '6', '局'], ['gameplay_seconds', '160', '秒'], ['unique_install_events', '5', '安装事件'], ['reinstall_events', '1', '安装事件'], ['late_install_events', '0', '安装事件']]) {
      const item = result.cases.find((c: any) => c.oracle.column === field);
      assert.equal(item?.oracle.value, value); assert.equal(item?.oracle.unit, unit); assert.equal(item?.oracle.date, '2026-11-01');
    }
    assert.equal(result.cases.find((c: any) => c.oracle.kind === 'dimension_cost_group').oracle.groups[0].discounted_cost_usd, '0.300003');
    assert.equal(result.cases.find((c: any) => c.oracle.kind === 'channel_cpi').oracle.groups[0].cpi_usd_per_register, null);
    assert.equal(result.cases[0].oracle.date, '2026-11-01');
    assert.equal(result.cases.at(-1).oracle.kind, 'clarification');
    await assert.rejects(run('python3', args));
    result.cases[0].oracle.value = '999';
    await write('tampered.json', result);
    await write('reader.json', { url: 'http://127.0.0.1:1', username: 'starhaven_preflight_0123456789_reader', password: 'fictional', database: 'starhaven_preflight_0123456789' });
    await assert.rejects(run('python3', ['scripts/check-synthetic-evals.py', '--dataset', dir, '--cases', path.join(dir, 'tampered.json'), '--reader-file', path.join(dir, 'reader.json'), '--output', path.join(dir, 'checked.json')], { env: { ...process.env, PYTHONPATH: process.cwd() } }), (error: any) => /oracle_value_mismatch/.test(error.stderr));
    await write('fact_activity_daily.jsonl', activity.slice(0, 1).map(x => JSON.stringify(x)).join('\n') + '\n');
    await assert.rejects(run('python3', ['scripts/check-synthetic-evals.py', '--dataset', dir, '--cases', out, '--reader-file', path.join(dir, 'reader.json'), '--output', path.join(dir, 'checked.json')], { env: { ...process.env, PYTHONPATH: process.cwd() } }), (error: any) => /dataset_file_fingerprint_mismatch/.test(error.stderr));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
