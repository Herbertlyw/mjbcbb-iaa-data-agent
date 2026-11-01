import { loadConfig } from "./config.js";
import { RedisJobQueue } from "./redis-queue.js";
import { createRuntime } from "./runtime.js";

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
while (running) {
  const message = await queue.take(1);
  if (message?.job_id) {
    const claim = runtime.state.claimJob(message.job_id, runtime.jobs.workerOwner, Date.now(), config.leaseMs);
    if (claim) await runtime.jobs.runClaimed(claim);
  }
  if (Date.now() >= nextRecovery) {
    const recovered = runtime.state.claimNext(runtime.jobs.workerOwner, Date.now(), config.leaseMs);
    if (recovered) await runtime.jobs.runClaimed(recovered);
    nextRecovery = Date.now() + config.recoveryMs;
  }
}
await queue.close();
await runtime.close({ abandon: true });
process.exit(0);
