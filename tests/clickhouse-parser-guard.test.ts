import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { authorizeClickHouseDirect, authorizeClickHouseScoped, authorizeClickHouseJoin, preflightClickHouseSql } from "../src/clickhouse-sql-preflight.js";
import { guardSql, SqlRejected } from "../src/sql.js";
import { loadKnowledge } from "../src/knowledge.js";
import { clickHouseCommand, clickHouseInsert, clickHouseQuery, clickHouseQueryBounded, createClickHouseClient } from "../src/clickhouse-client.js";
import { assessCoverage, provenCoverageScope } from "../src/coverage.js";
import { verifyConditionalAggregates } from "../src/conditional-aggregate-evidence.js";
import type { QueryResource } from "../src/types.js";
import { createTableSql, WAREHOUSE_TABLES } from "../src/warehouse.js";
import { isolatedDocker, loopbackPort, runOwnedContainer } from "./isolated-docker.js";

const knowledge = loadKnowledge("knowledge/harborlight");
const fact = knowledge.contract_by_table.get("fact_fox_daily_install")!.contract!;
const rules = [{ table: fact.table, allowed_columns: fact.columns.filter((column) => !fact.sensitive_columns.includes(column.name)).map((column) => column.name), sensitive_columns: fact.sensitive_columns, must_filter: fact.must_filter, column_types: Object.fromEntries(fact.columns.map((column) => [column.name, column.type])) }];
const where = "event_date >= '2026-10-06' AND event_date <= '2026-10-08'";

test("ClickHouse AST 独立解析 JOIN 字段及 ON 条件，拒绝歧义、越权与别名伪装", () => {
  const dimension = knowledge.contract_by_table.get("dim_fox_title")!.contract!;
  const all = [...rules, { table: dimension.table, allowed_columns: dimension.columns.map((column) => column.name), sensitive_columns: dimension.sensitive_columns, must_filter: dimension.must_filter }];
  const sql = `SELECT d.title_name AS label, SUM(f.new_users) AS total FROM ${fact.table} f JOIN ${dimension.table} d ON f.title_id = d.title_id WHERE f.event_date >= '2026-10-06' AND f.event_date <= '2026-10-08' GROUP BY d.title_name ORDER BY label`;
  const result = authorizeClickHouseJoin(sql, all);
  assert.equal(result.applicable && result.ok, true, JSON.stringify(result));
  if (result.applicable && result.ok) assert.deepEqual(result.columns, ["dim_fox_title.title_id", "dim_fox_title.title_name", "fact_fox_daily_install.event_date", "fact_fox_daily_install.new_users", "fact_fox_daily_install.title_id"]);
  assert.doesNotThrow(() => guardSql(sql, all, "clickhouse"));
  for (const invalid of [
    sql.replace("SUM(f.new_users)", "SUM(f.device_token)"),
    sql.replace("f.title_id = d.title_id", "f.device_token = d.title_id"),
    sql.replace("d.title_name AS label", "title_id AS label"),
    sql.replace("SUM(f.new_users)", "SUM(other.new_users)"),
    sql.replace("dim_fox_title d", "unknown_dimension d"),
    sql.replace("AS total", "AS label"),
    sql.replace("AS total", "AS event_date"),
    sql.replace("AS total", "AS title_id").replace("GROUP BY d.title_name", "GROUP BY d.title_name, title_id"),
  ]) {
    const rejected = authorizeClickHouseJoin(invalid, all);
    assert.equal(rejected.applicable && !rejected.ok, true, invalid);
    assert.throws(() => guardSql(invalid, all, "clickhouse"), SqlRejected, invalid);
  }
});

