import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { clickHouseQuery, createClickHouseClient } from "../src/clickhouse-client.js";

test("锁定只读账号先验证服务端边界，异常配置不能执行实际查询", async () => {
  let settings: Record<string, unknown> = {};
  let actualQueries = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (part: string) => { body += part; });
    request.on("end", () => {
      const query = new URL(request.url ?? "/", "http://127.0.0.1");
      const sql = `${query.searchParams.get("query") ?? ""} ${body}`;
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      if (sql.includes("getSetting('readonly')")) response.end(`${JSON.stringify(settings)}\n`);
      else { actualQueries += 1; response.end('{"n":1}\n'); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const config = { url: `http://127.0.0.1:${address.port}`, username: "fictional", password: "fictional", database: "synthetic", maxRowsToRead: 5_000_000, timeoutSeconds: 3, lockedReadonly: true };
  const good = { ro: 1, seconds: 3, rows: 5_000_000, overflow: "throw", join_nulls: 1, decimals: 1, block_size: 1024 };
  try {
    settings = good;
    const client = createClickHouseClient(config, true);
    try {
      assert.deepEqual(await clickHouseQuery(client, "SELECT 1 AS n"), [{ n: 1 }]);
      settings = { ...good, join_nulls: 0 };
      await assert.rejects(() => clickHouseQuery(client, "SELECT 1 AS n"), /clickhouse_locked_profile_invalid/);
    }
    finally { await client.close(); }
    for (const changed of [{ ro: 0 }, { seconds: 0 }, { seconds: 4 }, { rows: 0 }, { rows: 5_000_001 }, { overflow: "break" }, { join_nulls: 0 }, { decimals: 0 }, { block_size: 1025 }]) {
      settings = { ...good, ...changed };
      const rejected = createClickHouseClient(config, true);
      try { await assert.rejects(() => clickHouseQuery(rejected, "SELECT 1 AS n"), /clickhouse_locked_profile_invalid/); }
      finally { await rejected.close(); }
    }
    assert.equal(actualQueries, 1);
    assert.throws(() => createClickHouseClient(config, false), /requires_readonly/);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
