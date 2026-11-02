import assert from "node:assert/strict";
import test from "node:test";
import { SessionStore } from "../src/session.js";
import type { StateStore } from "../src/state-store.js";

test("工具预算等待不冻结计时器，结果未知后当前执行者不再次派发", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const store = new SessionStore({} as StateStore, async () => {
    calls += 1;
    await gate;
    throw new Error("mysql_state_outcome_unknown");
  });
  store.setActiveJob("synthetic_session", "synthetic_job", { owner: "worker_a", fence: 1 });
  const pending = store.reserveToolCall("synthetic_session", 3);
  let timerFired = false;
  await new Promise<void>((resolve) => setTimeout(() => { timerFired = true; resolve(); }, 20));
  assert.equal(timerFired, true);
  assert.equal(calls, 1);
  release();
  assert.equal(await pending, "lost");
  assert.equal(await store.reserveToolCall("synthetic_session", 3), "lost");
  assert.equal(calls, 1);
});
