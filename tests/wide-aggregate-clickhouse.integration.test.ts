import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { clickHouseCommand, clickHouseInsert, clickHouseQueryBounded, createClickHouseClient } from "../src/clickhouse-client.js";
import { loadKnowledge } from "../src/knowledge.js";
import { prepareWideAggregateProof, verifyWideAggregateProof, wideCaptureHash, type WideQueryResource } from "../src/wide-aggregate-proof.js";
import { isolatedDocker, loopbackPort, runOwnedContainer } from "./isolated-docker.js";

test("isolated ClickHouse detects UInt64 overflow with same-query wide sums", async () => {
  const name = `wide-proof-${randomUUID()}`; const password = randomBytes(16).toString("hex"); const owned: string[] = [];
  try {
    await runOwnedContainer(["run", "--pull=never", "-d", "--name", name, "--label", `dataagent.test.run=${name}`, "--tmpfs", "/var/lib/clickhouse:rw,size=512m", "--tmpfs", "/var/log/clickhouse-server:rw,size=64m", "--ulimit", "nofile=262144:262144", "-p", "127.0.0.1::8123", "-e", `CLICKHOUSE_PASSWORD=${password}`, "clickhouse/clickhouse-server:24.8.14.39"], name, name, owned);
    const port = await loopbackPort(name, 8123); const url = `http://127.0.0.1:${port}`; const deadline = Date.now() + 60_000;
    while (true) { try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {} if (Date.now() > deadline) throw new Error("isolated_clickhouse_not_ready"); await new Promise((r) => setTimeout(r, 200)); }
    const admin = createClickHouseClient({ url, username: "default", password, database: "default", maxRowsToRead: 5_000_000, timeoutSeconds: 30 }, false);
    try {
      await clickHouseCommand(admin, "CREATE TABLE fact_delivery_daily (business_date Date, app_id String, ua_channel_id String, af_registers Nullable(UInt64)) ENGINE = Memory");
      await clickHouseInsert(admin, "fact_delivery_daily", [
        { business_date: "2026-11-07", app_id: "normal", ua_channel_id: "moss", af_registers: "2" },
        { business_date: "2026-11-07", app_id: "overflow", ua_channel_id: "moss", af_registers: "18446744073709551615" },
        { business_date: "2026-11-07", app_id: "overflow", ua_channel_id: "moss", af_registers: "1" },
      ]);
      const contract = loadKnowledge("knowledge/starhaven").contract_by_table.get("fact_delivery_daily")!.contract!;
      const range = { start: "2026-11-07", end: "2026-11-07", timezone: "UTC" };
      for (const [app, expected] of [["normal", true], ["overflow", false]] as const) {
        const sql = `SELECT ua_channel_id, SUM(af_registers) AS af_registers FROM fact_delivery_daily WHERE business_date = toDate('2026-11-07') AND app_id = '${app}' GROUP BY ua_channel_id`;
        const plan = prepareWideAggregateProof(sql, contract, range); assert.ok(plan);
        const got = await clickHouseQueryBounded(admin, plan.executionSql, 100, 100_000);
        const hidden = new Set(plan.fields.map((field) => field.proof));
        const rows = got.rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !hidden.has(key))));
        const types = Object.fromEntries(Object.entries(got.column_types).filter(([key]) => !hidden.has(key)));
        const source = { engine: "clickhouse-local", sql_review_engine: "clickhouse_ast_direct", sql, executed_sql: plan.executionSql, tables: [contract.table], time_range: range, execution_id: got.query_id, scan_limit: 5_000_000, truncated: false, sql_limited: false, complete_population: true, total_rows_exact: true, returned_rows: rows.length, total_rows: rows.length, columns: Object.keys(types), column_types: types, rows, wide_aggregate_proof: { rows: got.rows, column_types: got.column_types, capture_hash: wideCaptureHash(sql, plan.executionSql, got.query_id, got.rows, got.column_types) } } as unknown as WideQueryResource;
        assert.equal(Boolean(verifyWideAggregateProof(source, contract)), expected);
        if (app === "overflow") { assert.equal(rows[0]!.af_registers, "0"); assert.equal(got.rows[0]!.__da_wide_0, "18446744073709551616"); }
      }
    } finally { await admin.close(); }
  } finally { for (const container of owned) await isolatedDocker(["rm", "-f", container]).catch(() => undefined); }
});
