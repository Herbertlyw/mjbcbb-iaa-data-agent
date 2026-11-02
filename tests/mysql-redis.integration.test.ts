import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { DEMO_QUESTIONS } from "../src/demo.js";
import { MysqlStateStore } from "../src/mysql-state-store.js";
import { AsyncMysqlStateStore } from "../src/async-mysql-state-store.js";
import { MysqlFreshnessStore } from "../src/mysql-freshness.js";
import { RedisJobQueue } from "../src/redis-queue.js";
import { createRuntime } from "../src/runtime.js";
import { freshnessManifest, probeSqliteFreshness } from "../src/freshness.js";
import { bindTables } from "./helpers.js";
import type { AnalysisRecord } from "../src/types.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const password = randomBytes(18).toString("hex");
const database = `lumenfox_it_${process.pid}`;
const user = "lumenfox_it";
const queueKey = `lumenfox:it:${process.pid}:jobs`;
const suffix = randomUUID();
const mysqlName = `lumenfox-it-${suffix}-mysql`;
const redisName = `lumenfox-it-${suffix}-redis`;

test("隔离的 MySQL 与 Redis 分进程：权威状态、outbox、围栏和恢复", async () => {
  await assertLocalImages();
  const mysqlPort = await freePort();
  const redisPort = await freePort();
  const apiPort = await freePort();
  const dir = mkdtempSync(path.join(tmpdir(), "lumenfox-it-"));
  const databasePath = path.join(dir, "business.sqlite");
  const freshnessPath = path.join(dir, "freshness.json");
  const seeded = createRuntime({
    databasePath,
    stateDatabasePath: path.join(dir, "unused-state.sqlite"),
    freshnessPath,
    startWorker: false,
    ephemeralDir: undefined,
    stateMode: "sqlite",
  });
  await seeded.close();
  const children: ChildProcess[] = [];
  const store = () => new MysqlStateStore({ host: "127.0.0.1", port: mysqlPort, user, password, database });
  let mysqlCreated = false;
  let redisCreated = false;
  try {
    await runQuiet("docker", ["run", "--pull=never", "-d", "--name", mysqlName, "--tmpfs", "/var/lib/mysql:rw,size=1g", "-p", `127.0.0.1:${mysqlPort}:3306`, "-e", `MYSQL_ROOT_PASSWORD=${password}`, "-e", `MYSQL_DATABASE=${database}`, "-e", `MYSQL_USER=${user}`, "-e", `MYSQL_PASSWORD=${password}`, "mysql:8.0.32", "--bind-address=0.0.0.0", "--skip-log-bin"], password);
    mysqlCreated = true;
    await runQuiet("docker", ["run", "--pull=never", "-d", "--name", redisName, "--tmpfs", "/data:rw,size=64m", "-p", `127.0.0.1:${redisPort}:6379`, "redis:6.2", "redis-server", "--bind", "0.0.0.0", "--protected-mode", "yes", "--requirepass", password], password);
    redisCreated = true;
    await waitForMysql(mysqlPort);
    await waitForRedis(redisPort);
    const authority = store();
    const freshnessA = await MysqlFreshnessStore.open({ host: "127.0.0.1", port: mysqlPort, user, password, database });
    const freshnessB = await MysqlFreshnessStore.open({ host: "127.0.0.1", port: mysqlPort, user, password, database });
    try {
      const manifest = { registry_revision: "synthetic-r1", target_hash: "a".repeat(64), contract_hashes: { sample: "b".repeat(64) }, target_tables: ["sample"] };
      const observation = (status: "fresh" | "probe_failed") => ({ source: "synthetic", engine: "clickhouse-local", valid_until: "2027-01-01", unimplemented_engines: [], tables: { sample: { status, as_of: null } } });
      assert.equal(await freshnessA.current(), null);
      const firstBatch = await freshnessA.begin(manifest);
      assert.equal(await freshnessA.publish(firstBatch.version, observation("fresh")), "published");
      const older = await freshnessA.begin(manifest);
      const newer = await freshnessB.begin(manifest);
      await assert.rejects(() => freshnessB.publish(newer.version, { ...observation("fresh"), tables: {} }), /freshness_batch_incomplete/);
      assert.equal((await freshnessA.current())?.version, firstBatch.version);
      assert.equal(await freshnessB.publish(newer.version, observation("probe_failed")), "published");
      assert.equal(await freshnessA.publish(older.version, observation("fresh")), "superseded");
      assert.equal((await freshnessA.current())?.tables.sample?.status, "probe_failed");
      assert.equal((await freshnessB.get(firstBatch.version))?.tables.sample?.status, "fresh");
      const abandoned = await freshnessA.begin(manifest);
      assert.ok(abandoned.version > newer.version);
      assert.equal((await freshnessB.current())?.version, newer.version, "未发布批次不可见");
      const publisherEnv = isolatedEnv({ mysqlPort, redisPort, apiPort, databasePath, freshnessPath, recoveryMs: "60000" });
      const startPublisher = () => spawn(process.execPath, ["--import", "tsx", "tests/freshness-publisher-child.ts"], { cwd: root, env: publisherEnv, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      const processA = startPublisher();
      const processB = startPublisher();
      children.push(processA, processB);
      const waitMessage = (child: ChildProcess) => new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("freshness publisher timeout")), 10000);
        child.once("message", (message) => { clearTimeout(timer); resolve(message as Record<string, unknown>); });
        child.once("error", reject);
      });
      assert.equal((await Promise.all([waitMessage(processA), waitMessage(processB)])).every((message) => message.ready === true), true);
      const beginA = waitMessage(processA); processA.send({ action: "begin", manifest });
      const versionA = Number(((await beginA).batch as { version: number }).version);
      const beginB = waitMessage(processB); processB.send({ action: "begin", manifest });
      const versionB = Number(((await beginB).batch as { version: number }).version);
      assert.ok(versionB > versionA);
      const publishB = waitMessage(processB); processB.send({ action: "publish", version: versionB, observation: observation("probe_failed") });
      assert.equal((await publishB).result, "published");
      const publishA = waitMessage(processA); processA.send({ action: "publish", version: versionA, observation: observation("fresh") });
      assert.equal((await publishA).result, "superseded");
      assert.equal((await freshnessA.current())?.version, versionB);
      const closeA = waitMessage(processA); processA.send({ action: "close" });
      const closeB = waitMessage(processB); processB.send({ action: "close" });
      await Promise.all([closeA, closeB]);
      const timeoutFreshness = await MysqlFreshnessStore.open({ host: "127.0.0.1", port: mysqlPort, user, password, database }, 500);
      const lockConnection = await mysql.createConnection({ host: "127.0.0.1", port: mysqlPort, user, password, database });
      try {
        const uncertain = await timeoutFreshness.begin(manifest);
        await lockConnection.beginTransaction();
        await lockConnection.query("SELECT version FROM freshness_pointer WHERE singleton = 1 FOR UPDATE");
        const pending = timeoutFreshness.publish(uncertain.version, observation("fresh"));
        await assert.rejects(() => pending, /freshness_state_outcome_unknown/);
        await lockConnection.commit();
        let observedVersion = 0;
        for (let attempt = 0; attempt < 40 && observedVersion !== uncertain.version; attempt += 1) {
          await delay(50);
          observedVersion = (await freshnessA.current())?.version ?? 0;
        }
        assert.equal(observedVersion, uncertain.version, "发布超时不证明事务未提交");
      } finally {
        await lockConnection.rollback().catch(() => undefined);
        await lockConnection.end();
        await timeoutFreshness.close();
      }
      const actualManifest = freshnessManifest(seeded.knowledge, seeded.config.freshnessTargetsPath);
      const probeObservation = () => probeSqliteFreshness({ databasePath, targetsPath: seeded.config.freshnessTargetsPath });
      const checkRuntime = createRuntime({ stateMode: "mysql", mysqlHost: "127.0.0.1", mysqlPort, mysqlUser: user, mysqlPassword: password, mysqlDatabase: database, redisHost: "127.0.0.1", redisPort, databasePath, freshnessPath, reseedDatabase: false, publishFreshnessOnStart: false, startWorker: false, ephemeralDir: undefined, queryLatencyMs: 1000 });
      try {
        const session = checkRuntime.sessions.create("analyst");
        await bindTables(checkRuntime, session.session_id, ["contract.daily_installs"]);
        checkRuntime.sessions.setActiveJob(session.session_id, "job_freshness_test");
        const sql = "SELECT event_date, new_users FROM daily_installs WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-12'";
        const before = await checkRuntime.tools.query(session.session_id, { sql });
        assert.equal(before.ok, false);
        if (!before.ok) assert.equal(before.code, "freshness_manifest_changed", "旧文件和不匹配的数据库版本都不能冒充当前权威状态");
        assert.equal((await checkRuntime.freshnessHealth()).status, "manifest_changed");
        const actualBatch = await freshnessA.begin(actualManifest);
        assert.equal(await freshnessA.publish(actualBatch.version, probeObservation()), "published");
        assert.equal((await checkRuntime.freshnessHealth()).status, "published");
        await runQuiet("docker", ["pause", mysqlName], password);
        try {
          const beforeHealth = Date.now();
          assert.equal((await checkRuntime.freshnessHealth()).status, "unavailable");
          assert.ok(Date.now() - beforeHealth < 15000, "权威库暂停时健康检查必须有限时返回");
        } finally { await runQuiet("docker", ["unpause", mysqlName], password); }
        let recoveredHealth = "unavailable";
        for (let attempt = 0; attempt < 10 && recoveredHealth !== "published"; attempt += 1) {
          await delay(200);
          recoveredHealth = (await checkRuntime.freshnessHealth()).status;
        }
        assert.equal(recoveredHealth, "published");
        const duringQuery = checkRuntime.tools.query(session.session_id, { sql });
        await delay(300);
        const changedBatch = await freshnessB.begin(actualManifest);
        assert.equal(await freshnessB.publish(changedBatch.version, probeObservation()), "published");
        const changed = await duringQuery;
        assert.equal(changed.ok, false);
        if (!changed.ok) assert.equal(changed.code, "freshness_version_changed");
        const query = await checkRuntime.tools.query(session.session_id, { sql });
        assert.equal(query.ok, true);
        if (query.ok) {
          const calc = await checkRuntime.tools.calculateSessionCells(session.session_id, { resource_id: String(query.resource_id), operations: [{ op: "sum", column: "new_users", as: "total" }] });
          assert.equal(calc.ok, true);
          if (calc.ok) {
            const afterQuery = await freshnessA.begin(actualManifest);
            assert.equal(await freshnessA.publish(afterQuery.version, probeObservation()), "published");
            const delivery = await checkRuntime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(query.resource_id), String(calc.resource_id)] });
            assert.equal(delivery.ok, true);
            if (delivery.ok) assert.ok((delivery.server_reasons as string[]).includes("freshness_version_changed"));
          }
        }
        // The candidate has already passed the service check. Publish between
        // that check and finish to exercise the transactional delivery barrier.
        const finishJob = authority.createJob({
          job: fakeJob(session.session_id, "终态前发布", `fresh-finish-${randomUUID()}`),
          session,
          message: { message_id: `msg_${randomUUID()}`, session_id: session.session_id, job_id: "pending", role: "user", text: "终态前发布", created_at: new Date().toISOString() },
        });
        const finishClaim = authority.claimJob(finishJob.job_id, "fresh-finish-owner", Date.now(), 15000);
        assert.ok(finishClaim);
        checkRuntime.sessions.setActiveJob(session.session_id, finishJob.job_id, { owner: finishClaim.owner, fence: finishClaim.fence });
        const finishQuery = await checkRuntime.tools.query(session.session_id, { sql });
        assert.equal(finishQuery.ok, true);
        if (!finishQuery.ok) throw new Error("freshness test query failed");
        const finishCalc = await checkRuntime.tools.calculateSessionCells(session.session_id, { resource_id: String(finishQuery.resource_id), operations: [{ op: "sum", column: "new_users", as: "total" }] });
        assert.equal(finishCalc.ok, true);
        if (!finishCalc.ok) throw new Error("freshness test calculation failed");
        const candidate = await checkRuntime.tools.updateAnalysis(session.session_id, { suggested_status: "completed", draft_answer: "", resource_ids: [String(finishQuery.resource_id), String(finishCalc.resource_id)] });
        assert.equal(candidate.ok, true);
        if (!candidate.ok) throw new Error("freshness test candidate failed");
        const candidateRecord = candidate as unknown as AnalysisRecord;
        assert.ok(candidateRecord.sources.some((source) => source.evidence_eligible));
        const beforeFinish = await freshnessB.begin(actualManifest);
        assert.equal(await freshnessB.publish(beforeFinish.version, probeObservation()), "published");
        assert.equal(authority.finish(finishJob.job_id, finishClaim.owner, finishClaim.fence, candidateRecord.status, candidateRecord, null), true);
        const finished = authority.getJob(finishJob.job_id);
        assert.equal(finished?.status, "failed");
        assert.equal(finished?.error?.code, "freshness_version_changed");
        assert.equal(finished?.analysis, null);
        assert.equal(finished?.events.filter((event) => event.type === "job_failed").length, 1);
        const failedJob = authority.createJob({
          job: fakeJob(session.session_id, "失败后候选", `failed-candidate-${randomUUID()}`),
          session,
          message: { message_id: `msg_${randomUUID()}`, session_id: session.session_id, job_id: "pending", role: "user", text: "失败后候选", created_at: new Date().toISOString() },
        });
        const failedClaim = authority.claimJob(failedJob.job_id, "failed-candidate-owner", Date.now(), 5000);
        assert.ok(failedClaim);
        assert.equal(authority.finish(failedJob.job_id, failedClaim.owner, failedClaim.fence, "failed", candidateRecord, { code: "synthetic_failure", message: "合成失败" }), true);
        assert.equal(authority.getJob(failedJob.job_id)?.analysis, null, "失败终态不能保存候选为正式答案");
        checkRuntime.sessions.setActiveJob(session.session_id, undefined);
      } finally { await checkRuntime.close(); }
      const versionBeforeProbe = (await freshnessB.current())?.version ?? 0;
      const probe = startRole("src/freshness-probe.ts", isolatedEnv({ mysqlPort, redisPort, apiPort, databasePath, freshnessPath, recoveryMs: "60000" }));
      children.push(probe);
      const probeExit = await new Promise<number | null>((resolve, reject) => {
        probe.once("error", reject);
        probe.once("exit", (code) => resolve(code));
      });
      assert.equal(probeExit, 0, "独立 freshness 进程应发布 MySQL 新版本");
      assert.ok(((await freshnessA.current())?.version ?? 0) > versionBeforeProbe);
    } finally {
      await freshnessA.close();
      await freshnessB.close();
    }
    const delayProbeSession = authority.createSession({ session_id: `ses_${randomUUID()}`, title: "延迟探针", role: "analyst", actor_id: "demo-analyst", created_at: new Date().toISOString(), slots: null, bindings: [] });
    const delayConnection = await mysql.createConnection({ host: "127.0.0.1", port: mysqlPort, user, password, database });
    const asyncAuthority = await AsyncMysqlStateStore.open({ host: "127.0.0.1", port: mysqlPort, user, password, database }, 5000);
    const shortTimeoutAuthority = await AsyncMysqlStateStore.open({ host: "127.0.0.1", port: mysqlPort, user, password, database }, 100);
    try {
      await delayConnection.query("CREATE TRIGGER test_session_delay BEFORE UPDATE ON sessions FOR EACH ROW DO SLEEP(0.35)");
      let timerFired = false;
      const timer = setTimeout(() => { timerFired = true; }, 40);
      const before = Date.now();
      authority.saveSession({ ...delayProbeSession, title: "探针完成" });
      const elapsed = Date.now() - before;
      assert.ok(elapsed >= 300);
      assert.equal(timerFired, false, "同步桥接调用期间 Node 定时器不能运行");
      await delay(10);
      assert.equal(timerFired, true);
      clearTimeout(timer);
      let asyncTimerFired = false;
      const asyncTimer = setTimeout(() => { asyncTimerFired = true; }, 40);
      const asyncStart = Date.now();
      await asyncAuthority.call("saveSession", { ...delayProbeSession, title: "异步探针" });
      assert.ok(Date.now() - asyncStart >= 300);
      assert.equal(asyncTimerFired, true, "异步桥接等待期间定时器应继续运行");
      clearTimeout(asyncTimer);
      await assert.rejects(() => shortTimeoutAuthority.call("saveSession", { ...delayProbeSession, title: "超时结果未知" }), /mysql_state_outcome_unknown/);
      await delay(500);
      assert.equal((await asyncAuthority.call("getSession", delayProbeSession.session_id))?.title, "超时结果未知", "超时不能被当成数据库回滚");
      const lockJob = authority.createJob({
        job: fakeJob(delayProbeSession.session_id, "租约锁等待", "lease-lock"),
        session: delayProbeSession,
        message: { message_id: `msg_${randomUUID()}`, session_id: delayProbeSession.session_id, job_id: "pending", role: "user", text: "租约锁等待", created_at: new Date().toISOString() },
      });
      const lockClaim = authority.claimJob(lockJob.job_id, "lock-owner", Date.now(), 1200);
      assert.ok(lockClaim);
      await delayConnection.beginTransaction();
      await delayConnection.query("SELECT job_id FROM jobs WHERE job_id = ? FOR UPDATE", [lockJob.job_id]);
      const waitingHeartbeat = asyncAuthority.call("heartbeat", lockJob.job_id, lockClaim.owner, lockClaim.fence, Date.now(), 5000);
      await delay(1600);
      await delayConnection.commit();
      assert.equal((await waitingHeartbeat).ok, false, "等待锁期间租约过期后不能复活");
      const lockRecovery = authority.claimJob(lockJob.job_id, "lock-recovery", Date.now(), 5000);
      assert.ok(lockRecovery);
      assert.equal(authority.finish(lockJob.job_id, lockRecovery.owner, lockRecovery.fence, "failed", null, { code: "synthetic_done", message: "测试完成" }), true);
    } finally {
      await asyncAuthority.close();
      await shortTimeoutAuthority.close();
      await delayConnection.query("DROP TRIGGER IF EXISTS test_session_delay");
      await delayConnection.end();
    }
    // Exercise the real Pi worker path while a progress snapshot holds a MySQL
    // row lock. The timer must fire while the server-side trigger is asleep.
    const snapshotDb = await mysql.createConnection({ host: "127.0.0.1", port: mysqlPort, user, password, database });
    const slowRuntime = createRuntime({ stateMode: "mysql", mysqlHost: "127.0.0.1", mysqlPort, mysqlUser: user, mysqlPassword: password, mysqlDatabase: database, redisHost: "127.0.0.1", redisPort, databasePath, freshnessPath, reseedDatabase: false, publishFreshnessOnStart: false, startWorker: false, ephemeralDir: undefined, modelMode: "pi", piProvider: "faux", leaseMs: 10000, heartbeatMs: 400 });
    let slowRun: Promise<void> | undefined;
    try {
      await snapshotDb.query("CREATE TRIGGER test_slow_snapshot BEFORE INSERT ON agent_snapshots FOR EACH ROW DO SLEEP(0.7)");
      const session = slowRuntime.sessions.create("analyst");
      const job = slowRuntime.jobs.submit(session.session_id, "合成问题：看看收入", `slow-snapshot-${randomUUID()}`);
      const state = await slowRuntime.mysqlAsyncState();
      const claim = await state.call("claimJob", job.job_id, slowRuntime.jobs.workerOwner, Date.now(), 10000);
      assert.ok(claim);
      slowRun = slowRuntime.jobs.runClaimed(claim);
      let sleeping = false;
      for (let attempt = 0; attempt < 100 && !sleeping; attempt += 1) {
        const [rows] = await snapshotDb.query("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE USER = ? AND STATE = 'User sleep'", [user]);
        sleeping = Number((rows as Array<{ n: number }>)[0]?.n ?? 0) > 0;
        if (!sleeping) await delay(20);
      }
      assert.equal(sleeping, true, "未观察到隔离 MySQL 的慢快照屏障");
      const start = Date.now();
      await delay(80);
      assert.ok(Date.now() - start < 500, "快照写入等待期间 worker 定时器应继续运行");
      await slowRun;
      const result = await state.call("getJob", job.job_id);
      assert.ok(result && ["needs_clarification", "partial", "completed"].includes(result.status), JSON.stringify(result?.error));
      assert.equal(result.events.filter((event) => event.type === "job_finished").length, 1);
      assert.deepEqual(result.events.map((event) => event.seq), result.events.map((_, index) => index + 1));
      const resourceSession = slowRuntime.sessions.create("analyst");
      const resourceJob = slowRuntime.jobs.submit(resourceSession.session_id, "合成查询", `slow-resource-${randomUUID()}`);
      const resourceClaim = await state.call("claimJob", resourceJob.job_id, slowRuntime.jobs.workerOwner, Date.now(), 10000);
      assert.ok(resourceClaim);
      slowRuntime.sessions.setActiveJob(resourceSession.session_id, resourceJob.job_id, { owner: resourceClaim.owner, fence: resourceClaim.fence });
      await bindTables(slowRuntime, resourceSession.session_id, ["contract.daily_installs"]);
      await snapshotDb.query("CREATE TRIGGER test_slow_resource BEFORE INSERT ON resources FOR EACH ROW DO SLEEP(0.7)");
      const query = slowRuntime.tools.query(resourceSession.session_id, { sql: "SELECT event_date, new_users FROM daily_installs WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-06' AND product_id = 'starlane_drift' AND platform = 'ios' AND country_code = 'US' AND channel = 'nebula_ads'" });
      let resourceSleeping = false;
      for (let attempt = 0; attempt < 100 && !resourceSleeping; attempt += 1) {
        const [rows] = await snapshotDb.query("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE USER = ? AND STATE = 'User sleep'", [user]);
        resourceSleeping = Number((rows as Array<{ n: number }>)[0]?.n ?? 0) > 0;
        if (!resourceSleeping) await delay(20);
      }
      assert.equal(resourceSleeping, true, "未观察到隔离 MySQL 的慢资源写入");
      const resourceStart = Date.now();
      await delay(80);
      assert.ok(Date.now() - resourceStart < 500, "工具资源写入不能冻结 worker 定时器");
      const queryResult = await query;
      assert.equal(queryResult.ok, true, JSON.stringify(queryResult));
      if (queryResult.ok) {
        const saved = await state.call("getResource", String(queryResult.resource_id));
        assert.equal(saved?.job_id, resourceJob.job_id);
        assert.equal(saved?.session_id, resourceSession.session_id);
      }
      assert.equal(await state.call("finish", resourceJob.job_id, resourceClaim.owner, resourceClaim.fence, "failed", null, { code: "synthetic_done", message: "测试完成" }), true);
      slowRuntime.sessions.setActiveJob(resourceSession.session_id, undefined);
    } finally {
      await slowRun?.catch(() => undefined);
      await slowRuntime.close({ abandon: true });
      await snapshotDb.query("DROP TRIGGER IF EXISTS test_slow_resource");
      await snapshotDb.query("DROP TRIGGER IF EXISTS test_slow_snapshot");
      await snapshotDb.end();
    }
    const baseEnv = isolatedEnv({ mysqlPort, redisPort, apiPort, databasePath, freshnessPath, recoveryMs: "60000" });
    const api = startRole("src/api.ts", baseEnv);
    children.push(api);
    await waitForHealth(apiPort);
    // A sleeping database write must not freeze unrelated requests or the
    // same API process's SSE pump. All ports and this trigger belong to this test.
    const slowApiSession = await postSession(apiPort);
    const slowApiJob = await postJob(apiPort, slowApiSession.session_id, "合成慢数据库测试", `slow-api-${randomUUID()}`);
    const eventStream = await fetch(`http://127.0.0.1:${apiPort}/api/jobs/${slowApiJob.job_id}/events?after=0`);
    assert.equal(eventStream.status, 200);
    const slowApiDb = await mysql.createConnection({ host: "127.0.0.1", port: mysqlPort, user, password, database });
    try {
      await slowApiDb.query("CREATE TRIGGER test_api_session_delay BEFORE INSERT ON sessions FOR EACH ROW DO SLEEP(1.2)");
      const slowStarted = Date.now();
      const slowSession = postSession(apiPort);
      await delay(250);
      const fastStarted = Date.now();
      const [demo, cancel] = await Promise.all([
        fetch(`http://127.0.0.1:${apiPort}/api/demo`),
        fetch(`http://127.0.0.1:${apiPort}/api/jobs/${slowApiJob.job_id}/cancel`, { method: "POST" }),
      ]);
      assert.equal(demo.status, 200);
      assert.equal(cancel.status, 200);
      assert.ok(Date.now() - fastStarted < 900, "1.2 秒慢写期间，独立请求和取消应能完成（容忍调度抖动）");
      const events = await eventStream.text();
      assert.match(events, /job_cancelled/);
      assert.equal((events.match(/job_cancelled/g) ?? []).length, 1);
      await slowSession;
      assert.ok(Date.now() - slowStarted >= 1100, "测试必须确实经过受控数据库延迟");
    } finally {
      await slowApiDb.query("DROP TRIGGER IF EXISTS test_api_session_delay");
      await slowApiDb.end();
    }
    const worker = startRole("src/worker.ts", baseEnv);
    const dispatcher = startRole("src/dispatcher.ts", baseEnv);
    children.push(worker, dispatcher);
    const japan = DEMO_QUESTIONS.find((item) => item.id === "japan")?.text ?? "";
    const created = await postSession(apiPort);
    const first = await postJob(apiPort, created.session_id, japan, "same-key");
    const replay = await postJob(apiPort, created.session_id, japan, "same-key");
    assert.equal(replay.job_id, first.job_id);
    const conflict = await postJob(apiPort, created.session_id, "完全不同的问题", "same-key", true);
    assert.equal(conflict.status, 409);
    const done = await waitJob(authority, first.job_id);
    assert.equal(done.status, "partial", JSON.stringify(done.error));
    assert.equal(done.events.filter((event) => event.type === "job_finished").length, 1);
    assert.deepEqual(done.events.map((event) => event.seq), done.events.map((_, index) => index + 1));
    const httpJob = await getJob(apiPort, first.job_id);
    assert.equal(httpJob.status, done.status);
    assert.equal(httpJob.events.length, done.events.length);
    const pending = authority.listPendingOutbox(10).filter((item) => item.job_id === first.job_id);
    assert.equal(pending.length, 0);
    assert.equal(authority.listJobs(created.session_id).length, 1);

    await stopProcess(api);
    const apiAgain = startRole("src/api.ts", baseEnv);
    children.push(apiAgain);
    await waitForHealth(apiPort);
    const afterRestart = await getJob(apiPort, first.job_id);
    assert.equal(afterRestart.job_id, first.job_id);
    assert.equal(afterRestart.events[0]?.type, "job_queued");
    const hidden = await fetch(`http://127.0.0.1:${apiPort}/api/sessions/${created.session_id}`, { headers: { "x-demo-actor": "demo-viewer" } });
    assert.equal(hidden.status, 404);
    const resumed = await fetch(`http://127.0.0.1:${apiPort}/api/jobs/${first.job_id}/events?after=1`);
    const text = await readSome(resumed);
    assert.match(text, /job_finished/);
    assert.doesNotMatch(text, /"seq":1[,}]/);

    const slowSession = await postSession(apiPort);
    await stopProcess(dispatcher);
    const queuedOnly = await postJob(apiPort, slowSession.session_id, japan, "before-dispatch");
    await delay(700);
    assert.equal(authority.getJob(queuedOnly.job_id)?.status, "queued");
    assert.equal(authority.listPendingOutbox(20).some((item) => item.job_id === queuedOnly.job_id), true);
    const dispatcherAgain = startRole("src/dispatcher.ts", baseEnv);
    children.push(dispatcherAgain);
    const recoveredDispatch = await waitJob(authority, queuedOnly.job_id);
    assert.equal(recoveredDispatch.status, "partial");
    assert.equal(recoveredDispatch.events.filter((event) => ["job_finished", "job_failed", "job_cancelled"].includes(event.type)).length, 1);

    await stopProcess(worker);
    await stopProcess(dispatcherAgain);
    const duplicateSession = await postSession(apiPort);
    const duplicate = await postJob(apiPort, duplicateSession.session_id, japan, "duplicate-dispatch");
    const pendingDuplicate = authority.listPendingOutbox(20).find((item) => item.job_id === duplicate.job_id);
    assert.ok(pendingDuplicate);
    const queue = new RedisJobQueue({ host: "127.0.0.1", port: redisPort, password, queueKey });
    await queue.publish({ job_id: duplicate.job_id, outbox_id: pendingDuplicate?.outbox_id ?? 0 });
    await queue.publish({ job_id: duplicate.job_id, outbox_id: pendingDuplicate?.outbox_id ?? 0 });
    const duplicateWorker = startRole("src/worker.ts", baseEnv);
    children.push(duplicateWorker);
    const duplicated = await waitJob(authority, duplicate.job_id);
    assert.equal(duplicated.status, "partial");
    assert.equal(duplicated.events.filter((event) => event.type === "job_finished").length, 1);
    await queue.close();
    await stopProcess(duplicateWorker);

    const lostSession = await postSession(apiPort);
    const lost = await postJob(apiPort, lostSession.session_id, japan, "lost-redis");
    await delay(400);
    assert.equal(authority.getJob(lost.job_id)?.status, "queued");
    assert.equal(authority.listPendingOutbox(20).some((item) => item.job_id === lost.job_id), true);
    const recoveryEnv = isolatedEnv({ mysqlPort, redisPort, apiPort, databasePath, freshnessPath, recoveryMs: "400" });
    const recoveryWorker = startRole("src/worker.ts", recoveryEnv);
    children.push(recoveryWorker);
    const recoveredWithoutRedis = await waitJob(authority, lost.job_id);
    assert.equal(recoveredWithoutRedis.status, "partial");
    assert.equal(recoveredWithoutRedis.events.filter((event) => event.type === "job_finished").length, 1);
    assert.equal(authority.listPendingOutbox(20).some((item) => item.job_id === lost.job_id), true);
    await stopProcess(recoveryWorker);

    const fenceSession = authority.createSession({
      session_id: `ses_${randomUUID()}`,
      title: "围栏",
      role: "analyst",
      actor_id: "demo-analyst",
      created_at: new Date().toISOString(),
      slots: null,
      bindings: [],
    });
    const fenceJob = authority.createJob({
      job: fakeJob(fenceSession.session_id, "围栏任务", "fence-key"),
      session: fenceSession,
      message: { message_id: `msg_${randomUUID()}`, session_id: fenceSession.session_id, job_id: "pending", role: "user", text: "围栏任务", created_at: new Date().toISOString() },
    });
    const other = store();
    const claims = await Promise.all([
      Promise.resolve().then(() => authority.claimNext("owner-a", Date.now(), 5_000)),
      Promise.resolve().then(() => other.claimNext("owner-b", Date.now(), 5_000)),
    ]);
    const winner = claims.find((claim) => claim && claim.job.job_id === fenceJob.job_id);
    assert.equal(claims.filter((claim) => claim !== null).length, 1);
    assert.ok(winner);
    if (!winner) return;
    assert.equal(other.claimJob(fenceJob.job_id, "clock-skew-worker", Date.now() + 86_400_000, 5000), null, "客户端未来时钟不能抢走有效租约");
    const oldLease = { jobId: fenceJob.job_id, owner: winner.owner, fence: winner.fence };
    assert.equal(authority.reserveToolCall(fenceSession.session_id, oldLease, 1), "ok");
    const fencedResource = {
      resource_id: `res_${randomUUID()}`, session_id: fenceSession.session_id, job_id: fenceJob.job_id,
      kind: "calculation" as const, created_at: new Date().toISOString(), source_resource_id: "res_synthetic",
      cells: {}, input_truncated: false, complete_population: true, null_means: "missing" as const,
      zero_means: "observed_zero" as const, predicted_means: "forecast_not_actual" as const, notes: [],
    };
    authority.saveResource(fencedResource, oldLease);
    authority.expireLease(fenceJob.job_id);
    assert.equal(authority.heartbeat(fenceJob.job_id, winner.owner, winner.fence, Date.now() - 86_400_000, 172_800_000).ok, false, "过期租约不能借客户端旧时钟复活");
    assert.throws(() => authority.saveSession({ ...fenceSession, title: "stale" }, oldLease), /execution_fence_rejected/);
    assert.throws(() => authority.saveResource(fencedResource, oldLease), /execution_fence_rejected/);
    assert.equal(authority.appendEvent(fenceJob.job_id, winner.owner, winner.fence, "tool_finished", {}), null);
    assert.equal(authority.heartbeat(fenceJob.job_id, winner.owner, winner.fence, Date.now(), 5000).ok, false);
    assert.equal(authority.reserveRevision(fenceJob.job_id, winner.owner, winner.fence).ok, false);
    assert.equal(authority.reserveToolCall(fenceSession.session_id, oldLease, 1), "lost");
    assert.equal(authority.saveAgentSnapshot({ sessionId: fenceSession.session_id, jobId: fenceJob.job_id, owner: winner.owner, fence: winner.fence, kind: "progress", body: {} }), false);
    const second = other.claimJob(fenceJob.job_id, "owner-b", Date.now(), 5_000);
    assert.ok(second);
    if (!second) return;
    assert.notEqual(second.fence, winner.fence);
    assert.equal(other.reserveToolCall(fenceSession.session_id, { jobId: fenceJob.job_id, owner: second.owner, fence: second.fence }, 20), "budget_exhausted");
    assert.throws(() => authority.saveResource(fencedResource, oldLease), /execution_fence_rejected/);
    other.saveSession({ ...fenceSession, title: "current" }, { jobId: fenceJob.job_id, owner: second.owner, fence: second.fence });
    assert.equal(other.getSession(fenceSession.session_id)?.title, "current");
    assert.equal(authority.appendEvent(fenceJob.job_id, winner.owner, winner.fence, "tool_finished", { late: true }), null);
    assert.equal(authority.finish(fenceJob.job_id, winner.owner, winner.fence, "completed", null, null), false);
    assert.equal(other.finish(fenceJob.job_id, second.owner, second.fence, "failed", null, { code: "recovered", message: "新执行者收口" }), true);
    const fenced = authority.getJob(fenceJob.job_id);
    assert.equal(fenced?.status, "failed");
    assert.equal(fenced?.events.filter((event) => event.type === "job_failed" || event.type === "job_finished").length, 1);

    const cancelSession = authority.createSession({
      session_id: `ses_${randomUUID()}`,
      title: "取消",
      role: "analyst",
      actor_id: "demo-analyst",
      created_at: new Date().toISOString(),
      slots: null,
      bindings: [],
    });
    const cancelJob = authority.createJob({
      job: fakeJob(cancelSession.session_id, "取消竞争", "cancel-key"),
      session: cancelSession,
      message: { message_id: `msg_${randomUUID()}`, session_id: cancelSession.session_id, job_id: "pending", role: "user", text: "取消竞争", created_at: new Date().toISOString() },
    });
    const claimed = authority.claimJob(cancelJob.job_id, "owner-cancel", Date.now(), 5_000);
    assert.ok(claimed);
    if (!claimed) return;
    authority.requestCancel(cancelJob.job_id);
    assert.equal(authority.finish(cancelJob.job_id, claimed.owner, claimed.fence, "completed", null, null), true);
    const cancelled = authority.getJob(cancelJob.job_id);
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(cancelled?.events.filter((event) => event.type === "job_finished" || event.type === "job_cancelled").length, 1);
    authority.close();
    other.close();
  } finally {
    for (const child of children) await stopProcess(child);
    if (mysqlCreated) await runQuiet("docker", ["rm", "-f", mysqlName], password).catch(() => undefined);
    if (redisCreated) await runQuiet("docker", ["rm", "-f", redisName], password).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeJob(sessionId: string, text: string, key: string) {
  return {
    job_id: `job_${randomUUID()}`,
    session_id: sessionId,
    status: "queued" as const,
    user_text: text,
    idempotency_key: key,
    turn: {
      kind: "new_question" as const,
      intent: "performance" as const,
      raw_text: text,
      slots: { game: "starlane_drift" as const, metrics: [] },
      inherited: [],
      replaced: [],
      missing_slots: [],
      search_query: "",
      read_asset_ids: [],
      contract_asset_ids: [],
      clarification_question: null,
    },
    events: [],
    next_seq: 2,
    version: 1,
    analysis: null,
    error: null,
    abort_reason: null,
    fence: 0,
    lease_owner: null,
    lease_until: null,
    cancel_requested: false,
    simulated: true as const,
    created_at: new Date().toISOString(),
  };
}

function isolatedEnv(input: { mysqlPort: number; redisPort: number; apiPort: number; databasePath: string; freshnessPath: string; recoveryMs: string }) {
  return {
    PATH: process.env.PATH ?? "",
    SIMULATED_TODAY: "2026-10-29",
    HOST: "127.0.0.1",
    PORT: String(input.apiPort),
    STATE_MODE: "mysql",
    RESEED_DATABASE: "false",
    PUBLISH_FRESHNESS_ON_START: "false",
    DATABASE_PATH: input.databasePath,
    FRESHNESS_PATH: input.freshnessPath,
    MYSQL_HOST: "127.0.0.1",
    MYSQL_PORT: String(input.mysqlPort),
    MYSQL_USER: user,
    MYSQL_PASSWORD: password,
    MYSQL_DATABASE: database,
    REDIS_HOST: "127.0.0.1",
    REDIS_PORT: String(input.redisPort),
    REDIS_PASSWORD: password,
    REDIS_QUEUE_KEY: queueKey,
    RECOVERY_MS: input.recoveryMs,
    DISPATCHER_POLL_MS: "100",
    LEASE_MS: "5000",
    HEARTBEAT_MS: "200",
    MODEL_MODE: "deterministic",
  };
}

function startRole(script: string, env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", () => undefined);
  return child;
}

async function waitJob(store: MysqlStateStore, jobId: string) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    const job = store.getJob(jobId);
    if (job && !["queued", "running"].includes(job.status)) return job;
    await delay(50);
  }
  const last = store.getJob(jobId);
  throw new Error(`任务没有在 MySQL 中结束：${last?.status ?? "missing"}；事件类型：${last?.events.map((event) => event.type).join(",") ?? "none"}`);
}

