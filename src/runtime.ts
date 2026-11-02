import { rmSync } from "node:fs";
import { loadConfig, type AppConfig } from "./config.js";
import { assertLocalClickHouse, createClickHouseClient } from "./clickhouse-client.js";
import { freshnessManifest, freshnessPeriodKey, matchesFreshnessManifest, probeAndPublish, readPublication } from "./freshness.js";
import { openSimulatedDatabase } from "./database.js";
import { JobService } from "./jobs.js";
import { loadKnowledge } from "./knowledge.js";
import { MysqlStateStore } from "./mysql-state-store.js";
import { AsyncMysqlStateStore } from "./async-mysql-state-store.js";
import { MysqlFreshnessStore } from "./mysql-freshness.js";
import { SessionStore } from "./session.js";
import { SqliteStateStore, type StateStore } from "./state-store.js";
import { ToolService } from "./tools.js";
import type { DatabaseSync } from "node:sqlite";

export class Runtime {
  readonly sessions: SessionStore;
  readonly tools: ToolService;
  readonly jobs: JobService;
  private mysqlFreshness: MysqlFreshnessStore | null = null;
  private mysqlFreshnessOpening: Promise<MysqlFreshnessStore | null> | null = null;
  private asyncState: AsyncMysqlStateStore | null = null;
  private asyncStateOpening: Promise<AsyncMysqlStateStore> | null = null;
  private closing = false;

  constructor(
    readonly config: AppConfig,
    readonly knowledge: ReturnType<typeof loadKnowledge>,
    readonly db: DatabaseSync,
    readonly state: StateStore,
    readonly clickhouse: ReturnType<typeof createClickHouseClient> | null = null,
  ) {
    this.sessions = new SessionStore(state, async (sessionId, lease, maxCalls) => config.stateMode === "mysql"
      ? (await this.mysqlAsyncState()).call("reserveToolCall", sessionId, lease, maxCalls)
      : state.reserveToolCall(sessionId, lease, maxCalls), config.stateMode === "mysql" ? () => this.mysqlAsyncState() : undefined);
    this.tools = new ToolService({
      config,
      knowledge,
      db,
      sessions: this.sessions,
      businessEngine: config.businessEngine,
      clickhouse,
      ...(config.stateMode === "mysql" ? { mysqlFreshness: () => this.getMysqlFreshness() } : {}),
    });
    this.jobs = new JobService({ config, sessions: this.sessions, tools: this.tools, state, mysqlAsyncState: () => this.mysqlAsyncState() });
    if (config.startWorker) this.jobs.start();
  }

  async close(options: { abandon?: boolean } = {}): Promise<void> {
    if (options.abandon) await this.jobs.abandon();
    else await this.jobs.stop();
    this.closing = true;
    this.db.close();
    if (this.state instanceof MysqlStateStore) await this.state.closeAsync();
    else this.state.close();
    const asyncState = this.asyncState ?? await this.asyncStateOpening?.catch(() => null);
    if (asyncState) await asyncState.close();
    const freshness = this.mysqlFreshness ?? await this.mysqlFreshnessOpening;
    if (freshness) await freshness.close();
    if (this.clickhouse) await this.clickhouse.close();
    if (!options.abandon && this.config.ephemeralDir) rmSync(this.config.ephemeralDir, { recursive: true, force: true });
  }

  async mysqlAsyncState(): Promise<AsyncMysqlStateStore> {
    if (this.closing || this.config.stateMode !== "mysql") throw new Error("mysql_state_closed");
    if (this.asyncState?.available) return this.asyncState;
    if (this.asyncState) {
      const failed = this.asyncState;
      this.asyncState = null;
      await failed.close();
    }
    if (this.closing) throw new Error("mysql_state_closed");
    if (!this.asyncStateOpening) {
      const config = this.config;
      this.asyncStateOpening = AsyncMysqlStateStore.open({ host: config.mysqlHost, port: config.mysqlPort, user: config.mysqlUser, password: config.mysqlPassword, database: config.mysqlDatabase })
        .then((state) => { this.asyncState = state; return state; })
        .finally(() => { this.asyncStateOpening = null; });
    }
    return this.asyncStateOpening;
  }

  private async getMysqlFreshness(): Promise<MysqlFreshnessStore | null> {
    if (this.closing) return null;
    if (this.mysqlFreshness) return this.mysqlFreshness;
    if (!this.mysqlFreshnessOpening) {
      const config = this.config;
      this.mysqlFreshnessOpening = MysqlFreshnessStore.open({ host: config.mysqlHost, port: config.mysqlPort, user: config.mysqlUser, password: config.mysqlPassword, database: config.mysqlDatabase })
        .then((store) => { this.mysqlFreshness = store; return store; })
        .catch(() => null)
        .finally(() => { this.mysqlFreshnessOpening = null; });
    }
    return this.mysqlFreshnessOpening;
  }

  async freshnessHealth(): Promise<{ source: string; status: string }> {
    if (this.config.stateMode !== "mysql") {
      const publication = readPublication(this.config.freshnessPath);
      if (!publication) return { source: "sqlite-demo-file", status: "not_published" };
      try {
        const clock = { now: new Date(), simulatedToday: this.config.simulatedToday };
        const period = freshnessPeriodKey(this.config.freshnessTargetsPath, clock);
        if (period) freshnessManifest(this.knowledge, this.config.freshnessTargetsPath, clock);
        return { source: "sqlite-demo-file", status: period && period !== publication.period_key ? "manifest_changed" : "published" };
      } catch { return { source: "sqlite-demo-file", status: "unavailable" }; }
    }
    try {
      const store = await this.getMysqlFreshness();
      if (!store) return { source: "mysql", status: "unavailable" };
      const publication = await store.current();
      if (!publication) return { source: "mysql", status: "not_published" };
      return { source: "mysql", status: matchesFreshnessManifest(publication.manifest, freshnessManifest(this.knowledge, this.config.freshnessTargetsPath, { simulatedToday: this.config.simulatedToday })) ? "published" : "manifest_changed" };
    } catch { return { source: "mysql", status: "unavailable" }; }
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
  if (config.publishFreshnessOnStart && config.businessEngine === "sqlite" && config.stateMode === "sqlite") {
    probeAndPublish({ databasePath: config.databasePath, targetsPath: config.freshnessTargetsPath, destinationPath: config.freshnessPath, simulatedToday: config.simulatedToday });
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
