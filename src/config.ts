import { fileURLToPath } from "node:url";
import path from "node:path";
import { realpathSync } from "node:fs";
import { visitorOriginSettings } from "./visitor-credentials.js";

export interface AppConfig {
  identityMode: "local_mock" | "controlled_visitor";
  visitorOrigin: string;
  visitorAllowLoopbackHttp: boolean;
  visitorWindowMs: number;
  visitorMaxAccepted: number;
  visitorMaxActive: number;
  visitorMaxGlobalActive: number;
  visitorSessionWindowMs: number;
  visitorMaxSessionsPerWindow: number;
  visitorMaxSessions: number;
  visitorBootstrapWindowMs: number;
  visitorBootstrapMaxCreates: number;
  host: string;
  port: number;
  modelMode: "deterministic" | "pi";
  piProvider: string;
  piModel: string;
  piApiKey: string;
  piBaseUrl: string;
  piContextWindow: number;
  piMaxOutputTokens: number;
  piReasoning: string;
  protocolScript: string;
  maxKnownTokens: number;
  enabledReasoning: string[];
  allowRemoteHttps: boolean;
  deepseekSyntheticOnly: boolean;
  globalBudgetPath: string;
  globalBudgetId: string;
  globalBudgetMaxRequests: number;
  globalBudgetMaxTokens: number;
  knowledgeDir: string;
  databasePath: string;
  stateDatabasePath: string;
  freshnessPath: string;
  freshnessSourcePath: string;
  publishFreshnessOnStart: boolean;
  maxModelCalls: number;
  maxToolCalls: number;
  maxContextChars: number;
  leaseMs: number;
  heartbeatMs: number;
  pollMs: number;
  ephemeralDir?: string;
  queryTimeoutMs: number;
  queryLatencyMs: number;
  maxResultRows: number;
  maxResultBytes: number;
  maxAssetReadBytes: number;
  jobTimeoutMs: number;
  toolDelayMs: number;
  simulatedToday: string;
  demoFixtureToday: string;
  defaultRole: string;
  startWorker: boolean;
  stateMode: "sqlite" | "mysql";
  reseedDatabase: boolean;
  freshnessTargetsPath: string;
  mysqlHost: string;
  mysqlPort: number;
  mysqlUser: string;
  mysqlPassword: string;
  mysqlDatabase: string;
  redisHost: string;
  redisPort: number;
  redisPassword: string;
  redisQueueKey: string;
  recoveryMs: number;
  dispatcherPollMs: number;
  businessEngine: "sqlite" | "clickhouse";
  clickhouseUrl: string;
  clickhouseUser: string;
  clickhousePassword: string;
  clickhouseDatabase: string;
  clickhouseMaxRowsToRead: number;
  clickhouseLockedReadonly: boolean;
  compactionReserveTokens: number;
  compactionKeepRecentTokens: number;
  fauxContextWindow: number;
  modelHoldMs: number;
  toolResultHoldMs: number;
  toolResultHoldNames: string[];
  candidateHoldMs: number;
}

