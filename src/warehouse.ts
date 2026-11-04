import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { currentCalendarDate, isCalendarDate } from "./config.js";

export const WAREHOUSE_DATABASE = "harborlight";
export const WAREHOUSE_DATES = enumerate("2026-09-29", "2026-10-12");

export interface ColumnSpec {
  name: string;
  chType: string;
  description: string;
  nullable?: boolean;
  unit?: string;
  null_means?: string;
  zero_means?: string;
  sensitive?: boolean;
}

export interface TableSpec {
  asset_id: string;
  table: string;
  title: string;
  purpose: string;
  grain: string;
  primary_key: string[];
  date_column: string | null;
  partition: string | null;
  sensitive_columns: string[];
  series?: { date_column: string; dimensions: string[]; metrics: string[]; predicted_column?: string | null };
  columns: ColumnSpec[];
  scope: string;
}

const titleColumns: ColumnSpec[] = [
  { name: "title_id", chType: "LowCardinality(String)", description: "虚构产品标识" },
  { name: "title_name", chType: "String", description: "虚构产品显示名" },
  { name: "genre", chType: "LowCardinality(String)", description: "虚构题材" },
  { name: "launched_on", chType: "Date", description: "虚构上线日" },
];

export const WAREHOUSE_TABLES: TableSpec[] = [
  spec("dim_fox_title", "虚构产品维度", "产品主数据，不含账号。", "每个 title_id 一行", ["title_id"], null, null, [], titleColumns, "小型集只有 paper_lantern 与 glass_minnow。"),
  spec("dim_fox_channel", "虚构渠道维度", "获客渠道主数据。", "每个 channel_id 一行", ["channel_id"], null, null, [], [
    { name: "channel_id", chType: "LowCardinality(String)", description: "虚构渠道标识" },
    { name: "channel_name", chType: "String", description: "虚构渠道名" },
    { name: "channel_kind", chType: "LowCardinality(String)", description: "渠道类别" },
  ], "小型集只有 mist_ads 与 pebble_net。"),
  fact("fact_fox_daily_install", "每日新增", "按日、产品、平台、地区、渠道的新增用户。", "event_date", ["new_users"], null, ["device_token"], [
    metric("new_users", "Nullable(Int32)", "新增用户。NULL 是缺失，0 是真实零。", true, "人"),
    { name: "device_token", chType: "Nullable(String)", description: "虚构设备桶，敏感，不能出现在查询里。", nullable: true, sensitive: true },
  ], "2026-09-29 至 2026-10-12。雾帆美国 iOS 纸灯在 10-09 为 NULL，10-07 为 0。卵石渠道多数日期无行。"),
  fact("fact_fox_daily_active", "每日活跃", "同一粒度的活跃用户，不从新增填补。", "event_date", ["active_users"], null, [], [
    metric("active_users", "Nullable(Int32)", "活跃用户。NULL 是缺失，0 是真实零。", true, "人"),
  ], "与新增同一批日期。10-12 日本 iOS 纸灯雾帆是合成异常波动。"),
  fact("fact_fox_daily_payment", "合成精确金额", "演示 Decimal 保留精度，不是真实交易。", "event_date", ["amount_usd", "cost_usd"], null, [], [
    metric("amount_usd", "Nullable(Decimal(18,2))", "虚构金额，使用精确十进制美元。", true, "USD"),
    metric("cost_usd", "Nullable(Decimal(18,2))", "相同粒度的虚构成本。", true, "USD"),
  ], "合成金额仅用于验证定点计算。"),
  {
    ...fact("fact_fox_retention_cohort", "留存 cohort", "按 cohort 日和留存日龄的留存人数。", "cohort_date", ["retained_users"], null, [], [
      { name: "day_n", chType: "UInt16", description: "留存日龄" },
      metric("retained_users", "Nullable(Int32)", "留存人数。NULL 不是 0。", true, "人"),
    ], "小型集只覆盖纸灯美国 iOS 的 2026-10-06 cohort，日龄 1 和 7。日龄 7 为 NULL。"),
    date_column: "cohort_date",
    series: { date_column: "cohort_date", dimensions: ["title_id", "platform", "country_code"], metrics: ["retained_users"], predicted_column: null },
  },
  {
    ...fact("fact_fox_ad_receipt", "广告变现", "按日和广告位的变现。预测行不进入实际。", "event_date", ["revenue_usd"], "is_predicted", [], [
      { name: "placement", chType: "LowCardinality(String)", description: "虚构广告位" },
      metric("revenue_usd", "Nullable(Float64)", "变现金额。NULL 是缺失，0 是真实零。", true, "USD"),
      { name: "is_predicted", chType: "UInt8", description: "1 表示预测，不能并入实际。" },
    ], "纸灯美国 iOS rewarded：10-08 为 NULL，10-07 为 0，10-10 与 10-11 为预测。没有渠道字段，不能假装按渠道缺失。"),
    columns: undefined as unknown as ColumnSpec[],
  },
  fact("fact_fox_daily_spend", "每日投放成本", "按日的成本与当日实际或预测回收。", "event_date", ["spend_usd", "payback_usd"], "is_predicted", [], [
    metric("spend_usd", "Nullable(Float64)", "投放成本。NULL 不是 0。", true, "USD"),
    metric("payback_usd", "Nullable(Float64)", "当日回收。预测行不进入实际 ROI。", true, "USD"),
    { name: "is_predicted", chType: "UInt8", description: "1 表示预测。" },
  ], "纸灯美国 iOS 雾帆：10-08 成本 NULL，10-07 成本真实零，10-10 整行是预测。"),
  {
    ...fact("fact_fox_cohort_payback", "cohort 回收", "按 cohort 和回收周期的实际或预测回收。", "cohort_date", ["payback_usd"], "is_predicted", [], [
      { name: "horizon_day", chType: "UInt16", description: "回收观察日" },
      metric("payback_usd", "Nullable(Float64)", "该周期回收。", true, "USD"),
      { name: "is_predicted", chType: "UInt8", description: "1 表示预测。" },
    ], "纸灯美国 iOS 雾帆 cohort 2026-10-06：7 日实际，30 日预测，1 日为 NULL。"),
    date_column: "cohort_date",
    series: { date_column: "cohort_date", dimensions: ["title_id", "platform", "country_code", "channel_id"], metrics: ["payback_usd"], predicted_column: "is_predicted" },
  },
  {
    ...fact("fact_fox_experiment_arm", "实验分组", "实验变体的分配人数，不是用户明细。", "assigned_on", ["assigned_users"], null, [], [
      { name: "experiment_id", chType: "LowCardinality(String)", description: "虚构实验" },
      { name: "variant_id", chType: "LowCardinality(String)", description: "虚构变体" },
      metric("assigned_users", "Nullable(Int32)", "分配人数。", true),
    ], "只有 lantern_holdout 在 2026-10-06 的 hold 与 release。不能和投放表连接。"),
    date_column: "assigned_on",
    series: undefined,
  },
  fact("fact_fox_experiment_metric", "实验指标", "实验变体按日的指标，不含用户明细。", "event_date", ["metric_value"], null, [], [
    { name: "experiment_id", chType: "LowCardinality(String)", description: "虚构实验" },
    { name: "variant_id", chType: "LowCardinality(String)", description: "虚构变体" },
    { name: "metric_name", chType: "LowCardinality(String)", description: "指标名" },
    metric("metric_value", "Nullable(Float64)", "指标值。NULL 不是 0。", true),
  ], "2026-10-06 至 2026-10-12。release 在 10-09 为 NULL。没有和新增表登记连接。"),
];

