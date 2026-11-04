import assert from "node:assert/strict";
import test from "node:test";
import { analyst, bindTables, withRuntime } from "./helpers.js";

const WEEK = "event_date >= '2026-10-06' AND event_date <= '2026-10-12'";

test("不同指标、分组和无依据草稿不会被当成已验证数字", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs", "contract.daily_ad_revenue"]);
    runtime.sessions.setActiveJob(session.session_id, "job_findings");

    const installs = await runtime.tools.query(session.session_id, {
      sql: `SELECT event_date, product_id, platform, country_code, channel, new_users FROM daily_installs WHERE ${WEEK} AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'US' AND channel = 'nebula_ads'`,
    });
    assert.equal(installs.ok, true);
    if (!installs.ok) return;
    const installCalc = await runtime.tools.calculateSessionCells(session.session_id, {
      resource_id: String(installs.resource_id),
      operations: [
        { op: "sum", column: "new_users", as: "nebula_new_users" },
        { op: "count_null", column: "new_users", as: "nebula_nulls" },
        { op: "count_zero", column: "new_users", as: "nebula_zeros" },
      ],
    });
    assert.equal(installCalc.ok, true);
    if (!installCalc.ok) return;

    const revenue = await runtime.tools.query(session.session_id, {
      sql: `SELECT event_date, product_id, platform, country_code, placement, revenue_usd, is_predicted FROM daily_ad_revenue WHERE ${WEEK} AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'US'`,
    });
    assert.equal(revenue.ok, true);
    if (!revenue.ok) return;
    const revenueCalc = await runtime.tools.calculateSessionCells(session.session_id, {
      resource_id: String(revenue.resource_id),
      operations: [
        { op: "sum", column: "revenue_usd", predicted: "actual_only", as: "rewarded_actual" },
        { op: "sum", column: "revenue_usd", predicted: "predicted_only", as: "rewarded_predicted" },
        { op: "count_zero", column: "revenue_usd", predicted: "actual_only", as: "rewarded_zeros" },
      ],
    });
    assert.equal(revenueCalc.ok, true);
    if (!revenueCalc.ok) return;

    const grouped = await runtime.tools.query(session.session_id, {
      sql: `SELECT channel, new_users FROM daily_installs WHERE ${WEEK} AND product_id = 'ember_kites' AND platform = 'android' AND country_code = 'DE' AND channel = 'harbor_lab'`,
    });
    assert.equal(grouped.ok, true);
    if (!grouped.ok) return;
    const groupCalc = await runtime.tools.calculateSessionCells(session.session_id, {
      resource_id: String(grouped.resource_id),
      operations: [{ op: "sum", column: "new_users", as: "ember_de_new_users" }],
    });
    assert.equal(groupCalc.ok, true);
    if (!groupCalc.ok) return;

    const installCells = (installCalc as unknown as { cells: Record<string, number> }).cells;
    const revenueCells = (revenueCalc as unknown as { cells: Record<string, number> }).cells;
    const groupCells = (groupCalc as unknown as { cells: Record<string, number> }).cells;
    const cited = await runtime.tools.updateAnalysis(session.session_id, {
      suggested_status: "completed",
      draft_answer: "草稿写了 99999，这不是查询结果。",
      resource_ids: [String(installs.resource_id), String(installCalc.resource_id), String(revenue.resource_id), String(revenueCalc.resource_id), String(grouped.resource_id), String(groupCalc.resource_id)],
      findings: [
        { label: "星云新增", value: Number(installCells.nebula_new_users), kind: "actual", resource_id: String(installCalc.resource_id), cell: "nebula_new_users", group: { channel: "nebula_ads" }, time_range: { start: "2026-10-06", end: "2026-10-12" } },
        { label: "星云缺失天数", value: Number(installCells.nebula_nulls), kind: "missing", resource_id: String(installCalc.resource_id), cell: "nebula_nulls" },
        { label: "星云真实零天数", value: Number(installCells.nebula_zeros), kind: "zero", resource_id: String(installCalc.resource_id), cell: "nebula_zeros" },
        { label: "广告实际", value: Number(revenueCells.rewarded_actual), kind: "actual", resource_id: String(revenueCalc.resource_id), cell: "rewarded_actual" },
        { label: "广告预测", value: Number(revenueCells.rewarded_predicted), kind: "predicted", resource_id: String(revenueCalc.resource_id), cell: "rewarded_predicted" },
        { label: "余烬德国新增", value: Number(groupCells.ember_de_new_users), kind: "actual", resource_id: String(groupCalc.resource_id), cell: "ember_de_new_users", time_range: { start: "2026-10-06", end: "2026-10-12" } },
        { label: "无依据数字", value: 99999, kind: "actual", resource_id: String(installCalc.resource_id) },
      ],
    });
    assert.equal(cited.ok, true, JSON.stringify(cited));
    if (!cited.ok) return;
    assert.match(String(cited.answer), /daily_installs\.new_users/);
    assert.match(String(cited.answer), /channel=nebula_ads/);
    assert.doesNotMatch(String(cited.answer), /星云新增|余烬德国新增/);
    assert.match(String(cited.answer), /predicted|广告预测/);
    assert.equal(String(cited.answer).includes("99999"), false);
    assert.match((cited.limitations as string[]).join(" "), /模型草稿.*未作为已验证事实/);
    assert.notEqual(cited.status, "completed");
  });
});


