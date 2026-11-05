import assert from "node:assert/strict";
import test from "node:test";
import { analyst, bindTables, withRuntime } from "./helpers.js";

test("查询、单资源计算、变换、对齐和四则均可按同一视图读取且续页绑定版本", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime); await bindTables(runtime, session.session_id, ["contract.daily_installs"]);
    runtime.sessions.setActiveJob(session.session_id, "job_result_view");
    const query = await runtime.tools.query(session.session_id, { sql: "SELECT event_date, country_code, new_users FROM daily_installs WHERE event_date = '2026-10-06' AND product_id = 'starlane_drift' AND platform = 'ios' AND channel = 'nebula_ads'" });
    assert.ok(query.ok, JSON.stringify(query)); if (!query.ok) return;
    const calculation = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: String(query.resource_id), operations: [{ op: "sum", column: "new_users", as: "total" }] });
    assert.ok(calculation.ok, JSON.stringify(calculation)); if (!calculation.ok) return;
    const transformed = await runtime.tools.calculateSessionCells(session.session_id, { transform: { resource_id: String(query.resource_id), steps: [{ op: "sort", keys: [{ column: "country_code", direction: "asc", nulls: "last" }] }] } });
    assert.ok(transformed.ok, JSON.stringify(transformed)); if (!transformed.ok) return;
    const aligned = await runtime.tools.calculateSessionCells(session.session_id, { align: { op: "subtract", keys: ["country_code"], left: { resource_id: String(query.resource_id), cell: "new_users" }, right: { resource_id: String(query.resource_id), cell: "new_users" } } });
    assert.ok(aligned.ok, JSON.stringify(aligned)); if (!aligned.ok) return;
    const ref = { resource_id: String(transformed.resource_id), execution_id: String(transformed.execution_id), cell: "new_users", row: 0 };
    const arithmetic = await runtime.tools.calculateSessionCells(session.session_id, { arithmetic: { op: "add", left: ref, right: ref } });
    assert.ok(arithmetic.ok, JSON.stringify(arithmetic)); if (!arithmetic.ok) return;
    for (const [kind, result] of [["query_result", query], ["calculation", calculation], ["transform", transformed], ["alignment", aligned], ["arithmetic", arithmetic]] as const) {
      const page = await runtime.tools.readSessionResource(session.session_id, { resource_id: String(result.resource_id), format: "result_view", row_limit: 1 });
      assert.ok(page.ok, JSON.stringify(page)); if (!page.ok) return;
      const view = page.result_view as { source_kind: string; execution_id: string; saved_rows: number; columns: Array<{ name: string; type: string }>; rows: object[] };
      assert.equal(view.source_kind, kind); assert.equal(view.execution_id, result.execution_id);
      assert.ok(view.columns.length); assert.ok(view.saved_rows >= 1); assert.equal(view.rows.length, 1);
      if (page.has_more) {
        const missingHash = await runtime.tools.readSessionResource(session.session_id, { resource_id: String(result.resource_id), format: "result_view", row_offset: 1 });
        assert.equal(missingHash.ok, false);
        const next = await runtime.tools.readSessionResource(session.session_id, { resource_id: String(result.resource_id), format: "result_view", row_offset: 1, expected_resource_hash: String(page.resource_hash) });
        assert.ok(next.ok, JSON.stringify(next));
      }
    }
    const wrong = await runtime.tools.calculateSessionCells(session.session_id, { arithmetic: { op: "add", left: { ...ref, execution_id: "not-the-execution" }, right: ref } });
    assert.equal(wrong.ok, false);
  });
});
