import { loadConfig } from "./config.js";
import { clickHouseQuery, createClickHouseClient } from "./clickhouse-client.js";
import { openSimulatedDatabase } from "./database.js";
import { freshnessManifest, probeAndPublish, probeClickHouseAndPublish, probeClickHouseFreshness, probeSqliteFreshness } from "./freshness.js";
import { loadKnowledge } from "./knowledge.js";
import { MysqlFreshnessStore } from "./mysql-freshness.js";

const config = loadConfig();
// A batch uses one instant even when probing crosses midnight.
const clock = { now: new Date(), simulatedToday: config.simulatedToday };
const publication = config.stateMode === "mysql" ? await probeMysql() : config.businessEngine === "clickhouse" ? await probeClickHouse() : probeSqlite();

async function probeMysql() {
  if (!config.mysqlUser || !config.mysqlPassword || !config.mysqlDatabase) throw new Error("MySQL freshness 需要本机隔离库和临时凭据。");
  const store = await MysqlFreshnessStore.open({ host: config.mysqlHost, port: config.mysqlPort, user: config.mysqlUser, password: config.mysqlPassword, database: config.mysqlDatabase });
  try {
    const batch = await store.begin(freshnessManifest(loadKnowledge(config.knowledgeDir), config.freshnessTargetsPath, clock));
    let observation;
    if (config.businessEngine === "clickhouse") {
      const client = createClickHouseClient({ url: config.clickhouseUrl, username: config.clickhouseUser, password: config.clickhousePassword, database: config.clickhouseDatabase, maxRowsToRead: config.clickhouseMaxRowsToRead, timeoutSeconds: 30 }, true);
      try {
        observation = await probeClickHouseFreshness({ targetsPath: config.freshnessTargetsPath, query: (sql) => clickHouseQuery(client, sql) as Promise<Array<{ event_date: string }>>, ...clock });
      } finally { await client.close(); }
    } else {
      if (config.reseedDatabase) openSimulatedDatabase(config.databasePath, loadKnowledge(config.knowledgeDir).seed_sql).close();
      observation = probeSqliteFreshness({ databasePath: config.databasePath, targetsPath: config.freshnessTargetsPath, ...clock });
    }
    if (await store.publish(batch.version, observation) !== "published") throw new Error("freshness_batch_superseded");
    const published = await store.get(batch.version);
    if (!published) throw new Error("freshness_publication_unavailable");
    return published;
  } finally { await store.close(); }
}

async function probeClickHouse() {
  const client = createClickHouseClient({
    url: config.clickhouseUrl,
    username: config.clickhouseUser,
    password: config.clickhousePassword,
    database: config.clickhouseDatabase,
    maxRowsToRead: config.clickhouseMaxRowsToRead,
    timeoutSeconds: 30,
  }, true);
  try {
    return await probeClickHouseAndPublish({
      targetsPath: config.freshnessTargetsPath,
      destinationPath: config.freshnessPath,
      ...clock,
      query: (sql) => clickHouseQuery(client, sql) as Promise<Array<{ event_date: string }>>,
    });
  } finally {
    await client.close();
  }
}

function probeSqlite() {
  if (config.reseedDatabase) openSimulatedDatabase(config.databasePath, loadKnowledge(config.knowledgeDir).seed_sql).close();
  return probeAndPublish({
    databasePath: config.databasePath,
    targetsPath: config.freshnessTargetsPath,
    destinationPath: config.freshnessPath,
    ...clock,
  });
}
const failed = Object.entries(publication.tables).filter(([, table]) => table.status !== "fresh");
console.log(`新鲜度已发布 ${publication.publication_id} 版本 ${publication.version}，来源 ${publication.source}，引擎 ${publication.engine}`);
for (const [table, state] of Object.entries(publication.tables)) {
  const reason = "failure_reason" in state && state.failure_reason ? ` ${state.failure_reason}` : "";
  console.log(`${table}: ${state.status}${reason}`);
}
if (failed.length) console.log("未新鲜的表保留探测结果，没有沿用上一版的成功状态。");
console.log(`未实现的远程引擎：${publication.unimplemented_engines.join(", ") || "无"}`);