export function repoRoot(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} 必须是非负整数`);
  }
  return value;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const modelMode = overrides.modelMode ?? (process.env.MODEL_MODE === "pi" ? "pi" : "deterministic");
  const config: AppConfig = {
    identityMode: process.env.IDENTITY_MODE === "controlled_visitor" ? "controlled_visitor" : "local_mock",
    visitorOrigin: process.env.VISITOR_ORIGIN || "",
    visitorAllowLoopbackHttp: process.env.VISITOR_ALLOW_LOOPBACK_HTTP === "true",
    visitorWindowMs: integer("VISITOR_WINDOW_MS", 900000),
    visitorMaxAccepted: integer("VISITOR_MAX_ACCEPTED", 6),
    visitorMaxActive: integer("VISITOR_MAX_ACTIVE", 1),
    visitorMaxGlobalActive: integer("VISITOR_MAX_GLOBAL_ACTIVE", 10),
    visitorSessionWindowMs: integer("VISITOR_SESSION_WINDOW_MS", 900000),
    visitorMaxSessionsPerWindow: integer("VISITOR_MAX_SESSIONS_PER_WINDOW", 40),
    visitorMaxSessions: integer("VISITOR_MAX_SESSIONS", 500),
    visitorBootstrapWindowMs: integer("VISITOR_BOOTSTRAP_WINDOW_MS", 900000),
    visitorBootstrapMaxCreates: integer("VISITOR_BOOTSTRAP_MAX_CREATES", 60),
    host: process.env.HOST || "127.0.0.1",
    port: integer("PORT", 4317),
    modelMode,
    piProvider: process.env.PI_PROVIDER || "anthropic",
    piModel: process.env.PI_MODEL || (process.env.PI_PROVIDER === "deepseek" ? "deepseek-flash" : ""),
    piApiKey: process.env.PI_API_KEY || "",
    piBaseUrl: process.env.PI_BASE_URL || (process.env.PI_PROVIDER === "deepseek" ? "https://api.deepseek.com" : ""),
    piContextWindow: integer("PI_CONTEXT_WINDOW", 0),
    piMaxOutputTokens: integer("PI_MAX_OUTPUT_TOKENS", 0),
    piReasoning: process.env.PI_REASONING || "off",
    protocolScript: process.env.PI_PROTOCOL_SCRIPT || "",
    maxKnownTokens: integer("MAX_KNOWN_TOKENS", 200_000),
    enabledReasoning: (process.env.PI_ENABLED_REASONING || "off").split(",").map((item) => item.trim()).filter(Boolean),
    allowRemoteHttps: process.env.PI_ALLOW_REMOTE_HTTPS === "true",
    deepseekSyntheticOnly: process.env.DEEPSEEK_SYNTHETIC_ONLY === "true",
    // Only loopback protocol tests may override this; official HTTPS rejects it.
    globalBudgetPath: process.env.DATAAGENT_TEST_GLOBAL_BUDGET_PATH || path.join(repoRoot(), ".local-runtime", "deepseek-budget.sqlite"),
    globalBudgetId: process.env.DEEPSEEK_BUDGET_ID || "",
    globalBudgetMaxRequests: integer("DEEPSEEK_BUDGET_MAX_REQUESTS", 0),
    globalBudgetMaxTokens: integer("DEEPSEEK_BUDGET_MAX_TOKENS", 0),
    knowledgeDir: process.env.KNOWLEDGE_DIR || path.join(repoRoot(), "knowledge", "lumenfox"),
    databasePath: process.env.DATABASE_PATH || path.join(repoRoot(), ".local-runtime", "lumenfox.sqlite"),
    stateDatabasePath: process.env.STATE_DATABASE_PATH || path.join(repoRoot(), ".local-runtime", "state.sqlite"),
    freshnessPath: process.env.FRESHNESS_PATH || path.join(repoRoot(), ".local-runtime", "freshness-current.json"),
    freshnessSourcePath: process.env.FRESHNESS_SOURCE_PATH || path.join(repoRoot(), "knowledge", "lumenfox", "freshness-source.json"),
    freshnessTargetsPath: process.env.FRESHNESS_TARGETS_PATH || path.join(repoRoot(), "knowledge", "lumenfox", "freshness-targets.json"),
    publishFreshnessOnStart: process.env.PUBLISH_FRESHNESS_ON_START === "false" ? false : true,
    stateMode: process.env.STATE_MODE === "mysql" ? "mysql" : "sqlite",
    reseedDatabase: process.env.RESEED_DATABASE === "false" ? false : true,
    mysqlHost: process.env.MYSQL_HOST || "127.0.0.1",
    mysqlPort: integer("MYSQL_PORT", 3306),
    mysqlUser: process.env.MYSQL_USER || "",
    mysqlPassword: process.env.MYSQL_PASSWORD || "",
    mysqlDatabase: process.env.MYSQL_DATABASE || "",
    redisHost: process.env.REDIS_HOST || "127.0.0.1",
    redisPort: integer("REDIS_PORT", 6379),
    redisPassword: process.env.REDIS_PASSWORD || "",
    redisQueueKey: process.env.REDIS_QUEUE_KEY || "lumenfox:local:jobs",
    recoveryMs: integer("RECOVERY_MS", 15_000),
    dispatcherPollMs: integer("DISPATCHER_POLL_MS", 200),
    businessEngine: process.env.BUSINESS_ENGINE === "clickhouse" ? "clickhouse" : "sqlite",
    clickhouseUrl: process.env.CLICKHOUSE_URL || "",
    clickhouseUser: process.env.CLICKHOUSE_USER || "",
    clickhousePassword: process.env.CLICKHOUSE_PASSWORD || "",
    clickhouseDatabase: process.env.CLICKHOUSE_DATABASE || "",
    clickhouseMaxRowsToRead: integer("CLICKHOUSE_MAX_ROWS_TO_READ", 5_000_000),
    clickhouseLockedReadonly: process.env.CLICKHOUSE_LOCKED_READONLY === "true",
    compactionReserveTokens: integer("COMPACTION_RESERVE_TOKENS", 2048),
    compactionKeepRecentTokens: integer("COMPACTION_KEEP_RECENT_TOKENS", 4096),
    fauxContextWindow: integer("PI_FAUX_CONTEXT_WINDOW", 128_000),
    modelHoldMs: integer("PI_HOLD_BEFORE_MODEL_RESPONSE_MS", 0),
    toolResultHoldMs: integer("PI_HOLD_AFTER_TOOL_RESULT_MS", 0),
    toolResultHoldNames: (process.env.PI_HOLD_AFTER_TOOL_NAMES ?? "").split(",").map((item) => item.trim()).filter(Boolean),
    candidateHoldMs: integer("PI_HOLD_AFTER_CANDIDATE_MS", 0),
    maxModelCalls: integer("MAX_MODEL_CALLS", 16),
    maxToolCalls: integer("MAX_TOOL_CALLS", 40),
    maxContextChars: integer("MAX_CONTEXT_CHARS", 500_000),
    leaseMs: integer("LEASE_MS", 15_000),
    heartbeatMs: integer("HEARTBEAT_MS", 2_000),
    pollMs: integer("POLL_MS", 200),
    queryTimeoutMs: integer("QUERY_TIMEOUT_MS", 3000),
    queryLatencyMs: integer("QUERY_LATENCY_MS", 0),
    maxResultRows: integer("MAX_RESULT_ROWS", 10_000),
    maxResultBytes: integer("MAX_RESULT_BYTES", 2_000_000),
    maxAssetReadBytes: integer("MAX_ASSET_READ_BYTES", 200_000),
    jobTimeoutMs: integer("JOB_TIMEOUT_MS", 60_000),
    toolDelayMs: integer("TOOL_DELAY_MS", 0),
    // Empty means real time in the contract/knowledge timezone. Tests and
    // explicitly simulated demos can inject a fixed calendar date.
    simulatedToday: process.env.SIMULATED_TODAY || "",
    // Applies only to prewritten examples for the explicitly synthetic stack.
    demoFixtureToday: process.env.DEMO_FIXTURE_TODAY || "",
    defaultRole: process.env.DEFAULT_ROLE || "analyst",
    startWorker: true,
  };
  const merged = { ...config, ...overrides };
  if (process.env.IDENTITY_MODE && !["local_mock", "controlled_visitor"].includes(process.env.IDENTITY_MODE)) throw new Error("IDENTITY_MODE 无效。");
  if (merged.identityMode === "controlled_visitor") {
    if (merged.stateMode !== "mysql") throw new Error("受控访客模式需要 MySQL 权威状态，不能使用 SQLite 回退。");
    if (merged.businessEngine !== "clickhouse" || !merged.clickhouseLockedReadonly) throw new Error("受控访客模式需要启用锁定只读配置的本机 ClickHouse。");
    visitorOriginSettings(merged.visitorOrigin, merged.visitorAllowLoopbackHttp);
    if (merged.visitorWindowMs < 1000 || merged.visitorWindowMs > 86400000 || [merged.visitorMaxAccepted, merged.visitorMaxActive, merged.visitorMaxGlobalActive].some(n => !Number.isSafeInteger(n) || n < 1 || n > 10000)) throw new Error("访客准入配置无效。");
    if (merged.visitorSessionWindowMs < 1000 || merged.visitorSessionWindowMs > 86400000 || [merged.visitorMaxSessionsPerWindow, merged.visitorMaxSessions].some(n => !Number.isSafeInteger(n) || n < 1 || n > 10000)) throw new Error("访客会话配额配置无效。");
    if (merged.visitorBootstrapWindowMs < 1000 || merged.visitorBootstrapWindowMs > 86400000 || merged.visitorBootstrapMaxCreates < 1 || merged.visitorBootstrapMaxCreates > 10000) throw new Error("访客引导配额配置无效。");
  }
  if ((overrides.knowledgeDir || process.env.KNOWLEDGE_DIR) && !overrides.freshnessTargetsPath && !process.env.FRESHNESS_TARGETS_PATH) {
    merged.freshnessTargetsPath = path.join(merged.knowledgeDir, "freshness-targets.json");
  }
  if (merged.host !== "127.0.0.1") throw new Error("本地 mock 身份只允许监听 127.0.0.1。");
  if (merged.simulatedToday && !isCalendarDate(merged.simulatedToday)) throw new Error("SIMULATED_TODAY 必须是真实的 YYYY-MM-DD 日历日期。");
  if (merged.demoFixtureToday && (!isCalendarDate(merged.demoFixtureToday) || merged.demoFixtureToday < "1971-01-01" || merged.demoFixtureToday > "2148-12-31")) throw new Error("DEMO_FIXTURE_TODAY 必须是支持范围内的真实日历日期。");
  validateModelProvider(merged);
  return merged;
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function currentCalendarDate(config: Pick<AppConfig, "simulatedToday">, timezone: string, now = new Date()): string {
  if (config.simulatedToday) return config.simulatedToday;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const field = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${field("year")}-${field("month")}-${field("day")}`;
}

