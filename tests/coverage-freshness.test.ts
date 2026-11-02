import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { modelPrompt } from "../src/agent.js";
import { assessCoverage, coverageHasGap, provenCoverageFilters } from "../src/coverage.js";
import { verifyCell } from "../src/evidence.js";
import { currentCalendarDate, isCalendarDate, loadConfig } from "../src/config.js";
import { DEMO_QUESTIONS } from "../src/demo.js";
import { publishFreshness, readPublication } from "../src/freshness.js";
import { planFromTranscript } from "../src/planner.js";
import { startServer } from "../src/server.js";
import { resolveTurn } from "../src/turn.js";
import type { CoverageReport, DataContract, QueryResource } from "../src/types.js";
import { analyst, ask, bindTables, withRuntime } from "./helpers.js";

const WEEK = "event_date >= '2026-10-06' AND event_date <= '2026-10-12'";

test("覆盖分组与日期组合超预算时返回未知，不用截断分组冒充完整", async () => {
  await withRuntime({}, async (runtime) => {
    const contract = runtime.knowledge.contract_by_table.get("daily_installs")?.contract;
    assert.ok(contract);
    const rows = Array.from({ length: 275 }, (_, index) => ({ event_date: "2026-01-01", product_id: "starlane_drift", platform: "ios", country_code: `S${index}`, channel: "nebula_ads", new_users: 1 }));
    const coverage = assessCoverage(contract, { product_id: "starlane_drift", platform: "ios", channel: "nebula_ads" }, { start: "2026-01-01", end: "2026-12-31" }, rows);
    assert.equal(coverage.status, "unknown");
    assert.match(coverage.reason, /超过预算/);
    assert.equal(coverageHasGap(coverage), true);
    assert.deepEqual(coverage.groups, []);
  });
});

test("多维组合各自缺日时不能被完整的单维覆盖掩盖", () => {
  const contract = JSON.parse(readFileSync(new URL("../knowledge/lumenfox/contracts/daily-installs.json", import.meta.url), "utf8")) as DataContract;
  const rows = [
    { event_date: "2026-10-06", country_code: "US", channel: "nebula_ads", new_users: 10 },
    { event_date: "2026-10-06", country_code: "JP", channel: "comet_network", new_users: 20 },
    { event_date: "2026-10-07", country_code: "US", channel: "comet_network", new_users: 30 },
    { event_date: "2026-10-07", country_code: "JP", channel: "nebula_ads", new_users: 40 },
  ];
  const report = assessCoverage(contract, { product_id: "starlane_drift", platform: "ios" }, { start: "2026-10-06", end: "2026-10-07" }, rows);
  assert.equal(report.groups.filter((group) => group.dimension === "country_code" || group.dimension === "channel").every((group) => group.absent_dates.length === 0), true);
  assert.equal(report.groups.filter((group) => group.dimension === "country_code,channel").length, 4);
  assert.equal(coverageHasGap(report), true);
});

test("当前日期使用显式时区，模拟时钟和无效日期有明确边界", () => {
  const instant = new Date("2026-01-01T01:00:00.000Z");
  assert.equal(currentCalendarDate({ simulatedToday: "" }, "America/Los_Angeles", instant), "2025-12-31");
  assert.equal(currentCalendarDate({ simulatedToday: "" }, "Asia/Shanghai", instant), "2026-01-01");
  assert.equal(currentCalendarDate({ simulatedToday: "2026-10-29" }, "Asia/Shanghai", instant), "2026-10-29");
  assert.equal(isCalendarDate("2026-02-30"), false);
  assert.equal(isCalendarDate("2024-02-29"), true);
  assert.throws(() => loadConfig({ simulatedToday: "2026-02-30" }), /SIMULATED_TODAY/);
});

