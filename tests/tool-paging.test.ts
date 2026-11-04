import assert from "node:assert/strict";
import test from "node:test";
import { analyst, withRuntime } from "./helpers.js";
import type { QueryResource } from "../src/types.js";

test("宽行分页受字节上限约束，续页按实际返回行数推进", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    assert.equal((await runtime.tools.readDataContractView(session.session_id, { asset_id: "contract.daily_installs" })).ok, true);
    runtime.sessions.setActiveJob(session.session_id, "wide_page_job");
    const query = await runtime.tools.query(session.session_id, { sql: "SELECT event_date, country_code, new_users FROM daily_installs WHERE event_date = '2026-10-06' AND product_id = 'starlane_drift' AND platform = 'ios' AND channel = 'nebula_ads'" });
    assert.equal(query.ok, true); if (!query.ok) return;
    const found = runtime.sessions.lookupResource(session.session_id, String(query.resource_id));
    assert.ok(found.ok && found.resource.kind === "query_result"); if (!found.ok || found.resource.kind !== "query_result") return;
    const resource = structuredClone(found.resource) as QueryResource;
    resource.rows = Array.from({ length: 3 }, (_, index) => ({ event_date: "2026-10-06", country_code: `${index}${"X".repeat(12_000)}`, new_users: index }));
    resource.total_rows = 3; resource.returned_rows = 3; resource.total_rows_exact = true;
    runtime.state.saveResource(resource);
    const first = await runtime.tools.readSessionResource(session.session_id, { resource_id: resource.resource_id, row_limit: 100 });
    assert.equal(first.ok, true); if (!first.ok) return;
    assert.equal((first.resource as QueryResource).rows.length, 2); assert.equal(first.next_row_offset, 2); assert.equal(first.has_more, true);
    const second = await runtime.tools.readSessionResource(session.session_id, { resource_id: resource.resource_id, row_offset: 2, row_limit: 100, expected_resource_hash: String(first.resource_hash) });
    assert.equal(second.ok, true); if (!second.ok) return;
    assert.equal((second.resource as QueryResource).rows.length, 1); assert.equal(second.has_more, false);
  });
});

test("搜索稳定续页，版本变化与越权正文不泄露", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    const page = await runtime.tools.searchAssets(session.session_id, { query: "", limit: 2 });
    assert.equal(page.ok, true);
    if (!page.ok) return;
    assert.equal(page.has_more, true);
    const next = await runtime.tools.searchAssets(session.session_id, { query: "", offset: Number(page.next_offset), limit: 2, expected_search_hash: String(page.search_hash) });
    assert.equal(next.ok, true);
    if (!next.ok) return;
    const firstIds = (page.hits as Array<{ asset_id: string }>).map((item) => item.asset_id);
    const secondIds = (next.hits as Array<{ asset_id: string }>).map((item) => item.asset_id);
    assert.equal(new Set([...firstIds, ...secondIds]).size, 4);
    const changed = runtime.knowledge.by_id.get(firstIds[0]!);
    assert.ok(changed); changed.content_hash = "synthetic_changed_version";
    const stale = await runtime.tools.searchAssets(session.session_id, { query: "", offset: 2, limit: 2, expected_search_hash: String(page.search_hash) });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, "search_version_changed");
  });
});

test("批量阅读逐资产分页、错误隔离和契约字段续页", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    const asset = runtime.knowledge.by_id.get("metric.new_users");
    assert.ok(asset); asset.body = "甲🙂乙丙"; asset.content_hash = "synthetic_version";
    const first = await runtime.tools.readAssets(session.session_id, { requests: [{ asset_id: asset.asset_id, body_limit: 2 }, { asset_id: "contract.not_found", body_limit: 2 }] });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const results = first.results as Array<Record<string, unknown>>;
    assert.equal(results[0]?.body, "甲🙂");
    assert.equal(results[0]?.next_body_offset, 2);
    assert.equal(results[1]?.ok, false);
    const next = await runtime.tools.readAssets(session.session_id, { requests: [{ asset_id: asset.asset_id, body_offset: 2, body_limit: 2, expected_content_hash: "synthetic_version" }] });
    assert.equal(next.ok, true);
    if (next.ok) assert.equal((next.results as Array<Record<string, unknown>>)[0]?.body, "乙丙");
    const invalid = await runtime.tools.readAssets(session.session_id, { requests: [{ asset_id: asset.asset_id, body_offset: 2, expected_content_hash: "stale" }, { asset_id: "metric.ad_revenue", body_limit: 1 }] });
    assert.equal(invalid.ok, true);
    if (invalid.ok) assert.equal((invalid.results as Array<Record<string, unknown>>)[0]?.code, "asset_version_changed");
    const contract = await runtime.tools.readDataContractView(session.session_id, { asset_id: "contract.daily_installs", columns_limit: 2 });
    assert.equal(contract.ok, true);
    if (!contract.ok) return;
    assert.equal((contract.columns as unknown[]).length, 2);
    assert.equal(contract.columns_has_more, true);
    assert.equal((contract.published_freshness as { status: string }).status, "fresh");
    const contractNext = await runtime.tools.readDataContractView(session.session_id, { asset_id: "contract.daily_installs", columns_offset: 2, columns_limit: 2, expected_content_hash: String(contract.content_hash) });
    assert.equal(contractNext.ok, true);
    if (contractNext.ok) assert.equal((contractNext.columns as unknown[]).length, 2);
    const staleContract = await runtime.tools.readDataContractView(session.session_id, { asset_id: "contract.daily_installs", columns_offset: 2, expected_content_hash: "stale" });
    assert.equal(staleContract.ok, false);
  });
});

