// Real isolated MySQL acceptance for history paging; no model or worker is started.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createTcpServer } from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import mysql from "mysql2/promise";
import { AsyncMysqlStateStore } from "../src/async-mysql-state-store.js";
import { parseHistoryPage } from "../src/history-page.mjs";
import { startServer } from "../src/server.js";
import { openRuntime } from "./helpers.js";
import { isolatedDocker, loopbackPort, runOwnedContainer } from "./isolated-docker.js";

test("真实 MySQL 历史数量边界、200 任务、迁移和有界 SSE", { timeout: 180_000 }, async () => {
  const run = `vv-history-${randomUUID()}`;
  const password = randomBytes(20).toString("hex");
  const created: string[] = [];
  const dir = mkdtempSync(path.join(tmpdir(), "vv-mysql-history-"));
  let runtime: ReturnType<typeof openRuntime> | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  const auxiliary: AsyncMysqlStateStore[] = [];
  try {
    await runOwnedContainer(["run", "--pull=never", "-d", "--name", run, "--label", `dataagent.test.run=${run}`, "--tmpfs", "/var/lib/mysql:rw,size=1g", "-p", "127.0.0.1::3306", "-e", `MYSQL_ROOT_PASSWORD=${password}`, "-e", "MYSQL_DATABASE=history_it", "-e", "MYSQL_USER=history_it", "-e", `MYSQL_PASSWORD=${password}`, "mysql:8.0.32", "--skip-log-bin"], run, run, created);
    const port = await loopbackPort(run, 3306);
    const config = { host: "127.0.0.1", port, user: "history_it", password, database: "history_it" };
    const deadline = Date.now() + 60_000;
    while (true) {
      try { const connection = await mysql.createConnection(config); await connection.end(); break; }
      catch { if (Date.now() > deadline) throw new Error("isolated_mysql_not_ready"); await delay(200); }
    }
    runtime = openRuntime(dir, { stateMode: "mysql", mysqlPort: port, mysqlUser: config.user, mysqlPassword: password, mysqlDatabase: config.database, startWorker: false });
    const bridge = await runtime.mysqlAsyncState();
    const workerInstance = randomUUID(), dispatcherInstance = randomUUID();
    assert.deepEqual(await bridge.call("executorReadiness", 15000), { worker: false, dispatcher: false });
    await Promise.all([bridge.call("executorHeartbeat", "worker", workerInstance), bridge.call("executorHeartbeat", "dispatcher", dispatcherInstance)]);
    assert.deepEqual(await bridge.call("executorReadiness", 15000), { worker: true, dispatcher: true });
    const clockControl = await mysql.createConnection(config);
    await clockControl.execute("UPDATE executor_activity SET last_seen_ms=0 WHERE kind=? AND instance_id=?", ["worker", workerInstance]);
    await clockControl.end();
    assert.deepEqual(await bridge.call("executorReadiness", 15000), { worker: false, dispatcher: true });
    await bridge.call("executorHeartbeat", "worker", workerInstance);
    await bridge.call("executorStop", "worker", workerInstance);
    assert.deepEqual(await bridge.call("executorReadiness", 15000), { worker: false, dispatcher: true });
    await bridge.call("executorStop", "dispatcher", dispatcherInstance);
    {
    // A separate database is essential: mock and controlled identities must
    // never share one authority. Both containers are owned by this test.
    const visitorRun = `${run}-visitor`;
    await runOwnedContainer(["run", "--pull=never", "-d", "--name", visitorRun, "--label", `dataagent.test.run=${run}`, "--tmpfs", "/var/lib/mysql:rw,size=1g", "-p", "127.0.0.1::3306", "-e", `MYSQL_ROOT_PASSWORD=${password}`, "-e", "MYSQL_DATABASE=visitor_it", "-e", "MYSQL_USER=visitor_it", "-e", `MYSQL_PASSWORD=${password}`, "mysql:8.0.32", "--skip-log-bin"], visitorRun, run, created);
    const port = await loopbackPort(visitorRun, 3306);
    const rawConfig = { host: "127.0.0.1", port, user: "visitor_it", password, database: "visitor_it" };
    const visitorDeadline = Date.now()+60000;
    while (true) { try { const c = await mysql.createConnection(rawConfig); await c.end(); break; } catch { if(Date.now()>visitorDeadline) throw new Error("visitor_mysql_not_ready"); await delay(200); } }
    const authority = { mode:"controlled_visitor" as const, policy:{version:1 as const, windowMs:60000, maxAccepted:1, maxActive:1, maxGlobalActive:1, sessionWindowMs:900000, maxSessionsPerWindow:40, maxSessions:500,bootstrapWindowMs:900000,bootstrapMaxCreates:60} };
    const config = {...rawConfig,authority};
    const closedProbe = createTcpServer(socket => socket.destroy());
    await new Promise<void>(resolve => closedProbe.listen(0,"127.0.0.1",resolve));
    try {
    const closedAddress = closedProbe.address(); assert.ok(closedAddress && typeof closedAddress === "object");
    const controlledDb = {businessEngine:"clickhouse" as const,clickhouseLockedReadonly:true,clickhouseUrl:`http://127.0.0.1:${closedAddress.port}`,clickhouseUser:"fictional",clickhousePassword:"fictional",clickhouseDatabase:"synthetic"};
    const initialized = await Promise.allSettled([AsyncMysqlStateStore.open(config), AsyncMysqlStateStore.open(config)]);
    await Promise.all(initialized.map(s => s.status === "fulfilled" ? s.value.close() : Promise.resolve()));
    for (const result of initialized) if (result.status === "rejected") throw result.reason;
    await assert.rejects(AsyncMysqlStateStore.open(rawConfig), error => error instanceof Error && error.name === "authority_mode_conflict");
    for (const change of [{maxGlobalActive:10},{maxAccepted:2},{windowMs:120000},{maxSessionsPerWindow:41},{bootstrapMaxCreates:61}]) {
      await assert.rejects(AsyncMysqlStateStore.open({...rawConfig,authority:{...authority,policy:{...authority.policy,...change}}}), error => error instanceof Error && error.name === "authority_policy_conflict");
    }
    const runtime = openRuntime(dir, {...controlledDb,stateMode:"mysql",mysqlPort:port,mysqlUser:config.user,mysqlPassword:password,mysqlDatabase:config.database,startWorker:false,identityMode:"controlled_visitor",visitorOrigin:"http://127.0.0.1:44123",visitorAllowLoopbackHttp:true,visitorWindowMs:60000,visitorMaxAccepted:1,visitorMaxGlobalActive:1});
    try {
    const bridge = await runtime.mysqlAsyncState();
    // Disposable synthetic hashes exercise a shared, database-time bounded
    // bootstrap. No raw credential is passed to, or saved by, the store.
    const visitors = Array.from({ length: 4 }, () => ({ visitorId: `vis_${randomBytes(16).toString("hex")}`, credentialHash: createHash("sha256").update(randomBytes(32)).digest("hex"), ttlMs: 60000, windowMs: 60000, maxCreates: 2 }));
    const secondVisitorBridge = await AsyncMysqlStateStore.open(config);
    let createdVisitors;
    try { createdVisitors = await Promise.all(visitors.map((visitor, index) => (index % 2 ? secondVisitorBridge : bridge).call("createVisitor", visitor))); }
    finally { await secondVisitorBridge.close(); }
    assert.equal(createdVisitors.filter(Boolean).length, 4, "调用者的旧 maxCreates 参数不能改写权威策略");
    const winner = visitors[createdVisitors.findIndex(Boolean)]!;
    assert.equal((await bridge.call("lookupVisitor", winner.credentialHash))?.visitor_id, winner.visitorId);
    assert.equal(await bridge.call("lookupVisitor", "bad"), null);
    assert.equal(await bridge.call("revokeVisitor", winner.visitorId), true);
    assert.equal(await bridge.call("lookupVisitor", winner.credentialHash), null);
    const expiring = { visitorId: `vis_${randomBytes(16).toString("hex")}`, credentialHash: createHash("sha256").update(randomBytes(32)).digest("hex"), ttlMs: 200, windowMs: 60000, maxCreates: 3 };
    assert.ok(await bridge.call("createVisitor", expiring));
    await delay(300);
    assert.equal(await bridge.call("lookupVisitor", expiring.credentialHash), null);
    const admissionVisitors = Array.from({ length: 2 }, () => ({ visitorId: `vis_${randomBytes(16).toString("hex")}`, credentialHash: createHash("sha256").update(randomBytes(32)).digest("hex"), ttlMs: 60000, windowMs: 60000, maxCreates: 5 }));
    for (const visitor of admissionVisitors) assert.ok(await bridge.call("createVisitor", visitor));
    const makeSession = (visitorId: string, suffix: string) => bridge.call("createSession", { session_id: `ses_admission_${suffix}`, title: "合成", role: "analyst", actor_id: visitorId, created_at: "2026-11-09T00:00:00.000Z", slots: null, bindings: [] }, {visitorId,credentialHash:admissionVisitors.find(v => v.visitorId === visitorId)!.credentialHash,creationKey:`session-${suffix}`});
    const [firstSession, secondSession] = await Promise.all([makeSession(admissionVisitors[0]!.visitorId, "a"), makeSession(admissionVisitors[1]!.visitorId, "b")]);
    await assert.rejects(bridge.call("createSession", {...firstSession,session_id:"ses_missing_visitor"}), error => error instanceof Error && error.name === "visitor_required");
    const sameSession = await bridge.call("createSession", {...firstSession,session_id:"ses_new_retry"}, {visitorId:admissionVisitors[0]!.visitorId,credentialHash:admissionVisitors[0]!.credentialHash,creationKey:"session-a"});
    assert.equal(sameSession.session_id,firstSession.session_id);
    for(let i=0;i<39;i++) await bridge.call("createSession", {...firstSession,session_id:`ses_rate_${i}`}, {visitorId:admissionVisitors[0]!.visitorId,credentialHash:admissionVisitors[0]!.credentialHash,creationKey:`rate-${i}`});
    await assert.rejects(bridge.call("createSession", {...firstSession,session_id:"ses_rate_exceeded"}, {visitorId:admissionVisitors[0]!.visitorId,credentialHash:admissionVisitors[0]!.credentialHash,creationKey:"rate-exceeded"}), error => error instanceof Error && error.name === "visitor_session_limit");
    assert.equal((await bridge.call("createSession", {...firstSession,session_id:"ses_replay_at_limit"}, {visitorId:admissionVisitors[0]!.visitorId,credentialHash:admissionVisitors[0]!.credentialHash,creationKey:"session-a"})).session_id,firstSession.session_id);
    await assert.rejects(runtime.jobs.submitAsync(bridge, firstSession, "未授权", "no-admission"), error => error instanceof Error && error.name === "visitor_required");
    const admissionPeer = await AsyncMysqlStateStore.open(config);
    try {
      const quota = (visitorId: string, text = "合成比较") => ({ visitorId, credentialHash: admissionVisitors.find(v => v.visitorId === visitorId)!.credentialHash, requestHash: createHash("sha256").update(text).digest("hex") });
      const candidates = await Promise.allSettled([
        runtime.jobs.submitAsync(bridge, firstSession, "合成比较", "idem-a", undefined, quota(admissionVisitors[0]!.visitorId)),
        runtime.jobs.submitAsync(admissionPeer, secondSession, "合成比较", "idem-b", undefined, quota(admissionVisitors[1]!.visitorId)),
      ]);
      assert.equal(candidates.filter(item => item.status === "fulfilled").length, 1);
      assert.equal(candidates.filter(item => item.status === "rejected" && item.reason?.code === "global_active_limit").length, 1);
      const index = candidates.findIndex(item => item.status === "fulfilled");
      const won = candidates[index]!; if (won.status !== "fulfilled") throw new Error("missing_winner");
      const chosen = index === 0 ? firstSession : secondSession; const actor = admissionVisitors[index]!.visitorId; const key = index === 0 ? "idem-a" : "idem-b";
      const w = randomUUID(), d = randomUUID();
      await bridge.call("executorHeartbeat", "worker", w); await bridge.call("executorHeartbeat", "dispatcher", d);
      const clock = await mysql.createConnection(rawConfig);
      try {
        await clock.execute("UPDATE jobs SET queued_ms=1 WHERE job_id=?", [won.value.job_id]);
        await clock.execute("UPDATE outbox SET created_ms=1 WHERE job_id=?", [won.value.job_id]);
        assert.deepEqual(await bridge.call("executorProgressSummary",15000,30000), {worker:"stalled",dispatcher:"stalled",blocked:true});
        await bridge.call("executorProgress","worker",w); await bridge.call("executorProgress","dispatcher",d);
        assert.deepEqual(await bridge.call("executorProgressSummary",15000,30000), {worker:"waiting",dispatcher:"waiting",blocked:false});
      } finally { await clock.end(); await bridge.call("executorStop","worker",w); await bridge.call("executorStop","dispatcher",d); }
      const replay = await runtime.jobs.submitAsync(admissionPeer, chosen, "合成比较", key, undefined, quota(actor));
      assert.equal(replay.job_id, won.value.job_id);
      assert.equal((await bridge.call("recoverVisitorSubmission",chosen.session_id,quota(actor),key))?.job_id,won.value.job_id);
      await assert.rejects(bridge.call("recoverVisitorSubmission",chosen.session_id,quota(actor,"伪造范围"),key), error => error instanceof Error && error.name === "idempotency_conflict");
      await assert.rejects(runtime.jobs.submitAsync(bridge, chosen, "不同问题", key, undefined, quota(actor,"不同问题")), error => error instanceof Error && error.name === "RequestError" && "code" in error && error.code === "idempotency_conflict");
      const claimed=await bridge.call("claimJob",won.value.job_id,"worker-long-test",Date.now(),10000); assert.ok(claimed);
      assert.deepEqual(await bridge.call("executorProgressSummary",15000,30000), {worker:"busy",dispatcher:"idle",blocked:false}, "有效租约下的长任务不能误判停滞");
      await bridge.call("requestCancel", won.value.job_id);
      assert.equal(await bridge.call("finish",won.value.job_id,claimed.owner,claimed.fence,"cancelled",null,null),true);
      assert.deepEqual(await bridge.call("executorProgressSummary",15000,30000), {worker:"idle",dispatcher:"idle",blocked:false}, "已经取消的 outbox 不应把空闲误判为停滞");
      await assert.rejects(runtime.jobs.submitAsync(bridge, chosen, "新问题", "new-key", undefined, quota(actor)), error => error instanceof Error && "code" in error && error.code === "visitor_rate_limit");
      await assert.rejects(runtime.jobs.submitAsync(bridge, chosen, "跨身份", "other-key", undefined, quota(admissionVisitors[1-index]!.visitorId)), error => error instanceof Error && "code" in error && error.code === "session_not_found");
    } finally { await admissionPeer.close(); }
    // Expiry must be checked again after a slow global admission lock, using
    // database time. An earlier successful identity check is not a lease.
    const delayed = {visitorId:`vis_${randomBytes(16).toString("hex")}`,credentialHash:createHash("sha256").update(randomBytes(32)).digest("hex"),ttlMs:1000,windowMs:60000,maxCreates:60};
    assert.ok(await bridge.call("createVisitor",delayed));
    const delayedSession = await bridge.call("createSession",{...firstSession,session_id:"ses_expiring_lock",actor_id:delayed.visitorId},{visitorId:delayed.visitorId,credentialHash:delayed.credentialHash,creationKey:"expiring"});
    const blocker = await mysql.createConnection(rawConfig);
    try {
      await blocker.beginTransaction(); await blocker.query("SELECT singleton FROM visitor_admission_mutex WHERE singleton=1 FOR UPDATE");
      const submission=runtime.jobs.submitAsync(bridge,delayedSession,"锁等待合成问题","delayed",undefined,{visitorId:delayed.visitorId,credentialHash:delayed.credentialHash,requestHash:createHash("sha256").update("delayed").digest("hex")});
      const rejection=assert.rejects(submission,error=>error instanceof Error && "code" in error && error.code==="visitor_expired");
      await delay(1200); await blocker.commit(); await rejection;
      assert.equal((await bridge.call("listJobs",delayedSession.session_id)).length,0);
    } finally { await blocker.rollback().catch(()=>undefined); await blocker.end(); }
    // A timed-out caller is not proof of rollback: release a lock after the
    // bridge timeout and recover the eventual commit by the original key.
    const late = {visitorId:`vis_${randomBytes(16).toString("hex")}`,credentialHash:createHash("sha256").update(randomBytes(32)).digest("hex"),ttlMs:60000,windowMs:60000,maxCreates:60};
    assert.ok(await bridge.call("createVisitor",late));
    const lateSession=await bridge.call("createSession",{...firstSession,session_id:"ses_unknown_commit",actor_id:late.visitorId},{visitorId:late.visitorId,credentialHash:late.credentialHash,creationKey:"unknown-session"});
    const lateAdmission={visitorId:late.visitorId,credentialHash:late.credentialHash,requestHash:createHash("sha256").update("unknown-commit").digest("hex")};
    const lock=await mysql.createConnection(rawConfig); const short=await AsyncMysqlStateStore.open(config,150,20000);
    try {
      await lock.beginTransaction(); await lock.query("SELECT singleton FROM visitor_admission_mutex WHERE singleton=1 FOR UPDATE");
      const unknown=runtime.jobs.submitAsync(short,lateSession,"未知提交合成问题","unknown-key",undefined,lateAdmission);
      await assert.rejects(unknown,error=>error instanceof Error && error.message==="mysql_state_outcome_unknown");
      await lock.commit(); let recovered=null;
      for(let attempt=0;attempt<40&&!recovered;attempt++){await delay(50);recovered=await bridge.call("recoverVisitorSubmission",lateSession.session_id,lateAdmission,"unknown-key");}
      assert.ok(recovered,"超时之后数据库实际提交必须可按原键找回");
      assert.equal((await bridge.call("listJobs",lateSession.session_id)).length,1);
      await bridge.call("requestCancel",recovered.job_id);
    } finally { await lock.rollback().catch(()=>undefined); await lock.end(); await short.close(); }
    // Without the required ClickHouse, Redis, freshness and executors this
    // controlled server must fail closed across independent cookies.
    const visitorDir = mkdtempSync(path.join(tmpdir(), "vv-visitor-http-"));
    const notRedis = createTcpServer(socket => socket.destroy());
    await new Promise<void>(resolve => notRedis.listen(0, "127.0.0.1", resolve));
    const notRedisAddress = notRedis.address(); assert.ok(notRedisAddress && typeof notRedisAddress === "object");
    const visitorRuntime = openRuntime(visitorDir, { ...controlledDb, stateMode: "mysql", mysqlPort: port, mysqlUser: config.user, mysqlPassword: password, mysqlDatabase: config.database, redisPort: notRedisAddress.port, startWorker: false, identityMode: "controlled_visitor", visitorOrigin: "http://127.0.0.1:44123", visitorAllowLoopbackHttp: true, visitorWindowMs:60000, visitorMaxAccepted:1, visitorMaxGlobalActive:1 });
    const visitorServer = startServer(visitorRuntime);
    await new Promise<void>(resolve => visitorServer.listen(0, "127.0.0.1", resolve));
    const visitorAddress = visitorServer.address(); assert.ok(visitorAddress && typeof visitorAddress === "object");
    const visitorBase = `http://127.0.0.1:${visitorAddress.port}`;
    const origin = visitorBase; const host = `127.0.0.1:${visitorAddress.port}`;
    visitorRuntime.config.visitorOrigin = origin;
    let syntheticJobId = "";
    try {
      assert.equal((await fetch(`${visitorBase}/api/sessions`, { headers: { host } })).status, 401);
      assert.equal((await fetch(`${visitorBase}/api/visitor`, { method: "POST", headers: { host, "content-type": "application/json" }, body: "{}" })).status, 403);
      const bootstrap = async () => {
        const response = await fetch(`${visitorBase}/api/visitor`, { method: "POST", headers: { host, origin, "content-type": "application/json" }, body: "{}" });
        assert.equal(response.status, 201); const cookie = response.headers.get("set-cookie")!; assert.match(cookie, /HttpOnly; SameSite=Strict/u);
        return { cookie: cookie.split(";")[0]!, csrf: ((await response.json()) as { csrf_token: string }).csrf_token };
      };
      const a = await bootstrap(), b = await bootstrap();
      const headers = { host, origin, cookie: a.cookie, "x-csrf-token": a.csrf, "content-type": "application/json", "x-demo-actor": "demo-analyst" };
      assert.equal((await fetch(`${visitorBase}/api/sessions`, { method: "POST", headers: { ...headers, "x-csrf-token": b.csrf }, body: "{}" })).status, 403);
      assert.equal((await fetch(`${visitorBase}/api/sessions`, { method: "POST", headers: { ...headers, origin: "http://other.invalid" }, body: "{}" })).status, 403);
      const create = await fetch(`${visitorBase}/api/sessions`, { method: "POST", headers, body: JSON.stringify({creation_key:"session-http"}) }); assert.equal(create.status, 201);
      const own = await create.json() as { session_id: string; actor_id: string }; assert.match(own.actor_id, /^vis_[0-9a-f]{32}$/u);
      assert.equal((await fetch(`${visitorBase}/api/sessions/${own.session_id}`, { headers: { host, cookie: b.cookie } })).status, 404);
      assert.equal((await fetch(`${visitorBase}/api/sessions/${own.session_id}/messages`, { method: "POST", headers, body: JSON.stringify({text:"合成",idempotency_key:"one"}) })).status, 503);
      assert.equal((await bridge.call("listJobs", own.session_id)).length, 0);
      assert.equal((await fetch(`${visitorBase}/api/sessions`, { headers: { host, cookie: "vv_visitor=forged" } })).status, 401);
      // Create a synthetic queued job directly to exercise the guarded read
      // surfaces even though this isolated server has no executable stack.
      const stored = await bridge.call("getSession", own.session_id); assert.ok(stored);
      const syntheticJob = await runtime.jobs.submitAsync(bridge, stored, "合成", "owned-job", undefined, {visitorId:own.actor_id,credentialHash:createHash("sha256").update(a.cookie.split("=")[1]!).digest("hex"),requestHash:createHash("sha256").update("合成").digest("hex")});
      syntheticJobId = syntheticJob.job_id;
      for (const endpoint of [`/api/jobs/${syntheticJob.job_id}`, `/api/jobs/${syntheticJob.job_id}/events?after=0`, `/api/sessions/${own.session_id}/resources/unknown`, `/api/sessions/${own.session_id}/provider-payloads?job_id=${syntheticJob.job_id}`]) {
        assert.equal((await fetch(`${visitorBase}${endpoint}`, {headers:{host,cookie:b.cookie}})).status, 404);
      }
      assert.equal((await fetch(`${visitorBase}/api/jobs/${syntheticJob.job_id}/cancel`, {method:"POST",headers:{...headers,cookie:b.cookie,"x-csrf-token":b.csrf}})).status, 404);
      const events = await fetch(`${visitorBase}/api/jobs/${syntheticJob.job_id}/events?after=0`, {headers:{host,cookie:a.cookie}});
      assert.equal(events.status, 200); assert.ok(events.body);
      const reader = events.body.getReader(); assert.equal((await reader.read()).done, false);
      assert.equal(await bridge.call("revokeVisitor", own.actor_id), true);
      const closed = await Promise.race([reader.read(), delay(5000).then(() => {throw new Error("visitor_sse_did_not_close");})]);
      assert.equal(closed.done, true);
      assert.equal((await fetch(`${visitorBase}/api/sessions`, { headers: { host, cookie: a.cookie } })).status, 401);
      assert.equal((await fetch(`${visitorBase}/api/visitor/reset`, { method:"POST", headers:{host,cookie:a.cookie,"content-type":"application/json"}, body:"{}" })).status, 403);
      const reset = await fetch(`${visitorBase}/api/visitor/reset`, { method:"POST", headers:{host,origin,cookie:a.cookie,"content-type":"application/json"}, body:"{}" });
      assert.equal(reset.status, 200); assert.match(reset.headers.get("set-cookie") ?? "", /Max-Age=0/u);
      const c = await bootstrap();
      assert.equal((await fetch(`${visitorBase}/api/sessions/${own.session_id}`, { headers: {host,cookie:c.cookie} })).status, 404);
    } finally {
      visitorServer.closeAllConnections(); await new Promise<void>(resolve => visitorServer.close(() => resolve()));
      await visitorRuntime.close({abandon:true}); rmSync(visitorDir, {recursive:true, force:true});
      await new Promise<void>(resolve => notRedis.close(() => resolve()));
    }
    const policyEnv = {PATH:process.env.PATH,HOME:process.env.HOME,MODEL_MODE:"deterministic",IDENTITY_MODE:"controlled_visitor",VISITOR_ORIGIN:"http://127.0.0.1:44123",VISITOR_ALLOW_LOOPBACK_HTTP:"true",STATE_MODE:"mysql",BUSINESS_ENGINE:"clickhouse",CLICKHOUSE_LOCKED_READONLY:"true",CLICKHOUSE_URL:controlledDb.clickhouseUrl,CLICKHOUSE_USER:"fictional",CLICKHOUSE_PASSWORD:"fictional",CLICKHOUSE_DATABASE:"synthetic",MYSQL_HOST:"127.0.0.1",MYSQL_PORT:String(port),MYSQL_USER:config.user,MYSQL_PASSWORD:password,MYSQL_DATABASE:config.database,VISITOR_WINDOW_MS:"60000",VISITOR_MAX_ACCEPTED:"1",VISITOR_MAX_GLOBAL_ACTIVE:"2"};
    const policyCommand = (args:string[]) => new Promise<{code:number|null;output:string}>((resolve,reject) => {
      const child=spawn(process.execPath,["--import","tsx","scripts/visitor-policy.ts",...args],{env:policyEnv,stdio:["ignore","pipe","pipe"]}); let output="";
      child.stdout.on("data",chunk=>{output+=String(chunk)}); child.on("error",reject); child.on("close",code=>resolve({code,output}));
    });
    const planned = await policyCommand(["--plan"]); assert.equal(planned.code,0); assert.match(planned.output,/"usage_retained":true/u);
    assert.notEqual((await policyCommand(["--apply","--expected-revision=1"])).code,0,"活动任务存在时不能修改策略");
    await bridge.call("requestCancel",syntheticJobId);
    assert.equal((await policyCommand(["--apply","--expected-revision=1"])).code,0);
    assert.notEqual((await policyCommand(["--apply","--expected-revision=1"])).code,0,"旧修订不能覆盖新策略");
    const policyDb = await mysql.createConnection(rawConfig);
    try { const [history]:any = await policyDb.query("SELECT revision FROM state_authority_history"); assert.deepEqual(history.map((row:any)=>Number(row.revision)),[2]); }
    finally { await policyDb.end(); }
    assert.ok(await bridge.call("getSessionMetadata",firstSession.session_id,admissionVisitors[0]!.visitorId),"策略漂移期间旧实例仍可读取历史");
    await assert.rejects(bridge.call("createSession", {...firstSession,session_id:"ses_stale_policy"}, {visitorId:admissionVisitors[0]!.visitorId,credentialHash:admissionVisitors[0]!.credentialHash,creationKey:"stale"}));
    const newPolicyBridge = await AsyncMysqlStateStore.open({...rawConfig,authority:{...authority,policy:{...authority.policy,maxGlobalActive:2}}});
    try { assert.ok(await newPolicyBridge.call("getSession",firstSession.session_id)); } finally { await newPolicyBridge.close(); }
    } finally { await runtime.close({abandon:true}); }
    } finally { await new Promise<void>(resolve => closedProbe.close(()=>resolve())); }
    }
    const time = "2026-11-09T00:00:00.000Z";
    const insert = (id: string, actor = "demo-analyst") => bridge.call("createSession", { session_id: id, title: id, role: "analyst", actor_id: actor, created_at: time, slots: null, bindings: [] });
    server = startServer(runtime);
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const operations: string[] = [];
    const tracked = new Proxy(bridge, {
      get(target, key, receiver) {
        if (key === "call") return (operation: string, ...args: unknown[]) => { operations.push(operation); return Reflect.apply(target.call, target, [operation, ...args]); };
        return Reflect.get(target, key, receiver);
      },
    });
    runtime.mysqlAsyncState = async () => tracked;
    for (let count = 0; count <= 100; count++) {
      if (count) await insert(`ses_${String(count).padStart(3, "0")}`);
      if (![0, 1, 63, 64, 65, 70, 100].includes(count)) continue;
      operations.length = 0;
      const response = await fetch(`${base}/api/sessions`); assert.equal(response.status, 200, `total=${count}`);
      const text = await response.text();
      const page = JSON.parse(text) as { sessions: object[]; has_more: boolean };
      assert.equal(page.sessions.length, Math.min(count, 25)); assert.equal(page.has_more, count > 25);
      assert.deepEqual(operations, ["listSessionSummaries"], "首屏一个桥调用，不按会话扇出");
      assert.ok(Buffer.byteLength(text) < 15_000);
      assert.doesNotMatch(text, /"jobs"|"analysis"|"events"|"slots"|"bindings"/);
    }
    await insert("ses_private", "demo-viewer");
    let page = await bridge.call("listSessionSummaries", "demo-analyst", parseHistoryPage(new URLSearchParams(), "sessions", "demo-analyst"));
    const ids = page.items.map(item => item.session_id);
    await insert("ses_050_late"); await insert("ses_000_late");
    while (page.has_more) {
      page = await bridge.call("listSessionSummaries", "demo-analyst", parseHistoryPage(new URLSearchParams({ before: page.next_cursor! }), "sessions", "demo-analyst"));
      ids.push(...page.items.map(item => item.session_id));
    }
    assert.equal(ids.length, 100); assert.equal(new Set(ids).size, 100);
    const selected = (await bridge.call("getSession", "ses_001"))!;
    for (let n = 0; n < 200; n++) {
      const job = await runtime.jobs.submitForSessionAsync(selected.session_id, `合成历史 ${n} ${"x".repeat(300)}`, `history-${n}`);
      await bridge.call("requestCancel", job.job_id);
    }
    const active = await runtime.jobs.submitForSessionAsync(selected.session_id, "当前活动任务", "active");
    let cursor: string | null = null; const jobIds: string[] = [];
    do {
      operations.length = 0;
      const response: Response = await fetch(`${base}/api/sessions/${selected.session_id}/jobs${cursor ? `?before=${cursor}` : ""}`);
      assert.equal(response.status, 200);
      const text = await response.text(); assert.ok(Buffer.byteLength(text) < 45_000);
      const result = JSON.parse(text) as { jobs: Array<{ job_id: string; user_text_preview: string }>; next_cursor: string | null; active_job_id: string };
      assert.ok(result.jobs.length <= 25); assert.equal(result.active_job_id, active.job_id);
      assert.ok(result.jobs.every(job => job.user_text_preview.length <= 240));
      assert.deepEqual(operations, ["getSessionMetadata", "listJobSummaries"]);
      assert.doesNotMatch(text, /"analysis"|"events"|"usage"|"turn"/);
      jobIds.push(...result.jobs.map(job => job.job_id)); cursor = result.next_cursor;
    } while (cursor);
    assert.equal(jobIds.length, 201); assert.equal(new Set(jobIds).size, 201);
    const claim = await bridge.call("claimJob", active.job_id, "history-sse", Date.now(), 30_000); assert.ok(claim);
    for (let n = 0; n < 70; n++) assert.ok(await bridge.call("appendEvent", active.job_id, claim.owner, claim.fence, "tool_finished", { marker: n }));
    assert.equal(await bridge.call("finish", active.job_id, claim.owner, claim.fence, "completed", null, null), true);
    operations.length = 0;
    const replay = await (await fetch(`${base}/api/jobs/${active.job_id}/events?after=1`)).text();
    assert.deepEqual([...replay.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1])), Array.from({ length: 71 }, (_, n) => n + 2));
    assert.ok(!operations.includes("getJob")); assert.ok(operations.filter(op => op === "readJobEvents").length >= 3);
    const cross = await fetch(`${base}/api/sessions/${selected.session_id}/jobs`, { headers: { "x-demo-actor": "demo-viewer" } }); assert.equal(cross.status, 404);
    const liveSession = await insert("ses_contention_live");
    const cancelSession = await insert("ses_contention_cancel");
    const live = await runtime.jobs.submitForSessionAsync(liveSession.session_id, "合成心跳", "contention-live");
    const cancelJob = await runtime.jobs.submitForSessionAsync(cancelSession.session_id, "合成取消", "contention-cancel");
    const liveClaim = await bridge.call("claimJob", live.job_id, "contention-owner", Date.now(), 30_000); assert.ok(liveClaim);
    const db = await mysql.createConnection(config);
    try {
      await db.beginTransaction();
      await db.query("SELECT kind FROM history_writers WHERE kind = 'sessions' FOR UPDATE");
      const blocked = Array.from({ length: 8 }, (_, index) => insert(`ses_pool_wait_${index}`));
      try {
        await delay(200);
        const operations = Promise.all([
          bridge.call("getSessionMetadata", liveSession.session_id, "demo-analyst"),
          bridge.call("readJobEvents", live.job_id, 0),
          bridge.call("heartbeat", live.job_id, liveClaim.owner, liveClaim.fence, Date.now(), 30_000),
          bridge.call("requestCancel", cancelJob.job_id),
        ]);
        const completed = await Promise.race([operations.then(() => true), delay(2000).then(() => false)]);
        assert.equal(completed, true, "八个等待创建不能占满用于历史、事件、续租和取消的连接");
      } finally {
        await db.commit();
        await Promise.allSettled(blocked);
      }
      const gate = `vvhist_${randomUUID()}`;
      await db.query("SELECT GET_LOCK(?, 0)", [gate]);
      await db.query(`CREATE TRIGGER synthetic_history_slow AFTER INSERT ON sessions FOR EACH ROW BEGIN IF NEW.session_id = 'ses_050_inflight' THEN DO GET_LOCK('${gate}', 15); DO RELEASE_LOCK('${gate}'); END IF; END`);
      const slow = insert("ses_050_inflight");
      let fast: ReturnType<typeof insert> | undefined;
      try {
        let locked = false;
        const lockDeadline = Date.now() + 3000;
        while (!locked && Date.now() < lockDeadline) {
          try { await db.query("SELECT session_id FROM sessions WHERE session_id = 'ses_050_inflight' FOR UPDATE NOWAIT"); }
          catch (error) { if ((error as { code?: string }).code === "ER_LOCK_NOWAIT") locked = true; else throw error; }
          if (!locked) await delay(5);
        }
        assert.equal(locked, true, "慢事务已插入但尚未提交");
        let fastCommitted = false;
        fast = insert("ses_049_fast").then(value => { fastCommitted = true; return value; });
        await delay(50);
        assert.equal(fastCommitted, false, "后续序号不能抢在已分配的慢创建事务之前提交");
        let frozen = await bridge.call("listSessionSummaries", "demo-analyst", parseHistoryPage(new URLSearchParams(), "sessions", "demo-analyst"));
        await db.query("SELECT RELEASE_LOCK(?)", [gate]);
        await Promise.all([slow, fast]);
        const frozenIds = frozen.items.map(item => item.session_id);
        while (frozen.has_more) {
          frozen = await bridge.call("listSessionSummaries", "demo-analyst", parseHistoryPage(new URLSearchParams({ before: frozen.next_cursor! }), "sessions", "demo-analyst"));
          frozenIds.push(...frozen.items.map(item => item.session_id));
        }
        assert.ok(!frozenIds.includes("ses_050_inflight") && !frozenIds.includes("ses_049_fast"));
      } finally {
        await db.query("SELECT RELEASE_LOCK(?)", [gate]);
        await Promise.allSettled([slow, ...(fast ? [fast] : [])]);
        await db.query("DROP TRIGGER synthetic_history_slow");
      }
      await bridge.close();
      for (const table of ["sessions", "jobs"]) await db.query(`ALTER TABLE ${table} DROP COLUMN history_seq`);
      await db.query("DROP INDEX idx_sessions_history ON sessions");
      await db.query("DROP INDEX idx_jobs_history ON jobs");
      await db.query("DROP INDEX idx_jobs_active ON jobs");
      // Re-open an existing populated schema concurrently. Only precise
      // duplicate-column/index races may be ignored by migration code.
      const opened = await Promise.allSettled([0, 1].map(async () => {
        const value = await AsyncMysqlStateStore.open(config); auxiliary.push(value); return value;
      }));
      for (const result of opened) if (result.status === "rejected") throw result.reason;
      const peer = auxiliary[0]!;
      const found = await peer.call("getSessionMetadata", selected.session_id, "demo-analyst"); assert.ok(found);
      const persisted = await peer.call("getJob", active.job_id); assert.equal(persisted?.events.length, 72);
      for (const [table, names] of [["sessions", ["idx_sessions_history"]], ["jobs", ["idx_jobs_history", "idx_jobs_active"]]] as const) {
        const [indexes] = await db.query(`SHOW INDEX FROM ${table}`);
        for (const name of names) assert.ok((indexes as Array<{ Key_name: string }>).some(index => index.Key_name === name));
      }
    } finally { await db.end(); }
  } finally {
    server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await Promise.all(auxiliary.map(bridge => bridge.close())); await runtime?.close({ abandon: true });
    for (const name of created.reverse()) await isolatedDocker(["rm", "-f", name]);
    rmSync(dir, { recursive: true, force: true });
  }
});