test("当前任务不能用旧任务查询重新计算并冒充本轮证据", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    runtime.sessions.setActiveJob(session.session_id, "job_old");
    const old = await runtime.tools.query(session.session_id, { sql: `SELECT event_date, new_users FROM daily_installs WHERE ${WEEK} AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'US'` });
    assert.equal(old.ok, true);
    if (!old.ok) return;
    runtime.sessions.setActiveJob(session.session_id, "job_new");
    const calculation = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: String(old.resource_id), operations: [{ op: "sum", column: "new_users", as: "new_users_sum" }] });
    assert.equal(calculation.ok, false);
    if (!calculation.ok) assert.equal(calculation.code, "resource_from_other_execution");
    runtime.sessions.saveResource({ resource_id: "res_forged_calculation", session_id: session.session_id, job_id: "job_new", kind: "calculation", created_at: new Date().toISOString(), source_resource_id: String(old.resource_id), cells: { new_users_sum: 123456 }, input_truncated: false, complete_population: true, null_means: "missing", zero_means: "observed_zero", predicted_means: "forecast_not_actual", notes: [] });
    const current = await runtime.tools.query(session.session_id, { sql: `SELECT event_date, new_users FROM daily_installs WHERE ${WEEK} AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'US'` });
    assert.equal(current.ok, true);
    if (!current.ok) return;
    const forged = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(current.resource_id), "res_forged_calculation"] });
    assert.equal(forged.ok, true);
    if (forged.ok) {
      assert.equal(String(forged.answer).includes("123456"), false);
      assert.ok((forged.server_reasons as string[]).includes("resource_from_other_execution"));
    }
    const attempt = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "旧数字", resource_ids: [String(old.resource_id)] });
    assert.equal(attempt.ok, false);
    if (!attempt.ok) assert.equal(attempt.code, "evidence_feedback");
  });
});

