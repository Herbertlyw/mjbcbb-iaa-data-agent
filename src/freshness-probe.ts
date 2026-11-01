import { loadConfig } from "./config.js";
import { clickHouseQuery, createClickHouseClient } from "./clickhouse-client.js";
import { openSimulatedDatabase } from "./database.js";
import { probeAndPublish, probeClickHouseAndPublish } from "./freshness.js";
import { loadKnowledge } from "./knowledge.js";

const config = loadConfig();
const publication = config.businessEngine === "clickhouse" ? await probeClickHouse() : probeSqlite();

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
