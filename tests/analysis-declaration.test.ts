import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { DEMO_QUESTIONS } from "../src/demo.js";
import { startServer } from "../src/server.js";
import { analyst, ask, bindTables, withRuntime } from "./helpers.js";
import type { AnalysisRecord, QueryResource } from "../src/types.js";

const sql = "SELECT event_date, country_code, new_users FROM daily_installs WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-06' AND product_id = 'starlane_drift' AND platform = 'ios' AND channel = 'nebula_ads'";

test("模型工作记录与核验单元分离，伪造摘录、执行号和跨任务来源不能交付", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    runtime.sessions.setActiveJob(session.session_id, "job_declaration");
    const query = await runtime.tools.query(session.session_id, { sql });
    assert.equal(query.ok, true, JSON.stringify(query)); if (!query.ok) return;
    const asset = runtime.knowledge.by_id.get("metric.new_users")!;
    const row = (query.rows as Array<{ country_code: string }>).findIndex((item) => item.country_code === "US");
    const base = { scope: "模型假设：不存在的地区", grain: "模型自报", expected_group_keys: ["country_code"], unresolved_questions: ["是否需要其他地区？"], assumptions: ["尚待确认"], source_excerpts: [{ asset_id: asset.asset_id, content_hash: asset.content_hash, quote: asset.body.slice(0, 12) }], result_cells: [{ resource_id: String(query.resource_id), execution_id: String(query.execution_id), row, column: "new_users" }] };
    const deliver = (declaration: typeof base) => runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(query.resource_id)], declaration });
    const result = await deliver(base);
    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) {
      assert.doesNotMatch(String(result.answer), /不存在的地区/);
      const record = result.analysis_declaration as { provenance: string; excerpts_checked: number; verified_cells: Array<{ value: string; field: string }> };
      assert.equal(record.provenance, "model_declared"); assert.equal(record.excerpts_checked, 1);
      assert.equal(record.verified_cells[0]?.value, "120"); assert.match(record.verified_cells[0]?.field ?? "", /daily_installs\.new_users/);
      const candidate = result as unknown as AnalysisRecord;
      assert.equal(await runtime.tools.revalidateAnalysis(session.session_id, "job_declaration", candidate), true);
      const saved = runtime.sessions.lookupResource(session.session_id, String(query.resource_id));
      assert.ok(saved.ok && saved.resource.kind === "query_result");
      if (saved.ok && saved.resource.kind === "query_result") {
        const changed = structuredClone(saved.resource) as QueryResource;
        changed.rows[row]!.new_users = 999;
        runtime.state.saveResource(changed);
        assert.equal(await runtime.tools.revalidateAnalysis(session.session_id, "job_declaration", candidate), false);
        runtime.state.saveResource(saved.resource);
      }
    }
    assert.equal((await deliver({ ...base, source_excerpts: [{ ...base.source_excerpts[0]!, quote: "并不存在的知识原文" }] })).ok, false);
    assert.equal((await deliver({ ...base, result_cells: [{ ...base.result_cells[0]!, execution_id: "forged" }] })).ok, false);
    assert.equal((await deliver({ ...base, result_cells: [{ ...base.result_cells[0]!, row: 999 }] })).ok, false);
    runtime.sessions.setActiveJob(session.session_id, "different_job");
    const cross = await deliver(base); assert.equal(cross.ok, false);
  });
});

test("契约文件变化时，已保存资源读取、计算与交付失败关闭", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "synthetic-knowledge-recheck-"));
  try {
    const knowledgeDir = path.join(root, "knowledge");
    cpSync(path.resolve("knowledge/lumenfox"), knowledgeDir, { recursive: true });
    await withRuntime({ knowledgeDir }, async (runtime) => {
      const session = analyst(runtime); await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
      runtime.sessions.setActiveJob(session.session_id, "job_recheck");
      const query = await runtime.tools.query(session.session_id, { sql });
      assert.equal(query.ok, true, JSON.stringify(query)); if (!query.ok) return;
      appendFileSync(path.join(knowledgeDir, "contracts", "daily-installs.json"), "\n");
      const page = await runtime.tools.readSessionResource(session.session_id, { resource_id: String(query.resource_id) });
      assert.equal(page.ok, false); if (!page.ok) assert.equal(page.code, "resource_authorization_changed");
      const calculation = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: String(query.resource_id), operations: [{ op: "count_rows", as: "count" }] });
      assert.equal(calculation.ok, false);
      const answer = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(query.resource_id)] });
      assert.equal(answer.ok, false); if (!answer.ok) assert.equal(answer.code, "knowledge_source_changed");
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("权限文件变化后，即使持有旧资源与候选也不能读取或提交", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "synthetic-policy-recheck-"));
  try {
    const knowledgeDir = path.join(root, "knowledge");
    cpSync(path.resolve("knowledge/lumenfox"), knowledgeDir, { recursive: true });
    await withRuntime({ knowledgeDir }, async (runtime) => {
      const session = analyst(runtime); await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
      runtime.sessions.setActiveJob(session.session_id, "job_policy");
      const query = await runtime.tools.query(session.session_id, { sql });
      assert.equal(query.ok, true); if (!query.ok) return;
      const candidate = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(query.resource_id)] });
      assert.equal(candidate.ok, true); if (!candidate.ok) return;
      assert.equal(await runtime.tools.revalidateAnalysis(session.session_id, "job_policy", candidate as unknown as AnalysisRecord), true);
      appendFileSync(path.join(knowledgeDir, "policy.json"), "\n");
      assert.equal(await runtime.tools.revalidateAnalysis(session.session_id, "job_policy", candidate as unknown as AnalysisRecord), false);
      assert.equal((await runtime.tools.readSessionResource(session.session_id, { resource_id: String(query.resource_id) })).ok, false);
      assert.equal((await runtime.tools.readAsset(session.session_id, { asset_id: "metric.new_users" })).ok, false);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("历史 API 在权限文件变化后隐藏旧答案，但不改写保存记录", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "synthetic-history-access-"));
  try {
    const knowledgeDir = path.join(root, "knowledge");
    cpSync(path.resolve("knowledge/lumenfox"), knowledgeDir, { recursive: true });
    await withRuntime({ knowledgeDir }, async (runtime) => {
      const session = analyst(runtime); const job = await ask(runtime, session.session_id, DEMO_QUESTIONS[0]!.text);
      assert.ok(job.analysis);
      const server = startServer(runtime);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      try {
        const before = await (await fetch(`http://127.0.0.1:${port}/api/jobs/${job.job_id}`)).json() as { analysis: unknown };
        assert.ok(before.analysis);
        appendFileSync(path.join(knowledgeDir, "policy.json"), "\n");
        const after = await (await fetch(`http://127.0.0.1:${port}/api/jobs/${job.job_id}`)).json() as { analysis: unknown; error: { code: string }; user_text: string };
        assert.equal(after.analysis, null); assert.equal(after.error.code, "analysis_access_changed"); assert.equal(after.user_text, DEMO_QUESTIONS[0]!.text);
        const list = await (await fetch(`http://127.0.0.1:${port}/api/sessions/${session.session_id}`)).json() as { jobs: Array<{ analysis: unknown }> };
        assert.equal(list.jobs[0]?.analysis, null);
        assert.ok(runtime.state.getJob(job.job_id)?.analysis, "原始历史不得改写");
      } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