function spec(table: string, title: string, purpose: string, grain: string, primary_key: string[], date_column: string | null, partition: string | null, sensitive: string[], columns: ColumnSpec[], scope: string): TableSpec {
  return { asset_id: `contract.${table}`, table, title, purpose, grain, primary_key, date_column, partition, sensitive_columns: sensitive, columns, scope };
}

function fact(table: string, title: string, purpose: string, dateColumn: string, metrics: string[], predicted: string | null, sensitive: string[], extra: ColumnSpec[], scope: string): TableSpec {
  const dims = ["title_id", "platform", "country_code", ...(table === "fact_fox_ad_receipt" || table === "fact_fox_retention_cohort" || table === "fact_fox_experiment_arm" || table === "fact_fox_experiment_metric" ? [] : ["channel_id"])];
  const columns = [
    { name: dateColumn, chType: "Date", description: "业务日期，时区 America/Los_Angeles，分区按月。" },
    ...dims.map((name) => ({ name, chType: "LowCardinality(String)", description: `${name} 维度` })),
    ...extra,
  ];
  return {
    asset_id: `contract.${table}`,
    table,
    title,
    purpose,
    grain: `${dateColumn} + ${dims.join(" + ")}`,
    primary_key: [dateColumn, ...dims],
    date_column: dateColumn,
    partition: `toYYYYMM(${dateColumn})`,
    sensitive_columns: sensitive,
    series: table.startsWith("fact_fox_experiment") ? undefined : { date_column: dateColumn, dimensions: dims, metrics, predicted_column: predicted },
    columns,
    scope,
  };
}

function metric(name: string, chType: string, description: string, nullable: boolean, unit?: string): ColumnSpec {
  return { name, chType, description, nullable, ...(unit ? { unit } : {}), null_means: "缺失，不能当成零", zero_means: "观测到的真实零" };
}

// Repair ad receipt columns: fact() already includes placement via extra, but I passed extra after the spread bug.
// The object overwrite below is applied in normalize().
normalizeTables();

