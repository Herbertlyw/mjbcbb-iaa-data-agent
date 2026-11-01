import assert from "node:assert/strict";
import test from "node:test";
import { analyst, bindTables, withRuntime } from "./helpers.js";

test("连接审查核对登记的键，错误键和缺键不能通过", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    await bindTables(runtime, session.session_id, ["contract.daily_installs", "contract.daily_ad_revenue"]);
    const wrong = await runtime.tools.query(session.session_id, {
      sql: `SELECT a.event_date, a.product_id, a.platform, a.country_code, a.new_users, b.revenue_usd, b.is_predicted
        FROM daily_installs AS a
        JOIN daily_ad_revenue AS b ON a.event_date = b.event_date AND a.channel = b.placement
        WHERE a.event_date >= '2026-10-06' AND a.event_date <= '2026-10-12'
          AND b.event_date >= '2026-10-06' AND b.event_date <= '2026-10-12'`,
    });
    assert.equal(wrong.ok, false);
    if (wrong.ok) return;
    assert.ok(["join_key_missing", "join_key_not_allowed", "join_key_mismatch"].includes(wrong.code), wrong.code);

    const direct = await runtime.tools.query(session.session_id, {
      sql: `SELECT a.event_date, a.product_id, a.platform, a.country_code, a.new_users, b.revenue_usd, b.is_predicted
        FROM daily_installs AS a
        JOIN daily_ad_revenue AS b
          ON a.event_date = b.event_date AND a.product_id = b.product_id AND a.platform = b.platform AND a.country_code = b.country_code
        WHERE a.event_date >= '2026-10-06' AND a.event_date <= '2026-10-12'
          AND b.event_date >= '2026-10-06' AND b.event_date <= '2026-10-12'
          AND a.product_id = 'starlane_drift' AND b.product_id = 'starlane_drift'
          AND a.platform = 'ios' AND b.platform = 'ios'
          AND a.country_code = 'US' AND b.country_code = 'US'`,
    });
    assert.equal(direct.ok, false);
    if (direct.ok) return;
    assert.equal(direct.code, "join_grain_mismatch");

    const bypasses = [
      [`SELECT a.event_date, a.new_users, b.revenue_usd FROM daily_installs AS a JOIN daily_ad_revenue AS b ON a.event_date = a.event_date AND a.product_id = a.product_id AND a.platform = a.platform AND a.country_code = a.country_code WHERE a.event_date >= '2026-10-06' AND a.event_date <= '2026-10-12' AND b.event_date >= '2026-10-06' AND b.event_date <= '2026-10-12'`, "join_key_mismatch"],
      [`SELECT a.event_date, a.new_users, b.revenue_usd FROM daily_installs AS a JOIN daily_ad_revenue AS b ON a.event_date = b.placement AND a.product_id = b.product_id AND a.platform = b.platform AND a.country_code = b.country_code WHERE a.event_date >= '2026-10-06' AND a.event_date <= '2026-10-12' AND b.event_date >= '2026-10-06' AND b.event_date <= '2026-10-12'`, "join_key_mismatch"],
      [`SELECT a.event_date, a.new_users, b.revenue_usd FROM daily_installs AS a JOIN daily_ad_revenue AS b ON (a.event_date = b.event_date AND a.product_id = b.product_id AND a.platform = b.platform AND a.country_code = b.country_code) OR 1 = 1 WHERE a.event_date >= '2026-10-06' AND a.event_date <= '2026-10-12' AND b.event_date >= '2026-10-06' AND b.event_date <= '2026-10-12'`, "join_predicate_unsafe"],
      [`SELECT a.event_date, b.event_date FROM daily_installs AS a JOIN daily_installs AS b ON a.event_date = b.event_date AND a.product_id = b.product_id AND a.platform = b.platform AND a.country_code = b.country_code AND a.channel = b.channel WHERE a.event_date >= '2026-10-06' AND a.event_date <= '2026-10-12' AND b.event_date >= '2026-10-06' AND b.event_date <= '2026-10-12'`, "self_join_unsupported"],
      [`SELECT a.event_date, a.new_users FROM daily_installs AS a JOIN (SELECT event_date, product_id, platform, country_code, revenue_usd FROM daily_ad_revenue WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-12') AS b ON a.event_date = b.event_date AND a.product_id = b.product_id AND a.platform = b.platform AND a.country_code = b.country_code WHERE a.event_date >= '2026-10-06' AND a.event_date <= '2026-10-12'`, "join_structure_unsupported"],
      [`SELECT a.event_date, a.new_users, b.revenue_usd FROM daily_installs AS a JOIN daily_ad_revenue AS b ON event_date = b.event_date AND a.product_id = b.product_id AND a.platform = b.platform AND a.country_code = b.country_code WHERE a.event_date >= '2026-10-06' AND a.event_date <= '2026-10-12' AND b.event_date >= '2026-10-06' AND b.event_date <= '2026-10-12'`, "join_column_ambiguous"],
    ] as const;
    for (const [sql, code] of bypasses) {
      const result = await runtime.tools.query(session.session_id, { sql });
      assert.equal(result.ok, false, sql);
      if (!result.ok) assert.equal(result.code, code, `${sql} -> ${result.code}`);
    }
  });
});
