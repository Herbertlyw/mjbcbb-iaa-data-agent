import assert from "node:assert/strict";
import test from "node:test";
import { planClickHouse } from "../src/clickhouse-plan.js";
import {
  joinMetricColumns,
  prepareJoinEvidence,
  prepareJoinAggregateEvidence,
  verifyJoinEvidence,
  type JoinEvidencePlan,
} from "../src/join-evidence.js";
import { joinIntegerSumSafe, joinIntegerType, joinIntegerValue } from "../src/join-integer.js";
import { joinResultTable } from "../src/join-result-table.js";
import { joinCoverage } from "../src/join-resource-proof.js";
import { loadKnowledge } from "../src/knowledge.js";
import { SqlRejected } from "../src/sql.js";
import type { DataContract } from "../src/types.js";

const knowledge = loadKnowledge("knowledge/starhaven");
const dimension = knowledge.contract_by_table.get("dim_app")!.contract!;
const version = "sv_55c525926d882d7044f9";
// Actual SQL rejected by the receiving machine before this compatibility fix.
const actualSql = `SELECT f.app_id, d.game_name, SUM(f.discounted_cost_usd) AS cost_usd FROM fact_delivery_daily f JOIN dim_app d ON f.dataset_version = d.dataset_version AND f.app_id = d.app_id WHERE f.dataset_version = '${version}' AND f.business_date BETWEEN '2026-11-01' AND '2026-11-08' GROUP BY f.app_id, d.game_name`;
const fact = (table: string) => knowledge.contract_by_table.get(table)!.contract!;

test("稀疏事实表即使 JOIN 捕获了出现的组，也不宣称未出现 cohort 已覆盖", () => {
  const revenue = fact("fact_cohort_revenue_daily");
  const sql = `SELECT f.revenue_date, SUM(f.revenue_usd) AS total FROM fact_cohort_revenue_daily f JOIN dim_app d ON f.dataset_version = d.dataset_version AND f.app_id = d.app_id WHERE f.revenue_date = '2026-11-05' AND f.app_id = 'gridfit_ios' AND f.revenue_source = 'sdk' GROUP BY f.revenue_date`;
  const admitted = prepareJoinEvidence(sql, revenue, dimension, knowledge.joins, true);
  assert.ok(admitted);
  const coverage = joinCoverage(admitted, [], revenue);
  assert.equal(coverage.status, "unknown");
  assert.match(coverage.reason, /稀疏观测/u);
});

function plan(sql: string, source = fact("fact_delivery_daily")) {
  const contracts = [source, dimension];
  return planClickHouse(sql, contracts.map(contract => ({
    table: contract.table,
    allowed_columns: contract.columns.map(column => column.name),
    sensitive_columns: contract.sensitive_columns,
    must_filter: contract.must_filter,
    column_types: Object.fromEntries(contract.columns.map(column => [column.name, column.type])),
  })), contracts, knowledge.joins, "starhaven_validation", 1000);
}

const activitySql = `SELECT f.app_id, d.game_name, SUM(f.active_devices) AS devices FROM fact_activity_daily f JOIN dim_app d ON f.dataset_version = d.dataset_version AND f.app_id = d.app_id WHERE f.dataset_version = '${version}' AND f.activity_date >= '2026-11-02' AND f.activity_date <= '2026-11-08' AND f.app_id = 'gridfit_ios' AND f.acquisition_country_code = 'US' AND f.ua_channel_id = 'breeze' GROUP BY f.app_id, d.game_name`;

function captured(plan: JoinEvidencePlan, values: unknown[], total: string) {
  const fields: Record<string, string> = {
    "fact.dataset_version": version,
    "fact.app_id": "gridfit_ios",
    "fact.acquisition_country_code": "US",
    "fact.ua_channel_id": "breeze",
    "dimension.dataset_version": version,
    "dimension.app_id": "gridfit_ios",
    "dimension.game_name": "拼格",
  };
  return {
    app_id: "gridfit_ios", game_name: "拼格", devices: total,
    __da_join_proof: plan.expectedDates.map((day, index) => [
      day,
      ...joinMetricColumns(plan).map(() => values[index]),
      ...plan.proofFields.map(field => fields[`${field.table}.${field.column}`]),
    ]),
  };
}

