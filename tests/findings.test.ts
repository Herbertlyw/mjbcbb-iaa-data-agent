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
    assert.match(String(cited.answer), /星云新增/);
    assert.match(String(cited.answer), /余烬德国新增/);
    assert.match(String(cited.answer), /predicted|广告预测/);
    assert.equal(String(cited.answer).includes("99999"), false);
    assert.match((cited.limitations as string[]).join(" "), /没有逐一验证/);
    assert.notEqual(cited.status, "completed");
  });
});
