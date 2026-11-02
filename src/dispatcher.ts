import { loadConfig } from "./config.js";
import { AsyncMysqlStateStore } from "./async-mysql-state-store.js";
import { RedisJobQueue } from "./redis-queue.js";
import { assertIsolatedMysql } from "./runtime.js";

const config = loadConfig({ stateMode: "mysql", startWorker: false, publishFreshnessOnStart: false, reseedDatabase: false });
assertIsolatedMysql(config);
const state = await AsyncMysqlStateStore.open({
  host: config.mysqlHost,
  port: config.mysqlPort,
  user: config.mysqlUser,
  password: config.mysqlPassword,
  database: config.mysqlDatabase,
});
const queue = new RedisJobQueue({
  host: config.redisHost,
  port: config.redisPort,
  password: config.redisPassword,
  queueKey: config.redisQueueKey,
});
let running = true;
process.on("SIGTERM", () => {
  running = false;
});
console.log("Lumenfox dispatcher：从 MySQL outbox 投递到 Redis。投递成功不等于任务完成。");
try {
  while (running) {
    try {
      const pending = await state.call("listPendingOutbox", 20);
      for (const item of pending) {
        try {
          await queue.publish({ job_id: item.job_id, outbox_id: item.outbox_id });
          await state.call("markOutboxDispatched", item.outbox_id);
        } catch {
          // Redis is only a wakeup channel. A timed-out acknowledgement may
          // have committed; duplicate wakeups remain possible and harmless.
          await state.call("recordOutboxAttempt", item.outbox_id).catch(() => undefined);
          console.error("outbox 投递结果不明或失败；重复唤醒不决定任务终态。");
        }
      }
    } catch {
      console.error("outbox 状态暂不可用，稍后重新读取。");
    }
    await new Promise((resolve) => setTimeout(resolve, config.dispatcherPollMs));
  }
} finally {
  await queue.close();
  await state.close();
}
