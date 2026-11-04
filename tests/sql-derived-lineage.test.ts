import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { assertJoinKeys, guardSql, inspectSingleSourceProjection, SqlRejected, type TableRule } from "../src/sql.js";

const rules: TableRule[] = [
  { table: "facts", allowed_columns: ["event_date", "id", "region", "value"], sensitive_columns: ["secret"], must_filter: ["event_date"] },
  { table: "labels", allowed_columns: ["id", "label"], sensitive_columns: [], must_filter: [] },
];
const range = "event_date = '2026-10-06' AND region = 'A'";

test("一层 CTE 和派生表绑定真实输出、内部日期及等价直接投影", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE facts (event_date TEXT, id TEXT, region TEXT, value INTEGER, secret TEXT); INSERT INTO facts VALUES ('2026-10-06','i1','A',4,'synthetic'),('2026-10-06','i2','A',7,'synthetic'),('2026-10-07','i3','A',9,'synthetic')");
    const inner = `SELECT event_date,id,value AS v FROM facts WHERE ${range}`;
    const queries = [`WITH x AS (${inner}) SELECT x.event_date,x.id,x.v FROM x`, `SELECT x.event_date,x.id,x.v FROM (${inner}) x`];
    for (const sql of queries) {
      const guard = guardSql(sql, rules);
      assert.deepEqual(guard.tables, ["facts"]);
      assert.deepEqual(guard.time_range, { start: "2026-10-06", end: "2026-10-06" });
      const proof = inspectSingleSourceProjection(sql, rules);
      assert.ok(proof); assert.equal(proof.original_sql, sql); assert.equal(proof.table, "facts");
      assert.deepEqual({ ...proof.output_columns }, { event_date: "event_date", id: "id", v: "value" });
      const rows = (query: string) => db.prepare(query).all().map((row) => ({ ...row }));
      assert.deepEqual(rows(sql), rows(proof.proof_sql));
      assert.deepEqual(rows(sql).map((row) => row.v), [4, 7]);
    }
  } finally { db.close(); }
});

test("派生作用域不能读取未投影或敏感字段，复杂形式不产生等价证明", () => {
  const rejected = (sql: string, code?: string) => assert.throws(() => guardSql(sql, rules), (error: unknown) => error instanceof SqlRejected && (!code || error.code === code));
  rejected(`WITH x AS (SELECT event_date,id FROM facts WHERE ${range}) SELECT x.secret FROM x`, "column_not_in_contract");
  rejected(`WITH x AS (SELECT event_date,secret FROM facts WHERE ${range}) SELECT secret FROM x`, "sensitive_field");
  rejected(`SELECT "secret" FROM facts WHERE ${range}`, "sensitive_field");
  rejected(`SELECT id FROM facts WHERE ${range} AND "secret" = 'synthetic'`, "sensitive_field");
  rejected(`SELECT id AS event_date FROM facts WHERE ${range}`, "date_alias_shadowing");
  rejected("WITH x AS (SELECT id,value FROM facts) SELECT id FROM x", "unbounded_query");
  rejected(`WITH x AS (SELECT event_date,id,value FROM facts WHERE ${range}) SELECT x.id FROM x JOIN labels d ON x.id = d.id`, "join_structure_unsupported");
  assert.equal(inspectSingleSourceProjection(`WITH x AS (SELECT event_date,id,value FROM facts WHERE ${range}) SELECT id,value FROM x WHERE id = 'i1'`, rules), null);
  assert.equal(inspectSingleSourceProjection(`WITH x AS (SELECT event_date,id,value FROM facts WHERE ${range} LIMIT 1) SELECT id,value FROM x`, rules), null);
  assert.equal(inspectSingleSourceProjection(`WITH x AS (SELECT event_date,id,SUM(value) AS total FROM facts WHERE ${range} GROUP BY event_date,id) SELECT id,total FROM x`, rules), null);
  const withQuotes = `WITH x AS (SELECT event_date,id FROM facts WHERE event_date = '2026-10-06' AND region = 'A"safe"B') SELECT id FROM x`;
  assert.match(inspectSingleSourceProjection(withQuotes, rules)?.proof_sql ?? "", /'A"safe"B'/);
});

test("LEFT JOIN 仅由宿主显式确认维表、登记键和可证明粒度时放行", () => {
  const sql = "SELECT f.id,d.label FROM facts f LEFT JOIN labels d ON f.id = d.id WHERE f.event_date = '2026-10-06'";
  const joins = [{ tables: ["facts", "labels"], keys: ["id"] }];
  const grains = new Map([["facts", ["event_date", "id"]], ["labels", ["id"]]]);
  assert.doesNotThrow(() => guardSql(sql, rules));
  assert.throws(() => assertJoinKeys(sql, joins, grains), SqlRejected);
  assert.doesNotThrow(() => assertJoinKeys(sql, joins, grains, { leftJoinDimensions: new Set(["labels"]) }));
  assert.throws(() => assertJoinKeys(sql, joins, new Map([["facts", ["event_date", "id"]], ["labels", ["id", "region"]]]), { leftJoinDimensions: new Set(["labels"]) }), SqlRejected);
  assert.throws(() => assertJoinKeys(sql.replace("f.id = d.id", "f.id = d.id OR 1=1"), joins, grains, { leftJoinDimensions: new Set(["labels"]) }), SqlRejected);
  assert.throws(() => assertJoinKeys(sql, joins, grains, { leftJoinDimensions: new Set(["facts"]) }), SqlRejected);
});
