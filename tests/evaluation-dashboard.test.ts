import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { displayStatus } from '../src/evaluation-dashboard/status.js';

test('未启动记录和已派发失败分开显示，旧记录不需改写', () => {
  const judgement = '评测在此题启动前中断，未创建此题任务。';
  assert.equal(displayStatus({ verdict: 'not_started', dispatched: 0 }), 'not_started');
  assert.equal(displayStatus({ verdict: 'failed', dispatched: 0, steps: [], judgement }), 'not_started');
  assert.equal(displayStatus({ verdict: 'failed', dispatched: 1, steps: [], judgement }), 'failed');
  assert.equal(displayStatus({ verdict: 'failed', dispatched: null, steps: [], judgement }), 'failed');
  assert.equal(displayStatus({ verdict: 'failed', dispatched: 0, job_id: 'job_1', steps: [], judgement }), 'failed');
  assert.equal(displayStatus({ verdict: 'failed', dispatched: 0, steps: [], judgement: '供应商失败' }), 'failed');
});

test('本地评测页只读合成记录，拒绝越界、跨站与非 GET', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vv-eval-view-'));
  const sample = { schema: 'synthetic-eval-run-v1', synthetic: true, records: [{ id: 'a', question: '<script>alert(1)</script>', dispatched: 1, steps: [{ input_tokens: null }] }] };
  await writeFile(path.join(dir, 'valid.json'), JSON.stringify(sample));
  await writeFile(path.join(dir, 'private.json'), JSON.stringify({ schema: 'unknown', records: [{ secret: 'never' }] }));
  await symlink(path.join(dir, 'valid.json'), path.join(dir, 'link.json'));
  const child = spawn(process.execPath, ['scripts/evaluation-dashboard.mjs'], { env: { ...process.env, EVAL_RECORD_DIR: dir, EVAL_DASHBOARD_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const reader = createInterface({ input: child.stdout });
    const [line] = await once(reader, 'line') as [string];
    const base = line.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; assert.ok(base);
    const data = await (await fetch(`${base}/api/runs`)).json() as { runs: Array<{ id: string; records: Array<{ question: string }> }> };
    assert.deepEqual(data.runs.map(r => r.id), ['valid']);
    assert.equal(data.runs[0]!.records[0]!.question, '<script>alert(1)</script>');
    const js = await (await fetch(`${base}/app.js`)).text(); assert.match(js, /textContent/); assert.doesNotMatch(js, /innerHTML/);
    assert.equal((await fetch(`${base}/status.js`)).status, 200);
    const index = await fetch(base); assert.match(index.headers.get('content-security-policy')!, /default-src 'none'/);
    assert.equal((await fetch(`${base}/api/runs`, { headers: { origin: 'https://example.invalid' } })).status, 403);
    assert.equal((await fetch(`${base}/api/runs`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/../../private.json`)).status, 404);
  } finally { child.kill('SIGTERM'); await once(child, 'exit'); await rm(dir, { recursive: true, force: true }); }
});
