import assert from "node:assert/strict";
import test from "node:test";
import { recordExecutorActivity } from "../src/executor-activity.js";

test("关闭执行器时状态桥无法打开也不会中断其他清理", async () => {
  const stop = recordExecutorActivity("worker", async () => { throw new Error("isolated_state_unavailable"); });
  await assert.doesNotReject(stop());
});
