import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import mysql from "mysql2/promise";
import { clickHouseCommand, clickHouseInsert, clickHouseQuery, createClickHouseClient } from "../src/clickhouse-client.js";
import { freshnessManifest, probeClickHouseFreshness } from "../src/freshness.js";
import { MysqlFreshnessStore } from "../src/mysql-freshness.js";
import { loadKnowledge } from "../src/knowledge.js";
import { createTableSql, smallWarehouse, WAREHOUSE_TABLES } from "../src/warehouse.js";
import { startFakeOpenAI } from "./openai-fake-server.js";
import { isolatedDocker as docker, loopbackPort, runOwnedContainer } from "./isolated-docker.js";
import { largeSyntheticInstallSql } from "../src/synthetic-large.js";

const root = process.cwd();
const fixtureToken = "fictional-loopback-token";

test("封闭契约域十万行经 Pi 主链完整交付，缺组缺日不冒充完成", { timeout: 180_000 }, async () => {
  const fake = await startFakeOpenAI(fixtureToken);
  const pass = randomBytes(18).toString("hex"); const run = `dataagent-large-e2e-${randomUUID()}`;
  const names = [run + "-ch", run + "-mysql", run + "-redis"]; const created: string[] = [];
  const dir = mkdtempSync(path.join(tmpdir(), "dataagent-large-e2e-")); const children: ChildProcess[] = [];
  try {
    await runOwnedContainer(["run", "--pull=never", "-d", "--name", names[0]!, "--label", `dataagent.test.run=${run}`, "--tmpfs", "/var/lib/clickhouse:rw,size=768m", "--ulimit", "nofile=262144:262144", "-p", "127.0.0.1::8123", "-e", `CLICKHOUSE_PASSWORD=${pass}`, "-e", "CLICKHOUSE_DB=harborlight", "-e", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1", "clickhouse/clickhouse-server:24.8.14.39"], names[0]!, run, created);
    await runOwnedContainer(["run", "--pull=never", "-d", "--name", names[1]!, "--label", `dataagent.test.run=${run}`, "--tmpfs", "/var/lib/mysql:rw,size=1g", "-p", "127.0.0.1::3306", "-e", `MYSQL_ROOT_PASSWORD=${pass}`, "-e", "MYSQL_DATABASE=large_it", "-e", "MYSQL_USER=large_it", "-e", `MYSQL_PASSWORD=${pass}`, "mysql:8.0.32"], names[1]!, run, created);
    await runOwnedContainer(["run", "--pull=never", "-d", "--name", names[2]!, "--label", `dataagent.test.run=${run}`, "--tmpfs", "/data:rw,size=64m", "-p", "127.0.0.1::6379", "redis:6.2", "redis-server", "--bind", "0.0.0.0", "--protected-mode", "yes", "--requirepass", pass], names[2]!, run, created);
    const [chPort, mysqlPort, redisPort] = await Promise.all([loopbackPort(names[0]!, 8123), loopbackPort(names[1]!, 3306), loopbackPort(names[2]!, 6379)]);
    const apiPort = await freePort();
    const url = `http://127.0.0.1:${chPort}`; await waitHttp(url); await waitMysql(mysqlPort, pass);
    const ch = createClickHouseClient({ url, username: "default", password: pass, database: "harborlight", maxRowsToRead: 5_000_000, timeoutSeconds: 30 }, false);
    for (const table of WAREHOUSE_TABLES) await clickHouseCommand(ch, createTableSql(table));
    const data = smallWarehouse();
    for (const [table, rows] of Object.entries({ dim_fox_title: data.titles, dim_fox_channel: data.channels, fact_fox_daily_install: data.installs, fact_fox_daily_active: data.active, fact_fox_daily_payment: data.payments, fact_fox_ad_receipt: data.revenue, fact_fox_daily_spend: data.spend, fact_fox_retention_cohort: data.retention, fact_fox_cohort_payback: data.cohortPayback, fact_fox_experiment_arm: data.arms, fact_fox_experiment_metric: data.experimentMetrics })) await clickHouseInsert<unknown>(ch, table, rows);
    // For each day, odd values 1..24999 sum to 156250000 and even
    // values 2..25000 sum to 156262500; four days total 1250050000.
    await clickHouseCommand(ch, largeSyntheticInstallSql());
    await clickHouseCommand(ch, `CREATE USER IF NOT EXISTS fox_reader IDENTIFIED BY '${pass}'`);
    await clickHouseCommand(ch, "GRANT SELECT ON harborlight.* TO fox_reader");
    const knowledgeDir = path.join(dir, "knowledge");
    cpSync(path.join(root, "knowledge", "harborlight"), knowledgeDir, { recursive: true });
    const contractPath = path.join(knowledgeDir, "contracts", "fact_fox_daily_install.json");
    const contract = JSON.parse(readFileSync(contractPath, "utf8"));
    contract.series.coverage_domains = { country_code: { prefix: "S", start: 0, end: 12499 }, channel_id: { values: ["mist_ads", "pebble_net"] } };
    writeFileSync(contractPath, JSON.stringify(contract));
    const freshness = await MysqlFreshnessStore.open({ host: "127.0.0.1", port: mysqlPort, user: "large_it", password: pass, database: "large_it" });
    try {
      const targetsPath = path.join(knowledgeDir, "freshness-targets.json");
      const batch = await freshness.begin(freshnessManifest(loadKnowledge(knowledgeDir), targetsPath));
      const observed = await probeClickHouseFreshness({ targetsPath, query: (sql) => clickHouseQuery(ch, sql) as Promise<Array<{ event_date: string }>> });
      assert.equal(await freshness.publish(batch.version, observed), "published");
    } finally { await freshness.close(); await ch.close(); }
    const env = { PATH: process.env.PATH ?? "", SIMULATED_TODAY: "2026-10-29", HOST: "127.0.0.1", PORT: String(apiPort), STATE_MODE: "mysql", BUSINESS_ENGINE: "clickhouse", KNOWLEDGE_DIR: knowledgeDir, CLICKHOUSE_URL: url, CLICKHOUSE_USER: "fox_reader", CLICKHOUSE_PASSWORD: pass, CLICKHOUSE_DATABASE: "harborlight", FRESHNESS_PATH: path.join(dir, "unused-freshness.json"), DATABASE_PATH: path.join(dir, "unused.sqlite"), RESEED_DATABASE: "false", PUBLISH_FRESHNESS_ON_START: "false", MYSQL_HOST: "127.0.0.1", MYSQL_PORT: String(mysqlPort), MYSQL_USER: "large_it", MYSQL_PASSWORD: pass, MYSQL_DATABASE: "large_it", REDIS_HOST: "127.0.0.1", REDIS_PORT: String(redisPort), REDIS_PASSWORD: pass, REDIS_QUEUE_KEY: `${run}:queue`, MODEL_MODE: "pi", PI_PROVIDER: "openai-compatible", PI_MODEL: "local-protocol", PI_API_KEY: fixtureToken, PI_BASE_URL: fake.url, PI_CONTEXT_WINDOW: "64000", PI_MAX_OUTPUT_TOKENS: "512", PI_REASONING: "off", PI_PROTOCOL_SCRIPT: "happy", RECOVERY_MS: "600", LEASE_MS: "4000", MAX_MODEL_CALLS: "24" };
    for (const file of ["api", "dispatcher", "worker"]) children.push(spawn(process.execPath, ["--import", "tsx", `src/${file}.ts`], { cwd: root, env, stdio: "ignore" }));
    await waitHttp(`http://127.0.0.1:${apiPort}/api/health`);
    const sessionResponse = await fetch(`http://127.0.0.1:${apiPort}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const { session_id: sessionId } = await sessionResponse.json() as { session_id: string }; assert.ok(sessionId);
    const posted = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/${sessionId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "合成十万行渠道日期：查询四天两个渠道的新增。", idempotency_key: randomUUID() }) });
    assert.equal(posted.status, 202); const { job_id: jobId } = await posted.json() as { job_id: string };
    const job = await waitJob(apiPort, jobId);
    assert.ok(job.analysis, JSON.stringify(job));
    assert.equal(job.status, "completed", JSON.stringify(job.analysis));
    assert.match(job.analysis.answer, /1250050000/);
    assert.match(job.analysis.answer, /156250000/);
    assert.match(job.analysis.answer, /156262500/);
    assert.doesNotMatch(job.analysis.answer, /覆盖情况未知/);
    const source = job.analysis.sources.find((item: any) => item.engine === "clickhouse-local"); assert.ok(source);
    assert.match(source.sql, /^WITH /); assert.match(source.executed_sql, /uniqExact/); assert.notEqual(source.sql, source.executed_sql);
    assert.equal(source.freshness_receipts.length, 2); assert.equal(source.total_rows, 8); assert.equal(source.coverage.status, "known");
    assert.equal(job.events.filter((event: any) => ["job_finished", "job_failed", "job_cancelled", "job_timed_out"].includes(event.type)).length, 1);
    const hash = job.analysis.resource_hashes[source.resource_id]; assert.ok(hash);
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/${sessionId}/resources/${source.resource_id}?offset=0&limit=100&resource_hash=${hash}`);
    assert.equal(response.status, 200); const { resource } = await response.json() as { resource: { session_id: string; job_id: string; execution_id: string; rows: Array<{ day: string; channel: string; label: string; total: string | number }> } };
    assert.equal(resource.session_id, sessionId); assert.equal(resource.job_id, jobId); assert.equal(resource.execution_id, source.execution_id);
    const expectedRows = ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"].flatMap((day) => [
      { day, channel: "mist_ads", label: "雾帆", total: "156250000" },
      { day, channel: "pebble_net", label: "卵石", total: "156262500" },
    ]);
    assert.deepEqual(resource.rows.map((row) => ({ ...row, total: String(row.total) })), expectedRows, "四日及两个渠道的全部分组必须各自匹配独立求和");
    const transform = job.analysis.transform_results.find((entry: any) => entry.source_resource_id === source.resource_id); assert.ok(transform);
    const transformHash = job.analysis.resource_hashes[transform.resource_id]; assert.ok(transformHash);
    const transformResponse = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/${sessionId}/resources/${transform.resource_id}?offset=0&limit=100&resource_hash=${transformHash}`);
    assert.equal(transformResponse.status, 200);
    const transformPage = await transformResponse.json() as { resource: { session_id: string; job_id: string; result: { rows: Array<{ all_total: string | number }> } } };
    assert.equal(transformPage.resource.session_id, sessionId); assert.equal(transformPage.resource.job_id, jobId);
    assert.equal(transformPage.resource.result.rows.length, 1);
    assert.equal(String(transformPage.resource.result.rows[0]?.all_total), "1250050000", "持久化变换资源从全部八组合计");
    // Recreate data in the same isolated instance after publication. This is a
    // deliberate new observation: the publication is not a data snapshot.
    const admin = createClickHouseClient({ url, username: "default", password: pass, database: "harborlight", maxRowsToRead: 5_000_000, timeoutSeconds: 30 }, false);
    try {
      const insert = largeSyntheticInstallSql();
      for (const [label, predicate] of [["缺失整个地区渠道组", "NOT (intDiv(number, 8) = 0 AND intDiv(number, 4) % 2 = 0)"], ["缺失一个业务日", "number != 0"], ["小于预算但未覆盖封闭域", "intDiv(number, 8) < 2"]] as const) {
        await clickHouseCommand(admin, "TRUNCATE TABLE fact_fox_daily_install");
        await clickHouseCommand(admin, `${insert} WHERE ${predicate}`);
        const next = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/${sessionId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "合成十万行渠道日期：查询四天两个渠道的新增。", idempotency_key: randomUUID() }) });
        assert.equal(next.status, 202);
        const nextJob = await waitJob(apiPort, (await next.json() as { job_id: string }).job_id);
        assert.notEqual(nextJob.status, "completed", label);
      }
    } finally { await admin.close(); }
    // Invalid closed-domain metadata must not silently fall back to the old
    // detailed proof, even when only 16 matching source rows are observed.
    await Promise.all(children.map(stop)); children.length = 0;
    contract.series.coverage_domains.country_code.end = "not-an-integer";
    writeFileSync(contractPath, JSON.stringify(contract));
    const admin2 = createClickHouseClient({ url, username: "default", password: pass, database: "harborlight", maxRowsToRead: 5_000_000, timeoutSeconds: 30 }, false);
    try {
      await clickHouseCommand(admin2, "TRUNCATE TABLE fact_fox_daily_install");
      await clickHouseInsert(admin2, "fact_fox_daily_install", data.installs);
      await clickHouseCommand(admin2, `${largeSyntheticInstallSql()} WHERE intDiv(number, 8) < 2`);
      const authority = await MysqlFreshnessStore.open({ host: "127.0.0.1", port: mysqlPort, user: "large_it", password: pass, database: "large_it" });
      try {
        const targetsPath = path.join(knowledgeDir, "freshness-targets.json");
        const batch = await authority.begin(freshnessManifest(loadKnowledge(knowledgeDir), targetsPath));
        const observed = await probeClickHouseFreshness({ targetsPath, query: (statement) => clickHouseQuery(admin2, statement) as Promise<Array<{ event_date: string }>> });
        assert.equal(await authority.publish(batch.version, observed), "published");
      } finally { await authority.close(); }
    } finally { await admin2.close(); }
    for (const file of ["api", "dispatcher", "worker"]) children.push(spawn(process.execPath, ["--import", "tsx", `src/${file}.ts`], { cwd: root, env, stdio: "ignore" }));
    await waitHttp(`http://127.0.0.1:${apiPort}/api/health`);
    const createdAgain = await fetch(`http://127.0.0.1:${apiPort}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const secondSession = (await createdAgain.json() as { session_id: string }).session_id;
    const submittedAgain = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/${secondSession}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "合成十万行渠道日期：查询四天两个渠道的新增。", idempotency_key: randomUUID() }) });
    assert.equal(submittedAgain.status, 202);
    const invalid = await waitJob(apiPort, (await submittedAgain.json() as { job_id: string }).job_id);
    assert.notEqual(invalid.status, "completed", "非法封闭域不能因详细元组小于预算变成完成");
    const invalidSource = invalid.analysis?.sources?.find((item: any) => item.engine === "clickhouse-local");
    if (invalidSource) assert.equal(invalidSource.coverage.status, "unknown");

  } finally {
    await Promise.all(children.map(stop));
    for (const name of created.reverse()) await docker(["rm", "-f", name]).catch(() => {});
    await fake.close(); rmSync(dir, { recursive: true, force: true });
  }
});

function freePort() { return new Promise<number>((resolve, reject) => { const server = createServer(); server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => resolve(typeof address === "object" && address ? address.port : 0)); }); server.on("error", reject); }); }
async function waitHttp(url: string) { const deadline = Date.now() + 90_000; while (Date.now() < deadline) { try { const result = await fetch(url); if (result.status < 500) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 250)); } throw new Error("local_http_not_ready"); }
async function waitMysql(port: number, password: string) { const deadline = Date.now() + 90_000; while (Date.now() < deadline) { try { const db = await mysql.createConnection({ host: "127.0.0.1", port, user: "large_it", password, database: "large_it" }); await db.end(); return; } catch {} await new Promise((resolve) => setTimeout(resolve, 400)); } throw new Error("local_mysql_not_ready"); }
function stop(child: ChildProcess) { return new Promise<void>((resolve) => { if (child.exitCode !== null || child.signalCode !== null) return resolve(); child.once("exit", () => resolve()); child.kill("SIGKILL"); }); }
async function waitJob(port: number, id: string): Promise<any> { const deadline = Date.now() + 90_000; while (Date.now() < deadline) { const response = await fetch(`http://127.0.0.1:${port}/api/jobs/${id}`); const job = await response.json() as any; if (!["queued", "running"].includes(job.status)) return job; await new Promise((resolve) => setTimeout(resolve, 150)); } throw new Error("job_timeout"); }
