import { loadConfig } from "./config.js";
import { createRuntime } from "./runtime.js";
import { startServer } from "./server.js";

const config = loadConfig();
if (config.stateMode === "mysql") {
  console.error("这个入口只启动 SQLite 单进程演示。MySQL 模式请分别运行 api、dispatcher、worker 和 freshness-probe。");
  process.exit(1);
}
if (config.modelMode === "pi" && config.piProvider !== "faux" && config.piProvider !== "openai-compatible" && !config.piApiKey) {
  console.error("MODEL_MODE=pi 需要 PI_API_KEY。只有显式 PI_PROVIDER=faux 才使用本地伪模型。openai-compatible 缺少配置会直接失败，不会静默回退。");
  process.exit(1);
}
const runtime = createRuntime(config);
const server = startServer(runtime);
server.listen(config.port, config.host, () => {
  console.log(`Lumenfox Data Agent 本地演示：http://${config.host}:${config.port}`);
  console.log("运行模式：sqlite-demo。状态在本进程 SQLite，不是 MySQL/Redis 分进程模式。没有外部模型。");
});