test("覆盖统计只接受能证明与主查询完全一致的筛选", async () => {
  const contract = JSON.parse(readFileSync(new URL("../knowledge/lumenfox/contracts/daily-installs.json", import.meta.url), "utf8")) as DataContract;
  const range = { start: "2026-10-06", end: "2026-10-12" };
  const base = `SELECT event_date, new_users FROM daily_installs WHERE ${WEEK}`;
  assert.deepEqual(provenCoverageFilters(`${base} AND country_code = 'US'`, contract, range), { country_code: "US" });
  for (const suffix of [" AND new_users > 0", " AND country_code IN ('US', 'JP')", " AND (country_code = 'US' OR country_code = 'JP')", " AND country_code = 'US' AND country_code = 'JP'", " LIMIT 3"]) {
    assert.equal(provenCoverageFilters(base + suffix, contract, range), null, suffix);
  }
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    const result = await runtime.tools.query(session.session_id, { sql: `${base} AND new_users > 0` });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal((result.coverage as CoverageReport).status, "unknown");
    const invalid = await runtime.tools.query(session.session_id, { sql: "SELECT event_date, new_users FROM daily_installs WHERE event_date >= '2026-02-30' AND event_date <= '2026-03-03'" });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.code, "invalid_date_range");
  });
});

test("同一天的 NULL、零、实际和预测分别记录；无映射不推断实际", () => {
  const contract = JSON.parse(readFileSync(new URL("../knowledge/harborlight/contracts/fact_fox_ad_receipt.json", import.meta.url), "utf8")) as DataContract;
  const range = { start: "2026-10-06", end: "2026-10-06" };
  const mixed = assessCoverage(contract, { title_id: "paper_lantern", platform: "ios", country_code: "US" }, range, [
    { event_date: "2026-10-06", revenue_usd: 0, is_predicted: 0 },
    { event_date: "2026-10-06", revenue_usd: null, is_predicted: 1 },
  ]);
  assert.deepEqual(mixed.zero_dates, ["2026-10-06"]);
  assert.deepEqual(mixed.null_dates, ["2026-10-06"]);
  assert.deepEqual(mixed.actual_dates, ["2026-10-06"]);
  assert.deepEqual(mixed.predicted_dates, ["2026-10-06"]);
  const unknown = assessCoverage({ ...contract, series: { ...contract.series!, predicted_column: null, prediction_values: undefined, prediction_mode: undefined } }, {}, range, [{ event_date: "2026-10-06", revenue_usd: 0 }]);
  assert.deepEqual(unknown.zero_dates, ["2026-10-06"]);
  assert.deepEqual(unknown.actual_dates, []);
  assert.deepEqual(unknown.predicted_dates, []);
  assert.deepEqual(unknown.unknown_prediction_dates, ["2026-10-06"]);
});

test("未声明预测语义时不能把全部记录当成实际或预测", () => {
  const original = JSON.parse(readFileSync(new URL("../knowledge/harborlight/contracts/fact_fox_daily_install.json", import.meta.url), "utf8")) as DataContract;
  const contract: DataContract = { ...original, series: { ...original.series!, prediction_mode: undefined } };
  const source = {
    resource_id: "res_synthetic", tables: [contract.table], sql: "SELECT event_date, country_code, new_users FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-06' AND country_code = 'JP'",
    time_range: { start: "2026-10-06", end: "2026-10-06", timezone: contract.timezone }, rows: [{ event_date: "2026-10-06", country_code: "JP", new_users: 70 }], truncated: false, complete_population: true,
  } as unknown as QueryResource;
  const operation = { op: "sum" as const, column: "new_users", as: "model_alias" };
  assert.equal(verifyCell(source, contract, { ...operation, predicted: "actual_only" }, 70), null);
  assert.equal(verifyCell(source, contract, { ...operation, predicted: "predicted_only" }, 70), null);
  assert.match(verifyCell(source, contract, operation, 70)?.prediction ?? "", /未验证/);
  assert.match(verifyCell(source, original, { ...operation, predicted: "actual_only" }, 70)?.prediction ?? "", /契约声明仅观察值/);
});

