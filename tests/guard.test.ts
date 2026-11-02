import assert from "node:assert/strict";
import test from "node:test";
import { analyst, bindTables, withRuntime } from "./helpers.js";

const WEEK = "event_date >= '2026-10-06' AND event_date <= '2026-10-12'";

test("未生效和无效日期的契约均不能用于查询", async () => {
  await withRuntime({ simulatedToday: "2026-10-29" }, async (runtime) => {
    const session = analyst(runtime);
    const asset = runtime.knowledge.by_id.get("contract.daily_installs");
    assert.ok(asset?.contract);
    asset.contract.valid_from = "2026-11-01";
    const future = await runtime.tools.readDataContractView(session.session_id, { asset_id: asset.asset_id });
    assert.equal(future.ok, true);
    if (future.ok) { assert.equal(future.queryable, false); assert.equal(future.reason, "contract_not_yet_valid"); }
    const result = await runtime.tools.query(session.session_id, { sql: `SELECT event_date, new_users FROM daily_installs WHERE ${WEEK}` });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "contract_not_yet_valid");
    asset.contract.valid_from = "2026-02-30";
    const invalid = await runtime.tools.readDataContractView(session.session_id, { asset_id: asset.asset_id });
    assert.equal(invalid.ok, true);
    if (invalid.ok) { assert.equal(invalid.queryable, false); assert.equal(invalid.reason, "invalid_contract_period"); }
  });
});

test("未授权资产、缺少契约和过期契约不能查询", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    const search = await runtime.tools.searchAssets(session.session_id, { query: "财务" });
    assert.equal(search.ok, true);
    if (!search.ok) return;
    const hits = search.hits as Array<{ asset_id: string }>;
    assert.equal(hits.some((hit) => hit.asset_id === "contract.finance_ledger"), true);
    assert.equal(session.bindings.length, 0);

    const denied = await runtime.tools.readAsset(session.session_id, { asset_id: "contract.finance_ledger" });
    assert.equal(denied.ok, false);
    if (denied.ok) return;
    assert.equal(denied.code, "asset_not_authorized");

    const finance = await runtime.tools.query(session.session_id, {
      sql: `SELECT event_date, amount_usd FROM finance_ledger WHERE ${WEEK}`,
    });
    assert.equal(finance.ok, false);
    if (finance.ok) return;
    assert.equal(finance.code, "table_not_authorized");

    const missing = await runtime.tools.query(session.session_id, {
      sql: `SELECT note FROM staging_notes WHERE ${WEEK}`,
    });
    assert.equal(missing.ok, false);
    if (missing.ok) return;
    assert.equal(missing.code, "missing_data_contract");

    const expiredView = await runtime.tools.readDataContractView(session.session_id, { asset_id: "contract.legacy_installs" });
    assert.equal(expiredView.ok, true);
    if (!expiredView.ok) return;
    assert.equal(expiredView.queryable, false);
    const expired = await runtime.tools.query(session.session_id, {
      sql: "SELECT event_date, new_users FROM legacy_installs WHERE event_date >= '2025-01-01' AND event_date <= '2025-01-02'",
    });
    assert.equal(expired.ok, false);
    if (expired.ok) return;
    assert.equal(expired.code, "expired_contract");

    const bodyOnly = await runtime.tools.readAsset(session.session_id, { asset_id: "contract.daily_installs" });
    assert.equal(bodyOnly.ok, true);
    const notBound = await runtime.tools.query(session.session_id, {
      sql: `SELECT event_date, new_users FROM daily_installs WHERE ${WEEK}`,
    });
    assert.equal(notBound.ok, false);
    if (notBound.ok) return;
    assert.equal(notBound.code, "missing_data_contract_evidence");

    const viewer = runtime.sessions.create("viewer");
    const viewerRead = await runtime.tools.readAsset(viewer.session_id, { asset_id: "contract.daily_installs" });
    assert.equal(viewerRead.ok, false);
    const hidden = await runtime.tools.searchAssets(session.session_id, { query: "未发布草稿" });
    assert.equal(hidden.ok, true);
    if (!hidden.ok) return;
    const hiddenHits = hidden.hits as Array<{ asset_id: string }>;
    assert.equal(hiddenHits.some((hit) => hit.asset_id === "sop.draft_memo"), false);
    const draft = await runtime.tools.readAsset(session.session_id, { asset_id: "sop.draft_memo" });
    assert.equal(draft.ok, false);
    if (draft.ok) return;
    assert.equal(draft.code, "asset_not_published");
  });
});

