import { loadConfig } from "./config.js";
import { createRuntime } from "./runtime.js";
import { startServer } from "./server.js";

const config = loadConfig({
  stateMode: "mysql",
  startWorker: false,
  publishFreshnessOnStart: false,
  reseedDatabase: false,
});
if (config.host !== "127.0.0.1") {
  console.error("API 只监听 127.0.0.1。mock 身份不能暴露到非本机地址。");
  process.exit(1);
}
const runtime = createRuntime(config);
const server = startServer(runtime);
server.listen(config.port, config.host, () => {
  console.log(`Lumenfox API：http://${config.host}:${config.port}`);
  console.log("运行模式：mysql-redis。本进程不执行任务。完成状态只写在 MySQL。");
});
process.on("SIGTERM", () => {
  server.close(() => {
    void runtime.close({ abandon: true }).finally(() => process.exit(0));
  });
});