test("无记录、NULL、真实零、预测和未知覆盖分开", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs", "contract.daily_ad_revenue", "contract.daily_unit_economics"]);
    const absent = await runtime.tools.query(session.session_id, {
      sql: `SELECT event_date, product_id, platform, country_code, channel, spend_usd, payback_usd, is_predicted FROM daily_unit_economics WHERE ${WEEK} AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'US' AND channel = 'comet_network'`,
    });
    assert.equal(absent.ok, true);
    if (!absent.ok) return;
    const absentCoverage = absent.coverage as CoverageReport;
    assert.equal(absentCoverage.status, "known");
    assert.equal(absentCoverage.absent_dates.length, 6);
    assert.equal(absentCoverage.zero_dates.length, 0);
    assert.equal(absentCoverage.actual_dates.length, 1);

    runtime.sessions.setActiveJob(session.session_id, "job_empty");
    const empty = await runtime.tools.query(session.session_id, {
      sql: "SELECT event_date, product_id, platform, country_code, channel, new_users FROM daily_installs WHERE event_date >= '2026-01-01' AND event_date <= '2026-01-03' AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'US' AND channel = 'nebula_ads'",
    });
    assert.equal(empty.ok, true);
    if (!empty.ok) return;
    const emptyCoverage = empty.coverage as CoverageReport;
    assert.deepEqual(emptyCoverage.absent_dates, ["2026-01-01", "2026-01-02", "2026-01-03"]);
    const emptyAnalysis = await runtime.tools.updateAnalysis(session.session_id, {
      suggested_status: "completed",
      draft_answer: "模型把空窗口说成 0。",
      resource_ids: [String(empty.resource_id)],
    });
    assert.equal(emptyAnalysis.ok, true);
    if (!emptyAnalysis.ok) return;
    assert.equal(emptyAnalysis.status, "partial");
    assert.match(String(emptyAnalysis.answer), /无记录/);
    assert.doesNotMatch(String(emptyAnalysis.answer), /观测值为零/);

    runtime.sessions.setActiveJob(session.session_id, "job_zero");
    const zero = await runtime.tools.query(session.session_id, {
      sql: "SELECT event_date, product_id, platform, country_code, channel, new_users FROM daily_installs WHERE event_date >= '2026-10-07' AND event_date <= '2026-10-07' AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'US' AND channel = 'nebula_ads'",
    });
    assert.equal(zero.ok, true);
    if (!zero.ok) return;
    const zeroCoverage = zero.coverage as CoverageReport;
    assert.deepEqual(zeroCoverage.zero_dates, ["2026-10-07"]);
    assert.equal(zeroCoverage.absent_dates.length, 0);
    const zeroAnalysis = await runtime.tools.updateAnalysis(session.session_id, {
      suggested_status: "completed",
      draft_answer: "单日真实零。",
      resource_ids: [String(zero.resource_id)],
    });
    assert.equal(zeroAnalysis.ok, true);
    if (!zeroAnalysis.ok) return;
    assert.equal(zeroAnalysis.status, "completed");

    const crossMonth = await runtime.tools.query(session.session_id, {
      sql: "SELECT event_date, product_id, platform, country_code, channel, new_users FROM daily_installs WHERE event_date >= '2026-09-29' AND event_date <= '2026-10-06' AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'US' AND channel = 'nebula_ads'",
    });
    assert.equal(crossMonth.ok, true);
    if (!crossMonth.ok) return;
    const crossCoverage = crossMonth.coverage as CoverageReport;
    assert.equal(crossCoverage.expected_days, 8);
    assert.equal(crossCoverage.absent_dates.length, 0);
    assert.equal(crossCoverage.null_dates.length, 0);

    const predicted = await runtime.tools.query(session.session_id, {
      sql: "SELECT event_date, product_id, platform, country_code, revenue_usd, is_predicted FROM daily_ad_revenue WHERE event_date >= '2026-10-10' AND event_date <= '2026-10-10' AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'US'",
    });
    assert.equal(predicted.ok, true);
    if (!predicted.ok) return;
    const predictedCoverage = predicted.coverage as CoverageReport;
    assert.deepEqual(predictedCoverage.predicted_dates, ["2026-10-10"]);
    assert.equal(predictedCoverage.actual_dates.length, 0);

    const joined = await runtime.tools.query(session.session_id, {
      sql: `SELECT a.event_date, b.revenue_usd FROM daily_installs AS a JOIN daily_ad_revenue AS b ON a.event_date = b.event_date AND a.product_id = b.product_id AND a.platform = b.platform AND a.country_code = b.country_code WHERE a.event_date >= '2026-10-06' AND a.event_date <= '2026-10-12' AND b.event_date >= '2026-10-06' AND b.event_date <= '2026-10-12'`,
    });
    assert.equal(joined.ok, false);
    if (joined.ok) return;
    assert.equal(joined.code, "join_grain_mismatch");
    const installsCoverage = await runtime.tools.query(session.session_id, {
      sql: `SELECT event_date, product_id, platform, country_code, channel, new_users FROM daily_installs WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-12' AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'US' AND channel = 'nebula_ads'`,
    });
    assert.equal(installsCoverage.ok, true);
    if (!installsCoverage.ok) return;
    assert.equal((installsCoverage.coverage as CoverageReport).null_dates.includes("2026-10-09"), true);

    const comet = await ask(runtime, session.session_id, DEMO_QUESTIONS.find((item) => item.id === "comet-gap")?.text ?? "");
    assert.equal(comet.status, "partial");
    assert.match(comet.analysis?.answer ?? "", /无记录/);
    assert.match(comet.analysis?.answer ?? "", /5/);
    const nebula = await ask(runtime, session.session_id, "那星云渠道");
    assert.equal(nebula.turn.kind, "follow_up");
    assert.equal(nebula.turn.slots.channel, "nebula_ads");
    assert.equal(nebula.status, "partial");
    assert.match(nebula.analysis?.answer ?? "", /NULL|真实零|预测/);
    assert.equal((nebula.analysis?.sources[0]?.coverage.absent_dates.length ?? 1), 0);
  });
});

