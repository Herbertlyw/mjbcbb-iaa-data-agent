import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { clickHousePreflightedQuery, createClickHouseClient } from "../src/clickhouse-client.js";

test("执行计划允许真实空白分隔行，空计划、异常类型和截断仍阻止正式查询", async () => {
  let names = ["explain"];
  let types = ["String"];
  let rows: unknown[][] = [];
  let queries = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (part: string) => { body += part; });
    request.on("end", () => {
      const query = new URL(request.url ?? "/", "http://127.0.0.1");
      const sql = `${query.searchParams.get("query") ?? ""} ${body}`;
      const result = sql.includes("EXPLAIN PLAN")
        ? [names, types, ...rows]
        : [["n"], ["UInt8"], [1]];
      if (!sql.includes("EXPLAIN PLAN")) queries++;
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(result.map(row => JSON.stringify(row) + "\n").join(""));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = createClickHouseClient({ url: `http://127.0.0.1:${address.port}`, username: "fictional", password: "fictional", database: "synthetic", maxRowsToRead: 100, timeoutSeconds: 3 }, true);
  try {
    for (const invalid of [[], [[""]], [["  "]], [[123]], Array.from({ length: 10001 }, () => ["Read"]), [["X".repeat(270000)]]]) {
      rows = invalid;
      await assert.rejects(() => clickHousePreflightedQuery(client, "SELECT 1 AS n", 10, 1000), /clickhouse_plan_invalid/);
    }
    rows = [["Read"]];
    types = ["UInt64"];
    await assert.rejects(() => clickHousePreflightedQuery(client, "SELECT 1 AS n", 10, 1000), /clickhouse_plan_invalid/);
    types = ["String"];
    names = ["other"];
    await assert.rejects(() => clickHousePreflightedQuery(client, "SELECT 1 AS n", 10, 1000), /clickhouse_plan_invalid/);
    assert.equal(queries, 0);
    names = ["explain"];
    rows = [["Output: n"], [""], ["ReadFromMergeTree"]];
    const result = await clickHousePreflightedQuery(client, "SELECT 1 AS n", 10, 1000);
    assert.deepEqual(result.rows, [{ n: 1 }]);
    assert.equal(queries, 1);
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
