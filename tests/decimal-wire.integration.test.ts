import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { clickHouseQueryBounded, createClickHouseClient } from "../src/clickhouse-client.js";
import { decimalOperation } from "../src/decimal-kernel.js";
import { previewRows } from "../src/tool-preview.js";
import { isolatedDocker, loopbackPort, runOwnedContainer } from "./isolated-docker.js";

test("隔离 ClickHouse wire、预览和定点计算区分六位小数、零、NULL 与大整数", { timeout: 120_000 }, async () => {
  const name = `decimal-wire-${randomUUID()}`; const password = randomBytes(20).toString("hex"); const owned: string[] = [];
  try {
    await runOwnedContainer(["run", "--pull=never", "-d", "--name", name, "--label", `dataagent.test.run=${name}`, "--tmpfs", "/var/lib/clickhouse:rw,size=512m", "--tmpfs", "/var/log/clickhouse-server:rw,size=64m", "--ulimit", "nofile=262144:262144", "-p", "127.0.0.1::8123", "-e", `CLICKHOUSE_PASSWORD=${password}`, "clickhouse/clickhouse-server:24.8.14.39"], name, name, owned);
    const url = `http://127.0.0.1:${await loopbackPort(name, 8123)}`; const deadline = Date.now() + 60_000;
    while (true) { try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {} if (Date.now() > deadline) throw new Error("isolated_clickhouse_not_ready"); await new Promise((resolve) => setTimeout(resolve, 200)); }
    const client = createClickHouseClient({ url, username: "default", password, database: "default", maxRowsToRead: 5000, timeoutSeconds: 10 }, false);
    try {
      const sql = "SELECT CAST('1.146593' AS Decimal(18,6)) AS amount, CAST('0.000000' AS Decimal(18,6)) AS actual_zero, CAST(NULL AS Nullable(Decimal(18,6))) AS missing, CAST('9007199254740993' AS UInt64) AS large_integer";
      const result = await clickHouseQueryBounded(client, sql, 10, 10_000);
      // ClickHouse may omit trailing zeroes in quoted Decimal JSON; retain the
      // physical Decimal type rather than inferring scale from its spelling.
      assert.deepEqual(result.rows, [{ amount: "1.146593", actual_zero: "0", missing: null, large_integer: "9007199254740993" }]);
      assert.deepEqual(result.column_types, { amount: "Decimal(18, 6)", actual_zero: "Decimal(18, 6)", missing: "Nullable(Decimal(18, 6))", large_integer: "UInt64" });
      const preview = JSON.parse(JSON.stringify(previewRows(result.rows, 10)));
      assert.deepEqual(preview, result.rows);
      assert.equal(decimalOperation("add", preview[0].amount, preview[0].actual_zero, 6), "1.146593");
      assert.equal(decimalOperation("divide", preview[0].amount, preview[0].actual_zero, 6), null);
      assert.notEqual(preview[0].amount, "1146593");
    } finally { await client.close(); }
  } finally { for (const id of owned) await isolatedDocker(["rm", "-f", id]).catch(() => undefined); }
});
