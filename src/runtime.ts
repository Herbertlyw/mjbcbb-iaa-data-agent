import { rmSync } from "node:fs";
import { loadConfig, type AppConfig } from "./config.js";
import { assertLocalClickHouse, createClickHouseClient } from "./clickhouse-client.js";
import { probeAndPublish, probeClickHouseAndPublish } from "./freshness.js";
import { openSimulatedDatabase } from "./database.js";
import { JobService } from "./jobs.js";
import { loadKnowledge } from "./knowledge.js";
import { MysqlStateStore } from "./mysql-state-store.js";
import { SessionStore } from "./session.js";
import { SqliteStateStore, type StateStore } from "./state-store.js";
import { ToolService } from "./tools.js";
import type { DatabaseSync } from "node:sqlite";

export class Runtime {
  readonly sessions: SessionStore;
  readonly tools: ToolService;
  readonly jobs: JobService;

  constructor(
    readonly config: AppConfig,
    readonly knowledge: ReturnType<typeof loadKnowledge>,
    readonly db: DatabaseSync,
    readonly state: StateStore,
    readonly clickhouse: ReturnType<typeof createClickHouseClient> | null = null,
  ) {
    this.sessions = new SessionStore(state);
    this.tools = new ToolService({
      config,
      knowledge,
      db,
      sessions: this.sessions,
      businessEngine: config.businessEngine,
      clickhouse,
    });
    this.jobs = new JobService({ config, sessions: this.sessions, tools: this.tools, state });
    if (config.startWorker) this.jobs.start();
  }

  async close(options: { abandon?: boolean } = {}): Promise<void> {
    if (options.abandon) await this.jobs.abandon();
    else await this.jobs.stop();
    this.db.close();
    this.state.close();
    if (this.clickhouse) await this.clickhouse.close();
    if (!options.abandon && this.config.ephemeralDir) rmSync(this.config.ephemeralDir, { recursive: true, force: true });
  }
}

export function createRuntime(overrides: Partial<AppConfig> = {}): Runtime {
  const config = loadConfig(overrides);
  if (config.stateMode === "mysql") {
    assertIsolatedMysql(config);
  }
  const knowledge = loadKnowledge(config.knowledgeDir);
  const clickhouse = config.businessEngine === "clickhouse" ? openClickHouse(config) : null;
  const db = config.businessEngine === "clickhouse"
    ? openSimulatedDatabase(config.databasePath, "SELECT 1")
    : openSimulatedDatabase(config.databasePath, knowledge.seed_sql, { reseed: config.reseedDatabase });
  if (config.publishFreshnessOnStart && config.businessEngine === "sqlite") {
    probeAndPublish({ databasePath: config.databasePath, targetsPath: config.freshnessTargetsPath, destinationPath: config.freshnessPath });
  }
  const state = config.stateMode === "mysql"
    ? new MysqlStateStore({
        host: config.mysqlHost,
        port: config.mysqlPort,
        user: config.mysqlUser,
        password: config.mysqlPassword,
        database: config.mysqlDatabase,
      })
    : new SqliteStateStore(config.stateDatabasePath);
  return new Runtime(config, knowledge, db, state, clickhouse);
}

function openClickHouse(config: AppConfig) {
  assertLocalClickHouse(config.clickhouseUrl);
  if (!config.clickhouseUser || !config.clickhousePassword || !config.clickhouseDatabase) {
    throw new Error("ClickHouse 模式需要本机库名、只读用户和一次性口令");
  }
  return createClickHouseClient({
    url: config.clickhouseUrl,
    username: config.clickhouseUser,
    password: config.clickhousePassword,
    database: config.clickhouseDatabase,
    maxRowsToRead: config.clickhouseMaxRowsToRead,
    timeoutSeconds: Math.max(1, Math.ceil(config.queryTimeoutMs / 1000)),
  }, true);
}

export function assertIsolatedMysql(config: AppConfig): void {
  if (config.mysqlHost !== "127.0.0.1" || config.redisHost !== "127.0.0.1") {
    throw new Error("MySQL 和 Redis 只允许 127.0.0.1 上的隔离实例");
  }
  if (!config.mysqlPassword || !config.mysqlUser || !config.mysqlDatabase) {
    throw new Error("MySQL 模式需要独立库名、用户和一次性口令");
  }
}