test("写操作、多语句、敏感字段和无界查询被拒绝", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs", "contract.player_device_map"]);
    const write = await runtime.tools.query(session.session_id, { sql: "DELETE FROM daily_installs" });
    assert.equal(write.ok, false);
    if (write.ok) return;
    assert.equal(write.code, "write_statement");
    const multi = await runtime.tools.query(session.session_id, {
      sql: `SELECT event_date FROM daily_installs WHERE ${WEEK}; DROP TABLE daily_installs`,
    });
    assert.equal(multi.ok, false);
    if (multi.ok) return;
    assert.equal(multi.code, "multiple_statements");
    const danger = await runtime.tools.query(session.session_id, { sql: "SELECT load_extension('x')" });
    assert.equal(danger.ok, false);
    if (danger.ok) return;
    assert.equal(danger.code, "dangerous_function");
    const wildcard = await runtime.tools.query(session.session_id, {
      sql: `SELECT * FROM daily_installs WHERE ${WEEK}`,
    });
    assert.equal(wildcard.ok, false);
    if (wildcard.ok) return;
    assert.equal(wildcard.code, "wildcard_projection");
    const sensitive = await runtime.tools.query(session.session_id, {
      sql: `SELECT device_id, player_id FROM player_device_map WHERE ${WEEK}`,
    });
    assert.equal(sensitive.ok, false);
    if (sensitive.ok) return;
    assert.equal(sensitive.code, "sensitive_field");
    const unbounded = await runtime.tools.query(session.session_id, { sql: "SELECT new_users FROM daily_installs" });
    assert.equal(unbounded.ok, false);
    if (unbounded.ok) return;
    assert.equal(unbounded.code, "unbounded_query");
    const orBypass = await runtime.tools.query(session.session_id, {
      sql: `SELECT new_users FROM daily_installs WHERE ${WEEK} OR platform = 'ios'`,
    });
    assert.equal(orBypass.ok, false);
    if (orBypass.ok) return;
    assert.equal(orBypass.code, "unsafe_predicate");
    const broken = await runtime.tools.query(session.session_id, { sql: "SELECT FROM ((" });
    assert.equal(broken.ok, false);
    if (broken.ok) return;
    assert.equal(broken.code, "unparseable_sql");
    const count = runtime.db.prepare("SELECT COUNT(*) AS n FROM daily_installs").get() as { n: number };
    assert.ok(count.n > 0);
    assert.throws(() => runtime.db.exec("DELETE FROM daily_installs"));
    const safe = await runtime.tools.query(session.session_id, {
      sql: `SELECT platform FROM player_device_map WHERE ${WEEK}`,
    });
    assert.equal(safe.ok, true);
    if (!safe.ok) return;
    assert.equal(JSON.stringify(safe.rows).includes("sim-device"), false);
  });
});

test("查询超时、取消、截断和跨会话资源", async () => {
  await withRuntime({ queryLatencyMs: 80, queryTimeoutMs: 20 }, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    const timedOut = await runtime.tools.query(session.session_id, {
      sql: `SELECT event_date, new_users FROM daily_installs WHERE ${WEEK}`,
    });
    assert.equal(timedOut.ok, false);
    if (timedOut.ok) return;
    assert.equal(timedOut.code, "query_timeout");
    assert.equal(runtime.sessions.resourceCount(), 0);
  });

  await withRuntime({ queryLatencyMs: 200 }, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    const controller = new AbortController();
    const pending = runtime.tools.query(
      session.session_id,
      { sql: `SELECT event_date, new_users FROM daily_installs WHERE ${WEEK}` },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 20);
    const cancelled = await pending;
    assert.equal(cancelled.ok, false);
    if (cancelled.ok) return;
    assert.equal(cancelled.code, "query_cancelled");
  });

  await withRuntime({ maxResultRows: 2 }, async (runtime) => {
    const session = analyst(runtime);
    const other = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    const queried = await runtime.tools.query(session.session_id, {
      sql: `SELECT event_date, new_users FROM daily_installs WHERE ${WEEK} AND platform = 'ios' AND country_code = 'US'`,
    });
    assert.equal(queried.ok, true);
    if (!queried.ok) return;
    assert.equal(queried.truncated, true);
    assert.equal(queried.complete_population, false);
    assert.equal(queried.returned_rows, 2);
    assert.ok(Number(queried.total_rows) > 2);
    const calc = await runtime.tools.calculateSessionCells(session.session_id, {
      resource_id: String(queried.resource_id),
      operations: [{ op: "count_rows", as: "rows" }],
    });
    assert.equal(calc.ok, true);
    if (!calc.ok) return;
    assert.equal(calc.input_truncated, true);
    assert.equal(calc.complete_population, false);
    const analysis = await runtime.tools.updateAnalysis(session.session_id, {
      suggested_status: "completed",
      draft_answer: "模型把截断样本当成了总体。",
      resource_ids: [String(queried.resource_id), String(calc.resource_id)],
    });
    assert.equal(analysis.ok, true);
    if (!analysis.ok) return;
    assert.equal(analysis.status, "partial");
    assert.ok((analysis.server_reasons as string[]).includes("truncated_result_is_not_population"));
    const foreign = await runtime.tools.readSessionResource(other.session_id, { resource_id: String(queried.resource_id) });
    assert.equal(foreign.ok, false);
    if (foreign.ok) return;
    assert.equal(foreign.code, "cross_session_resource");
    const foreignCalc = await runtime.tools.calculateSessionCells(other.session_id, {
      resource_id: String(queried.resource_id),
      operations: [{ op: "count_rows", as: "rows" }],
    });
    assert.equal(foreignCalc.ok, false);
    if (foreignCalc.ok) return;
    assert.equal(foreignCalc.code, "cross_session_resource");
  });
});

