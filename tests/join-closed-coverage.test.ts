import { isolatedDocker, loopbackPort, runOwnedContainer } from "./isolated-docker.js";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { loadKnowledge } from "../src/knowledge.js";
import { prepareJoinCoverageEvidence, verifyJoinEvidence, verifyJoinExecutionSchema, joinClosedCoverage } from "../src/join-evidence.js";
import { createClickHouseClient, clickHouseCommand, clickHouseQueryBounded } from "../src/clickhouse-client.js";
import { createTableSql, smallWarehouse, WAREHOUSE_TABLES } from "../src/warehouse.js";
import { largeSyntheticInstallSql } from "../src/synthetic-large.js";
import { clickHouseInsert } from "../src/clickhouse-client.js";

const kb = loadKnowledge("knowledge/harborlight");
const original = kb.contract_by_table.get("fact_fox_daily_install")!.contract!;
const dimension = kb.contract_by_table.get("dim_fox_channel")!.contract!;
const fact = structuredClone(original);
fact.series!.coverage_domains = { country_code: { prefix: "S", start: 0, end: 12499 }, channel_id: { values: ["mist_ads", "pebble_net"] } };
const sql = `WITH p AS (SELECT f.event_date AS day, f.channel_id AS channel, SUM(f.new_users) AS subtotal FROM fact_fox_daily_install f WHERE f.event_date >= '2026-10-06' AND f.event_date <= '2026-10-09' AND f.title_id = 'big_demo' AND f.platform = 'android' GROUP BY f.event_date, f.channel_id) SELECT p.day AS day, p.channel AS channel, d.channel_name AS label, SUM(p.subtotal) AS total FROM p INNER JOIN dim_fox_channel d ON p.channel = d.channel_id GROUP BY p.day, p.channel, d.channel_name ORDER BY p.day, p.channel`;