async function postSession(port: number) {
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-demo-actor": "demo-analyst" },
    body: JSON.stringify({ userId: "root", role: "viewer", title: "隔离会话" }),
  });
  assert.equal(response.status, 201);
  const body = (await response.json()) as { session_id: string; role: string; actor_id: string };
  assert.equal(body.role, "analyst");
  assert.equal(body.actor_id, "demo-analyst");
  return body;
}

async function postJob(port: number, sessionId: string, text: string, key: string, allowError = false) {
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-demo-actor": "demo-analyst" },
    body: JSON.stringify({ text, idempotency_key: key, userId: "root" }),
  });
  if (allowError) return { status: response.status, job_id: "" };
  assert.equal(response.status, 202);
  return (await response.json()) as { job_id: string; status: number };
}

async function getJob(port: number, jobId: string) {
  const response = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}`, { headers: { "x-demo-actor": "demo-analyst" } });
  assert.equal(response.status, 200);
  return (await response.json()) as { job_id: string; status: string; events: Array<{ seq: number; type: string }> };
}

async function readSome(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  let text = "";
  const started = Date.now();
  while (Date.now() - started < 3000 && !text.includes("job_finished")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
  }
  await reader.cancel();
  return text;
}

async function waitForHealth(port: number) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        const body = (await response.json()) as { state_mode: string; queue: string; freshness_status: string };
        assert.equal(body.state_mode, "mysql");
        assert.equal(body.queue, "redis-wake-only");
        assert.equal(body.freshness_status, "published");
        return;
      }
    } catch {
      // 进程还在监听前。
    }
    await delay(100);
  }
  throw new Error("API 没有在隔离端口就绪");
}

async function waitForMysql(port: number) {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    try {
      const connection = await mysql.createConnection({ host: "127.0.0.1", port, user, password, database });
      await connection.query("SELECT 1");
      await connection.end();
      return;
    } catch {
      await delay(500);
    }
  }
  throw new Error("隔离 MySQL 未就绪");
}

async function waitForRedis(port: number) {
  const queue = new RedisJobQueue({ host: "127.0.0.1", port, password, queueKey: `${queueKey}:ping` });
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    try {
      await queue.depth();
      await queue.close();
      return;
    } catch {
      await delay(200);
    }
  }
  await queue.close();
  throw new Error("隔离 Redis 未就绪");
}

async function assertLocalImages() {
  await runQuiet("docker", ["image", "inspect", "mysql:8.0.32"], password);
  await runQuiet("docker", ["image", "inspect", "redis:6.2"], password);
}

function runQuiet(command: string, args: string[], secret: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error((err || `${command} exit ${code}`).replaceAll(secret, "[secret]").slice(0, 400)));
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}