test("缺失、真实零和预测值不会被混成一个完成结论", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs", "contract.daily_ad_revenue"]);
    const installs = await runtime.tools.query(session.session_id, {
      sql: `SELECT event_date, new_users FROM daily_installs WHERE ${WEEK} AND platform = 'ios' AND country_code = 'US'`,
    });
    const revenue = await runtime.tools.query(session.session_id, {
      sql: `SELECT event_date, revenue_usd, is_predicted FROM daily_ad_revenue WHERE ${WEEK} AND platform = 'ios' AND country_code = 'US'`,
    });
    assert.equal(installs.ok && revenue.ok, true);
    if (!installs.ok || !revenue.ok) return;
    const timeRange = installs.time_range as { timezone: string };
    assert.equal(timeRange.timezone, "America/Los_Angeles");
    assert.equal(installs.simulated, true);
    const installCells = await runtime.tools.calculateSessionCells(session.session_id, {
      resource_id: String(installs.resource_id),
      operations: [
        { op: "sum", column: "new_users", predicted: "any", as: "new_users_sum" },
        { op: "count_null", column: "new_users", predicted: "any", as: "new_users_missing" },
        { op: "count_zero", column: "new_users", predicted: "any", as: "new_users_zero" },
      ],
    });
    const revenueCells = await runtime.tools.calculateSessionCells(session.session_id, {
      resource_id: String(revenue.resource_id),
      operations: [
        { op: "sum", column: "revenue_usd", predicted: "actual_only", as: "revenue_actual" },
        { op: "sum", column: "revenue_usd", predicted: "predicted_only", as: "revenue_predicted" },
        { op: "count_null", column: "revenue_usd", predicted: "actual_only", as: "revenue_missing" },
        { op: "count_zero", column: "revenue_usd", predicted: "actual_only", as: "revenue_zero" },
      ],
    });
    assert.equal(installCells.ok && revenueCells.ok, true);
    if (!installCells.ok || !revenueCells.ok) return;
    assert.deepEqual(installCells.cells, { new_users_sum: 480, new_users_missing: 1, new_users_zero: 1 });
    assert.deepEqual(revenueCells.cells, { revenue_actual: 43.5, revenue_predicted: 27.5, revenue_missing: 1, revenue_zero: 1 });
    session.active_job_id = "job_test";
    const analysis = await runtime.tools.updateAnalysis(session.session_id, {
      suggested_status: "completed",
      draft_answer: "模型声称全部完成，并把预测算进实际。",
      resource_ids: [String(installs.resource_id), String(revenue.resource_id), String(installCells.resource_id), String(revenueCells.resource_id)],
    });
    assert.equal(analysis.ok, true);
    if (!analysis.ok) return;
    assert.equal(analysis.status, "partial");
    assert.ok((analysis.server_reasons as string[]).includes("completeness_gap"));
    assert.match(String(analysis.answer), /NULL/);
    assert.match(String(analysis.answer), /480/);
    assert.match(String(analysis.answer), /43\.5/);
    assert.match(String(analysis.answer), /27\.5/);
    assert.ok((analysis.server_reasons as string[]).includes("missing_values_disclosed"));
    assert.ok((analysis.server_reasons as string[]).includes("predicted_values_disclosed"));
    assert.ok((analysis.server_reasons as string[]).includes("true_zeros_disclosed"));
    const limitations = analysis.limitations as string[];
    assert.ok(limitations.some((item) => item.includes("NULL")));
    assert.ok(limitations.some((item) => item.includes("数值为零")));
    assert.ok(limitations.some((item) => item.includes("预测")));
  });
});