test("封闭契约域在隔离 ClickHouse 上证明十万行覆盖，缺日和缺整组不可完成", { timeout: 120_000 }, async () => {
  const name = `dataagent-closed-${randomUUID()}`; const password = randomBytes(20).toString("hex"); const ownedContainers: string[] = [];
  try {
    await runOwnedContainer(["run", "--pull=never", "-d", "--name", name, "--label", `dataagent.test.run=${name}`, "--tmpfs", "/var/lib/clickhouse:rw,size=768m", "--ulimit", "nofile=262144:262144", "-p", "127.0.0.1::8123", "-e", `CLICKHOUSE_PASSWORD=${password}`, "-e", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1", "clickhouse/clickhouse-server:24.8.14.39"], name, name, ownedContainers);
    const port = await loopbackPort(name, 8123); assert.ok(port > 0);
    const url = `http://127.0.0.1:${port}`; const deadline = Date.now() + 45_000;
    while (true) { try { if ((await fetch(`${url}/ping`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {} if (Date.now() > deadline) throw new Error("isolated_clickhouse_start_timeout"); await new Promise((resolve) => setTimeout(resolve, 250)); }
    const ch = createClickHouseClient({ url, username: "default", password, database: "default", maxRowsToRead: 1_000_000, timeoutSeconds: 30 }, false);
    try {
      for (const table of [fact.table, dimension.table]) { const spec = WAREHOUSE_TABLES.find((entry) => entry.table === table); assert.ok(spec); await clickHouseCommand(ch, createTableSql(spec)); }
      await clickHouseInsert(ch, dimension.table, smallWarehouse().channels);
      const generated = largeSyntheticInstallSql();
      await clickHouseCommand(ch, generated);
      const plan = prepareJoinCoverageEvidence(sql, fact, dimension, kb.joins); assert.ok(plan); assert.equal(plan.coverageExpectedRows, 100_000);
      const read = async () => clickHouseQueryBounded(ch, plan.executionSql, 100, 2_000_000);
      const full = await read();
      assert.equal(full.truncated, false); assert.equal(verifyJoinExecutionSchema(plan, fact, dimension, full.column_types), true, JSON.stringify(full.column_types));
      assert.equal(full.rows.length, 8); assert.equal(joinClosedCoverage(plan, full.rows)?.status, "known");
      const expected = ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"].flatMap((day) => [
        { day, channel: "mist_ads", label: "雾帆", total: "156250000" },
        { day, channel: "pebble_net", label: "卵石", total: "156262500" },
      ]);
      assert.deepEqual(full.rows.map(({ __da_join_proof: _proof, ...row }) => ({ ...row, total: String(row.total) })), expected);
      const originalRows = await clickHouseQueryBounded(ch, sql, 100, 2_000_000);
      assert.deepEqual(full.rows.map(({ __da_join_proof: _proof, ...row }) => row), originalRows.rows);
      await clickHouseCommand(ch, `TRUNCATE TABLE ${fact.table}`);
      await clickHouseCommand(ch, `${generated} WHERE NOT (intDiv(number, 8) = 0 AND intDiv(number, 4) % 2 = 0)`);
      assert.equal(joinClosedCoverage(plan, (await read()).rows), null, "整个地区/渠道分组缺失不能完成");
      await clickHouseCommand(ch, `TRUNCATE TABLE ${fact.table}`);
      await clickHouseCommand(ch, `${generated} WHERE number != 0`);
      assert.equal(joinClosedCoverage(plan, (await read()).rows), null, "缺一天不能完成");
      await clickHouseCommand(ch, `TRUNCATE TABLE ${fact.table}`);
      await clickHouseCommand(ch, generated);
      await clickHouseCommand(ch, `TRUNCATE TABLE ${dimension.table}`);
      await clickHouseInsert(ch, dimension.table, smallWarehouse().channels.filter((row) => row.channel_id !== "mist_ads"));
      assert.equal(joinClosedCoverage(plan, (await read()).rows), null, "INNER JOIN 遗漏整组维键不能完成");
      await clickHouseCommand(ch, `TRUNCATE TABLE ${dimension.table}`);
      await clickHouseInsert(ch, dimension.table, [...smallWarehouse().channels, smallWarehouse().channels[0]!]);
      assert.equal(verifyJoinEvidence(plan, (await read()).rows), null, "重复维键不能证明覆盖");
      await clickHouseCommand(ch, `TRUNCATE TABLE ${dimension.table}`);
      await clickHouseInsert(ch, dimension.table, smallWarehouse().channels);
      await clickHouseCommand(ch, `TRUNCATE TABLE ${fact.table}`);
      const metric = "toInt32(2 * intDiv(number, 8) + 1 + intDiv(number, 4) % 2)";
      assert.ok(generated.includes(metric));
      await clickHouseCommand(ch, generated.replace(metric, `if(number = 0, NULL, ${metric})`));
      assert.equal(joinClosedCoverage(plan, (await read()).rows), null, "NULL 不能当作完整观测");
      await clickHouseCommand(ch, `TRUNCATE TABLE ${fact.table}`);
      await clickHouseCommand(ch, generated.replace(metric, `if(number = 0, 0, ${metric})`));
      assert.deepEqual(joinClosedCoverage(plan, (await read()).rows)?.zero_dates, ["2026-10-06"], "真实零保留日期");
      await clickHouseCommand(ch, `TRUNCATE TABLE ${fact.table}`);
      const region = "concat('S', toString(intDiv(number, 8)))";
      assert.ok(generated.includes(region));
      await clickHouseCommand(ch, generated.replace(region, `if(intDiv(number, 8) = 0, 'S12500', ${region})`));
      assert.equal(joinClosedCoverage(plan, (await read()).rows), null, "数量相同但含域外地区不能补全域内缺失");
      await clickHouseCommand(ch, `TRUNCATE TABLE ${fact.table}`);
      await clickHouseCommand(ch, generated);
      await clickHouseCommand(ch, `${generated} WHERE number = 0`);
      assert.equal(verifyJoinEvidence(plan, (await read()).rows), null, "重复事实粒度不能证明覆盖");
    } finally { await ch.close(); }
  } finally { for (const owned of ownedContainers) await isolatedDocker(["rm", "-f", owned]).catch(() => undefined); }
});

test("封闭域必须来自可验证的有限契约，非法或不完整范围失败关闭", () => {
  const build = (v: unknown) => { const c = structuredClone(original); (c.series as unknown as { coverage_domains: unknown }).coverage_domains = v; return prepareJoinCoverageEvidence(sql, c, dimension, kb.joins); };
  assert.equal(build(undefined), null);
  assert.equal(build({ country_code: { prefix: "S", start: 0, end: 12499 } }), null);
  assert.equal(build({ country_code: { prefix: "S' OR 1=1", start: 0, end: 12499 }, channel_id: { values: ["mist_ads", "pebble_net"] } }), null);
  assert.equal(build({ country_code: { prefix: "S", start: 0, end: 12499 }, channel_id: { values: ["mist_ads", "mist_ads"] } }), null);
  assert.equal(build({ country_code: { prefix: "S", start: 0, end: 1000001 }, channel_id: { values: ["mist_ads", "pebble_net"] } }), null);
  assert.equal(build({ country_code: { prefix: "S", start: 0, end: 12499 }, channel_id: { values: ["mist_ads", "pebble_net"] }, injected: { values: ["x"] } }), null);
});
