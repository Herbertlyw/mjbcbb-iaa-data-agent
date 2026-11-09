import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { clickHouseCommand, clickHouseInsert, clickHouseQueryBounded, createClickHouseClient } from "../src/clickhouse-client.js";
import { prepareJoinEvidence, verifyJoinEvidence, verifyJoinExecutionSchema } from "../src/join-evidence.js";
import { loadKnowledge } from "../src/knowledge.js";
import { isolatedDocker, loopbackPort, runOwnedContainer } from "./isolated-docker.js";

test("隔离 ClickHouse：事实属性分组仍按原始粒度拒绝跨组重复", { timeout: 120_000 }, async () => {
  const knowledge = loadKnowledge("knowledge/starhaven");
  const fact = knowledge.contract_by_table.get("fact_delivery_daily")!.contract!;
  const dimension = knowledge.contract_by_table.get("dim_app")!.contract!;
  const name = `attribute-proof-${randomUUID()}`;
  const password = randomBytes(20).toString("hex");
  const owned: string[] = [];
  try {
    await runOwnedContainer(["run", "--pull=never", "-d", "--name", name, "--label", `dataagent.test.run=${name}`, "--tmpfs", "/var/lib/clickhouse:rw,size=512m", "--tmpfs", "/var/log/clickhouse-server:rw,size=64m", "--ulimit", "nofile=262144:262144", "-p", "127.0.0.1::8123", "-e", `CLICKHOUSE_PASSWORD=${password}`, "clickhouse/clickhouse-server:24.8.14.39"], name, name, owned);
    const port = await loopbackPort(name, 8123); const url = `http://127.0.0.1:${port}`; const deadline = Date.now() + 60_000;
    while (true) { try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {} if (Date.now() > deadline) throw new Error("isolated_clickhouse_not_ready"); await new Promise((resolve) => setTimeout(resolve, 200)); }
    const ch = createClickHouseClient({ url, username: "default", password, database: "default", maxRowsToRead: 5_000_000, timeoutSeconds: 30 }, false);
    try {
      const factFields = [fact.series!.date_column, ...fact.series!.dimensions, "source_currency", "discounted_cost_usd"];
      const dimFields = ["dataset_version", "app_id", "game_name", "platform"];
      const columns = (contract: typeof fact, names: string[]) => names.map((field) => `${field} ${contract.columns.find((item) => item.name === field)!.type}`).join(", ");
      await clickHouseCommand(ch, `CREATE TABLE fact_delivery_daily (${columns(fact, factFields)}) ENGINE = Memory`);
      await clickHouseCommand(ch, `CREATE TABLE dim_app (${columns(dimension, dimFields)}) ENGINE = Memory`);
      await clickHouseInsert(ch, "dim_app", [{ dataset_version: "synthetic_v1", app_id: "demo_ios", game_name: "示例", platform: "ios" }]);
      const makeRow = (currency: string, account: string, amount: string | null) => ({
        ...Object.fromEntries(fact.series!.dimensions.map((field) => [field, fact.columns.find((item) => item.name === field)!.nullable ? null : "scope"])),
        business_date: "2026-10-30", dataset_version: "synthetic_v1", app_id: "demo_ios", account_id: account, source_currency: currency, discounted_cost_usd: amount,
      });
      const sql = "SELECT f.app_id, d.game_name, d.platform, f.source_currency, SUM(f.discounted_cost_usd) AS total_cost, COUNT(f.discounted_cost_usd) AS nonnull_cost, COUNT() AS source_rows FROM fact_delivery_daily f JOIN dim_app d ON f.dataset_version = d.dataset_version AND f.app_id = d.app_id WHERE f.dataset_version = 'synthetic_v1' AND f.business_date = '2026-10-30' GROUP BY f.app_id, d.game_name, d.platform, f.source_currency ORDER BY f.app_id, f.source_currency";
      const plan = prepareJoinEvidence(sql, fact, dimension, knowledge.joins, true); assert.ok(plan);
      const read = () => clickHouseQueryBounded(ch, plan.executionSql, 100, 1_000_000);
      await clickHouseInsert(ch, "fact_delivery_daily", [makeRow("USD", "account_a", "1.250000"), makeRow("XCU", "account_b", "0.000000")]);
      const good = await read();
      assert.equal(verifyJoinExecutionSchema(plan, fact, dimension, good.column_types), true);
      assert.deepEqual(verifyJoinEvidence(plan, good.rows)?.filter((item) => item.operation === "sum").map((item) => [item.group["fact_delivery_daily.source_currency"], item.value]), [["USD", "1.250000"], ["XCU", "0.000000"]]);
      await clickHouseCommand(ch, "TRUNCATE TABLE fact_delivery_daily");
      await clickHouseInsert(ch, "fact_delivery_daily", [makeRow("USD", "account_a", "1.250000"), makeRow("XCU", "account_a", "2.000000")]);
      assert.equal(verifyJoinEvidence(plan, (await read()).rows), null, "同一主键拆进不同分组仍是重复事实");
      await clickHouseCommand(ch, "TRUNCATE TABLE fact_delivery_daily");
      await clickHouseInsert(ch, "fact_delivery_daily", [makeRow("USD", "account_a", null)]);
      assert.equal(verifyJoinEvidence(plan, (await read()).rows), null, "NULL 不应变成已核验的零");
      await clickHouseCommand(ch, "TRUNCATE TABLE fact_delivery_daily");
      await clickHouseInsert(ch, "fact_delivery_daily", [makeRow("USD", "account_a", "1.250000")]);
      await clickHouseInsert(ch, "dim_app", [{ dataset_version: "synthetic_v1", app_id: "demo_ios", game_name: "重复名称", platform: "ios" }]);
      assert.equal(verifyJoinEvidence(plan, (await read()).rows), null, "重复维表键不可放大事实");
    } finally { await ch.close(); }
  } finally { for (const id of owned) await isolatedDocker(["rm", "-f", id]).catch(() => undefined); }
});
