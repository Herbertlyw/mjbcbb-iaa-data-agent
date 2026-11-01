import { loadConfig } from "./config.js";
import { MysqlStateStore } from "./mysql-state-store.js";
import { RedisJobQueue } from "./redis-queue.js";
import { assertIsolatedMysql } from "./runtime.js";

const config = loadConfig({ stateMode: "mysql", startWorker: false, publishFreshnessOnStart: false, reseedDatabase: false });
assertIsolatedMysql(config);
const state = new MysqlStateStore({
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
while (running) {
  const pending = state.listPendingOutbox(20);
  for (const item of pending) {
    try {
      await queue.publish({ job_id: item.job_id, outbox_id: item.outbox_id });
      state.markOutboxDispatched(item.outbox_id);
    } catch {
      state.recordOutboxAttempt(item.outbox_id);
      console.error("outbox 投递失败，稍后重试。队列里即使出现重复消息，也不能产生第二个终态。");
    }
  }
  await new Promise((resolve) => setTimeout(resolve, config.dispatcherPollMs));
}
await queue.close();
state.close();
