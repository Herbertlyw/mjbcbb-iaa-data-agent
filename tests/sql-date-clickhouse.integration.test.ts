import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { clickHouseCommand, clickHouseInsert, clickHouseQuery, createClickHouseClient } from "../src/clickhouse-client.js";
import { probeClickHouseAndPublish } from "../src/freshness.js";
import { createRuntime } from "../src/runtime.js";
import { createTableSql, smallWarehouse, WAREHOUSE_TABLES } from "../src/warehouse.js";
import { bindTables } from "./helpers.js";
import { isolatedDocker, loopbackPort, runOwnedContainer } from "./isolated-docker.js";

const knowledgeDir = fileURLToPath(new URL("../knowledge/harborlight/", import.meta.url));

test("隔离 ClickHouse：日期等值及 BETWEEN 按实际查询与覆盖交付", async () => {
  const name = `lumenfox-sqldate-${randomUUID()}`;
  const adminPassword = randomBytes(16).toString("hex");
  const readerPassword = randomBytes(16).toString("hex");
  const dir = mkdtempSync(path.join(tmpdir(), "lumenfox-sqldate-"));
  const ownedContainers: string[] = [];
  try {
    await runOwnedContainer(["run", "--pull=never", "-d", "--name", name, "--label", `dataagent.test.run=${name}`, "--tmpfs", "/var/lib/clickhouse:rw,size=512m", "--ulimit", "nofile=262144:262144", "-p", "127.0.0.1::8123", "-e", `CLICKHOUSE_PASSWORD=${adminPassword}`, "-e", "CLICKHOUSE_DB=harborlight", "-e", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1", "clickhouse/clickhouse-server:24.8.14.39"], name, name, ownedContainers);
    const port = await loopbackPort(name, 8123);
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 60_000;
    while (true) {
      try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* container is starting */ }
      if (Date.now() > deadline) throw new Error("isolated ClickHouse not ready");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const common = { url, maxRowsToRead: 5_000_000, timeoutSeconds: 30 };
    const bootstrap = createClickHouseClient({ ...common, username: "default", password: adminPassword, database: "default" }, false);
    try { await clickHouseCommand(bootstrap, "CREATE DATABASE IF NOT EXISTS harborlight"); } finally { await bootstrap.close(); }
    const admin = createClickHouseClient({ ...common, username: "default", password: adminPassword, database: "harborlight" }, false);
    try {
      for (const table of WAREHOUSE_TABLES) await clickHouseCommand(admin, createTableSql(table));
      const data = smallWarehouse();
      const tables = { dim_fox_title: data.titles, dim_fox_channel: data.channels, fact_fox_daily_install: data.installs, fact_fox_daily_active: data.active, fact_fox_daily_payment: data.payments, fact_fox_ad_receipt: data.revenue, fact_fox_daily_spend: data.spend, fact_fox_retention_cohort: data.retention, fact_fox_cohort_payback: data.cohortPayback, fact_fox_experiment_arm: data.arms, fact_fox_experiment_metric: data.experimentMetrics };
      for (const [table, rows] of Object.entries(tables)) await clickHouseInsert<unknown>(admin, table, rows);
      try { await clickHouseCommand(admin, `CREATE USER fox_reader IDENTIFIED BY '${readerPassword}'`); }
      catch { throw new Error("isolated read-only account creation failed"); }
      await clickHouseCommand(admin, "GRANT SELECT ON harborlight.* TO fox_reader");
      const reader = createClickHouseClient({ ...common, username: "fox_reader", password: readerPassword, database: "harborlight" }, true);
      const freshnessPath = path.join(dir, "freshness.json");
      try {
        const publication = await probeClickHouseAndPublish({ targetsPath: path.join(knowledgeDir, "freshness-targets.json"), destinationPath: freshnessPath, query: (sql) => clickHouseQuery(reader, sql) as Promise<Array<{ event_date: string }>> });
        assert.equal(publication.tables.fact_fox_daily_install?.status, "fresh");
        const runtime = createRuntime({ knowledgeDir, businessEngine: "clickhouse", clickhouseUrl: url, clickhouseUser: "fox_reader", clickhousePassword: readerPassword, clickhouseDatabase: "harborlight", freshnessPath, publishFreshnessOnStart: false, databasePath: path.join(dir, "unused.sqlite"), stateDatabasePath: path.join(dir, "state.sqlite"), startWorker: false, ephemeralDir: undefined });
        try {
          const session = runtime.sessions.create("analyst"); await bindTables(runtime, session.session_id, ["contract.fact_fox_daily_install"]);
          runtime.sessions.setActiveJob(session.session_id, "job_date_clickhouse");
          const scope = "title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'JP' AND channel_id = 'mist_ads'";
          for (const [condition, expected] of [["event_date = '2026-10-06'", "10"], ["event_date BETWEEN '2026-10-06' AND '2026-10-08'", "30"]] as const) {
            const query = await runtime.tools.query(session.session_id, { sql: `SELECT SUM(new_users) AS total FROM fact_fox_daily_install WHERE ${condition} AND ${scope}` });
            assert.equal(query.ok, true, JSON.stringify(query)); if (!query.ok) return;
            assert.equal(String((query.rows as Array<{ total: unknown }>)[0]?.total), expected);
            const result = await runtime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(query.resource_id)] });
            assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) return;
            assert.equal(result.status, "completed", JSON.stringify(result));
            assert.match(String(result.answer), new RegExp(`数据库求和 ${expected}；单位 人`));
            assert.equal((result.sources as Array<{ engine: string }>)[0]?.engine, "clickhouse-local");
          }
          const denied = await runtime.tools.query(session.session_id, { sql: "SELECT device_token FROM fact_fox_daily_install WHERE event_date = '2026-10-06'" });
          assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.code, "sensitive_field");
        } finally { await runtime.close(); }
      } finally { await reader.close(); }
    } finally { await admin.close(); }
  } finally {
    for (const owned of ownedContainers) await isolatedDocker(["rm", "-f", owned]).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