test("新鲜度只读已发布快照，版本变化后不能当成已验证事实", async () => {
  await withRuntime({ publishFreshnessOnStart: false }, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    const missing = await runtime.tools.query(session.session_id, {
      sql: `SELECT event_date, new_users FROM daily_installs WHERE ${WEEK} AND platform = 'ios'`,
    });
    assert.equal(missing.ok, false);
    if (missing.ok) return;
    assert.equal(missing.code, "freshness_not_published");
  });

  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    const publication = readPublication(runtime.config.freshnessPath);
    assert.ok(publication);
    if (!publication) return;
    publication.tables.daily_installs = { status: "probe_failed", as_of: null };
    writeFileSync(runtime.config.freshnessPath, JSON.stringify(publication));
    const probed = await runtime.tools.query(session.session_id, {
      sql: `SELECT event_date, new_users FROM daily_installs WHERE ${WEEK} AND platform = 'ios' AND country_code = 'US'`,
    });
    assert.equal(probed.ok, false);
    if (probed.ok) return;
    assert.equal(probed.code, "freshness_probe_failed");
    delete publication.tables.daily_installs;
    writeFileSync(runtime.config.freshnessPath, JSON.stringify(publication));
    const gone = await runtime.tools.query(session.session_id, {
      sql: `SELECT event_date, new_users FROM daily_installs WHERE ${WEEK} AND platform = 'ios' AND country_code = 'US'`,
    });
    assert.equal(gone.ok, false);
    if (gone.ok) return;
    assert.equal(gone.code, "freshness_table_missing");
    publication.tables.daily_installs = { status: "fresh", as_of: "2026-10-13T09:00:00-07:00" };
    publication.valid_until = "2020-01-01";
    writeFileSync(runtime.config.freshnessPath, JSON.stringify(publication));
    const expired = await runtime.tools.query(session.session_id, {
      sql: `SELECT event_date, new_users FROM daily_installs WHERE ${WEEK} AND platform = 'ios' AND country_code = 'US'`,
    });
    assert.equal(expired.ok, false);
    if (expired.ok) return;
    assert.equal(expired.code, "freshness_expired");
  });

  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    runtime.sessions.setActiveJob(session.session_id, "job_fresh");
    const queried = await runtime.tools.query(session.session_id, {
      sql: "SELECT event_date, product_id, platform, country_code, channel, new_users FROM daily_installs WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-06' AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'JP' AND channel = 'nebula_ads'",
    });
    assert.equal(queried.ok, true);
    if (!queried.ok) return;
    const before = (queried.freshness_receipts as Array<{ version: number }>)[0]?.version;
    publishFreshness(runtime.config.freshnessSourcePath, runtime.config.freshnessPath);
    const after = readPublication(runtime.config.freshnessPath);
    assert.notEqual(after?.version, before);
    const analysis = await runtime.tools.updateAnalysis(session.session_id, {
      suggested_status: "completed",
      draft_answer: "模型忽略了发布版本。",
      resource_ids: [String(queried.resource_id)],
    });
    assert.equal(analysis.ok, true);
    if (!analysis.ok) return;
    assert.equal(analysis.status, "partial");
    assert.ok((analysis.server_reasons as string[]).includes("freshness_version_changed"));
    assert.doesNotMatch(String(analysis.answer), /合计 10/);
    assert.deepEqual((analysis.sources as Array<{ rows: unknown[] }>)[0]?.rows, []);
  });
});