test("ClickHouse AST 逐层绑定 CTE 与派生表的输出字段及物理血缘", () => {
  const sql = `WITH a AS (SELECT event_date AS d, country_code AS country, new_users AS n FROM ${fact.table} WHERE ${where}), b AS (SELECT d, country, n FROM a WHERE country IN ('US','JP')) SELECT country, SUM(n) AS total FROM b GROUP BY country ORDER BY total`;
  const bound = authorizeClickHouseScoped(sql, rules);
  assert.equal(bound.applicable, true);
  if (!bound.applicable || !bound.ok) assert.fail(JSON.stringify(bound));
  assert.deepEqual(bound.outputs, { country: [`${fact.table}.country_code`], total: [`${fact.table}.new_users`] });
  assert.doesNotThrow(() => guardSql(sql, rules, "clickhouse"));
  const derived = `SELECT q.country, q.n FROM (SELECT event_date AS d, country_code AS country, new_users AS n FROM ${fact.table} WHERE ${where}) AS q WHERE q.country = 'US'`;
  const derivedBinding = authorizeClickHouseScoped(derived, rules);
  assert.equal(derivedBinding.applicable && derivedBinding.ok, true, JSON.stringify(derivedBinding));
  assert.doesNotThrow(() => guardSql(derived, rules, "clickhouse"));
  for (const invalid of [
    sql.replace("new_users AS n", "device_token AS n"),
    sql.replace("SELECT d, country, n FROM a", "SELECT d, country, device_token AS n FROM a"),
    sql.replace("SUM(n)", "SUM(new_users)"),
    sql.replace("FROM b GROUP", "FROM unknown_table GROUP"),
    sql.replace("SUM(n)", "SUM(other.n)"),
  ]) {
    const result = authorizeClickHouseScoped(invalid, rules);
    assert.equal(result.applicable && !result.ok, true, invalid);
    assert.throws(() => guardSql(invalid, rules, "clickhouse"), SqlRejected, invalid);
  }
  // JOIN remains governed by the existing registered-key policy; this binder
  // must never claim that an unsupported multi-relation scope is authorized.
  const join = `WITH a AS (SELECT event_date, new_users FROM ${fact.table} WHERE ${where}) SELECT a.new_users FROM a JOIN ${fact.table} AS f ON a.event_date = f.event_date`;
  assert.deepEqual(authorizeClickHouseScoped(join, rules), { applicable: false });
});

test("ClickHouse AST 独立绑定单表字段与别名，敏感列在投影、过滤和排序均拒绝", () => {
  const legal = `SELECT f.country_code, sum(f.new_users) AS total FROM ${fact.table} AS f WHERE f.event_date >= '2026-10-06' AND f.event_date <= '2026-10-08' AND f.country_code IN ('US','JP') GROUP BY f.country_code ORDER BY total DESC`;
  const direct = authorizeClickHouseDirect(legal, rules);
  assert.equal(direct.applicable, true);
  if (direct.applicable && direct.ok) assert.deepEqual(new Set(direct.columns), new Set(["country_code", "new_users", "event_date"]));
  else assert.fail("合法字段应能绑定");
  assert.doesNotThrow(() => guardSql(legal, rules, "clickhouse"));
  for (const sql of [
    legal.replace("sum(f.new_users)", "sum(f.device_token)"),
    legal.replace("f.country_code IN", "f.device_token IN"),
    legal.replace("ORDER BY total", "ORDER BY f.device_token"),
    legal.replace("sum(f.new_users)", "sum(x.new_users)"),
    legal.replace(`FROM ${fact.table}`, "FROM another_table"),
  ]) {
    const result = authorizeClickHouseDirect(sql, rules);
    assert.equal(result.applicable && !result.ok, true, sql);
    assert.throws(() => guardSql(sql, rules, "clickhouse"), SqlRejected);
  }
  assert.equal(authorizeClickHouseDirect(`WITH q AS (SELECT event_date FROM ${fact.table} WHERE ${where}) SELECT event_date FROM q`, rules).applicable, false);
});

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

test("条件聚合检查两个语法树、谓词结构和每个引用字段", () => {
  const good = [
    "countIf(isNull(new_users))", "countIf(isNotNull(new_users))", "countIf(new_users IS NULL)",
    "countIf(new_users IS NOT NULL)", "countIf(new_users = 0)", "countIf(new_users > 0)",
    "countIf((new_users IS NULL) OR (new_users = 0))",
    "countIf(country_code = 'JP' AND new_users >= 0)",
  ];
  for (const expr of good) {
    const sql = `SELECT ${expr} AS c FROM ${fact.table} WHERE ${where}`;
    const parsed = preflightClickHouseSql(sql); assert.equal(parsed.ok, true, sql);
    if (parsed.ok) assert.ok(parsed.functions.includes("countif"));
    assert.doesNotThrow(() => guardSql(sql, rules, "clickhouse"), sql);
    assert.throws(() => guardSql(sql, rules, "sqlite"), (error: unknown) => error instanceof SqlRejected && error.code === "clickhouse_function_only");
  }
  for (const expr of [
    "countIf(isNull(device_token))", "countIf(device_token = 'fixture')", "countIf(unknown_field = 0)",
    "countIf(sleep(1))", "countIf(new_users = 0, new_users = 1)", "countIf(new_users + 1 > 0)",
    "countIf(isNull(new_users + 1))", "countIf(new_users IN (SELECT new_users FROM secret_table))",
  ]) {
    const sql = `SELECT ${expr} AS c FROM ${fact.table} WHERE ${where}`;
    assert.throws(() => guardSql(sql, rules, "clickhouse"), SqlRejected, sql);
  }
  const hidden = `WITH q AS (SELECT event_date, device_token FROM ${fact.table} WHERE ${where}) SELECT countIf(isNull(device_token)) AS c FROM q`;
  assert.throws(() => guardSql(hidden, rules, "clickhouse"), SqlRejected);
  assert.throws(() => guardSql(`SELECT countIf(new_users = 0) AS c FROM ${fact.table}`, rules, "clickhouse"), SqlRejected);
});

