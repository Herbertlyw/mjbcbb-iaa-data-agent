import assert from "node:assert/strict";
import test from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import { clickHouseQueryBounded } from "../src/clickhouse-client.js";

function clientFor(lines: unknown[][]) {
  let closed = false;
  const client = { query: async () => ({
    query_id: "synthetic-query",
    stream: async function* () { yield lines.map((line) => ({ json: () => line })); },
    close: () => { closed = true; },
  }) } as unknown as ClickHouseClient;
  return { client, closed: () => closed };
}

test("ClickHouse 有界流保留列类型和十进制，超限只报告观察到的下界", async () => {
  const fixture = clientFor([["n"], ["Decimal(20, 2)"], ["90071992547409.91"], ["0.09"], ["1.00"]]);
  const result = await clickHouseQueryBounded(fixture.client, "SELECT n", 2, 1000);
  assert.deepEqual(result.rows, [{ n: "90071992547409.91" }, { n: "0.09" }]);
  assert.deepEqual(result.column_types, { n: "Decimal(20, 2)" });
  assert.equal(result.query_id, "synthetic-query");
  assert.equal(result.observed_rows, 3);
  assert.equal(result.truncated, true);
  assert.equal(fixture.closed(), true);
  const bytes = clientFor([["n"], ["String"], ["a"], ["longer"]]);
  const small = await clickHouseQueryBounded(bytes.client, "SELECT n", 100, 11);
  assert.deepEqual(small.rows, [{ n: "a" }]);
  assert.equal(small.truncated, true);
  assert.equal(bytes.closed(), true);
});

test("ClickHouse 有界流拒绝重复列并关闭响应", async () => {
  const fixture = clientFor([["x", "x"], ["Int32", "Int32"]]);
  await assert.rejects(clickHouseQueryBounded(fixture.client, "SELECT 1", 10, 100), /duplicate_or_invalid_result_columns/);
  assert.equal(fixture.closed(), true);
});