test("批量读取全部失败时报告真实原因，空页不冒充权限失败", async () => {
  await withRuntime({ maxAssetReadBytes: 1 }, async (runtime) => {
    const session = analyst(runtime);
    const asset = runtime.knowledge.by_id.get("metric.new_users"); assert.ok(asset);
    const expired = await runtime.tools.readAssets(session.session_id, { requests: [{ asset_id: asset.asset_id, body_offset: 1, expected_content_hash: "stale" }] });
    assert.equal(expired.ok, false); if (!expired.ok) assert.equal(expired.code, "asset_version_changed");
    const missing = await runtime.tools.readAssets(session.session_id, { asset_ids: ["metric.synthetic_missing"] });
    assert.equal(missing.ok, false); if (!missing.ok) assert.equal(missing.code, "asset_not_found");
    const mixed = await runtime.tools.readAssets(session.session_id, { requests: [{ asset_id: asset.asset_id, body_offset: 1, expected_content_hash: "stale" }, { asset_id: "metric.synthetic_missing" }] });
    assert.equal(mixed.ok, false); if (!mixed.ok) assert.equal(mixed.code, "asset_batch_failed");
    const empty = await runtime.tools.readAssets(session.session_id, { asset_ids: [] });
    assert.equal(empty.ok, true); if (empty.ok) assert.deepEqual(empty.results, []);
    const malformed = await runtime.tools.readAssets(session.session_id, { asset_ids: "not-an-array" } as unknown as { asset_ids: string[] });
    assert.equal(malformed.ok, false); if (!malformed.ok) assert.equal(malformed.code, "invalid_asset_page");
  });
});

test("查询预览分页不截断完整资源，SQL LIMIT 不冒充完整总体", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    assert.equal((await runtime.tools.readDataContractView(session.session_id, { asset_id: "contract.daily_installs" })).ok, true);
    runtime.sessions.setActiveJob(session.session_id, "synthetic_page_job");
    const sql = "SELECT event_date, new_users FROM daily_installs WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-12' AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'US' AND channel = 'nebula_ads' ORDER BY event_date";
    const query = await runtime.tools.query(session.session_id, { sql, preview_limit: 2 });
    assert.equal(query.ok, true);
    if (!query.ok) return;
    assert.equal((query.rows as unknown[]).length, 2);
    assert.equal(query.preview_has_more, true);
    assert.equal(query.complete_population, true);
    const page = await runtime.tools.readSessionResource(session.session_id, { resource_id: String(query.resource_id), row_offset: 2, row_limit: 3, expected_resource_hash: String(query.resource_hash) });
    assert.equal(page.ok, true);
    if (page.ok) assert.equal((page.resource as { rows: unknown[] }).rows.length, 3);
    const calculation = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: String(query.resource_id), operations: [{ op: "sum", column: "new_users", as: "total" }] });
    assert.equal(calculation.ok, true);
    if (calculation.ok) assert.equal((calculation.cells as Record<string, number>).total, 480);
    const limited = await runtime.tools.query(session.session_id, { sql: `${sql} LIMIT 2`, preview_limit: 1 });
    assert.equal(limited.ok, true);
    if (!limited.ok) return;
    assert.equal(limited.sql_limited, true);
    assert.equal(limited.truncated, false);
    assert.equal(limited.complete_population, false);
    const pageLimited = await runtime.tools.readSessionResource(session.session_id, { resource_id: String(limited.resource_id) });
    assert.equal(pageLimited.ok, true);
    if (pageLimited.ok) assert.equal(pageLimited.resource_truncated, true);
  });
});

test("空查询明确提示检查编码与范围，不伪造成零", async () => {
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    assert.equal((await runtime.tools.readDataContractView(session.session_id, { asset_id: "contract.daily_installs" })).ok, true);
    runtime.sessions.setActiveJob(session.session_id, "empty_result_job");
    const result = await runtime.tools.query(session.session_id, { sql: "SELECT event_date, new_users FROM daily_installs WHERE event_date = '2026-10-06' AND product_id = 'starlane_drift' AND platform = 'IOS' AND country_code = 'US' AND channel = 'nebula_ads'" });
    assert.equal(result.ok, true); if (!result.ok) return;
    assert.deepEqual(result.rows, []);
    assert.match(String(result.notice), /空结果不是数值零/u);
    assert.match(String(result.notice), /大小写/u);
    const calculation = await runtime.tools.calculateSessionCells(session.session_id, { resource_id: String(result.resource_id), operations: [{ op: "sum", column: "new_users", as: "total" }] });
    assert.equal(calculation.ok, true); if (calculation.ok) assert.equal((calculation.cells as Record<string, unknown>).total, null);
  });
});