test("日期投影仅允许单表契约扫描日期，不能替代日期边界", () => {
  for (const fn of ["toYear", "toMonth", "toYYYYMM", "toStartOfMonth", "toStartOfDay"]) {
    const sql = `SELECT ${fn}(event_date) AS bucket, count() AS n FROM ${fact.table} WHERE ${where} GROUP BY bucket`;
    assert.doesNotThrow(() => guardSql(sql, rules, "clickhouse"), sql);
    assert.throws(() => guardSql(sql, rules, "sqlite"), (error: unknown) => error instanceof SqlRejected && error.code === "clickhouse_function_only");
    assert.throws(() => guardSql(sql.replace(`${fn}(event_date)`, `${fn}(new_users)`), rules, "clickhouse"), SqlRejected);
    assert.throws(() => guardSql(sql.replace(`${fn}(event_date)`, `${fn}(device_token)`), rules, "clickhouse"), SqlRejected);
    assert.throws(() => guardSql(sql.replace(`WHERE ${where}`, ""), rules, "clickhouse"), SqlRejected);
  }
  assert.throws(() => guardSql(`SELECT toStartOfMonth(toDate('2026-10-06')) AS bucket FROM ${fact.table} WHERE ${where}`, rules, "clickhouse"), SqlRejected);
  assert.throws(() => guardSql(`WITH q AS (SELECT event_date FROM ${fact.table} WHERE ${where}) SELECT toMonth(event_date) AS bucket FROM q`, rules, "clickhouse"), SqlRejected);
  assert.throws(() => guardSql(`SELECT toYear(event_date) AS bucket FROM ${fact.table} WHERE ${where}`, [{ ...rules[0]!, column_types: { event_date: "DateTime('America/Los_Angeles')" } }], "clickhouse"), SqlRejected);
  assert.throws(() => guardSql(`SELECT toYear(event_date) AS bucket FROM ${fact.table} WHERE ${where}`, [{ ...rules[0]!, column_types: {} }], "clickhouse"), SqlRejected);
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
      const scoped = `WITH a AS (SELECT event_date AS d, country_code AS country, new_users AS n FROM ${fact.table} WHERE ${where}), b AS (SELECT d, country, n FROM a WHERE country IN ('US','JP')) SELECT country, SUM(n) AS total FROM b GROUP BY country ORDER BY total`;
      assert.doesNotThrow(() => guardSql(scoped, rules, "clickhouse"));
      assert.deepEqual((await clickHouseQuery(ch, scoped)).map((row) => ({ country: row.country, total: String(row.total) })), [{ country: "JP", total: "13" }]);
      await clickHouseInsert(ch, fact.table, [
        { event_date: "2026-10-06", title_id: "fixture_us", platform: "ios", country_code: "US", channel_id: "mist_ads", new_users: null, device_token: null },
        { event_date: "2026-10-07", title_id: "fixture_us", platform: "ios", country_code: "US", channel_id: "mist_ads", new_users: 0, device_token: null },
        { event_date: "2026-10-08", title_id: "fixture_us", platform: "ios", country_code: "US", channel_id: "mist_ads", new_users: 5, device_token: null },
        { event_date: "2026-10-06", title_id: "fixture_jp", platform: "ios", country_code: "JP", channel_id: "mist_ads", new_users: 0, device_token: null },
        { event_date: "2026-10-07", title_id: "fixture_jp", platform: "ios", country_code: "JP", channel_id: "mist_ads", new_users: null, device_token: null },
        { event_date: "2026-10-08", title_id: "fixture_jp", platform: "ios", country_code: "JP", channel_id: "mist_ads", new_users: 7, device_token: null },
      ]);
      const conditional = `SELECT country_code, countIf(isNull(new_users)) AS missing, countIf(new_users = 0) AS zeros, countIf(new_users > 0) AS positives, countIf((new_users IS NULL) OR (new_users = 0)) AS missing_or_zero FROM ${fact.table} WHERE ${where} AND title_id IN ('fixture_us', 'fixture_jp') GROUP BY country_code ORDER BY country_code`;
      assert.doesNotThrow(() => guardSql(conditional, rules, "clickhouse"));
      const grouped = await clickHouseQuery(ch, conditional);
      assert.deepEqual(grouped.map((row) => ({ country: row.country_code, missing: String(row.missing), zeros: String(row.zeros), positives: String(row.positives), missing_or_zero: String(row.missing_or_zero) })), [
        { country: "JP", missing: "1", zeros: "1", positives: "1", missing_or_zero: "2" },
        { country: "US", missing: "1", zeros: "1", positives: "1", missing_or_zero: "2" },
      ]);
      const readerPassword = randomBytes(18).toString("hex");
      await clickHouseCommand(ch, `CREATE USER evidence_reader IDENTIFIED BY '${readerPassword}'`);
      await clickHouseCommand(ch, `GRANT SELECT ON default.${fact.table} TO evidence_reader`);
      const reader = createClickHouseClient({ url, username: "evidence_reader", password: readerPassword, database: "default", maxRowsToRead: 1_000_000, timeoutSeconds: 10 }, true);
      try {
        const scopeWhere = `${where} AND title_id IN ('fixture_us', 'fixture_jp') AND platform = 'ios' AND channel_id = 'mist_ads'`;
        const evidenceSql = `SELECT title_id, country_code, countIf(isNull(new_users)) AS missing, countIf(new_users = 0) AS zeros, countIf(isNotNull(new_users)) AS known FROM ${fact.table} WHERE ${scopeWhere} GROUP BY title_id, country_code ORDER BY title_id`;
        assert.doesNotThrow(() => guardSql(evidenceSql, rules, "clickhouse"));
        const bounded = await clickHouseQueryBounded(reader, evidenceSql, 100, 100_000);
        const details = await clickHouseQuery(reader, `SELECT event_date, title_id, platform, country_code, channel_id, new_users FROM ${fact.table} WHERE ${scopeWhere}`);
        const time = { start: "2026-10-06", end: "2026-10-08", timezone: fact.timezone };
        const scope = provenCoverageScope(evidenceSql, fact, time); assert.ok(scope);
        const coverage = assessCoverage(fact, scope.equalities, time, details, scope.inSets);
        const source = { resource_id: "res_ck_conditional", session_id: "ses_synthetic", job_id: "job_synthetic", execution_id: bounded.query_id, engine: "clickhouse-local", tables: [fact.table], sql: evidenceSql, truncated: bounded.truncated, complete_population: !bounded.truncated, total_rows_exact: true, total_rows: bounded.rows.length, returned_rows: bounded.rows.length, scan_limit: 1_000_000, time_range: time, column_types: bounded.column_types, columns: Object.keys(bounded.column_types), coverage, rows: bounded.rows } as unknown as QueryResource;
        const proof = verifyConditionalAggregates(source, fact); assert.ok(proof);
        assert.deepEqual(proof.map((item) => [item.group.title_id, item.group.country_code, item.operation, item.value, item.unit, item.coverage_incomplete]), [
          ["fixture_jp", "JP", "count_null", "1", "行", true], ["fixture_jp", "JP", "count_zero", "1", "行", true], ["fixture_jp", "JP", "count_nonnull", "2", "行", true],
          ["fixture_us", "US", "count_null", "1", "行", true], ["fixture_us", "US", "count_zero", "1", "行", true], ["fixture_us", "US", "count_nonnull", "2", "行", true],
        ]);
        // Admission of date buckets does not itself claim evidence lineage.
        const calendarSql = `SELECT toYear(event_date) AS yyyy, toMonth(event_date) AS mm, toYYYYMM(event_date) AS yyyymm, toStartOfMonth(event_date) AS month_start, count() AS n FROM ${fact.table} WHERE ${scopeWhere} GROUP BY yyyy, mm, yyyymm, month_start`;
        assert.doesNotThrow(() => guardSql(calendarSql, rules, "clickhouse"));
        const calendar = await clickHouseQuery(reader, calendarSql);
        assert.deepEqual(calendar.map((row) => [Number(row.yyyy), Number(row.mm), Number(row.yyyymm), row.month_start, Number(row.n)]), [[2026, 10, 202610, "2026-10-01", 6]]);
      } finally { await reader.close(); }
    } finally { await ch.close(); }
  } finally { for (const id of owned.reverse()) await isolatedDocker(["rm", "-f", id]).catch(() => undefined); }
});
