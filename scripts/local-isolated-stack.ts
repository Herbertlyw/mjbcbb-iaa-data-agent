import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { clickHouseCommand, clickHouseInsert, clickHouseQuery, createClickHouseClient } from "../src/clickhouse-client.js";
import { currentCalendarDate } from "../src/config.js";
import { freshnessManifest, probeClickHouseFreshness } from "../src/freshness.js";
import { loadKnowledge } from "../src/knowledge.js";
import { MysqlFreshnessStore } from "../src/mysql-freshness.js";
import { syntheticDayShift } from "../src/synthetic-clock.js";
import { largeSyntheticInstallSql } from "../src/synthetic-large.js";
import { demoLocalModel } from "../src/demo-local-model.js";
import { demoTaskLimits } from "../src/demo-task-limits.js";
import { deepSeekKey } from "../src/deepseek-key.js";
import { GlobalBudget } from "../src/global-budget.js";
import { createTableSql, rollingWarehouse, smallWarehouse, WAREHOUSE_TABLES } from "../src/warehouse.js";
import { startFakeOpenAI } from "../tests/openai-fake-server.js";

// A disposable integration stack. Docker only publishes random loopback ports;
// all names, credentials and temporary files belong to this invocation.
const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const rolling = args.includes("--rolling");
const large = args.includes("--large");
const localModel = args.includes("--local-model");
const deepseek = args.includes("--deepseek");
const taskLimits = demoTaskLimits(process.env, deepseek);
const assetReadBytes = Number(process.env.MAX_ASSET_READ_BYTES ?? "200000");
if (!Number.isSafeInteger(assetReadBytes) || assetReadBytes < 0) throw new Error("MAX_ASSET_READ_BYTES 必须是非负安全整数。");
const dates = args.filter((arg) => arg.startsWith("--today="));
if (args.some((arg) => arg !== "--rolling" && arg !== "--large" && arg !== "--local-model" && arg !== "--deepseek" && !arg.startsWith("--today=")) || dates.length > 1 || args.filter((arg) => arg === "--rolling").length > 1 || args.filter((arg) => arg === "--large").length > 1 || args.filter((arg) => arg === "--local-model").length > 1 || args.filter((arg) => arg === "--deepseek").length > 1 || (localModel && deepseek) || (dates.length && !rolling)) throw new Error("用法：npm run demo:stack -- [--large] [--local-model | --deepseek] [--rolling [--today=YYYY-MM-DD]]");
// Explicit opt-in only. Validate before starting containers; do not probe the
// configured service, print its token, or inherit unrelated environment.
const budgetId = process.env.DEEPSEEK_BUDGET_ID || "";
const budgetRequests = Number(process.env.DEEPSEEK_BUDGET_MAX_REQUESTS || 0);
const budgetTokens = Number(process.env.DEEPSEEK_BUDGET_MAX_TOKENS || 0);
if (deepseek) {
  const budget = await GlobalBudget.open({ path: path.join(root, ".local-runtime", "deepseek-budget.sqlite"), budgetId, maxRequests: budgetRequests, maxTokens: budgetTokens });
  await budget.close();
}
const deepseekKey = deepseek ? deepSeekKey(process.env, path.join(root, ".local-runtime")) : "";
if (deepseek && !deepseekKey) throw new Error("请先在本机环境或被忽略的本机密钥文件中设置 DeepSeek 密钥；不要把密钥发到对话中。");
const configuredModel = deepseek ? { PI_PROVIDER: "deepseek", PI_MODEL: process.env.PI_MODEL || "deepseek-flash", PI_API_KEY: deepseekKey, PI_BASE_URL: "https://api.deepseek.com", PI_ALLOW_REMOTE_HTTPS: "true", DEEPSEEK_SYNTHETIC_ONLY: "true", PI_CONTEXT_WINDOW: "128000", PI_MAX_OUTPUT_TOKENS: "2048", PI_REASONING: "off", PI_ENABLED_REASONING: "off,low,high", PI_PROTOCOL_SCRIPT: "" } : localModel ? demoLocalModel(process.env) : null;
const testToday = dates[0]?.slice("--today=".length);
if (dates.length && !testToday) throw new Error("测试日期不能为空");
const fixtureToday = rolling ? (testToday || currentCalendarDate({ simulatedToday: "" }, "America/Los_Angeles")) : "2026-10-29";
const dateShift = syntheticDayShift(fixtureToday);
const configuredToday = rolling ? (testToday ?? "") : fixtureToday;
const id = randomUUID();
const password = randomBytes(18).toString("hex");
const readerPassword = randomBytes(18).toString("hex");
const token = `fictional-${randomBytes(18).toString("hex")}`;
const created: string[] = [];
let unconfirmedContainer = false;
const children: ChildProcess[] = [];
const dir = await mkdtemp(path.join(tmpdir(), "dataagent-stack-"));
const watchdog = spawn(process.execPath, [path.join(root, "scripts", "stack-watchdog.mjs"), id, dir], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
await new Promise<void>((resolve, reject) => { watchdog.once("spawn", resolve); watchdog.once("error", reject); });
watchdog.unref();
let fake: Awaited<ReturnType<typeof startFakeOpenAI>> | undefined;
let stopping = false;
let stopSignal: (() => void) | undefined;
const stopped = new Promise<void>((resolve) => { stopSignal = resolve; });

function requestStop() { stopping = true; stopSignal?.(); }
process.on("SIGINT", requestStop);
process.on("SIGTERM", requestStop);

async function command(program: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.once("error", () => reject(new Error(`${program} 无法启动`)));
    child.once("exit", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`${program} 命令失败（${code ?? "信号终止"}）`)));
  });
}