test("同任务完整整数来源支持可追溯比较，零分母和不兼容范围不伪造变化率", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    runtime.sessions.setActiveJob(session.session_id, "job_compare");
    const ids: string[] = [];
    async function cell(date: string, country = "US") {
      const result = await runtime.tools.query(session.session_id, { sql: `SELECT event_date, new_users FROM daily_installs WHERE event_date >= '${date}' AND event_date <= '${date}' AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = '${country}' AND channel = 'nebula_ads'` });
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error("synthetic query failed");
      const calculation = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: String(result.resource_id), operations: [{ op: "sum", column: "new_users", as: "total" }] });
      assert.equal(calculation.ok, true);
      if (!calculation.ok) throw new Error("synthetic calculation failed");
      ids.push(String(result.resource_id), String(calculation.resource_id));
      return { resource_id: String(calculation.resource_id), cell: "total", value: (calculation.cells as Record<string, number>).total };
    }
    // Independent fixture: the seed explicitly contains 120, 95, 0 and 10.
    const baseline = await cell("2026-10-06");
    const current = await cell("2026-10-08");
    const zero = await cell("2026-10-07");
    const japan = await cell("2026-10-08", "JP");
    assert.deepEqual([baseline.value, current.value, zero.value, japan.value], [120, 95, 0, 10]);
    const result = await runtime.tools.updateAnalysis(session.session_id, {
      suggested_status: "completed", draft_answer: "", resource_ids: ids,
      comparisons: [
        { left: current, right: baseline },
        { left: current, right: zero },
        { left: japan, right: current },
        // Both country and date differ: cannot attribute the change.
        { left: japan, right: baseline },
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const comparisons = result.comparisons as Array<{ difference: number; change_percent: string | null }>;
    assert.deepEqual(comparisons.map(({ difference, change_percent }) => ({ difference, change_percent })), [
      { difference: -25, change_percent: "-20.83" },
      { difference: 95, change_percent: null },
      { difference: -85, change_percent: "-89.47" },
    ]);
    assert.equal(result.status, "partial");
    assert.ok((result.server_reasons as string[]).includes("comparison_unverifiable"));
    assert.match(String(result.answer), /基准为零，变化率不可计算/);
    assert.match(String(result.answer), /2026-10-08/);
  });
});

test("按国家对原始授权行分组后由服务端交付，未出现的组合不补零", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    runtime.sessions.setActiveJob(session.session_id, "job_group_fixture");
    const query = await runtime.tools.query(session.session_id, { sql: "SELECT event_date, country_code, new_users FROM daily_installs WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-06' AND product_id = 'starlane_drift' AND platform = 'ios' AND channel = 'nebula_ads'" });
    assert.equal(query.ok, true);
    if (!query.ok) return;
    const calculation = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: String(query.resource_id), operations: [{ op: "sum", column: "new_users", as: "total" }] });
    assert.equal(calculation.ok, true);
    if (!calculation.ok) return;
    assert.equal((calculation.cells as Record<string, number>).total, 130);
    const answer = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(query.resource_id), String(calculation.resource_id)] });
    assert.equal(answer.ok, true);
    if (!answer.ok) return;
    assert.match(String(answer.answer), /按 country_code 分组/);
    assert.match(String(answer.answer), /US=120/);
    assert.match(String(answer.answer), /JP=10/);
    assert.doesNotMatch(String(answer.answer), /DE=0/);
  });
});

test("浮点金额不冒充精确十进制结论", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_ad_revenue"]);
    runtime.sessions.setActiveJob(session.session_id, "job_float_fixture");
    const query = await runtime.tools.query(session.session_id, { sql: "SELECT event_date, revenue_usd, is_predicted FROM daily_ad_revenue WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-06' AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'US'" });
    assert.equal(query.ok, true);
    if (!query.ok) return;
    const calculation = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: String(query.resource_id), operations: [{ op: "sum", column: "revenue_usd", predicted: "actual_only", as: "amount" }] });
    assert.equal(calculation.ok, true);
    if (!calculation.ok) return;
    assert.equal((calculation.cells as Record<string, number>).amount, 12.5);
    const result = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(query.resource_id), String(calculation.resource_id)] });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.status, "partial");
    assert.match(String(result.answer), /浮点近似，非精确十进制.*12\.5；单位 USD/);
    assert.ok((result.server_reasons as string[]).includes("floating_point_approximate"));
  });
});