function normalizeTables(): void {
  const ad = WAREHOUSE_TABLES.find((item) => item.table === "fact_fox_ad_receipt");
  if (!ad) return;
  ad.columns = [
    { name: "event_date", chType: "Date", description: "业务日期，时区 America/Los_Angeles。" },
    { name: "title_id", chType: "LowCardinality(String)", description: "虚构产品" },
    { name: "platform", chType: "LowCardinality(String)", description: "平台" },
    { name: "country_code", chType: "LowCardinality(String)", description: "地区" },
    { name: "placement", chType: "LowCardinality(String)", description: "虚构广告位" },
    metric("revenue_usd", "Nullable(Float64)", "变现金额。NULL 是缺失，0 是真实零。", true, "USD"),
    { name: "is_predicted", chType: "UInt8", description: "1 表示预测，不能并入实际。" },
  ];
  ad.series = { date_column: "event_date", dimensions: ["title_id", "platform", "country_code"], metrics: ["revenue_usd"], predicted_column: "is_predicted" };
  ad.primary_key = ["event_date", "title_id", "platform", "country_code", "placement"];
}

export function createTableSql(table: TableSpec): string {
  const columns = table.columns.map((column) => `  ${column.name} ${column.chType}`).join(",\n");
  const order = table.primary_key.join(", ");
  const partition = table.partition ? `\nPARTITION BY ${table.partition}` : "";
  return `CREATE TABLE IF NOT EXISTS ${table.table} (\n${columns}\n) ENGINE = MergeTree${partition}\nORDER BY (${order})`;
}

export interface InstallRow { event_date: string; title_id: string; platform: string; country_code: string; channel_id: string; new_users: number | null; device_token: string | null }
export interface ActiveRow { event_date: string; title_id: string; platform: string; country_code: string; channel_id: string; active_users: number | null }
export interface RevenueRow { event_date: string; title_id: string; platform: string; country_code: string; placement: string; revenue_usd: number | null; is_predicted: number }
export interface SpendRow { event_date: string; title_id: string; platform: string; country_code: string; channel_id: string; spend_usd: number | null; payback_usd: number | null; is_predicted: number }