test("伪造资源、跨会话、自报完成、部分来源失败和修订耗尽", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    const other = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    await bindTables(runtime, other.session_id, ["contract.daily_installs"]);
    runtime.sessions.setActiveJob(session.session_id, "job_evidence");
    const forged = await runtime.tools.updateAnalysis(session.session_id, {
      suggested_status: "completed",
      draft_answer: "合计是 999999。",
      resource_ids: ["res_forged"],
    });
    assert.equal(forged.ok, false);
    if (forged.ok) return;
    assert.equal(forged.code, "evidence_feedback");
    const exhausted = await runtime.tools.updateAnalysis(session.session_id, {
      suggested_status: "completed",
      draft_answer: "合计是 999999。",
      resource_ids: ["res_forged"],
    });
    assert.equal(exhausted.ok, true);
    if (!exhausted.ok) return;
    assert.equal(exhausted.status, "partial");
    assert.ok((exhausted.server_reasons as string[]).includes("revision_exhausted"));
    assert.equal(String(exhausted.answer).includes("999999"), false);

    const queried = await runtime.tools.query(other.session_id, {
      sql: "SELECT event_date, product_id, platform, country_code, channel, new_users FROM daily_installs WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-06' AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'JP' AND channel = 'nebula_ads'",
    });
    assert.equal(queried.ok, true);
    if (!queried.ok) return;
    runtime.sessions.setActiveJob(session.session_id, "job_cross");
    const crossed = await runtime.tools.updateAnalysis(session.session_id, {
      suggested_status: "completed",
      draft_answer: "引用了别的会话。",
      resource_ids: [String(queried.resource_id)],
    });
    assert.equal(crossed.ok, false);
    if (crossed.ok) return;
    assert.equal(crossed.code, "evidence_feedback");
    assert.ok((crossed.server_reasons as string[]).includes("cross_session_resource"));
  });
});