test("子查询、CTE 和联合查询不能绕过表、字段或日期边界", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs", "contract.daily_ad_revenue", "contract.player_device_map"]);
    const week = "event_date >= '2026-10-06' AND event_date <= '2026-10-12'";
    const cases: Array<[string, string]> = [
      [
        `WITH hidden AS (SELECT event_date, amount_usd FROM finance_ledger WHERE ${week}) SELECT event_date, amount_usd FROM hidden`,
        "table_not_authorized",
      ],
      [
        `SELECT event_date, new_users FROM daily_installs WHERE ${week} AND platform IN (SELECT platform FROM finance_ledger)`,
        "table_not_authorized",
      ],
      [
        `SELECT event_date, new_users FROM daily_installs WHERE ${week} UNION SELECT event_date, amount_usd FROM finance_ledger`,
        "table_not_authorized",
      ],
      [
        `SELECT event_date, new_users FROM daily_installs WHERE ${week}; /* comment */ SELECT 1`,
        "multiple_statements",
      ],
      [
        `SELECT event_date, new_users FROM daily_installs WHERE ${week} AND platform = 'ios' --\n; DROP TABLE daily_installs`,
        "multiple_statements",
      ],
      [
        `SELECT event_date FROM (SELECT event_date, device_id FROM player_device_map WHERE ${week}) nested`,
        "sensitive_field",
      ],
      [
        `SELECT daily_installs.* FROM daily_installs WHERE ${week}`,
        "wildcard_projection",
      ],
      [
        `SELECT event_date, new_users FROM daily_installs WHERE ${week} AND platform IN (SELECT platform FROM daily_ad_revenue)`,
        "unbounded_query",
      ],
      [
        `WITH outer_cte AS (WITH inner_cte AS (SELECT event_date, amount_usd FROM finance_ledger WHERE ${week}) SELECT event_date, amount_usd FROM inner_cte) SELECT event_date, amount_usd FROM outer_cte`,
        "table_not_authorized",
      ],
      [
        `WITH daily_installs AS (SELECT event_date, amount_usd AS new_users FROM finance_ledger WHERE ${week}) SELECT event_date, new_users FROM daily_installs`,
        "table_not_authorized",
      ],
      [
        `SELECT a.event_date, b.revenue_usd FROM daily_installs AS a JOIN daily_ad_revenue AS b ON a.event_date = b.event_date WHERE a.event_date >= '2026-10-06' AND a.event_date <= '2026-10-12' AND b.event_date >= '2026-10-06' AND b.event_date <= '2026-10-12'`,
        "join_key_missing",
      ],
      [
        `SELECT event_date, new_users FROM daily_installs d WHERE ${week} AND EXISTS (SELECT 1 FROM finance_ledger f WHERE f.event_date = d.event_date)`,
        "table_not_authorized",
      ],
      [
        `SeLeCt "event_date", "new_users" FrOm "daily_installs" WhErE "event_date" >= '2026-10-06' AND "event_date" <= '2026-10-12'`,
        "ok",
      ],
      [
        `SELECT event_date FROM player_device_map WHERE ${week} ORDER BY device_id`,
        "sensitive_field",
      ],
      [
        `SELECT event_date FROM player_device_map WHERE device_id = 'sim-device-001' AND ${week}`,
        "sensitive_field",
      ],
      [
        `SELECT lower(device_id) FROM player_device_map WHERE ${week}`,
        "sensitive_field",
      ],
      ["SELECT * FROM daily_installs WHERE " + week, "wildcard_projection"],
      ["SELECT name FROM sqlite_master", "system_table"],
      ["SELECT name FROM sqlite_schema", "system_table"],
      ["SELECT event_date FROM [daily_installs]", "unparseable_sql"],
      [
        `SELECT event_date FROM daily_installs WHERE ${week}; SELECT event_date FROM daily_ad_revenue`,
        "multiple_statements",
      ],
      [
        `WITH visible AS (SELECT * FROM daily_installs WHERE ${week}) SELECT event_date, new_users FROM visible`,
        "wildcard_projection",
      ],
    ];
    for (const [sql, code] of cases) {
      const result = await runtime.tools.query(session.session_id, { sql });
      if (code === "ok") {
        assert.equal(result.ok, true, sql);
        continue;
      }
      assert.equal(result.ok, false, sql);
      if (result.ok) continue;
      assert.equal(result.code, code, sql);
    }
    const count = runtime.db.prepare("SELECT COUNT(*) AS n FROM finance_ledger").get() as { n: number };
    assert.equal(count.n, 1);
  });
});

test("契约修订变化后不能继续用旧绑定", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    runtime.knowledge.registry_revision = "lumenfox-registry-replaced";
    const stale = await runtime.tools.query(session.session_id, {
      sql: `SELECT event_date, new_users FROM daily_installs WHERE ${WEEK}`,
    });
    assert.equal(stale.ok, false);
    if (stale.ok) return;
    assert.equal(stale.code, "stale_data_contract_binding");
  });
});
