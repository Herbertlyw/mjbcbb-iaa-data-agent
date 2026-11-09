import { loadConfig } from "./config.js";
import { RedisJobQueue } from "./redis-queue.js";
import { createRuntime } from "./runtime.js";
import { recordExecutorActivity } from "./executor-activity.js";

const config = loadConfig({
  stateMode: "mysql",
  startWorker: false,
  publishFreshnessOnStart: false,
  reseedDatabase: false,
});
if (config.host !== "127.0.0.1") {
  console.error("Worker 只接受本机隔离配置。");
  process.exit(1);
}
const runtime = createRuntime(config);
await runtime.mysqlAsyncState();
const stopActivity = recordExecutorActivity("worker", () => runtime.mysqlAsyncState());
const queue = new RedisJobQueue({
  host: config.redisHost,
  port: config.redisPort,
  password: config.redisPassword,
  queueKey: config.redisQueueKey,
});
let running = true;
let nextRecovery = Date.now() + config.recoveryMs;
process.on("SIGTERM", () => {
  running = false;
});
console.log("Lumenfox worker：Redis 只用来唤醒。领取、续租和终态都核对 MySQL 围栏。");
try {
  while (running) {
    try {
      let message: Awaited<ReturnType<RedisJobQueue["take"]>> = null;
      try { message = await queue.take(1); }
      catch {
        console.error("Redis 唤醒暂不可用，仍按计划检查 MySQL 租约恢复。");
        if (running) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (message?.job_id) {
        const claim = await (await runtime.mysqlAsyncState()).call("claimJob", message.job_id, runtime.jobs.workerOwner, Date.now(), config.leaseMs);
        await stopActivity.progress();
        if (claim) await runtime.jobs.runClaimed(claim);
      }
      if (Date.now() >= nextRecovery) {
        const recovered = await (await runtime.mysqlAsyncState()).call("claimNext", runtime.jobs.workerOwner, Date.now(), config.leaseMs);
        await stopActivity.progress();
        if (recovered) await runtime.jobs.runClaimed(recovered);
        nextRecovery = Date.now() + config.recoveryMs;
      }
    } catch {
      // A failed or timed-out claim may have committed. Do not replay it here:
      // authoritative lease expiry and normal recovery decide what runs next.
      console.error("worker 状态或唤醒暂不可用，等待租约恢复；未重放未知结果。");
      if (running) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
} finally {
  await stopActivity();
  await queue.close();
  await runtime.close({ abandon: true });
}
process.exit(0);
