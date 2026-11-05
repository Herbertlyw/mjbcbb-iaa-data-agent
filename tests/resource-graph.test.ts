import assert from "node:assert/strict";
import test from "node:test";
import { ResourceGraph, resourceHash } from "../src/resource-graph.js";
import type { SessionResource } from "../src/types.js";

const node = (value: object) => value as SessionResource;
const leaf = () => node({ resource_id: "query", session_id: "s", job_id: "j", kind: "query_result", rows: [{ value: "5" }] });
const calc = (source: SessionResource) => node({ resource_id: "calc", session_id: "s", job_id: "j", kind: "calculation", source_resource_id: source.resource_id, source_resource_hash: resourceHash(source) });

test("依赖图在一次评估中只读共享来源一次，结果按祖先顺序排列", async () => {
  const query = leaf(); const calculation = calc(query);
  const value = node({ resource_id: "math", session_id: "s", job_id: "j", kind: "arithmetic", left: { resource_id: "calc" }, right: { resource_id: "calc" } });
  const records = new Map([query, calculation, value].map((item) => [item.resource_id, item]));
  const reads: string[] = [];
  const graph = new ResourceGraph(async (id) => { reads.push(id); const resource = records.get(id); return resource ? { ok: true, resource } : { ok: false, code: "resource_not_found" }; }, "s", "j");
  assert.equal(await graph.add("math"), null);
  assert.equal(await graph.add("calc"), null);
  assert.deepEqual(graph.nodes().map((item) => item.resource_id), ["query", "calc", "math"]);
  assert.deepEqual(reads.sort(), ["calc", "math", "query"]);
});

test("依赖缺失、跨任务、来源变更及循环不会污染已通过的闭包", async () => {
  const query = leaf(); const calculation = calc(query);
  const records = new Map([query, calculation].map((item) => [item.resource_id, item]));
  const make = () => new ResourceGraph(async (id) => { const resource = records.get(id); return resource ? { ok: true, resource } : { ok: false, code: "resource_not_found" }; }, "s", "j");
  const graph = make(); assert.equal(await graph.add("query"), null);
  records.set("other", node({ resource_id: "other", session_id: "s", job_id: "different", kind: "arithmetic", left: { resource_id: "query" }, right: { resource_id: "missing" } }));
  assert.equal(await graph.add("other"), "resource_from_other_execution");
  assert.deepEqual(graph.nodes().map((item) => item.resource_id), ["query"]);
  records.set("query", node({ ...query, rows: [{ value: "6" }] }));
  assert.equal(await make().add("calc"), "resource_dependency_changed");
  records.set("cycle", node({ resource_id: "cycle", session_id: "s", job_id: "j", kind: "transform", source_resource_id: "cycle" }));
  assert.equal(await make().add("cycle"), "resource_dependency_cycle");
  records.set("missing_parent", node({ resource_id: "missing_parent", session_id: "s", job_id: "j", kind: "transform", source_resource_id: "missing" }));
  assert.equal(await make().add("missing_parent"), "resource_not_found");
  records.set("foreign_session", node({ resource_id: "foreign_session", session_id: "not-s", job_id: "j", kind: "query_result" }));
  assert.equal(await make().add("foreign_session"), "resource_dependency_invalid");
  for (let i = 0; i < 17; i++) records.set(`depth_${i}`, node({ resource_id: `depth_${i}`, session_id: "s", job_id: "j", kind: "transform", source_resource_id: i === 16 ? "query" : `depth_${i + 1}` }));
  assert.equal(await make().add("depth_0"), "resource_dependency_limit");
});
