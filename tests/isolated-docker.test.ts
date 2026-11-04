import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import test from "node:test";
import { isolatedDocker, runOwnedContainer } from "./isolated-docker.js";

test("隔离 Docker 启动碰到回环端口占用时只清理带本次标签的容器", { timeout: 60_000 }, async () => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const run = `dataagent-port-collision-${randomUUID()}`;
  const created: string[] = [];
  try {
    await assert.rejects(runOwnedContainer(["run", "--pull=never", "-d", "--name", run, "--label", `dataagent.test.run=${run}`, "--tmpfs", "/data:rw,size=16m", "-p", `127.0.0.1:${address.port}:6379`, "redis:6.2"], run, run, created), /docker_run_failed_port_bind_exit_125/);
    assert.deepEqual(created, [run], "Docker 已创建但未启动的容器须按标签纳入本轮清理");
  } finally {
    for (const name of created) await isolatedDocker(["rm", "-f", name]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
