import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { startServer } from "../src/server.js";
import { withRuntime } from "./helpers.js";

test("JSON 写入按实际字节限流并拒绝无效字段，失败不创建会话或任务", async () => {
  await withRuntime({ startWorker: false }, async runtime => {
    const server = startServer(runtime);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const post = (body: string, type = "application/json") => fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": type }, body });
    try {
      assert.equal((await post("{}", "text/plain")).status, 415);
      for (const body of ["[]", "null", "123", "", '{"title":123}', '{"role":"admin"}', JSON.stringify({ title: "x".repeat(201) })]) assert.equal((await post(body)).status, 400, body.slice(0, 25));
      assert.equal((await post(JSON.stringify({ title: "x".repeat(70_000) }))).status, 413);
      const chunked = await new Promise<number>((resolve, reject) => {
        const req = request(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } }, res => { res.resume(); resolve(res.statusCode!); });
        req.on("error", reject); req.write('{"title":"'); req.write("x".repeat(66_000)); req.end('"}');
      });
      assert.equal(chunked, 413);
      assert.equal(runtime.state.listSessions().length, 0);
      const good = await post('{"title":"合成会话"}'); assert.equal(good.status, 201);
      const session = await good.json() as { session_id: string };
      const spoof = await fetch(`${base}/api/sessions/${session.session_id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "test", idempotency_key: "valid", userId: "root" }) });
      assert.equal(spoof.status, 400);
      const invalid = await fetch(`${base}/api/sessions/${session.session_id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "test", idempotency_key: "x".repeat(129) }) });
      assert.equal(invalid.status, 400); assert.equal(runtime.state.listJobs(session.session_id).length, 0);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