test("部分查询失败时只提交成功资源", () => {
  const turn = resolveTurn(null, "Starlane Drift 在 2026-10-06 到 2026-10-12（日本、iOS）的新增用户和广告收入是多少？");
  const message = planFromTranscript({
    messages: [
      { role: "user", content: [{ type: "text", text: `<trusted_turn>${JSON.stringify(turn)}</trusted_turn>\n\n问题` }] },
      tool("search_assets", {}),
      tool("read_assets", {}),
      tool("read_data_contract_view", { asset_id: "contract.daily_installs", queryable: true }),
      tool("read_data_contract_view", { asset_id: "contract.daily_ad_revenue", queryable: true }),
      tool("query", { purpose: "installs", resource_id: "res_ok" }),
      tool("query", { purpose: "revenue", code: "query_execution_failed", message: "收入查询失败" }, true),
    ],
  } as never);
  const call = message.content.find((block) => block.type === "toolCall");
  assert.equal(call && call.type === "toolCall" ? call.name : "", "update_analysis");
  const args = call && call.type === "toolCall" ? call.arguments : {};
  assert.equal(args.suggested_status, "partial");
  assert.deepEqual(args.resource_ids, ["res_ok"]);
});

test("真实模式不注入演示槽位，预算耗尽和 mock 身份有边界", async () => {
  const prompt = modelPrompt("pi", { secret: "slot" }, "用户原话", ["上一句"]);
  assert.equal(prompt.includes("trusted_turn"), false);
  assert.match(prompt, /用户原话/);
  assert.match(prompt, /上一句/);
  assert.match(modelPrompt("deterministic", { ok: true }, "原话", []), /trusted_turn/);

  assert.throws(() => loadConfig({ modelMode: "pi", piApiKey: "" }), /不会改用 faux/);
  await withRuntime({ modelMode: "pi", piProvider: "faux" }, async (runtime) => {
    const session = analyst(runtime);
    const job = await ask(runtime, session.session_id, DEMO_QUESTIONS[2].text);
    assert.equal(job.turn.slots.metrics.length, 0);
    assert.equal(JSON.stringify(job.turn).includes("trusted_turn"), false);
  });

  await withRuntime({ maxToolCalls: 1 }, async (runtime) => {
    const session = analyst(runtime);
    const job = await ask(runtime, session.session_id, DEMO_QUESTIONS[2].text);
    assert.equal(job.status, "failed");
    assert.equal(job.error?.code, "budget_exhausted");
    assert.equal(job.usage?.input_tokens, null);
    assert.equal(job.usage?.output_tokens, null);
    assert.equal(job.usage?.cost, null);
    assert.ok((job.usage?.tool_calls ?? 0) > 0);
  });

  await withRuntime({ startWorker: false }, async (runtime) => {
    const server = startServer(runtime);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    try {
      const created = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-demo-actor": "demo-viewer" },
        body: JSON.stringify({ userId: "root", role: "analyst", title: "观察者" }),
      });
      const viewer = (await created.json()) as { role: string; actor_id: string; session_id: string };
      assert.equal(viewer.role, "viewer");
      assert.equal(viewer.actor_id, "demo-viewer");
      const analystList = await fetch(`http://127.0.0.1:${port}/api/sessions`);
      const analystBody = (await analystList.json()) as { sessions: Array<{ session_id: string }> };
      assert.equal(analystBody.sessions.some((item) => item.session_id === viewer.session_id), false);
      const hidden = await fetch(`http://127.0.0.1:${port}/api/sessions/${viewer.session_id}`);
      assert.equal(hidden.status, 404);
      const health = await fetch(`http://127.0.0.1:${port}/api/health`);
      const body = (await health.json()) as { production_mysql: boolean; production_redis: boolean; target_gaps: string[] };
      assert.equal(body.production_mysql, false);
      assert.equal(body.production_redis, false);
      assert.ok(body.target_gaps.some((item) => item.includes("mock")));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function tool(name: string, payload: Record<string, unknown>, isError = false) {
  return {
    role: "toolResult" as const,
    toolName: name,
    isError,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

test("发布文件可以被再次读回", () => {
  const raw = readFileSync(new URL("../knowledge/lumenfox/freshness-source.json", import.meta.url), "utf8");
  assert.match(raw, /offline-local-synthetic-publisher/);
});
