import { clickHouseCommand, clickHouseInsert, createClickHouseClient } from "./clickhouse-client.js";
import { createTableSql, rollingWarehouse, WAREHOUSE_TABLES } from "./warehouse.js";

// This command only creates a new, explicitly named synthetic database. It
// never drops or truncates an existing database, including on partial failure.
const url = process.env.CLICKHOUSE_URL ?? "";
const database = process.env.SYNTHETIC_DATABASE ?? "";
const adminUser = process.env.SYNTHETIC_ADMIN_USER ?? "";
const adminPassword = process.env.SYNTHETIC_ADMIN_PASSWORD ?? "";
const reader = process.env.SYNTHETIC_READER_USER ?? "";
const readerPassword = process.env.SYNTHETIC_READER_PASSWORD ?? "";
if (!/^synthetic_[a-z0-9_]{1,40}$/u.test(database) || !/^synthetic_[a-z0-9_]{1,40}$/u.test(reader) || !/^[A-Za-z0-9]{16,128}$/u.test(readerPassword) || !adminUser || !adminPassword) {
  throw new Error("synthetic_seed_configuration_invalid");
}
const config = { url, username: adminUser, password: adminPassword, maxRowsToRead: 5_000_000, timeoutSeconds: 30 };
const bootstrap = createClickHouseClient({ ...config, database: "default" }, false);
try {
  await clickHouseCommand(bootstrap, `CREATE DATABASE ${database}`);
} finally { await bootstrap.close(); }
const admin = createClickHouseClient({ ...config, database }, false);
try {
  for (const table of WAREHOUSE_TABLES) await clickHouseCommand(admin, createTableSql(table));
  const data = rollingWarehouse({ simulatedToday: process.env.SIMULATED_TODAY });
  const tables = {
    dim_fox_title: data.titles, dim_fox_channel: data.channels,
    fact_fox_daily_install: data.installs, fact_fox_daily_active: data.active, fact_fox_daily_payment: data.payments,
    fact_fox_ad_receipt: data.revenue, fact_fox_daily_spend: data.spend,
    fact_fox_retention_cohort: data.retention, fact_fox_cohort_payback: data.cohortPayback,
    fact_fox_experiment_arm: data.arms, fact_fox_experiment_metric: data.experimentMetrics,
  };
  for (const [table, rows] of Object.entries(tables)) await clickHouseInsert<unknown>(admin, table, rows);
  await clickHouseCommand(admin, `CREATE USER ${reader} IDENTIFIED BY '${readerPassword}'`);
  await clickHouseCommand(admin, `GRANT SELECT ON ${database}.* TO ${reader}`);
  console.log("合成 ClickHouse 数据库和只读账号已创建；请发布滚动 freshness。");
} catch {
  // Database server error details can contain SQL or credentials.
  console.error("合成初始化未完成；保留新数据库以供检查，不自动删除。");
  process.exitCode = 1;
} finally { await admin.close(); }
