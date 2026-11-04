import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { preflightClickHouseSql } from "../src/clickhouse-sql-preflight.js";
import { guardSql, SqlRejected } from "../src/sql.js";
import { loadKnowledge } from "../src/knowledge.js";
import { clickHouseCommand, clickHouseInsert, clickHouseQuery, createClickHouseClient } from "../src/clickhouse-client.js";
import { createTableSql, WAREHOUSE_TABLES } from "../src/warehouse.js";
import { isolatedDocker, loopbackPort, runOwnedContainer } from "./isolated-docker.js";

const knowledge = loadKnowledge("knowledge/harborlight");
const fact = knowledge.contract_by_table.get("fact_fox_daily_install")!.contract!;
const rules = [{ table: fact.table, allowed_columns: fact.columns.filter((column) => !fact.sensitive_columns.includes(column.name)).map((column) => column.name), sensitive_columns: fact.sensitive_columns, must_filter: fact.must_filter }];
const where = "event_date >= '2026-10-06' AND event_date <= '2026-10-08'";

test("ClickHouse AST 递归识别物理来源，危险结构不会取代契约授权", () => {
  const query = `WITH a AS (SELECT event_date, new_users, country_code FROM ${fact.table} WHERE ${where}), b AS (SELECT event_date, new_users FROM a WHERE country_code IN ('US','JP')) SELECT event_date, new_users FROM b`;
  const result = preflightClickHouseSql(query);
  assert.equal(result.ok, true); if (result.ok) assert.deepEqual(result.tables, [fact.table]);
  assert.doesNotThrow(() => guardSql(query, rules, "clickhouse"));
  for (const sql of [
    `SELECT new_users FROM ${fact.table} WHERE ${where} SETTINGS max_threads=8`,
    "SELECT x FROM remote('localhost', 'synthetic', 'facts')",
    `SELECT new_users FROM ${fact.table} WHERE ${where}; DELETE FROM ${fact.table}`,
    `SELECT new_users FROM ${fact.table} WHERE event_date = {value:Date}`,
  ]) assert.equal(preflightClickHouseSql(sql).ok, false, sql);
  assert.throws(() => guardSql(`SELECT "device_token" FROM ${fact.table} WHERE ${where}`, rules, "clickhouse"), (error: unknown) => error instanceof SqlRejected && error.code === "sensitive_field");
  assert.throws(() => guardSql(`SELECT new_users FROM ${fact.table} WHERE ${where} AND "device_token" = 'synthetic'`, rules, "clickhouse"), (error: unknown) => error instanceof SqlRejected && error.code === "sensitive_field");
  assert.doesNotThrow(() => guardSql(`SELECT "new_users" FROM ${fact.table} WHERE ${where}`, rules, "clickhouse"));
  assert.throws(() => guardSql(`WITH x AS (SELECT device_token FROM ${fact.table} WHERE ${where}) SELECT device_token FROM x`, rules, "clickhouse"), SqlRejected);
  const hidden = `WITH x AS (SELECT event_date, new_users FROM unauthorized_fact WHERE ${where}) SELECT new_users FROM x`;
  const hiddenSource = preflightClickHouseSql(hidden); assert.equal(hiddenSource.ok, true);
  if (hiddenSource.ok) assert.deepEqual(hiddenSource.tables, ["unauthorized_fact"]);
  assert.throws(() => guardSql(hidden, rules, "clickhouse"), SqlRejected);
});

test("隔离 ClickHouse：双引号是标识符，敏感字段不能冒充字符串", { timeout: 90_000 }, async () => {
  const name = `dataagent-ck-ast-${randomUUID()}`; const password = randomBytes(18).toString("hex"); const owned: string[] = [];
  try {
    await runOwnedContainer(["run", "--pull=never", "-d", "--name", name, "--label", `dataagent.test.run=${name}`, "--tmpfs", "/var/lib/clickhouse:rw,size=512m", "--ulimit", "nofile=262144:262144", "-p", "127.0.0.1::8123", "-e", `CLICKHOUSE_PASSWORD=${password}`, "-e", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1", "clickhouse/clickhouse-server:24.8.14.39"], name, name, owned);
    const port = await loopbackPort(name, 8123); const url = `http://127.0.0.1:${port}`; const deadline = Date.now() + 45_000;
    while (true) { try { if ((await fetch(`${url}/ping`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {} if (Date.now() > deadline) throw new Error("isolated_clickhouse_start_timeout"); await new Promise((resolve) => setTimeout(resolve, 250)); }
    const ch = createClickHouseClient({ url, username: "default", password, database: "default", maxRowsToRead: 1_000_000, timeoutSeconds: 10 }, false);
    try {
      const table = WAREHOUSE_TABLES.find((entry) => entry.table === fact.table); assert.ok(table);
      await clickHouseCommand(ch, createTableSql(table));
      await clickHouseInsert(ch, fact.table, [{ event_date: "2026-10-06", title_id: "fiction", platform: "ios", country_code: "JP", channel_id: "mist_ads", new_users: 13, device_token: "synthetic-value" }]);
      // This direct admin observation establishes dialect semantics, not a
      // permission to execute the same projection through the application.
      const dialect = await clickHouseQuery(ch, `SELECT "device_token" FROM ${fact.table} WHERE ${where}`);
      assert.equal(dialect[0]?.device_token, "synthetic-value");
      assert.throws(() => guardSql(`SELECT "device_token" FROM ${fact.table} WHERE ${where}`, rules, "clickhouse"), SqlRejected);
      const allowed = `SELECT event_date, country_code, new_users FROM ${fact.table} WHERE ${where} AND country_code IN ('US','JP')`;
      assert.doesNotThrow(() => guardSql(allowed, rules, "clickhouse"));
      assert.deepEqual((await clickHouseQuery(ch, allowed)).map(({ country_code, new_users }) => ({ country_code, new_users })), [{ country_code: "JP", new_users: 13 }]);
    } finally { await ch.close(); }
  } finally { for (const id of owned.reverse()) await isolatedDocker(["rm", "-f", id]).catch(() => undefined); }
});
