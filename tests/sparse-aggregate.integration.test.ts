import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { aggregateObservationInput } from "../src/aggregate-observation.js";
import { clickHouseCommand, clickHouseInsert, clickHouseQueryBounded, createClickHouseClient } from "../src/clickhouse-client.js";
import { loadKnowledge } from "../src/knowledge.js";
import { prepareWideAggregateProof, verifyWideAggregateProof, wideCaptureHash, type WideQueryResource } from "../src/wide-aggregate-proof.js";
import { isolatedDocker, loopbackPort, runOwnedContainer } from "./isolated-docker.js";

test("隔离 ClickHouse：离散日分组 SUM 只对同次无 NULL 且无溢出的观察提供部分血缘", { timeout: 120_000 }, async () => {
  const contract = loadKnowledge("knowledge/starhaven").contract_by_table.get("fact_activity_daily")!.contract!;
  const sql = "SELECT activity_date, completeness_state, SUM(active_devices) AS total FROM fact_activity_daily WHERE activity_date IN (toDate('2026-10-27'), toDate('2026-11-03')) AND app_id = 'demo_ios' GROUP BY activity_date, completeness_state ORDER BY activity_date";
  const range = { start: "2026-10-27", end: "2026-11-03", selected_dates: ["2026-10-27", "2026-11-03"], timezone: "UTC" };
  const plan = prepareWideAggregateProof(sql, contract, range); assert.ok(plan);
  const name = `sparse-sum-${randomUUID()}`; const password = randomBytes(20).toString("hex"); const owned: string[] = [];
  try {
    await runOwnedContainer(["run", "--pull=never", "-d", "--name", name, "--label", `dataagent.test.run=${name}`, "--tmpfs", "/var/lib/clickhouse:rw,size=512m", "--tmpfs", "/var/log/clickhouse-server:rw,size=64m", "--ulimit", "nofile=262144:262144", "-p", "127.0.0.1::8123", "-e", `CLICKHOUSE_PASSWORD=${password}`, "clickhouse/clickhouse-server:24.8.14.39"], name, name, owned);
    const port = await loopbackPort(name, 8123); const url = `http://127.0.0.1:${port}`; const deadline = Date.now() + 60_000;
    while (true) { try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {} if (Date.now() > deadline) throw new Error("isolated_clickhouse_not_ready"); await new Promise((resolve) => setTimeout(resolve, 200)); }
    const ch = createClickHouseClient({ url, username: "default", password, database: "default", maxRowsToRead: 5_000_000, timeoutSeconds: 30 }, false);
    try {
      await clickHouseCommand(ch, "CREATE TABLE fact_activity_daily (activity_date Date, app_id String, completeness_state String, active_devices Nullable(UInt64)) ENGINE = Memory");
      const row = (date: string, value: string | null) => ({ activity_date: date, app_id: "demo_ios", completeness_state: "complete", active_devices: value });
      const read = async () => {
        const captured = await clickHouseQueryBounded(ch, plan.executionSql, 100, 1_000_000);
        const hidden = new Set([...plan.fields.flatMap((field) => [field.proof, ...(field.nonnull ? [field.nonnull] : [])]), ...(plan.rowCount ? [plan.rowCount] : [])]);
        const rows = captured.rows.map((item) => Object.fromEntries(Object.entries(item).filter(([key]) => !hidden.has(key))));
        const types = Object.fromEntries(Object.entries(captured.column_types).filter(([key]) => !hidden.has(key)));
        return { resource_id: "res_synthetic", engine: "clickhouse-local", sql_review_engine: "clickhouse_ast_direct", result_semantics_version: 2, key_lineage_version: 1, sql, executed_sql: plan.executionSql, tables: [contract.table], time_range: range, execution_id: captured.query_id, scan_limit: 5_000_000, truncated: false, sql_limited: false, complete_population: true, total_rows_exact: true, returned_rows: rows.length, total_rows: rows.length, columns: Object.keys(types), column_types: types, coverage: { status: "unknown", absent_dates: [], null_dates: [], zero_dates: [], predicted_dates: [], actual_dates: [], unknown_prediction_dates: [], groups: [] }, rows, wide_aggregate_proof: { rows: captured.rows, column_types: captured.column_types, capture_hash: wideCaptureHash(sql, plan.executionSql, captured.query_id, captured.rows, captured.column_types) } } as unknown as WideQueryResource;
      };
      await clickHouseInsert(ch, "fact_activity_daily", [row("2026-10-27", "2"), row("2026-10-27", "3"), row("2026-11-03", "0")]);
      const good = await read(); const observation = aggregateObservationInput(good, contract); assert.ok(observation);
      assert.deepEqual(observation.observations.map((item) => [item.range.start, item.value, item.unit]), [["2026-10-27", "5", "设备×App"], ["2026-11-03", "0", "设备×App"]]);
      assert.ok(observation.observations.every((item) => item.filters.completeness_state === "complete"));
      assert.equal(observation.incomplete, true, "不将未观察的日期或分组认作完整总体");
      await clickHouseCommand(ch, "TRUNCATE TABLE fact_activity_daily");
      await clickHouseInsert(ch, "fact_activity_daily", [row("2026-10-27", "5"), row("2026-10-27", null), row("2026-11-03", "0")]);
      const missing = await read(); assert.equal(verifyWideAggregateProof(missing, contract), null); assert.equal(aggregateObservationInput(missing, contract), null, "部分 NULL 不能当作完整求和");
      await clickHouseCommand(ch, "TRUNCATE TABLE fact_activity_daily");
      await clickHouseInsert(ch, "fact_activity_daily", [row("2026-10-27", "18446744073709551615"), row("2026-10-27", "1"), row("2026-11-03", "0")]);
      const overflow = await read(); assert.equal(verifyWideAggregateProof(overflow, contract), null); assert.equal(aggregateObservationInput(overflow, contract), null, "64 位 SUM 溢出不能当作证据");
    } finally { await ch.close(); }
  } finally { for (const id of owned) await isolatedDocker(["rm", "-f", id]).catch(() => undefined); }
});