async function createContainer(name: string, args: string[]): Promise<void> {
  if (stopping) throw new Error("启动已取消");
  try {
    await command("docker", ["run", "--pull=never", "--rm", "-d", "--name", name, "--label", `dataagent.isolated=${id}`, ...args]);
    created.push(name);
  } catch (error) {
    // In case Docker created the container before reporting an error, only
    // claim it if its invocation-specific label matches.
    const label = await command("docker", ["inspect", "--format", '{{ index .Config.Labels "dataagent.isolated" }}', name]).catch(() => null);
    if (label === id) created.push(name);
    else if (label === null) unconfirmedContainer = true;
    throw error;
  }
}

async function mappedPort(name: string, port: number): Promise<number> {
  const value = await command("docker", ["port", name, `${port}/tcp`]);
  const match = /^127\.0\.0\.1:(\d+)$/u.exec(value);
  if (!match) throw new Error("容器端口未绑定到本机回环地址");
  return Number(match[1]);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitUntil(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (!stopping && Date.now() < deadline) {
    try { if (await check()) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(`${label} 启动超时或被取消`);
}

function launch(file: string, env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", file], { cwd: root, env, stdio: "ignore" });
  children.push(child);
  child.once("exit", (code, signal) => {
    if (!stopping) { console.error(`本地组件意外退出（${code ?? signal ?? "未知"}），正在清理本轮资源。`); process.exitCode = 1; requestStop(); }
  });
  child.once("error", () => { if (!stopping) { console.error("本地组件无法启动。"); process.exitCode = 1; requestStop(); } });
  return child;
}

try {
  console.log("创建独立的 ClickHouse、MySQL 和 Redis（仅随机回环端口）…");
  const chName = `dataagent-stack-ch-${id}`;
  const mysqlName = `dataagent-stack-mysql-${id}`;
  const redisName = `dataagent-stack-redis-${id}`;
  await createContainer(chName, ["--tmpfs", "/var/lib/clickhouse:rw,size=512m", "--ulimit", "nofile=262144:262144", "-p", "127.0.0.1::8123", "-e", `CLICKHOUSE_PASSWORD=${password}`, "-e", "CLICKHOUSE_DB=harborlight", "-e", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1", "clickhouse/clickhouse-server:24.8.14.39"]);
  await createContainer(mysqlName, ["--tmpfs", "/var/lib/mysql:rw,size=1g", "-p", "127.0.0.1::3306", "-e", `MYSQL_ROOT_PASSWORD=${password}`, "-e", "MYSQL_DATABASE=lumenfox_it", "-e", "MYSQL_USER=lumenfox_it", "-e", `MYSQL_PASSWORD=${password}`, "mysql:8.0.32"]);
  await createContainer(redisName, ["--tmpfs", "/data:rw,size=64m", "-p", "127.0.0.1::6379", "redis:6.2", "redis-server", "--bind", "0.0.0.0", "--protected-mode", "yes", "--save", "", "--appendonly", "no", "--requirepass", password]);
  const [chPort, mysqlPort, redisPort, apiPort] = await Promise.all([mappedPort(chName, 8123), mappedPort(mysqlName, 3306), mappedPort(redisName, 6379), freePort()]);
  const url = `http://127.0.0.1:${chPort}`;
  await waitUntil(async () => (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok, "ClickHouse");
  await waitUntil(async () => {
    const connection = await mysql.createConnection({ host: "127.0.0.1", port: mysqlPort, user: "lumenfox_it", password, database: "lumenfox_it", connectTimeout: 1000 });
    await connection.end(); return true;
  }, "MySQL");
  console.log(`装载${rolling ? "滚动" : "固定"}合成样本（业务日 ${fixtureToday}）并发布新鲜度…`);
  const base = { url, username: "default", password, maxRowsToRead: 5_000_000, timeoutSeconds: 30 };
  const bootstrap = createClickHouseClient({ ...base, database: "default" }, false);
  try { await clickHouseCommand(bootstrap, "CREATE DATABASE IF NOT EXISTS harborlight"); } finally { await bootstrap.close(); }
  const admin = createClickHouseClient({ ...base, database: "harborlight" }, false);
  try {
    for (const table of WAREHOUSE_TABLES) await clickHouseCommand(admin, createTableSql(table));
    const data = rolling ? rollingWarehouse({ simulatedToday: fixtureToday }) : smallWarehouse();
    const tables = { dim_fox_title: data.titles, dim_fox_channel: data.channels, fact_fox_daily_install: data.installs, fact_fox_daily_active: data.active, fact_fox_daily_payment: data.payments, fact_fox_ad_receipt: data.revenue, fact_fox_daily_spend: data.spend, fact_fox_retention_cohort: data.retention, fact_fox_cohort_payback: data.cohortPayback, fact_fox_experiment_arm: data.arms, fact_fox_experiment_metric: data.experimentMetrics };
    for (const [table, rows] of Object.entries(tables)) await clickHouseInsert<unknown>(admin, table, rows);
    if (large) await clickHouseCommand(admin, largeSyntheticInstallSql(fixtureToday));
    await clickHouseCommand(admin, `CREATE USER fox_reader IDENTIFIED BY '${readerPassword}'`);
    await clickHouseCommand(admin, "GRANT SELECT ON harborlight.* TO fox_reader");
  } finally { await admin.close(); }
  const knowledgeDir = path.join(root, "knowledge", "harborlight");
  const targetsPath = path.join(knowledgeDir, rolling ? "freshness-targets-rolling.example.json" : "freshness-targets.json");
  const reader = createClickHouseClient({ ...base, username: "fox_reader", password: readerPassword, database: "harborlight" }, true);
  const freshness = await MysqlFreshnessStore.open({ host: "127.0.0.1", port: mysqlPort, user: "lumenfox_it", password, database: "lumenfox_it" });
  try {
    const batch = await freshness.begin(freshnessManifest(loadKnowledge(knowledgeDir), targetsPath, { simulatedToday: fixtureToday }));
    const observed = await probeClickHouseFreshness({ targetsPath, simulatedToday: fixtureToday, query: (sql) => clickHouseQuery(reader, sql) as Promise<Array<{ event_date: string }>> });
    if (await freshness.publish(batch.version, observed) !== "published") throw new Error("新鲜度发布未完成");
  } finally { await freshness.close(); await reader.close(); }
  if (!configuredModel) fake = await startFakeOpenAI(token, { recordObservations: false, syntheticDateShiftDays: dateShift });
  const model = configuredModel ?? { PI_PROVIDER: "openai-compatible", PI_MODEL: "local-protocol", PI_API_KEY: token, PI_BASE_URL: fake!.url, PI_CONTEXT_WINDOW: "64000", PI_MAX_OUTPUT_TOKENS: "512", PI_REASONING: "off", PI_ENABLED_REASONING: "off", PI_PROTOCOL_SCRIPT: "happy" };
  const env = {
    PATH: process.env.PATH ?? "", HOST: "127.0.0.1", PORT: String(apiPort), SIMULATED_TODAY: configuredToday, DEMO_FIXTURE_TODAY: fixtureToday, STATE_MODE: "mysql", BUSINESS_ENGINE: "clickhouse", KNOWLEDGE_DIR: knowledgeDir, FRESHNESS_TARGETS_PATH: targetsPath,
    CLICKHOUSE_URL: url, CLICKHOUSE_USER: "fox_reader", CLICKHOUSE_PASSWORD: readerPassword, CLICKHOUSE_DATABASE: "harborlight",
    FRESHNESS_PATH: path.join(dir, "freshness.json"), DATABASE_PATH: path.join(dir, "unused.sqlite"), RESEED_DATABASE: "false", PUBLISH_FRESHNESS_ON_START: "false",
    MYSQL_HOST: "127.0.0.1", MYSQL_PORT: String(mysqlPort), MYSQL_USER: "lumenfox_it", MYSQL_PASSWORD: password, MYSQL_DATABASE: "lumenfox_it",
    REDIS_HOST: "127.0.0.1", REDIS_PORT: String(redisPort), REDIS_PASSWORD: password, REDIS_QUEUE_KEY: `dataagent:stack:${id}`,
    MODEL_MODE: "pi", ...model, ...(deepseek ? { DEEPSEEK_BUDGET_ID: budgetId, DEEPSEEK_BUDGET_MAX_REQUESTS: String(budgetRequests), DEEPSEEK_BUDGET_MAX_TOKENS: String(budgetTokens) } : {}), MAX_ASSET_READ_BYTES: String(assetReadBytes), RECOVERY_MS: "600", LEASE_MS: "4000", MAX_MODEL_CALLS: String(taskLimits.maxCalls), MAX_KNOWN_TOKENS: String(taskLimits.maxKnownTokens), JOB_TIMEOUT_MS: deepseek ? "120000" : "60000",
  };
  launch("src/api.ts", env); launch("src/dispatcher.ts", env); launch("src/worker.ts", env);
  await waitUntil(async () => (await fetch(`http://127.0.0.1:${apiPort}/api/health`, { signal: AbortSignal.timeout(1000) })).ok, "API");
  console.log(`\n本机演示：http://127.0.0.1:${apiPort}`);
  console.log(`${rolling ? "滚动" : "固定日期"}合成数据；${deepseek ? "Pi 将问题、授权合成知识和查询结果发送至 DeepSeek 官方服务；模型能力尚未验证。" : configuredModel ? "Pi 使用用户配置的本机兼容服务，模型能力未验证。" : "Pi 连接脚本化的本机假服务，不是真实模型。"}按 Ctrl+C 停止并清理本轮资源。`);
  if (large) console.log("已在本轮临时数据库生成 100,000 行合成安装数据（big_demo）。");
  if (rolling && !testToday) console.log("跨业务日后旧 freshness 不能继续使用；请停止并重新启动以生成新样本和发布。 ");
  await stopped;
} catch (error) {
  if (!stopping) { console.error(error instanceof Error ? error.message : "隔离栈启动失败"); process.exitCode = 1; }
} finally {
  stopping = true;
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await Promise.all(children.map((child) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>((resolve) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
  })));
  if (fake) await fake.close();
  let cleanupComplete = !unconfirmedContainer;
  for (const name of created.reverse()) {
    try { await command("docker", ["rm", "-f", name]); } catch { cleanupComplete = false; }
  }
  await rm(dir, { recursive: true, force: true });
  const watchdogExit = watchdog.exitCode !== null || watchdog.signalCode !== null ? Promise.resolve() : new Promise<void>((resolve) => {
    watchdog.once("exit", () => resolve());
  });
  watchdog.ref();
  watchdog.stdin?.end(cleanupComplete ? "cleanup-complete\n" : undefined);
  await watchdogExit;
  console.log("本轮隔离栈已停止。");
}
