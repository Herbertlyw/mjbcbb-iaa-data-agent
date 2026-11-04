import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { analyst, withRuntime } from "./helpers.js";
import { domainTools } from "../src/agent.js";

test("契约工具在 Pi 批次串行，SQLite 并发读取也保留所有绑定", async () => {
  await withRuntime({ startWorker: false }, async (runtime) => {
    const session = analyst(runtime);
    assert.equal(domainTools(session.session_id, runtime.tools).find((item) => item.name === "read_data_contract_view")?.executionMode, "sequential");
    const result = await Promise.all(["contract.daily_installs", "contract.daily_ad_revenue", "contract.daily_unit_economics"].map((asset_id) => runtime.tools.readDataContractView(session.session_id, { asset_id })));
    assert.ok(result.every((item) => item.ok));
    assert.deepEqual(runtime.sessions.require(session.session_id).bindings.map((item) => item.table).sort(), ["daily_ad_revenue", "daily_installs", "daily_unit_economics"]);
  });
});

test("契约视图提供有权查看的计算和登记关系，不创建其他契约绑定", async () => {
  await withRuntime({ knowledgeDir: path.resolve("knowledge/harborlight"), businessEngine: "clickhouse", clickhouseUrl: "http://127.0.0.1:1", clickhouseUser: "synthetic", clickhousePassword: "fictional", clickhouseDatabase: "default", publishFreshnessOnStart: false, startWorker: false }, async (runtime) => {
    const session = analyst(runtime);
    const view = await runtime.tools.readDataContractView(session.session_id, { asset_id: "contract.fact_fox_daily_payment" });
    assert.equal(view.ok, true, JSON.stringify(view)); if (!view.ok) return;
    const derived = view.derived_metrics as Array<{ id: string; numerator: string; denominator: string }>;
    assert.ok(derived.some((item) => item.id === "synthetic_amount_less_cost" && item.numerator === "amount_usd" && item.denominator === "cost_usd"));
    assert.ok(derived.some((item) => item.id === "synthetic_amount_per_install"));
    const joins = view.registered_relationships as Array<{ join_id: string; keys: string[] }>;
    assert.ok(joins.some((item) => item.join_id === "join.title_payment" && item.keys.includes("title_id")));
    assert.deepEqual(runtime.sessions.require(session.session_id).bindings.map((item) => item.table), ["fact_fox_daily_payment"]);
    const role = runtime.knowledge.policy.roles.analyst!;
    role.read = role.read.filter((id) => id !== "contract.fact_fox_daily_install" && id !== "contract.dim_fox_title");
    role.query_tables = role.query_tables.filter((table) => table !== "fact_fox_daily_install" && table !== "dim_fox_title");
    const restricted = await runtime.tools.readDataContractView(session.session_id, { asset_id: "contract.fact_fox_daily_payment" });
    assert.equal(restricted.ok, true); if (!restricted.ok) return;
    assert.ok((restricted.derived_metrics as Array<{ id: string }>).some((item) => item.id === "synthetic_amount_less_cost"));
    assert.ok(!(restricted.derived_metrics as Array<{ id: string }>).some((item) => item.id === "synthetic_amount_per_install"));
    assert.ok(!(restricted.registered_relationships as Array<{ join_id: string }>).some((item) => item.join_id === "join.title_payment"));
    role.read = role.read.filter((id) => id !== "join.rules");
    const noRules = await runtime.tools.readDataContractView(session.session_id, { asset_id: "contract.fact_fox_daily_payment" });
    assert.equal(noRules.ok, true); if (noRules.ok) assert.deepEqual(noRules.registered_relationships, []);
  });
});