const REASONING_LEVELS = new Set(["off", "low", "medium", "high"]);

export function validateModelProvider(config: AppConfig): void {
  if (process.env.PI_UNSUPPORTED_PARAM) {
    throw new Error("不支持的模型参数 PI_UNSUPPORTED_PARAM。不会静默忽略，也不会伪造一个等价参数。");
  }
  if (config.protocolScript && !/^[a-z0-9-]{1,32}$/u.test(config.protocolScript)) {
    throw new Error("PI_PROTOCOL_SCRIPT 只能是短的协议脚本名。");
  }
  if (!REASONING_LEVELS.has(config.piReasoning)) {
    throw new Error(`PI_REASONING=${config.piReasoning} 不在 off、low、medium、high 中。`);
  }
  if (config.enabledReasoning.some((level) => !REASONING_LEVELS.has(level))) {
    throw new Error("PI_ENABLED_REASONING 含有未支持的档位。");
  }
  if (!config.enabledReasoning.includes(config.piReasoning)) {
    throw new Error(`PI_REASONING=${config.piReasoning} 没有出现在 PI_ENABLED_REASONING 中。`);
  }
  if (config.modelMode !== "pi" || config.piProvider === "faux") return;
  if (config.piProvider === "anthropic") {
    throw new Error("供应商 anthropic 当前禁用：尚未接入统一派发和预算账本，不会向外网发送请求，也不会改用 faux。");
  }
  if (config.piProvider !== "openai-compatible" && config.piProvider !== "deepseek") {
    throw new Error(`未知供应商 ${config.piProvider}。不会改用 faux。`);
  }
  if (!config.piModel.trim()) throw new Error("openai-compatible 需要 PI_MODEL。不会改用 faux。");
  if (!config.piApiKey.trim()) throw new Error("openai-compatible 需要 PI_API_KEY。不会改用 faux。");
  if (!config.piBaseUrl.trim()) throw new Error("openai-compatible 需要 PI_BASE_URL。不会改用 faux。");
  if (config.piContextWindow <= 0) throw new Error("openai-compatible 需要 PI_CONTEXT_WINDOW。不会替模型猜测上下文长度。");
  if (config.piMaxOutputTokens <= 0) throw new Error("openai-compatible 需要 PI_MAX_OUTPUT_TOKENS。不会替模型猜测输出上限。");
  let url: URL;
  try {
    url = new URL(config.piBaseUrl);
  } catch {
    throw new Error("PI_BASE_URL 不是合法 URL。");
  }
  if (config.piProvider === "deepseek" && url.origin === "https://api.deepseek.com" && (url.pathname === "/" || url.pathname === "/v1") && !url.username && !url.password && !url.search && !url.hash) {
    if (!config.allowRemoteHttps || config.protocolScript) throw new Error("DeepSeek 远程派发需要显式启用，且不能启用协议脚本。");
    if (config.globalBudgetPath !== path.join(repoRoot(), ".local-runtime", "deepseek-budget.sqlite") || !config.globalBudgetId || config.globalBudgetMaxRequests < 1 || config.globalBudgetMaxTokens < 1) throw new Error("DeepSeek 远程派发需要先明确启用持久跨任务预算。");
    let syntheticKnowledge = false;
    let localClickHouse = false;
    try {
      syntheticKnowledge = realpathSync(config.knowledgeDir) === realpathSync(path.join(repoRoot(), "knowledge", "harborlight"));
      const ch = new URL(config.clickhouseUrl);
      localClickHouse = ch.protocol === "http:" && ch.hostname === "127.0.0.1" && Boolean(ch.port) && ch.port !== "8123" && !ch.username && !ch.password && !ch.search && !ch.hash;
    } catch { /* fail closed */ }
    if (!config.deepseekSyntheticOnly || !syntheticKnowledge || !localClickHouse || config.businessEngine !== "clickhouse" || config.clickhouseDatabase !== "harborlight" || config.clickhouseUser !== "fox_reader" || config.stateMode !== "mysql" || config.mysqlHost !== "127.0.0.1" || config.redisHost !== "127.0.0.1" || config.mysqlPort === 3306 || config.redisPort === 6379) {
      throw new Error("DeepSeek 远程模式仅允许显式的隔离合成演示配置；请使用 demo:stack -- --deepseek。");
    }
    return;
  }
  if (config.piProvider === "deepseek" && url.protocol === "https:") throw new Error("DeepSeek 只允许官方 HTTPS 地址。");
  if (url.protocol === "https:") {
    throw new Error("远程 HTTPS 供应商默认关闭。本构建只允许本机假服务，不会向外网派发。");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.search || url.hash) {
    throw new Error("未开启远程配置时，只允许 http://127.0.0.1 的端口。不会改用 faux。");
  }
}
