import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { stopProcess } from "./process-control.js";

test("清理已因信号退出的子进程不会等待已经发生的 exit", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, "SIGTERM");
  await stopProcess(child);
});

test("清理仍运行的测试子进程并等待其退出", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  await stopProcess(child);
  assert.equal(child.signalCode, "SIGTERM");
  await stopProcess(child);
});