test("VV 序列的完整物理粒度包含版本键，错误旧元数据仍拒绝", () => {
  for (const asset of knowledge.assets) {
    const contract = asset.contract;
    if (!contract?.series) continue;
    assert.deepEqual([...contract.grain!].sort(), [contract.series.date_column, ...contract.series.dimensions].sort());
    assert.equal(new Set(contract.series.dimensions).size, contract.series.dimensions.length);
    assert.ok(contract.series.dimensions.includes("dataset_version"));
  }
  const old: DataContract = structuredClone(fact("fact_delivery_daily"));
  old.series!.dimensions = old.series!.dimensions.filter(column => column !== "dataset_version");
  assert.throws(() => plan(actualSql, old), SqlRejected);
});

test("接收机的原始复合键成本 SQL 保留 Decimal 和完整事实捕获", () => {
  const admitted = plan(actualSql);
  assert.equal(admitted.coverage, "join");
  assert.deepEqual(admitted.join?.joinKeys, ["dataset_version", "app_id"]);
  assert.equal(admitted.join?.coarse, true);
  assert.equal(admitted.join?.factFilters.dataset_version, version);
  assert.equal(admitted.join?.metrics[0]?.scale, 6);
  assert.match(admitted.join!.executionSql, /f\.dataset_version = d\.dataset_version/);
  const bounded = prepareJoinAggregateEvidence(actualSql, fact("fact_delivery_daily"), dimension, knowledge.joins, true);
  assert.equal(bounded?.aggregateProof, true);
  assert.match(bounded!.executionSql, /uniqExact\(tuple\(f\.business_date, f\.dataset_version,/);
});

test("登记维表连接的单个等值日期形成闭合范围，冲突日期仍拒绝", () => {
  const oneDay = actualSql.replace("f.business_date BETWEEN '2026-11-01' AND '2026-11-08'", "f.business_date = toDate('2026-11-01')");
  const admitted = plan(oneDay);
  assert.equal(admitted.coverage, "join");
  assert.equal(admitted.join?.range.start, "2026-11-01");
  assert.equal(admitted.join?.range.end, "2026-11-01");
  assert.deepEqual(admitted.join?.expectedDates, ["2026-11-01"]);
  assert.throws(() => plan(oneDay.replace("GROUP BY", "AND f.business_date >= '2026-11-02' GROUP BY")), SqlRejected);
  assert.throws(() => plan(oneDay.replace("toDate('2026-11-01')", "toDate('2026-02-30')")), SqlRejected);
  assert.throws(() => plan(oneDay.replace("f.dataset_version = d.dataset_version AND ", "")), SqlRejected);
});

test("JOIN 捕获的可空事实粒度区分 NULL 与字符串 NULL，非空键和重复粒度仍拒绝", () => {
  const oneDay = actualSql.replace("f.business_date BETWEEN '2026-11-01' AND '2026-11-08'", "f.business_date = '2026-11-01'");
  const admitted = plan(oneDay).join!;
  const source = fact("fact_delivery_daily");
  const tuple = (account: string | null) => ["2026-11-01", "1.000000", ...admitted.proofFields.map(field => {
    if (field.table === "dimension") return field.column === "dataset_version" ? version : field.column === "app_id" ? "gridfit_ios" : "拼格";
    if (field.column === "dataset_version") return version;
    if (field.column === "app_id") return "gridfit_ios";
    if (field.column === "account_id") return account;
    if (source.columns.find(column => column.name === field.column)?.nullable) return null;
    return "scope";
  })];
  const captured = { app_id: "gridfit_ios", game_name: "拼格", cost_usd: "2.000000", __da_join_proof: [tuple(null), tuple("NULL")] };
  assert.equal(verifyJoinEvidence(admitted, [captured])?.[0]?.value, "2.000000");
  assert.equal(verifyJoinEvidence(admitted, [{ ...captured, __da_join_proof: [tuple(null), tuple(null)] }]), null);
  const nonNullKey = structuredClone(captured);
  const keyIndex = admitted.proofFields.findIndex(field => field.table === "fact" && field.column === "app_id");
  nonNullKey.__da_join_proof[0]![2 + keyIndex] = null;
  assert.equal(verifyJoinEvidence(admitted, [nonNullKey]), null);
  const unmarked = structuredClone(admitted);
  unmarked.proofFields.find(field => field.table === "fact" && field.column === "account_id")!.nullable = undefined;
  assert.equal(verifyJoinEvidence(unmarked, [captured]), null);
});

test("复合键缺失、OR 绕过、错误版本关联和事实表关联仍拒绝", () => {
  for (const sql of [
    actualSql.replace("f.dataset_version = d.dataset_version AND ", ""),
    actualSql.replace("f.dataset_version = d.dataset_version", "f.dataset_version = d.app_id"),
    actualSql.replace("f.app_id = d.app_id", "f.app_id = d.app_id OR 1 = 1"),
    actualSql.replace("'2026-11-08'", "'2026-11-08' OR 1 = 1"),
    actualSql.replace("dim_app d", "fact_delivery_daily d"),
  ]) assert.throws(() => plan(sql), SqlRejected, sql);
});

test("事实属性分组的关联按原始事实粒度跨组去重", () => {
  const sql = `SELECT f.app_id, d.game_name, d.platform, f.source_currency, SUM(f.discounted_cost_usd) AS total_discounted_cost_usd, COUNT(f.discounted_cost_usd) AS nonnull_discounted_cost_usd, COUNT() AS source_rows FROM fact_delivery_daily f JOIN dim_app d ON f.dataset_version = d.dataset_version AND f.app_id = d.app_id WHERE f.dataset_version = '${version}' AND f.business_date = '2026-10-30' GROUP BY f.app_id, d.game_name, d.platform, f.source_currency ORDER BY f.app_id, f.source_currency`;
  const source = fact("fact_delivery_daily");
  const admitted = plan(sql).join!;
  assert.ok(admitted);
  assert.deepEqual(admitted.factGrainFields, source.series!.dimensions);
  assert.ok(admitted.proofFields.some((field) => field.table === "fact" && field.column === "source_currency"));
  assert.equal(prepareJoinAggregateEvidence(sql, source, dimension, knowledge.joins, true), null, "聚合回执无法跨组验证原始事实粒度");
  const row = (currency: string, account: string) => {
    const fields: Record<string, string> = { "fact.dataset_version": version, "fact.app_id": "gridfit_ios", "fact.account_id": account, "fact.source_currency": currency, "dimension.dataset_version": version, "dimension.app_id": "gridfit_ios", "dimension.game_name": "拼格", "dimension.platform": "ios" };
    return { app_id: "gridfit_ios", game_name: "拼格", platform: "ios", source_currency: currency,
      total_discounted_cost_usd: "1.000000", nonnull_discounted_cost_usd: "1", source_rows: "1",
      __da_join_proof: [["2026-10-30", "1.000000", ...admitted.proofFields.map((field) => fields[`${field.table}.${field.column}`] ?? (field.nullable ? null : "scope"))]] };
  };
  const usd = row("USD", "acct_1"); const xcu = row("XCU", "acct_2");
  const result = verifyJoinEvidence(admitted, [usd, xcu]);
  assert.equal(result?.filter((value) => value.operation === "sum").length, 2);
  assert.equal(joinCoverage(admitted, [usd, xcu], source).status, "unknown", "观察到的属性值不证明不存在其他分组");
  assert.deepEqual(result?.filter((value) => value.operation === "sum").map((value) => value.group["fact_delivery_daily.source_currency"]), ["USD", "XCU"]);
  assert.equal(verifyJoinEvidence(admitted, [usd, row("XCU", "acct_1")]), null, "相同事实主键不得因属性不同而逃过重复检测");
  const spoofed = structuredClone(xcu); spoofed.source_currency = "USD";
  assert.equal(verifyJoinEvidence(admitted, [usd, spoofed]), null);
  const sensitive = structuredClone(source); sensitive.sensitive_columns.push("source_currency");
  assert.equal(prepareJoinEvidence(sql, sensitive, dimension, knowledge.joins, true), null);
  const restricted = [source, dimension].map((contract) => ({
    table: contract.table, allowed_columns: contract.columns.map((column) => column.name).filter((name) => contract.table !== source.table || name !== "account_id"),
    sensitive_columns: contract.sensitive_columns, must_filter: contract.must_filter,
    column_types: Object.fromEntries(contract.columns.map((column) => [column.name, column.type])),
  }));
  assert.throws(() => planClickHouse(sql, restricted, [source, dimension], knowledge.joins, "starhaven_validation", 1000),
    (error: unknown) => error instanceof SqlRejected && error.code === "join_proof_unauthorized", "证明元组不得读取未授权的事实粒度字段");
  const nullable = structuredClone(source); nullable.columns.find((column) => column.name === "source_currency")!.nullable = true;
  assert.equal(prepareJoinEvidence(sql, nullable, dimension, knowledge.joins, true), null);
  assert.equal(prepareJoinEvidence(sql.replaceAll("source_currency", "impressions"), source, dimension, knowledge.joins, true), null);
  assert.throws(() => plan(sql.replace("f.dataset_version = d.dataset_version AND ", "")), SqlRejected);
});

test("登记维表关联允许有界的多字段分组，并继续验证完整键、粒度和权限", () => {
  const source = fact("fact_delivery_daily");
  const channel = knowledge.contract_by_table.get("dim_ua_channel")!.contract!;
  const select = "f.business_date, f.app_id, f.ua_channel_id, c.channel_name, f.dataset_version, f.source_currency, f.completeness_state";
  const base = `SELECT ${select}, SUM(f.discounted_cost_usd) AS cost_usd, SUM(f.af_registers) AS registrations, COUNT(*) AS rows_n FROM fact_delivery_daily f LEFT JOIN dim_ua_channel c ON f.dataset_version = c.dataset_version AND f.ua_channel_id = c.ua_channel_id WHERE f.business_date = toDate('2026-11-05') AND f.app_id = 'gridfit_ios' GROUP BY ${select}`;
  const rules = [source, channel].map((contract) => ({ table: contract.table, allowed_columns: contract.columns.map((column) => column.name), sensitive_columns: contract.sensitive_columns, must_filter: contract.must_filter, column_types: Object.fromEntries(contract.columns.map((column) => [column.name, column.type])) }));
  const check = (sql: string) => planClickHouse(sql, rules, [source, channel], knowledge.joins, "starhaven_validation", 1000);
  const accepted = check(base).join;
  assert.equal(accepted?.groups.length, 7);
  assert.deepEqual(accepted?.factGrainFields, source.series!.dimensions);
  assert.equal(prepareJoinAggregateEvidence(base, source, channel, knowledge.joins, true), null, "宽分组不能绕过跨组原始粒度证明");
  assert.throws(() => check(base.replace("f.dataset_version = c.dataset_version AND ", "")), SqlRejected);
  assert.throws(() => check(base.replaceAll(select, `${select}, f.account_id, f.campaign_id`)), SqlRejected, "超过八个分组保持失败关闭");
  const denied = structuredClone(rules);
  denied[0]!.allowed_columns = denied[0]!.allowed_columns.filter((name) => name !== "account_id");
  assert.throws(() => planClickHouse(base, denied, [source, channel], knowledge.joins, "starhaven_validation", 1000), (error: unknown) => error instanceof SqlRejected && error.code === "join_proof_unauthorized");
});

test("不支持函数仍拒绝并提供安全的函数名和替代方向", () => {
  const sql = `SELECT medianExact(f.discounted_cost_usd) FROM fact_delivery_daily f WHERE f.business_date = '2026-11-01'`;
  assert.throws(() => planClickHouse(sql, [{ table: fact("fact_delivery_daily").table,
    allowed_columns: fact("fact_delivery_daily").columns.map(column => column.name),
    sensitive_columns: fact("fact_delivery_daily").sensitive_columns,
    must_filter: fact("fact_delivery_daily").must_filter,
    column_types: Object.fromEntries(fact("fact_delivery_daily").columns.map(column => [column.name, column.type])),
  }], [fact("fact_delivery_daily")], [], "starhaven_validation", 1000),
  (error: unknown) => error instanceof SqlRejected && error.code === "function_not_allowed" && /medianexact/u.test(error.message) && !error.message.includes("SELECT"));
});

test("UInt64 捕获按精确整数复算，不经过浮点", () => {
  const source = fact("fact_activity_daily");
  const admitted = plan(activitySql, source).join!;
  assert.ok(admitted);
  assert.equal(admitted.metrics[0]?.integer_type, "UInt64");
  const row = captured(admitted, ["9007199254740993", "1", "0", "0", "0", "0", "0"], "9007199254740994");
  const values = verifyJoinEvidence(admitted, [row]);
  assert.equal(values?.[0]?.value, "9007199254740994");
  assert.equal(joinResultTable(admitted, values!, source, dimension)?.rows[0]?.devices, "9007199254740994");
  const wrong = structuredClone(admitted);
  wrong.metrics[0]!.integer_type = "Int32";
  assert.equal(joinResultTable(wrong, values!, source, dimension), null);
});

test("UInt64 非法输入、SQL 溢出、重复行和缺日期不能进入正式计算", () => {
  const admitted = plan(activitySql, fact("fact_activity_daily")).join!;
  for (const input of [-1, "-1", "18446744073709551616", 9007199254740992, "1.5", "1e3"]) {
    assert.equal(verifyJoinEvidence(admitted, [captured(admitted, [input, "0", "0", "0", "0", "0", "0"], "0")]), null);
  }
  for (const total of ["0", "18446744073709551616"]) {
    const overflow = captured(admitted, ["18446744073709551615", "1", "0", "0", "0", "0", "0"], total);
    assert.equal(verifyJoinEvidence(admitted, [overflow]), null);
  }
  const row = captured(admitted, Array(7).fill("10"), "70");
  assert.equal(verifyJoinEvidence(admitted, [{ ...row, __da_join_proof: row.__da_join_proof.slice(1) }]), null);
  assert.equal(verifyJoinEvidence(admitted, [{ ...row, __da_join_proof: [...row.__da_join_proof, row.__da_join_proof[0]!] }]), null);
});

test("仅有数据库基数回执不能替代 UInt64 SUM 的精确溢出校验", () => {
  assert.equal(prepareJoinAggregateEvidence(activitySql, fact("fact_activity_daily"), dimension, knowledge.joins, true), null);
});

test("整数类型边界保留符号和位宽，Float 与 Decimal 不冒充整数", () => {
  for (const [type, minimum, maximum] of [
    ["Int8", "-128", "127"], ["UInt8", "0", "255"],
    ["Int16", "-32768", "32767"], ["UInt16", "0", "65535"],
    ["Int32", "-2147483648", "2147483647"], ["UInt32", "0", "4294967295"],
    ["Int64", "-9223372036854775808", "9223372036854775807"],
    ["UInt64", "0", "18446744073709551615"],
  ] as const) {
    assert.equal(joinIntegerType(`Nullable(${type})`), type);
    assert.equal(joinIntegerValue(minimum, type), minimum);
    assert.equal(joinIntegerValue(maximum, type), maximum);
    assert.equal(joinIntegerValue((BigInt(minimum) - 1n).toString(), type), null);
    assert.equal(joinIntegerValue((BigInt(maximum) + 1n).toString(), type), null);
  }
  assert.equal(joinIntegerType("Float64"), null);
  assert.equal(joinIntegerType("Decimal(24,6)"), null);
  assert.equal(joinIntegerSumSafe(5_000_000, "UInt32"), true);
  assert.equal(joinIntegerSumSafe(Number.MAX_SAFE_INTEGER, "UInt32"), false);
  assert.equal(joinIntegerSumSafe(1, "UInt64"), true);
  assert.equal(joinIntegerSumSafe(2, "UInt64"), false);
});