export function smallWarehouse() {
  const installs: InstallRow[] = [];
  const active: ActiveRow[] = [];
  for (const date of WAREHOUSE_DATES) {
    const mist = mistInstall(date);
    if (mist !== "absent") {
      installs.push({ event_date: date, title_id: "paper_lantern", platform: "ios", country_code: "US", channel_id: "mist_ads", new_users: mist, device_token: date === "2026-10-06" ? "sim-token-not-a-device" : null });
      active.push({ event_date: date, title_id: "paper_lantern", platform: "ios", country_code: "US", channel_id: "mist_ads", active_users: mist === null ? null : mist + 5 });
    }
    if (date === "2026-10-06") {
      installs.push({ event_date: date, title_id: "paper_lantern", platform: "ios", country_code: "US", channel_id: "pebble_net", new_users: 5, device_token: null });
    }
    if (date >= "2026-10-06" && date <= "2026-10-12") {
      installs.push({ event_date: date, title_id: "paper_lantern", platform: "ios", country_code: "JP", channel_id: "mist_ads", new_users: 10, device_token: null });
      const activeUsers = date === "2026-10-12" ? 5000 : 15;
      active.push({ event_date: date, title_id: "paper_lantern", platform: "ios", country_code: "JP", channel_id: "mist_ads", active_users: activeUsers });
      const glass = date === "2026-10-07" ? 0 : 8;
      installs.push({ event_date: date, title_id: "glass_minnow", platform: "ios", country_code: "DE", channel_id: "mist_ads", new_users: glass, device_token: null });
    }
  }
  // A separate synthetic Android population exercises complete-resource
  // pagination. Values 1..240 have the independently checkable sum 28,920;
  // region labels are fictional identifiers, not real country codes.
  for (let index = 1; index <= 240; index += 1) {
    installs.push({ event_date: "2026-10-06", title_id: "paper_lantern", platform: "android", country_code: `S${String(index).padStart(3, "0")}`, channel_id: "mist_ads", new_users: index, device_token: null });
  }
  // Three independently countable days of 1..1200: 720600 each, 2161800 in
  // total. Fictional region identifiers have no link to countries or devices.
  for (let index = 1; index <= 1200; index += 1) {
    for (const date of ["2026-10-06", "2026-10-07", "2026-10-08"]) {
      installs.push({ event_date: date, title_id: "glass_minnow", platform: "android", country_code: `Q${String(index).padStart(4, "0")}`, channel_id: "pebble_net", new_users: index, device_token: null });
    }
  }
  for (const date of WAREHOUSE_DATES.filter((day) => day >= "2026-10-06" && day <= "2026-10-12")) {
    installs.push({ event_date: date, title_id: "glass_minnow", platform: "android", country_code: "ZZ", channel_id: "mist_ads", new_users: 10, device_token: null });
    installs.push({ event_date: date, title_id: "glass_minnow", platform: "android", country_code: "ZZ", channel_id: "unlisted_channel", new_users: 3, device_token: null });
    installs.push({ event_date: date, title_id: "unknown_title", platform: "android", country_code: "ZZ", channel_id: "mist_ads", new_users: 3, device_token: null });
  }
  const revenue: RevenueRow[] = [];
  const spend: SpendRow[] = [];
  const payments = WAREHOUSE_DATES.map((date) => ({ event_date: date, title_id: "paper_lantern", platform: "ios", country_code: "US", channel_id: "mist_ads", amount_usd: date === "2026-10-06" ? "90071992547409.91" : date === "2026-10-07" ? "0.09" : date === "2026-10-08" ? "1.00" : date === "2026-10-09" ? null : "0.00", cost_usd: date === "2026-10-06" ? "0.10" : date === "2026-10-07" ? "0.03" : date === "2026-10-08" ? "2.00" : date === "2026-10-09" ? null : "0.00" }));
  payments.push(
    { event_date: "2026-10-08", title_id: "paper_lantern", platform: "ios", country_code: "US", channel_id: "pebble_net", amount_usd: "6.00", cost_usd: "3.00" },
    { event_date: "2026-10-08", title_id: "paper_lantern", platform: "ios", country_code: "JP", channel_id: "mist_ads", amount_usd: "3.00", cost_usd: "2.00" },
  );
  const revenuePlan: Record<string, [number | null, number]> = {
    "2026-10-06": [12.5, 0],
    "2026-10-07": [0, 0],
    "2026-10-08": [null, 0],
    "2026-10-09": [15, 0],
    "2026-10-10": [14, 1],
    "2026-10-11": [13.5, 1],
    "2026-10-12": [16, 0],
  };
  const spendPlan: Record<string, [number | null, number | null, number]> = {
    "2026-10-06": [10, 20, 0],
    "2026-10-07": [0, 0, 0],
    "2026-10-08": [null, null, 0],
    "2026-10-09": [10, 5, 0],
    "2026-10-10": [10, 30, 1],
    "2026-10-11": [8, 16, 0],
    "2026-10-12": [12, 6, 0],
  };
  for (const date of Object.keys(revenuePlan)) {
    const [amount, predicted] = revenuePlan[date]!;
    revenue.push({ event_date: date, title_id: "paper_lantern", platform: "ios", country_code: "US", placement: "rewarded", revenue_usd: amount, is_predicted: predicted });
    const [cost, payback, flag] = spendPlan[date]!;
    spend.push({ event_date: date, title_id: "paper_lantern", platform: "ios", country_code: "US", channel_id: "mist_ads", spend_usd: cost, payback_usd: payback, is_predicted: flag });
  }
  spend.push({ event_date: "2026-10-06", title_id: "paper_lantern", platform: "ios", country_code: "US", channel_id: "pebble_net", spend_usd: 5, payback_usd: 5, is_predicted: 0 });
  spend.push({ event_date: "2026-10-06", title_id: "glass_minnow", platform: "android", country_code: "DE", channel_id: "pebble_net", spend_usd: 0, payback_usd: 5, is_predicted: 0 });
  return {
    titles: [
      { title_id: "paper_lantern", title_name: "纸灯", genre: "kite", launched_on: "2026-01-01" },
      { title_id: "glass_minnow", title_name: "玻璃鲦", genre: "pond", launched_on: "2026-03-01" },
    ],
    channels: [
      { channel_id: "mist_ads", channel_name: "雾帆", channel_kind: "network" },
      { channel_id: "pebble_net", channel_name: "卵石", channel_kind: "network" },
    ],
    installs,
    active,
    payments,
    revenue,
    spend,
    retention: [
      { cohort_date: "2026-10-06", title_id: "paper_lantern", platform: "ios", country_code: "US", day_n: 1, retained_users: 40 },
      { cohort_date: "2026-10-06", title_id: "paper_lantern", platform: "ios", country_code: "US", day_n: 7, retained_users: null },
    ],
    cohortPayback: [
      { cohort_date: "2026-10-06", title_id: "paper_lantern", platform: "ios", country_code: "US", channel_id: "mist_ads", horizon_day: 1, payback_usd: null, is_predicted: 0 },
      { cohort_date: "2026-10-06", title_id: "paper_lantern", platform: "ios", country_code: "US", channel_id: "mist_ads", horizon_day: 7, payback_usd: 40, is_predicted: 0 },
      { cohort_date: "2026-10-06", title_id: "paper_lantern", platform: "ios", country_code: "US", channel_id: "mist_ads", horizon_day: 30, payback_usd: 55, is_predicted: 1 },
    ],
    arms: [
      { assigned_on: "2026-10-06", title_id: "paper_lantern", platform: "ios", country_code: "US", experiment_id: "lantern_holdout", variant_id: "hold", assigned_users: 100 },
      { assigned_on: "2026-10-06", title_id: "paper_lantern", platform: "ios", country_code: "US", experiment_id: "lantern_holdout", variant_id: "release", assigned_users: 100 },
    ],
    experimentMetrics: WAREHOUSE_DATES.filter((date) => date >= "2026-10-06" && date <= "2026-10-12").flatMap((date) => [
      { event_date: date, title_id: "paper_lantern", platform: "ios", country_code: "US", experiment_id: "lantern_holdout", variant_id: "hold", metric_name: "new_users", metric_value: 11 },
      { event_date: date, title_id: "paper_lantern", platform: "ios", country_code: "US", experiment_id: "lantern_holdout", variant_id: "release", metric_name: "new_users", metric_value: date === "2026-10-09" ? null : 9 },
    ]),
  };
}

