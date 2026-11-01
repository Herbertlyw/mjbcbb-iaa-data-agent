import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { isTerminal, type JobRecord } from "../src/types.js";
import type { AppConfig } from "../src/config.js";

export async function withRuntime(
  overrides: Partial<AppConfig>,
  fn: (runtime: Runtime) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "lumenfox-"));
  const runtime = createRuntime({
    databasePath: path.join(dir, "business.sqlite"),
    stateDatabasePath: path.join(dir, "state.sqlite"),
    freshnessPath: path.join(dir, "freshness-current.json"),
    ephemeralDir: dir,
    ...overrides,
  });
  try {
    await fn(runtime);
  } finally {
    await runtime.close();
  }
}

export function analyst(runtime: Runtime) {
  return runtime.sessions.create("analyst");
}

export function openRuntime(dir: string, overrides: Partial<AppConfig> = {}): Runtime {
  return createRuntime({
    databasePath: path.join(dir, "business.sqlite"),
    stateDatabasePath: path.join(dir, "state.sqlite"),
    freshnessPath: path.join(dir, "freshness-current.json"),
    ephemeralDir: undefined,
    ...overrides,
  });
}

export async function bindTables(runtime: Runtime, sessionId: string, assetIds: string[]): Promise<void> {
  for (const assetId of assetIds) {
    const result = await runtime.tools.readDataContractView(sessionId, { asset_id: assetId });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
}

export async function waitForJob(runtime: Runtime, jobId: string, timeoutMs = 20000): Promise<JobRecord> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = runtime.jobs.require(jobId);
    if (isTerminal(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`任务没有结束：${runtime.jobs.require(jobId).status}`);
}

export async function ask(
  runtime: Runtime,
  sessionId: string,
  text: string,
  key?: string,
  selection?: { modelId?: string; reasoning?: string },
): Promise<JobRecord> {
  const job = runtime.jobs.submit(sessionId, text, key ?? crypto.randomUUID(), selection);
  return waitForJob(runtime, job.job_id);
}
