import assert from "node:assert/strict";
import test from "node:test";
import { analyst, openRuntime, withRuntime } from "./helpers.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("修订次数写在任务上，旧围栏不能增加，新运行时也不会从零开始", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lumenfox-revision-"));
  const runtime = openRuntime(dir, { startWorker: false });
  const session = analyst(runtime);
  const job = runtime.jobs.submit(session.session_id, "修订持久化", "revision-key");
  const claim = runtime.state.claimJob(job.job_id, "worker-a", Date.now(), 60_000);
  assert.ok(claim);
  const first = runtime.state.reserveRevision(job.job_id, "worker-a", claim.fence);
  const second = runtime.state.reserveRevision(job.job_id, "worker-a", claim.fence);
  assert.equal(first.ok, true);
  assert.equal(first.count, 1);
  assert.equal(second.ok, true);
  assert.equal(second.count, 2);
  const stale = runtime.state.reserveRevision(job.job_id, "worker-a", claim.fence - 1);
  assert.equal(stale.ok, false);
  assert.equal(stale.count, 2);
  await runtime.close({ abandon: true });

  const again = openRuntime(dir, { startWorker: false, reseedDatabase: false, publishFreshnessOnStart: false });
  const third = again.state.reserveRevision(job.job_id, "worker-a", claim.fence);
  assert.equal(third.ok, true);
  assert.equal(third.count, 3);
  await again.close({ abandon: true });
});

test("直接工具调用没有围栏时仍使用进程内计数，避免把测试路径写进任务", async () => {
  await withRuntime({ startWorker: false }, async (runtime) => {
    const session = analyst(runtime);
    assert.equal(await runtime.sessions.consumeRevision("job_missing"), "memory");
  });
});