/** Shift the immutable synthetic fixture as a whole so that its most recent
 * observation ends 17 calendar days before today in the contract timezone.
 * Relative NULL/zero/forecast examples and cohort relationships are preserved. */
export function rollingWarehouse(clock: { now?: Date; simulatedToday?: string } = {}): ReturnType<typeof smallWarehouse> {
  if (clock.simulatedToday && !isCalendarDate(clock.simulatedToday)) throw new Error("invalid_synthetic_clock");
  const today = currentCalendarDate({ simulatedToday: clock.simulatedToday ?? "" }, "America/Los_Angeles", clock.now);
  if (!isCalendarDate(today) || today < "1971-01-01" || today > "2148-12-31") throw new Error("invalid_synthetic_clock");
  const delta = (Date.parse(`${today}T00:00:00Z`) - Date.parse("2026-10-29T00:00:00Z")) / 86_400_000;
  const dateFields = new Set(["event_date", "cohort_date", "assigned_on", "launched_on"]);
  const fixture = smallWarehouse();
  const shifted = Object.fromEntries(Object.entries(fixture).map(([table, rows]) => [table, rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (!dateFields.has(key) || typeof value !== "string") return [key, value];
    const shiftedDate = new Date(Date.parse(`${value}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
    if (shiftedDate < "1970-01-01" || shiftedDate > "2149-06-06") throw new Error("synthetic_date_out_of_range");
    return [key, shiftedDate];
  })))]));
  return shifted as ReturnType<typeof smallWarehouse>;
}

export function bulkInstalls(count: number): InstallRow[] {
  const rows: InstallRow[] = [];
  for (let index = 0; index < count; index += 1) {
    const date = WAREHOUSE_DATES[index % WAREHOUSE_DATES.length] ?? "2026-10-01";
    rows.push({ event_date: date, title_id: "bulk_lantern", platform: "ios", country_code: "US", channel_id: "mist_ads", new_users: 1, device_token: null });
  }
  return rows;
}

export function chunks<T>(rows: T[], size = 5000): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < rows.length; index += size) groups.push(rows.slice(index, index + size));
  return groups;
}

function mistInstall(date: string): number | null | "absent" {
  if (date >= "2026-09-29" && date <= "2026-10-05") return 20;
  if (date === "2026-10-07") return 0;
  if (date === "2026-10-09") return null;
  if (date >= "2026-10-06" && date <= "2026-10-12") {
    const index = WAREHOUSE_DATES.indexOf(date) - WAREHOUSE_DATES.indexOf("2026-10-06");
    return 100 + index * 10;
  }
  return "absent";
}

function enumerate(start: string, end: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor.getTime() <= last.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export function emitHarborlightKnowledge(root: string): void {
  mkdirSync(path.join(root, "contracts"), { recursive: true });
  mkdirSync(path.join(root, "assets"), { recursive: true });
  const assets: Array<Record<string, unknown>> = [
    asset("catalog.harborlight", "catalog", "Harborlight 合成目录", "虚构工作室 Harborlight 的本地 ClickHouse 表卡入口。", "assets/catalog.md"),
    asset("metric.new_users", "metric", "新增口径", "new_users 的 NULL 与真实零分开。", "assets/metric-new-users.md"),
    asset("metric.ad_revenue", "metric", "变现口径", "预测变现不并入实际。", "assets/metric-ad-revenue.md"),
    asset("metric.active_users", "metric", "活跃口径", "活跃不从新增填补。", "assets/metric-active.md"),
    asset("metric.retention", "metric", "留存口径", "cohort 留存，NULL 不是零。", "assets/metric-retention.md"),
    asset("metric.roi", "metric", "ROI 口径", "实际回收除以实际成本。", "assets/metric-roi.md"),
    asset("sop.weekly_channel", "analysis_sop", "周度复盘", "先读表卡再查询。", "assets/sop.md"),
    asset("join.rules", "analysis_sop", "连接规则", "只允许登记过的键。", "assets/joins.md"),
    asset("sql.verified", "example_sql", "已核对 SQL", "示例不是授权。", "assets/sql.md"),
    asset("policy.analyst", "access_policy", "权限", "搜索、读取、查询分开。", "policy.json"),
  ];
  for (const table of WAREHOUSE_TABLES) {
    const body = {
      asset_id: table.asset_id,
      revision: `${table.asset_id}-r${table.table === "fact_fox_daily_payment" ? 4 : table.series || table.table.startsWith("dim_") ? 2 : 1}`,
      table: table.table,
      engine: "clickhouse-local",
      simulated: true,
      valid_from: "2026-09-01",
      valid_until: "2027-04-01",
      timezone: "America/Los_Angeles",
      freshness: { as_of: null, status: "unknown", note: "查询只认已发布探测，不认这里的占位。" },
      must_filter: table.date_column ? [table.date_column] : [],
      ...(table.table.startsWith("dim_") || table.table === "fact_fox_ad_receipt" || table.table === "fact_fox_daily_payment" ? { grain: table.primary_key } : {}),
      ...(table.series ? { series: { ...table.series, ...(table.series.predicted_column ? { prediction_values: { actual: 0, predicted: 1 } } : { prediction_mode: "observed_only" }) } } : {}),
      ...(table.table === "fact_fox_daily_spend" ? { derived_metrics: [{ id: "roi", label: "实际 ROI", operation: "divide", numerator: "payback_usd", denominator: "spend_usd", prediction: "actual_only", unit: "比值" }] } : {}),
      ...(table.table === "fact_fox_daily_payment" ? { derived_metrics: [
        { id: "synthetic_return_ratio", label: "合成收入与成本比", operation: "divide", numerator: "amount_usd", denominator: "cost_usd", prediction: "actual_only", unit: "比值" },
        { id: "synthetic_amount_less_cost", label: "合成收入减成本", operation: "subtract", numerator: "amount_usd", denominator: "cost_usd", prediction: "actual_only", unit: "USD" },
        { id: "synthetic_amount_per_install", label: "同范围收入与新增数之比（非用户归因）", operation: "divide", numerator: "fact_fox_daily_payment.amount_usd", denominator: "fact_fox_daily_install.new_users", prediction: "actual_only", unit: "(USD)/(人)" },
      ] } : {}),
      columns: table.columns.map((column) => ({
        name: column.name,
        type: column.chType,
        description: column.description,
        ...(column.unit ? { unit: column.unit } : {}),
        ...(column.nullable ? { nullable: true, null_means: column.null_means, zero_means: column.zero_means } : {}),
      })),
      sensitive_columns: table.sensitive_columns,
      notes: `${table.purpose} 粒度：${table.grain}。主键 ${table.primary_key.join(", ")}。适用范围：${table.scope}`,
    };
    writeFileSync(path.join(root, "contracts", `${table.table}.json`), JSON.stringify(body, null, 2));
    assets.push({
      asset_id: table.asset_id,
      kind: "data_contract",
      title: table.title,
      summary: table.purpose,
      revision: `${table.asset_id}-r${table.table === "fact_fox_daily_payment" ? 4 : table.series || table.table.startsWith("dim_") ? 2 : 1}`,
      status: "published",
      discoverable: true,
      table: table.table,
      path: `contracts/${table.table}.json`,
    });
  }
  writeFileSync(path.join(root, "registry.json"), JSON.stringify({
    registry_revision: "harborlight-registry-2026-11-02",
    simulated: true,
    scenario: "虚构工作室 Harborlight 的合成 ClickHouse。不是任何真实业务库。",
    timezone: "America/Los_Angeles",
    policy_path: "policy.json",
    seed_path: "schema.sql",
    joins_path: "joins.json",
    verified_sql_path: "verified-sql.json",
    assets,
  }, null, 2));
  writeFileSync(path.join(root, "schema.sql"), WAREHOUSE_TABLES.map(createTableSql).join(";\n") + ";\n");
  writeFileSync(path.join(root, "policy.json"), JSON.stringify({
    policy_revision: "policy-harborlight-r1",
    simulated: true,
    note: "虚构权限。表卡读过不等于可以查询。",
    roles: {
      analyst: {
        read: assets.map((item) => item.asset_id),
        query_tables: WAREHOUSE_TABLES.map((item) => item.table),
      },
      viewer: { read: ["catalog.harborlight"], query_tables: [] },
    },
  }, null, 2));
  writeFileSync(path.join(root, "joins.json"), JSON.stringify({
    revision: "joins-harborlight-r2",
    simulated: true,
    joins: [
      { join_id: "join.title_payment", tables: ["dim_fox_title", "fact_fox_daily_payment"], keys: ["title_id"], note: "合成产品维度到收入及成本。" },
      { join_id: "join.channel_payment", tables: ["dim_fox_channel", "fact_fox_daily_payment"], keys: ["channel_id"], note: "合成渠道维度到收入及成本。" },
      { join_id: "join.title_install", tables: ["dim_fox_title", "fact_fox_daily_install"], keys: ["title_id"], note: "产品维度到新增。" },
      { join_id: "join.channel_install", tables: ["dim_fox_channel", "fact_fox_daily_install"], keys: ["channel_id"], note: "渠道维度到新增。" },
      { join_id: "join.install_active", tables: ["fact_fox_daily_install", "fact_fox_daily_active"], keys: ["event_date", "title_id", "platform", "country_code", "channel_id"], note: "同一粒度。" },
      { join_id: "join.install_spend", tables: ["fact_fox_daily_install", "fact_fox_daily_spend"], keys: ["event_date", "title_id", "platform", "country_code", "channel_id"], note: "成本和新增按渠道对齐。" },
      { join_id: "join.install_revenue", tables: ["fact_fox_daily_install", "fact_fox_ad_receipt"], keys: ["event_date", "title_id", "platform", "country_code"], note: "变现没有渠道，不能把渠道当连接键。" },
    ],
  }, null, 2));
  writeFileSync(path.join(root, "verified-sql.json"), JSON.stringify({
    examples: [
      { example_id: "installs_week", sql: "SELECT event_date, new_users FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-12' AND title_id = 'paper_lantern'" },
      { example_id: "revenue_week", sql: "SELECT event_date, revenue_usd, is_predicted FROM fact_fox_ad_receipt WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-12'" },
    ],
  }, null, 2));
  writeFileSync(path.join(root, "freshness-targets.json"), JSON.stringify({
    source: "harborlight-clickhouse",
    engine: "clickhouse-local",
    valid_until: "2027-04-01",
    unimplemented_engines: ["maxcompute", "mysql-business"],
    note: "只读探测本地 ClickHouse 的声明周期。MAX(date) 和连接成功都不是完整。",
    targets: [...WAREHOUSE_TABLES.filter((table) => table.date_column).map((table) => ({
      table: table.table,
      engine: "clickhouse-local",
      date_column: table.date_column,
      expected_start: table.table === "fact_fox_retention_cohort" || table.table === "fact_fox_cohort_payback" || table.table === "fact_fox_experiment_arm" ? "2026-10-06" : "2026-10-06",
      expected_end: table.table === "fact_fox_retention_cohort" || table.table === "fact_fox_cohort_payback" || table.table === "fact_fox_experiment_arm" ? "2026-10-06" : "2026-10-12",
    })),
      { table: "dim_fox_title", engine: "clickhouse-local", kind: "dimension_snapshot", key_columns: ["title_id"], snapshot_columns: ["title_id", "title_name", "genre", "launched_on"] },
      { table: "dim_fox_channel", engine: "clickhouse-local", kind: "dimension_snapshot", key_columns: ["channel_id"], snapshot_columns: ["channel_id", "channel_name", "channel_kind"] },
    ],
  }, null, 2));
  writeFileSync(path.join(root, "semantics.json"), JSON.stringify({
    simulated: true,
    note: "只给确定性演示槽位编译器。真实模型模式不读它来替用户理解。",
    default_game: "paper_lantern",
    sensitive_window: { start: "2026-10-06", end: "2026-10-12" },
    products: [
      { id: "glass_minnow", terms: ["玻璃鲦", "glass_minnow"] },
      { id: "paper_lantern", terms: ["纸灯", "paper_lantern"] },
    ],
    platforms: [
      { id: "android", terms: ["安卓", "android"] },
      { id: "ios", terms: ["苹果", "ios"] },
    ],
    countries: [
      { id: "US", terms: ["美国", "US"] },
      { id: "JP", terms: ["日本", "JP"] },
      { id: "DE", terms: ["德国", "DE"] },
    ],
    channels: [
      { id: "mist_ads", terms: ["雾帆", "mist_ads"] },
      { id: "pebble_net", terms: ["卵石", "pebble_net"] },
    ],
    group_by: [
      { id: "channel", terms: ["按渠道", "分渠道"] },
      { id: "platform", terms: ["按平台"] },
      { id: "country", terms: ["按地区", "按国家"] },
      { id: "product", terms: ["按产品"] },
    ],
    compare_terms: ["环比", "上一等长"],
    metrics: [
      { id: "new_users", terms: ["新增", "新用户"], contracts: ["contract.fact_fox_daily_install"], warehouse: binding("fact_fox_daily_install", "event_date", "new_users", true) },
      { id: "active_users", terms: ["活跃"], contracts: ["contract.fact_fox_daily_active"], warehouse: binding("fact_fox_daily_active", "event_date", "active_users", true) },
      { id: "retention", terms: ["留存"], contracts: ["contract.fact_fox_retention_cohort"], warehouse: binding("fact_fox_retention_cohort", "cohort_date", "retained_users", false) },
      { id: "ad_revenue", terms: ["收入", "变现", "广告"], contracts: ["contract.fact_fox_ad_receipt"], warehouse: { ...binding("fact_fox_ad_receipt", "event_date", "revenue_usd", false), select_columns: ["event_date", "title_id", "platform", "country_code", "placement", "revenue_usd", "is_predicted"], predicted_column: "is_predicted" } },
      { id: "spend", terms: ["投放成本", "花费", "成本"], contracts: ["contract.fact_fox_daily_spend"], warehouse: { ...binding("fact_fox_daily_spend", "event_date", "spend_usd", true), select_columns: ["event_date", "title_id", "platform", "country_code", "channel_id", "spend_usd", "payback_usd", "is_predicted"], predicted_column: "is_predicted" } },
      { id: "actual_payback", terms: ["实际回收"], contracts: ["contract.fact_fox_daily_spend"], warehouse: { ...binding("fact_fox_daily_spend", "event_date", "payback_usd", true), select_columns: ["event_date", "title_id", "platform", "country_code", "channel_id", "spend_usd", "payback_usd", "is_predicted"], predicted_column: "is_predicted" } },
      { id: "predicted_payback", terms: ["预测回收"], contracts: ["contract.fact_fox_cohort_payback"], warehouse: binding("fact_fox_cohort_payback", "cohort_date", "payback_usd", true) },
      { id: "roi", terms: ["ROI", "投入产出"], contracts: ["contract.fact_fox_daily_spend"], warehouse: { ...binding("fact_fox_daily_spend", "event_date", "spend_usd", true), select_columns: ["event_date", "title_id", "platform", "country_code", "channel_id", "spend_usd", "payback_usd", "is_predicted"], predicted_column: "is_predicted" } },
    ],
    unsupported_terms: ["为什么", "自动投放", "停掉预算"],
    sensitive_terms: ["设备", "device_token"],
    unauthorized_terms: ["财务总账"],
    retention_terms: [],
    performance_assets: ["metric.new_users", "metric.ad_revenue", "metric.roi", "sop.weekly_channel", "sql.verified", "policy.analyst", "join.rules"],
    sensitive_contract: "contract.fact_fox_daily_install",
    unauthorized_contract: "contract.fact_fox_experiment_metric",
  }, null, 2));
  writeFileSync(path.join(root, "assets", "catalog.md"), "# Harborlight\n\n虚构工作室的合成 ClickHouse。纸灯与玻璃鲦都不是真实产品。\n");
  writeFileSync(path.join(root, "assets", "metric-new-users.md"), "新增按 fact_fox_daily_install.new_users 汇总。NULL 不计入，0 是真实零。\n");
  writeFileSync(path.join(root, "assets", "metric-ad-revenue.md"), "实际变现只汇总 is_predicted = 0。预测单独列出。\n");
  writeFileSync(path.join(root, "assets", "metric-active.md"), "活跃来自 fact_fox_daily_active，不用新增填补。\n");
  writeFileSync(path.join(root, "assets", "metric-retention.md"), "留存按 cohort_date 与 day_n。日龄 7 的 NULL 不是零。\n");
  writeFileSync(path.join(root, "assets", "metric-roi.md"), "实际 ROI = 实际 payback_usd / 实际 spend_usd。预测不进分子，NULL 成本不补零。分母为 0 时不能算比率。\n");
  writeFileSync(path.join(root, "assets", "sop.md"), "先搜索表卡，再读契约，再按封闭日期查询。实验表不能和投放表连接。\n");
  writeFileSync(path.join(root, "assets", "joins.md"), "连接键以 joins.json 为准。变现表没有渠道。实验表没有登记连接。\n");
  writeFileSync(path.join(root, "assets", "sql.md"), "示例 SQL 只说明写法，不是查询许可。\n");
}

function asset(id: string, kind: string, title: string, summary: string, file: string) {
  return { asset_id: id, kind, title, summary, revision: `${id}-r1`, status: "published", discoverable: true, path: file };
}

function binding(table: string, dateColumn: string, valueColumn: string, withChannel: boolean) {
  return {
    table,
    date_column: dateColumn,
    title_column: "title_id",
    platform_column: "platform",
    country_column: "country_code",
    ...(withChannel ? { channel_column: "channel_id" } : {}),
    value_column: valueColumn,
    select_columns: [dateColumn, "title_id", "platform", "country_code", ...(withChannel ? ["channel_id"] : []), valueColumn],
  };
}
