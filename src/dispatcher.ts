import { loadConfig } from "./config.js";
import { AsyncMysqlStateStore } from "./async-mysql-state-store.js";
import { RedisJobQueue } from "./redis-queue.js";
import { assertIsolatedMysql, mysqlConnection } from "./runtime.js";
import { recordExecutorActivity } from "./executor-activity.js";

const config = loadConfig({ stateMode: "mysql", startWorker: false, publishFreshnessOnStart: false, reseedDatabase: false });
assertIsolatedMysql(config);
const connection = mysqlConnection(config);
let state = await AsyncMysqlStateStore.open(connection);
const stopActivity = recordExecutorActivity("dispatcher", async () => state);
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
      if (!state.available) {
        await state.close();
        state = await AsyncMysqlStateStore.open(connection);
      }
      const pending = await state.call("listPendingOutbox", 20);
      let delivered = true;
      for (const item of pending) {
        try {
          await queue.publish({ job_id: item.job_id, outbox_id: item.outbox_id });
          await state.call("markOutboxDispatched", item.outbox_id);
        } catch {
          delivered = false;
          // Redis is only a wakeup channel. A timed-out acknowledgement may
          // have committed; duplicate wakeups remain possible and harmless.
          await state.call("recordOutboxAttempt", item.outbox_id).catch(() => undefined);
          console.error("outbox 投递结果不明或失败；重复唤醒不决定任务终态。");
        }
      }
      if (delivered) await stopActivity.progress();
    } catch {
      console.error("outbox 状态暂不可用，稍后重新读取。");
    }
    await new Promise((resolve) => setTimeout(resolve, config.dispatcherPollMs));
  }
} finally {
  await stopActivity();
  await queue.close();
  await state.close();
}