test("直接列别名与排序保留契约血缘，遮蔽维度和 LIMIT 不能冒充完整结论", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    runtime.sessions.setActiveJob(session.session_id, "job_alias_fixture");
    const where = "event_date >= '2026-10-06' AND event_date <= '2026-10-06' AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'US' AND channel = 'nebula_ads'";
    async function analyze(sql: string, column: string) {
      const query = await runtime.tools.query(session.session_id, { sql });
      assert.equal(query.ok, true, JSON.stringify(query));
      if (!query.ok) throw new Error("synthetic query failed");
      const calculation = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: String(query.resource_id), operations: [{ op: "sum", column, as: "metric" }] });
      assert.equal(calculation.ok, true);
      if (!calculation.ok) throw new Error("synthetic calculation failed");
      return runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(query.resource_id), String(calculation.resource_id)] });
    }
    const valid = await analyze(`SELECT event_date AS day, new_users AS amount FROM daily_installs WHERE ${where} ORDER BY event_date`, "amount");
    assert.equal(valid.ok, true);
    if (valid.ok) {
      assert.match(String(valid.answer), /daily_installs\.new_users/);
      assert.match(String(valid.answer), /120；单位 人/);
      assert.match(String(valid.answer), /country_code=US/);
    }
    const shadow = await analyze(`SELECT event_date, new_users AS country_code FROM daily_installs WHERE ${where}`, "country_code");
    assert.equal(shadow.ok, true);
    if (shadow.ok) { assert.doesNotMatch(String(shadow.answer), /120/); assert.notEqual(shadow.status, "completed"); }
    const limited = await analyze(`SELECT event_date, new_users AS amount FROM daily_installs WHERE ${where} LIMIT 1`, "amount");
    assert.equal(limited.ok, true);
    if (limited.ok) { assert.doesNotMatch(String(limited.answer), /120/); assert.notEqual(limited.status, "completed"); }
  });
});

test("数据库分组聚合只交付完整覆盖且契约可证明的整数结果", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    runtime.sessions.setActiveJob(session.session_id, "job_sql_aggregate");
    const base = "product_id = 'starlane_drift' AND platform = 'ios' AND channel = 'nebula_ads'";
    async function analyze(sql: string) {
      const query = await runtime.tools.query(session.session_id, { sql });
      assert.equal(query.ok, true, JSON.stringify(query));
      if (!query.ok) throw new Error("synthetic query failed");
      const answer = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(query.resource_id)] });
      assert.equal(answer.ok, true, JSON.stringify(answer));
      if (!answer.ok) throw new Error("synthetic analysis failed");
      return answer;
    }
    const day = "event_date >= '2026-10-06' AND event_date <= '2026-10-06'";
    const result = await analyze(`SELECT country_code, SUM(new_users) AS total, COUNT(new_users) AS n FROM daily_installs WHERE ${day} AND ${base} GROUP BY country_code ORDER BY country_code`);
    assert.equal(result.status, "completed", JSON.stringify(result));
    const aggregates = result.aggregates as Array<{ operation: string; value: string; group: Record<string, string>; unit: string }>;
    assert.deepEqual(aggregates.map((a) => [a.group.country_code, a.operation, a.value, a.unit]), [["JP", "sum", "10", "人"], ["JP", "count_nonnull", "1", "行"], ["US", "sum", "120", "人"], ["US", "count_nonnull", "1", "行"]]);
    assert.match(String(result.answer), /country_code=US/);
    assert.deepEqual((result.sources as Array<{ rows: unknown[] }>)[0]?.rows, []);
    assert.match((result.limitations as string[]).join(" "), /未出现的组合没有补零/);
    const twoDimensions = await analyze(`SELECT country_code, channel, SUM(new_users) AS total FROM daily_installs WHERE ${day} AND product_id = 'starlane_drift' AND platform = 'ios' GROUP BY country_code, channel ORDER BY country_code, channel`);
    assert.equal(twoDimensions.status, "completed", JSON.stringify(twoDimensions));
    assert.deepEqual((twoDimensions.aggregates as Array<{ group: Record<string, string>; value: string }>).map((a) => [a.group.country_code, a.group.channel, a.value]), [["JP", "nebula_ads", "10"], ["US", "nebula_ads", "120"]]);
    for (const sql of [
      `SELECT SUM(new_users) AS country_code FROM daily_installs WHERE ${day} AND ${base} AND country_code = 'US'`,
      `SELECT SUM(new_users + 1) AS total FROM daily_installs WHERE ${day} AND ${base} AND country_code = 'US'`,
      `SELECT SUM(new_users) AS total FROM daily_installs WHERE ${day} AND ${base} AND country_code = 'US' LIMIT 1`,
      `SELECT SUM(new_users) AS total FROM daily_installs WHERE event_date >= '2026-10-09' AND event_date <= '2026-10-09' AND ${base} AND country_code = 'US'`,
    ]) {
      const rejected = await analyze(sql);
      assert.notEqual(rejected.status, "completed", sql);
      assert.deepEqual(rejected.aggregates, [], sql);
    }
  });
});
