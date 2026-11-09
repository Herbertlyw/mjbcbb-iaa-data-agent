import mysql from "mysql2/promise";
import { loadConfig } from "../src/config.js";
import { assertIsolatedMysql, mysqlConnection } from "../src/runtime.js";

// Policy changes are explicit operator actions. No user, question, credential,
// model request or SQL result is printed. Existing usage rows are retained.
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const revisionArg = args.find(item => item.startsWith("--expected-revision="));
if ((!args.includes("--plan") && !apply) || (apply && !revisionArg) || args.some(arg => !["--plan","--apply"].includes(arg) && !arg.startsWith("--expected-revision="))) {
  throw new Error("使用 --plan 查看；使用 --apply --expected-revision=当前修订号 明确修改。");
}
const config = loadConfig({ stateMode: "mysql", startWorker: false, publishFreshnessOnStart: false, reseedDatabase: false });
if (config.identityMode !== "controlled_visitor") throw new Error("策略工具需要受控访客模式配置。");
assertIsolatedMysql(config);
const connection = mysqlConnection(config);
const policy = connection.authority?.policy;
if (!policy) throw new Error("缺少准入策略。");
const db = await mysql.createConnection({host:connection.host,port:connection.port,user:connection.user,password:connection.password,database:connection.database,connectTimeout:5000});
try {
  await db.beginTransaction();
  const [rows] = await db.query<mysql.RowDataPacket[]>(`SELECT mode,policy_json,policy_revision FROM state_authority WHERE singleton=1${apply ? " FOR UPDATE" : ""}`);
  const row = rows[0];
  if (!row || row.mode !== "controlled_visitor" || !row.policy_json) throw new Error("受控状态库未初始化或模式不匹配。");
  const [counts] = await db.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM jobs WHERE status NOT IN ('completed','needs_clarification','partial','failed','cancelled','timed_out')");
  const previous = JSON.parse(String(row.policy_json)); const revision = Number(row.policy_revision); const active = Number(counts[0]?.n ?? 0);
  console.log(JSON.stringify({mode:"controlled_visitor",revision,previous,proposed:policy,active_jobs:active,usage_retained:true,effective:"not_yet_applied",restart_all_processes:true}));
  if (apply) {
    const expected = Number(revisionArg!.slice("--expected-revision=".length));
    if (!Number.isSafeInteger(expected) || expected !== revision) throw new Error("策略修订已变化，请重新计划。");
    if (active !== 0) throw new Error("仍有非终态任务，策略不能修改。");
    if (JSON.stringify(previous) !== JSON.stringify(policy)) {
      await db.execute("INSERT INTO state_authority_history (revision,previous_policy,next_policy,changed_at_ms) VALUES (?,?,?,CAST(UNIX_TIMESTAMP(SYSDATE(3))*1000 AS UNSIGNED))", [revision+1,JSON.stringify(previous),JSON.stringify(policy)]);
      await db.execute("UPDATE state_authority SET policy_json=?,policy_revision=? WHERE singleton=1", [JSON.stringify(policy),revision+1]);
    }
    await db.commit();
    console.log(JSON.stringify({applied:true,revision:JSON.stringify(previous) === JSON.stringify(policy) ? revision : revision+1}));
  } else await db.rollback();
} catch (error) { await db.rollback().catch(() => undefined); throw error; }
finally { await db.end(); }
