import { parentPort, workerData } from "node:worker_threads";
import mysql from "mysql2/promise";
import { cacheUsageFromMetadata } from "./provider-usage-metadata.mjs";
import { finishEventPage, finishHistoryPage } from "./history-page.mjs";

const config = workerData;
const poolOptions = {
  host: config.host,
  port: config.port,
  user: config.user,
  password: config.password,
  database: config.database,
  waitForConnections: true,
  queueLimit: 64,
  connectTimeout: 5000,
  multipleStatements: false,
  dateStrings: true,
};
// Preserve the original maximum of eight connections while preventing queued
// session/job creation locks from consuming the connections used by leases,
// cancellation and bounded history reads. Each creation kind has its own lane.
const pool = mysql.createPool({ ...poolOptions, connectionLimit: 6 });
const sessionCreationPool = mysql.createPool({ ...poolOptions, connectionLimit: 1 });
const jobCreationPool = mysql.createPool({ ...poolOptions, connectionLimit: 1 });

const TERMINAL = "('completed','needs_clarification','partial','failed','cancelled','timed_out')";
// SYSDATE is evaluated by MySQL at execution time, not supplied by the worker.
const DB_NOW_MS = "CAST(UNIX_TIMESTAMP(SYSDATE(3)) * 1000 AS UNSIGNED)";

const statements = `
  CREATE TABLE IF NOT EXISTS state_authority (
    singleton TINYINT PRIMARY KEY,
    mode VARCHAR(32) NULL,
    policy_json TEXT NULL,
    policy_version INT NULL,
    policy_revision BIGINT UNSIGNED NOT NULL DEFAULT 1
  ) ENGINE=InnoDB;
  CREATE TABLE IF NOT EXISTS visitor_session_admissions (
    visitor_id VARCHAR(64) NOT NULL,
    creation_key VARCHAR(128) NOT NULL,
    session_id VARCHAR(64) NOT NULL UNIQUE,
    requested_title VARCHAR(255) NOT NULL,
    accepted_ms BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (visitor_id, creation_key),
    KEY idx_session_admission_window (visitor_id, accepted_ms)
  ) ENGINE=InnoDB;
  CREATE TABLE IF NOT EXISTS state_authority_history (
    revision BIGINT UNSIGNED PRIMARY KEY,
    previous_policy TEXT NOT NULL,
    next_policy TEXT NOT NULL,
    changed_at_ms BIGINT UNSIGNED NOT NULL
  ) ENGINE=InnoDB;
  CREATE TABLE IF NOT EXISTS executor_activity (
    kind VARCHAR(16) NOT NULL,
    instance_id VARCHAR(64) NOT NULL,
    last_seen_ms BIGINT UNSIGNED NOT NULL,
    last_progress_ms BIGINT UNSIGNED NULL,
    PRIMARY KEY (kind, instance_id),
    KEY idx_executor_seen (kind, last_seen_ms)
  ) ENGINE=InnoDB;
  CREATE TABLE IF NOT EXISTS visitor_credentials (
    visitor_id VARCHAR(64) PRIMARY KEY,
    credential_hash CHAR(64) NOT NULL UNIQUE,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    expires_at_ms BIGINT UNSIGNED NOT NULL,
    revoked_at_ms BIGINT UNSIGNED NULL,
    KEY idx_visitor_expiry (expires_at_ms)
  ) ENGINE=InnoDB;
  CREATE TABLE IF NOT EXISTS visitor_bootstrap_limit (
    singleton TINYINT PRIMARY KEY,
    window_start_ms BIGINT UNSIGNED NOT NULL,
    accepted INT UNSIGNED NOT NULL
  ) ENGINE=InnoDB;
  CREATE TABLE IF NOT EXISTS visitor_admission_mutex (singleton TINYINT PRIMARY KEY) ENGINE=InnoDB;
  CREATE TABLE IF NOT EXISTS visitor_admissions (
    job_id VARCHAR(64) PRIMARY KEY,
    visitor_id VARCHAR(64) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    accepted_ms BIGINT UNSIGNED NOT NULL,
    request_hash CHAR(64) NULL,
    UNIQUE KEY uniq_visitor_idempotency (visitor_id, idempotency_key),
    KEY idx_visitor_admissions_window (visitor_id, accepted_ms)
  ) ENGINE=InnoDB;
  CREATE TABLE IF NOT EXISTS sessions (
    session_id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    role VARCHAR(64) NOT NULL,
    actor_id VARCHAR(64) NOT NULL,
    slots_json LONGTEXT NULL,
    bindings_json LONGTEXT NOT NULL,
    created_at VARCHAR(40) NOT NULL
  ) ENGINE=InnoDB;
  CREATE TABLE IF NOT EXISTS history_writers (
    kind VARCHAR(16) PRIMARY KEY
  ) ENGINE=InnoDB;
  CREATE TABLE IF NOT EXISTS session_asset_budgets (
    session_id VARCHAR(64) PRIMARY KEY,
    used_bytes BIGINT NOT NULL,
    max_bytes BIGINT NOT NULL
  ) ENGINE=InnoDB;
  CREATE TABLE IF NOT EXISTS messages (
    message_id VARCHAR(64) PRIMARY KEY,
    session_id VARCHAR(64) NOT NULL,
    job_id VARCHAR(64) NULL,
    role VARCHAR(16) NOT NULL,
    text LONGTEXT NOT NULL,
    created_at VARCHAR(40) NOT NULL,
    KEY idx_messages_session (session_id, created_at)
  ) ENGINE=InnoDB;
  CREATE TABLE IF NOT EXISTS resources (
    resource_id VARCHAR(80) PRIMARY KEY,
    session_id VARCHAR(64) NOT NULL,
    body_json LONGTEXT NOT NULL
  ) ENGINE=InnoDB;
  CREATE TABLE IF NOT EXISTS jobs (
    job_id VARCHAR(64) PRIMARY KEY,
    session_id VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL,
    user_text LONGTEXT NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    turn_json LONGTEXT NOT NULL,
    analysis_json LONGTEXT NULL,
    error_json LONGTEXT NULL,
    usage_json LONGTEXT NULL,
    version INT NOT NULL,
    next_seq INT NOT NULL,
    fence INT NOT NULL,
    lease_owner VARCHAR(128) NULL,
    lease_until BIGINT NULL,
    cancel_requested TINYINT NOT NULL DEFAULT 0,
    created_at VARCHAR(40) NOT NULL,
    queued_ms BIGINT UNSIGNED NULL,
    started_at VARCHAR(40) NULL,
    finished_at VARCHAR(40) NULL,
    model_id VARCHAR(128) NULL,
    reasoning VARCHAR(16) NULL,
    revision_count INT NOT NULL DEFAULT 0,
    tool_call_count INT NOT NULL DEFAULT 0,
    tool_call_limit INT NULL,
    UNIQUE KEY uniq_idem (session_id, idempotency_key),
    KEY idx_claim (status, lease_until, created_at)
  ) ENGINE=InnoDB;
  CREATE TABLE IF NOT EXISTS job_events (
    job_id VARCHAR(64) NOT NULL,
    seq INT NOT NULL,
    type VARCHAR(64) NOT NULL,
    at VARCHAR(40) NOT NULL,
    payload_json LONGTEXT NOT NULL,
    PRIMARY KEY (job_id, seq)
  ) ENGINE=InnoDB;
  CREATE TABLE IF NOT EXISTS outbox (
    outbox_id BIGINT PRIMARY KEY AUTO_INCREMENT,
    job_id VARCHAR(64) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    payload_json LONGTEXT NOT NULL,
    created_at VARCHAR(40) NOT NULL,
    created_ms BIGINT UNSIGNED NULL,
    dispatched_at VARCHAR(40) NULL,
    dispatch_attempts INT NOT NULL DEFAULT 0,
    UNIQUE KEY uniq_outbox (job_id, event_type),
    KEY idx_pending (dispatched_at, outbox_id)
  ) ENGINE=InnoDB;
  CREATE TABLE IF NOT EXISTS provider_steps (
    step_id VARCHAR(80) PRIMARY KEY,
    session_id VARCHAR(64) NOT NULL,
    job_id VARCHAR(64) NOT NULL,
    actor_id VARCHAR(64) NOT NULL,
    fence INT NOT NULL,
    provider VARCHAR(64) NOT NULL,
    model VARCHAR(128) NOT NULL,
    status VARCHAR(32) NOT NULL,
    input_tokens INT NULL,
    output_tokens INT NULL,
    usage_source VARCHAR(16) NOT NULL,
    duration_ms INT NULL,
    error_code VARCHAR(64) NULL,
    created_at VARCHAR(40) NOT NULL,
    estimated_input INT NOT NULL DEFAULT 0,
    reserved_output INT NOT NULL DEFAULT 0,
    reserved_total INT NOT NULL DEFAULT 0,
    estimate_source VARCHAR(32) NOT NULL DEFAULT 'char_estimate',
    settlement VARCHAR(32) NOT NULL DEFAULT 'pending',
    KEY idx_provider_job (job_id, created_at)
  ) ENGINE=InnoDB;
  CREATE TABLE IF NOT EXISTS turn_budgets (
    job_id VARCHAR(64) PRIMARY KEY,
    actor_id VARCHAR(64) NOT NULL,
    session_id VARCHAR(64) NOT NULL,
    max_tokens INT NOT NULL,
    context_window INT NOT NULL,
    max_output_tokens INT NOT NULL,
    max_model_calls INT NOT NULL,
    max_tool_calls INT NOT NULL,
    wall_clock_ms INT NOT NULL,
    max_resource_bytes INT NOT NULL,
    settled_input INT NOT NULL DEFAULT 0,
    settled_output INT NOT NULL DEFAULT 0,
    reserved_tokens INT NOT NULL DEFAULT 0,
    model_calls_settled INT NOT NULL DEFAULT 0,
    model_calls_reserved INT NOT NULL DEFAULT 0
  ) ENGINE=InnoDB;
  CREATE TABLE IF NOT EXISTS provider_payloads (
    payload_id VARCHAR(80) PRIMARY KEY,
    step_id VARCHAR(80) NOT NULL,
    session_id VARCHAR(64) NOT NULL,
    actor_id VARCHAR(64) NOT NULL,
    job_id VARCHAR(64) NOT NULL,
    kind VARCHAR(16) NOT NULL,
    body LONGTEXT NOT NULL,
    bytes INT NOT NULL,
    KEY idx_payload_job (job_id, actor_id)
  ) ENGINE=InnoDB;
  CREATE TABLE IF NOT EXISTS agent_snapshots (
    snapshot_id BIGINT PRIMARY KEY AUTO_INCREMENT,
    session_id VARCHAR(64) NOT NULL,
    job_id VARCHAR(64) NOT NULL,
    fence INT NOT NULL,
    kind VARCHAR(16) NOT NULL,
    body_json LONGTEXT NOT NULL,
    created_at VARCHAR(40) NOT NULL,
    KEY idx_snapshot_session (session_id, kind, snapshot_id),
    KEY idx_snapshot_job (job_id, snapshot_id)
  ) ENGINE=InnoDB;
`;
const ready = (async () => {
  for (const statement of statements.split(";").map((item) => item.trim()).filter(Boolean)) {
    await pool.query(statement);
  }
  await pool.query("INSERT IGNORE INTO history_writers (kind) VALUES ('sessions'), ('jobs')");
  await pool.query("INSERT IGNORE INTO visitor_bootstrap_limit (singleton, window_start_ms, accepted) VALUES (1, 0, 0)");
  await pool.query("INSERT IGNORE INTO visitor_admission_mutex (singleton) VALUES (1)");
  const [requestHashColumn] = await pool.query("SHOW COLUMNS FROM visitor_admissions LIKE 'request_hash'");
  if (!requestHashColumn.length) {
    try { await pool.query("ALTER TABLE visitor_admissions ADD COLUMN request_hash CHAR(64) NULL"); }
    catch (error) { if (error?.code !== "ER_DUP_FIELDNAME") throw error; }
  }
  for (const [table,column] of [["executor_activity","last_progress_ms"],["jobs","queued_ms"],["outbox","created_ms"]]) {
    const [existing] = await pool.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
    if (!existing.length) { try { await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} BIGINT UNSIGNED NULL`); } catch (error) { if (error?.code !== "ER_DUP_FIELDNAME") throw error; } }
  }
  const [authorityRevision] = await pool.query("SHOW COLUMNS FROM state_authority LIKE 'policy_revision'");
  if (!authorityRevision.length) { try { await pool.query("ALTER TABLE state_authority ADD COLUMN policy_revision BIGINT UNSIGNED NOT NULL DEFAULT 1"); } catch (error) { if (error?.code !== "ER_DUP_FIELDNAME") throw error; } }
  for (const [column, definition] of [["tool_call_count", "INT NOT NULL DEFAULT 0"], ["tool_call_limit", "INT NULL"]]) {
    const [existing] = await pool.query("SHOW COLUMNS FROM jobs LIKE ?", [column]);
    if (!existing.length) {
      try { await pool.query(`ALTER TABLE jobs ADD COLUMN ${column} ${definition}`); }
      catch (error) { if (error?.code !== "ER_DUP_FIELDNAME") throw error; }
    }
  }
  // An insertion sequence freezes page membership even for equal timestamps
  // and later backdated imports. This does not freeze mutable status/title.
  for (const table of ["sessions", "jobs"]) {
    const [columns] = await pool.query(`SHOW COLUMNS FROM ${table} LIKE 'history_seq'`);
    if (!columns.length) {
      try { await pool.query(`ALTER TABLE ${table} ADD COLUMN history_seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, ADD UNIQUE KEY idx_history_seq (history_seq)`); }
      catch (error) { if (error?.code !== "ER_DUP_FIELDNAME") throw error; }
    }
    const [actual] = await pool.query(`SHOW COLUMNS FROM ${table} LIKE 'history_seq'`);
    if (!actual[0]?.Extra?.includes("auto_increment")) throw new Error("history_schema_invalid");
  }
  for (const [table, name, columns] of [
    ["sessions", "idx_sessions_history", "actor_id, created_at, session_id"],
    ["jobs", "idx_jobs_history", "session_id, created_at, job_id"],
    ["jobs", "idx_jobs_active", "session_id, status, created_at, job_id"],
    ["jobs", "idx_jobs_queue_age", "status, queued_ms"],
    ["outbox", "idx_outbox_age", "dispatched_at, created_ms"],
  ]) {
    const [existing] = await pool.query(`SHOW INDEX FROM ${table} WHERE Key_name = ?`, [name]);
    if (!existing.length) {
      try { await pool.query(`CREATE INDEX ${name} ON ${table} (${columns})`); }
      catch (error) { if (error?.code !== "ER_DUP_KEYNAME") throw error; }
    }
    const [actual] = await pool.query(`SHOW INDEX FROM ${table} WHERE Key_name = ?`, [name]);
    if (actual.sort((a, b) => a.Seq_in_index - b.Seq_in_index).map(row => row.Column_name).join(", ") !== columns) throw new Error("history_schema_invalid");
  }
  await initializeAuthority();
})();

parentPort.on("message", (message) => {
  void ready.then(() => handle(message)).catch((error) => {
    const name = error instanceof Error && ["authority_mode_conflict", "authority_policy_conflict", "authority_legacy_data"].includes(error.message) ? error.message : "schema_failed";
    message.port.postMessage({ ok: false, name, message: "state initialization failed" });
  });
});

async function handle(message) {
  try {
    const result = await dispatch(message.op, message.args ?? []);
    message.port.postMessage({ ok: true, result });
  } catch (error) {
    message.port.postMessage({
      ok: false,
      name: error instanceof Error && error.message === "execution_fence_rejected" ? "execution_fence_rejected" : error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : "mysql error",
    });
  }
}

async function dispatch(op, args) {
  if (op === "ping") return "ok";
  if (op === "executorHeartbeat") {
    const [kind, id] = args;
    if (!['worker', 'dispatcher'].includes(kind) || !/^[0-9a-f-]{36}$/u.test(id)) throw new Error('invalid_executor_identity');
    await pool.query(`INSERT INTO executor_activity (kind,instance_id,last_seen_ms) VALUES (?,?,${DB_NOW_MS}) ON DUPLICATE KEY UPDATE last_seen_ms=${DB_NOW_MS}`, [kind,id]);
    return;
  }
  if (op === "executorStop") {
    const [kind,id] = args;
    if (!['worker', 'dispatcher'].includes(kind) || !/^[0-9a-f-]{36}$/u.test(id)) throw new Error('invalid_executor_identity');
    await pool.query('DELETE FROM executor_activity WHERE kind=? AND instance_id=?', [kind,id]);
    return;
  }
  if (op === "executorProgress") {
    const [kind,id] = args;
    if (!['worker','dispatcher'].includes(kind) || !/^[0-9a-f-]{36}$/u.test(id)) throw new Error('invalid_executor_identity');
    await pool.query(`UPDATE executor_activity SET last_progress_ms=${DB_NOW_MS} WHERE kind=? AND instance_id=?`, [kind,id]);
    return;
  }
  if (op === "executorProgressSummary") {
    const [maxAge,stall] = args;
    if (!Number.isSafeInteger(maxAge) || maxAge < 1000 || maxAge > 60000 || !Number.isSafeInteger(stall) || stall < maxAge || stall > 3600000) throw new Error('invalid_executor_age');
    const [rows] = await pool.query(`SELECT
      EXISTS(SELECT 1 FROM executor_activity WHERE kind='worker' AND last_seen_ms>${DB_NOW_MS}-? AND last_progress_ms>${DB_NOW_MS}-?) AS worker_progress,
      EXISTS(SELECT 1 FROM executor_activity WHERE kind='dispatcher' AND last_seen_ms>${DB_NOW_MS}-? AND last_progress_ms>${DB_NOW_MS}-?) AS dispatcher_progress,
      EXISTS(SELECT 1 FROM jobs WHERE status='queued' AND (queued_ms IS NULL OR queued_ms<${DB_NOW_MS}-?)) AS waiting,
      EXISTS(SELECT 1 FROM jobs WHERE status='running' AND lease_until>${DB_NOW_MS}) AS busy,
      EXISTS(SELECT 1 FROM outbox o JOIN jobs j ON j.job_id=o.job_id WHERE o.dispatched_at IS NULL AND j.status='queued' AND (o.created_ms IS NULL OR o.created_ms<${DB_NOW_MS}-?)) AS pending`, [maxAge,stall,maxAge,stall,stall,stall]);
    const r=rows[0]; const worker = !Number(r.waiting) ? (Number(r.busy) ? 'busy' : 'idle') : Number(r.busy) ? 'busy_waiting' : Number(r.worker_progress) ? 'waiting' : 'stalled';
    const dispatcher = !Number(r.pending) ? 'idle' : Number(r.dispatcher_progress) ? 'waiting' : 'stalled';
    return {worker,dispatcher,blocked:worker==='stalled' || dispatcher==='stalled'};
  }
  if (op === "executorReadiness") {
    const [maxAge] = args;
    if (!Number.isSafeInteger(maxAge) || maxAge < 1000 || maxAge > 60000) throw new Error('invalid_executor_age');
    const [rows] = await pool.query(`SELECT DISTINCT kind FROM executor_activity WHERE last_seen_ms > ${DB_NOW_MS} - ?`, [maxAge]);
    return { worker: rows.some(row => row.kind === 'worker'), dispatcher: rows.some(row => row.kind === 'dispatcher') };
  }
  if (op === "close") {
    await Promise.all([pool.end(), sessionCreationPool.end(), jobCreationPool.end()]);
    return "closed";
  }
  if (op === "createSession") return createSession(args[0], args[1]);
  if (op === "createVisitor") return createVisitor(args[0]);
  if (op === "lookupVisitor") return lookupVisitor(args[0]);
  if (op === "revokeVisitor") return revokeVisitor(args[0]);
  if (op === "recoverVisitorSubmission") return recoverVisitorSubmission(args[0], args[1], args[2]);
  if (op === "getSession") return getSession(args[0]);
  if (op === "listSessions") return listSessions();
  if (op === "listSessionSummaries") return listSessionSummaries(args[0], args[1]);
  if (op === "getSessionMetadata") return getSessionMetadata(args[0], args[1]);
  if (op === "listJobSummaries") return listJobSummaries(args[0], args[1], args[2]);
  if (op === "getJobHead") return getJobHead(args[0]);
  if (op === "readJobEvents") return readJobEvents(args[0], args[1]);
  if (op === "saveSession") return saveSession(args[0], args[1]);
  if (op === "upsertContractBinding") return upsertContractBinding(args[0], args[1], args[2], args[3], args[4]);
  if (op === "addMessage") return addMessage(args[0]);
  if (op === "listMessages") return listMessages(args[0]);
  if (op === "saveResource") return saveResource(args[0], args[1]);
  if (op === "getResource") return getResource(args[0]);
  if (op === "countResources") return countResources();
  if (op === "createJob") return createJob(args[0]);
  if (op === "getJob") return getJob(args[0]);
  if (op === "listJobs") return listJobs(args[0]);
  if (op === "claimNext") return claimNext(args[0], args[1], args[2]);
  if (op === "claimJob") return claimJob(args[0], args[1], args[2], args[3]);
  if (op === "heartbeat") return heartbeat(args[0], args[1], args[2], args[3], args[4]);
  if (op === "appendEvent") return appendEvent(args[0], args[1], args[2], args[3], args[4]);
  if (op === "finish") return finish(args[0], args[1], args[2], args[3], args[4], args[5], args[6]);
  if (op === "requestCancel") return requestCancel(args[0]);
  if (op === "expireLease") return expireLease(args[0]);
  if (op === "listPendingOutbox") return listPendingOutbox(args[0]);
  if (op === "markOutboxDispatched") return markOutboxDispatched(args[0]);
  if (op === "recordOutboxAttempt") return recordOutboxAttempt(args[0]);
  if (op === "saveAgentSnapshot") return saveAgentSnapshot(args[0]);
  if (op === "loadAgentSnapshot") return loadAgentSnapshot(args[0], args[1]);
  if (op === "beginProviderStep") return beginProviderStep(args[0]);
  if (op === "settleProviderStep") return settleProviderStep(args[0]);
  if (op === "listProviderSteps") return listProviderSteps(args[0]);
  if (op === "getTurnBudget") return getTurnBudget(args[0]);
  if (op === "reserveRevision") return reserveRevision(args[0], args[1], args[2]);
  if (op === "reserveToolCall") return reserveToolCall(args[0], args[1], args[2]);
  if (op === "reserveAssetRead") return reserveAssetRead(args[0], args[1], args[2], args[3]);
  if (op === "saveProviderPayload") return saveProviderPayload(args[0]);
  if (op === "listProviderPayloads") return listProviderPayloads(args[0], args[1]);
  if (op === "readProviderPayload") return readProviderPayload(args[0]);
  throw new Error(`未知状态操作 ${op}`);
}

async function transaction(fn, target = pool, readCommitted = false) {
  const conn = await target.getConnection();
  try {
    if (readCommitted) await conn.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await conn.beginTransaction();
    const value = await fn(conn);
    await conn.commit();
    return value;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

const authority = config.authority ?? { mode: "local_mock" };
function canonicalPolicy(policy) {
  const fields = ["version", "windowMs", "maxAccepted", "maxActive", "maxGlobalActive", "sessionWindowMs", "maxSessionsPerWindow", "maxSessions", "bootstrapWindowMs", "bootstrapMaxCreates"];
  if (!policy || fields.some(key => !Number.isSafeInteger(policy[key])) || policy.version !== 1 || ["windowMs", "sessionWindowMs", "bootstrapWindowMs"].some(key => policy[key] < 1000 || policy[key] > 86400000) || ["maxAccepted", "maxActive", "maxGlobalActive", "maxSessionsPerWindow", "maxSessions", "bootstrapMaxCreates"].some(key => policy[key] < 1 || policy[key] > 10000)) throw new Error("authority_policy_invalid");
  return JSON.stringify(Object.fromEntries(fields.map(key => [key, policy[key]])));
}
async function initializeAuthority() {
  if (!["local_mock", "controlled_visitor"].includes(authority.mode)) throw new Error("authority_mode_conflict");
  const policy = authority.mode === "controlled_visitor" ? canonicalPolicy(authority.policy) : null;
  await pool.query("INSERT IGNORE INTO state_authority (singleton,mode,policy_json,policy_version) VALUES (1,NULL,NULL,NULL)");
  await transaction(async conn => {
    const [rows] = await conn.query("SELECT mode,policy_json,policy_version FROM state_authority WHERE singleton=1 FOR UPDATE");
    const row = rows[0];
    if (row.mode === null) {
      const [legacy] = await conn.query("SELECT (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT COUNT(*) FROM jobs) AS jobs, (SELECT COUNT(*) FROM visitor_credentials) AS visitors, (SELECT COUNT(*) FROM sessions WHERE actor_id LIKE 'vis\\_%') AS visitor_sessions");
      if ((authority.mode === "controlled_visitor" && (Number(legacy[0].sessions) || Number(legacy[0].jobs) || Number(legacy[0].visitors))) || (authority.mode === "local_mock" && (Number(legacy[0].visitor_sessions) || Number(legacy[0].visitors)))) throw new Error("authority_legacy_data");
      await conn.query("UPDATE state_authority SET mode=?,policy_json=?,policy_version=? WHERE singleton=1", [authority.mode,policy,policy ? 1 : null]);
    } else if (row.mode !== authority.mode) throw new Error("authority_mode_conflict");
    else if ((row.policy_json ?? null) !== policy || (row.policy_version ?? null) !== (policy ? 1 : null)) throw new Error("authority_policy_conflict");
  });
}
async function requireAuthority(conn) {
  const [rows] = await conn.query("SELECT mode,policy_json,policy_version FROM state_authority WHERE singleton=1 FOR SHARE");
  const row = rows[0];
  if (!row || row.mode !== authority.mode) throw new Error("authority_mode_conflict");
  if (authority.mode === "controlled_visitor") {
    const policy = canonicalPolicy(authority.policy);
    if (row.policy_json !== policy || Number(row.policy_version) !== 1) throw new Error("authority_policy_conflict");
    return JSON.parse(policy);
  }
  return null;
}
async function requireVisitor(conn, input) {
  if (!input || !/^vis_[0-9a-f]{32}$/u.test(input.visitorId) || !/^[0-9a-f]{64}$/u.test(input.credentialHash ?? "")) { const e = new Error("visitor_required"); e.name = "visitor_required"; throw e; }
  const [visitors] = await conn.query(`SELECT visitor_id FROM visitor_credentials WHERE visitor_id=? AND credential_hash=? AND revoked_at_ms IS NULL AND expires_at_ms > ${DB_NOW_MS} FOR UPDATE`, [input.visitorId, input.credentialHash]);
  if (!visitors[0]) { const e = new Error("visitor_expired"); e.name = "visitor_expired"; throw e; }
}
async function recoverVisitorSubmission(sessionId, admission, key) {
  return transaction(async conn => {
    const policy = await requireAuthority(conn);
    if (!policy) throw new Error("authority_mode_conflict");
    await requireVisitor(conn, admission);
    if (!/^[0-9a-f]{64}$/u.test(admission.requestHash ?? "")) throw new Error("invalid_request_fingerprint");
    const [rows] = await conn.query("SELECT a.job_id,a.request_hash,j.session_id FROM visitor_admissions a JOIN jobs j ON j.job_id=a.job_id WHERE a.visitor_id=? AND a.idempotency_key=?", [admission.visitorId,key]);
    if (!rows[0]) return null;
    if (!rows[0].request_hash || rows[0].session_id !== sessionId || rows[0].request_hash !== admission.requestHash) { const e = new Error("idempotency_conflict"); e.name = "idempotency_conflict"; throw e; }
    return getJobOn(conn, String(rows[0].job_id));
  }, pool, true);
}

async function createVisitor(input) {
  if (!/^vis_[0-9a-f]{32}$/u.test(input.visitorId) || !/^[0-9a-f]{64}$/u.test(input.credentialHash) || !Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1 || input.ttlMs > 31 * 86400000 || !Number.isSafeInteger(input.windowMs) || input.windowMs < 1 || input.windowMs > 86400000 || !Number.isSafeInteger(input.maxCreates) || input.maxCreates < 1 || input.maxCreates > 10000) throw new Error("invalid_visitor_create");
  return transaction(async conn => {
    const policy = await requireAuthority(conn);
    if (!policy) throw new Error("authority_mode_conflict");
    const [limits] = await conn.query("SELECT window_start_ms, accepted FROM visitor_bootstrap_limit WHERE singleton=1 FOR UPDATE");
    const [times] = await conn.query(`SELECT ${DB_NOW_MS} AS now_ms`);
    const now = Number(times[0].now_ms), row = limits[0];
    const start = Number(row.window_start_ms), count = now - start >= policy.bootstrapWindowMs || now < start ? 0 : Number(row.accepted);
    if (count >= policy.bootstrapMaxCreates) return null;
    const expires = now + input.ttlMs;
    await conn.query("UPDATE visitor_bootstrap_limit SET window_start_ms=?, accepted=? WHERE singleton=1", [count === 0 ? now : start, count + 1]);
    await conn.query("INSERT INTO visitor_credentials (visitor_id,credential_hash,created_at_ms,expires_at_ms) VALUES (?,?,?,?)", [input.visitorId,input.credentialHash,now,expires]);
    return {visitor_id:input.visitorId,expires_at_ms:expires};
  }, sessionCreationPool);
}

async function lookupVisitor(hash) {
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/u.test(hash)) return null;
  const [rows] = await pool.query(`SELECT visitor_id, expires_at_ms FROM visitor_credentials WHERE credential_hash=? AND revoked_at_ms IS NULL AND expires_at_ms > ${DB_NOW_MS}`, [hash]);
  return rows[0] ? {visitor_id:String(rows[0].visitor_id),expires_at_ms:Number(rows[0].expires_at_ms)} : null;
}

async function revokeVisitor(id) {
  const [result] = await pool.query(`UPDATE visitor_credentials SET revoked_at_ms=${DB_NOW_MS} WHERE visitor_id=? AND revoked_at_ms IS NULL`, [id]);
  return result.affectedRows === 1;
}

async function createSession(session, admission) {
  return transaction(async (conn) => {
    const policy = await requireAuthority(conn);
    if (policy) {
      await requireVisitor(conn, admission);
      if (session.actor_id !== admission.visitorId || session.role !== "analyst" || typeof admission.creationKey !== "string" || !admission.creationKey.trim() || admission.creationKey.length > 128) { const e = new Error("visitor_required"); e.name = "visitor_required"; throw e; }
      const [existing] = await conn.query("SELECT s.*,a.requested_title FROM visitor_session_admissions a JOIN sessions s ON s.session_id=a.session_id WHERE a.visitor_id=? AND a.creation_key=?", [admission.visitorId,admission.creationKey]);
      if (existing[0]) {
        if (existing[0].requested_title !== session.title) { const e = new Error("idempotency_conflict"); e.name = "idempotency_conflict"; throw e; }
        return sessionFromRow(existing[0]);
      }
      const [times] = await conn.query(`SELECT ${DB_NOW_MS} AS now_ms`); const now = Number(times[0].now_ms);
      const [recent] = await conn.query("SELECT COUNT(*) AS n FROM visitor_session_admissions WHERE visitor_id=? AND accepted_ms>?", [admission.visitorId, now-policy.sessionWindowMs]);
      const [total] = await conn.query("SELECT COUNT(*) AS n FROM sessions WHERE actor_id=?", [admission.visitorId]);
      if (Number(recent[0].n) >= policy.maxSessionsPerWindow || Number(total[0].n) >= policy.maxSessions) { const e = new Error("visitor_session_limit"); e.name = "visitor_session_limit"; throw e; }
    } else if (admission) throw new Error("authority_mode_conflict");
    // Allocate insertion identities in commit order. AUTO_INCREMENT alone can
    // leave lower, uncommitted IDs behind a page's visible MAX(history_seq).
    await conn.query("SELECT kind FROM history_writers WHERE kind = 'sessions' FOR UPDATE");
    if (policy) await requireVisitor(conn, admission);
    await conn.query(
      "INSERT INTO sessions (session_id, title, role, actor_id, slots_json, bindings_json, created_at) VALUES (?, ?, ?, ?, ?, '[]', ?)",
      [session.session_id, session.title, session.role, session.actor_id || "demo-analyst", JSON.stringify(session.slots), session.created_at],
    );
    if (policy) await conn.query(`INSERT INTO visitor_session_admissions (visitor_id,creation_key,session_id,requested_title,accepted_ms) VALUES (?,?,?,?,${DB_NOW_MS})`, [admission.visitorId,admission.creationKey,session.session_id,session.title]);
    return session;
  }, sessionCreationPool, true);
}

async function getSession(sessionId) {
  const [rows] = await pool.query("SELECT * FROM sessions WHERE session_id = ?", [sessionId]);
  return rows[0] ? sessionFromRow(rows[0]) : null;
}

async function listSessions() {
  const [rows] = await pool.query("SELECT * FROM sessions ORDER BY created_at");
  return rows.map(sessionFromRow);
}

async function listSessionSummaries(actorId, page) {
  const [latest] = page.cursor ? [] : await pool.query("SELECT CAST(COALESCE(MAX(history_seq), 0) AS CHAR) AS n FROM sessions");
  const snapshot = page.cursor?.snapshot ?? String(latest[0].n);
  const before = page.cursor;
  const [rows] = await pool.query(`SELECT session_id, LEFT(title, 200) AS title, role, actor_id, created_at FROM sessions
    WHERE actor_id = ? AND history_seq <= ? ${before ? "AND (created_at < ? OR (created_at = ? AND session_id < ?))" : ""}
    ORDER BY created_at DESC, session_id DESC LIMIT ?`, [actorId, snapshot, ...(before ? [before.at, before.at, before.id] : []), page.limit + 1]);
  return finishHistoryPage(rows, page, "sessions", actorId, snapshot, "session_id");
}

async function getSessionMetadata(sessionId, actorId) {
  const [rows] = await pool.query("SELECT session_id, LEFT(title, 200) AS title, role, actor_id, created_at FROM sessions WHERE session_id = ? AND actor_id = ?", [sessionId, actorId]);
  if (!rows[0]) return null;
  const [active] = await pool.query("SELECT job_id FROM jobs WHERE session_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC, job_id DESC LIMIT 1", [sessionId]);
  return { ...rows[0], active_job_id: active[0]?.job_id ?? null };
}

async function listJobSummaries(sessionId, actorId, page) {
  const [latest] = page.cursor ? [] : await pool.query("SELECT CAST(COALESCE(MAX(history_seq), 0) AS CHAR) AS n FROM jobs");
  const snapshot = page.cursor?.snapshot ?? String(latest[0].n);
  const before = page.cursor;
  const [rows] = await pool.query(`SELECT j.job_id, j.session_id, j.status, LEFT(j.user_text, 240) AS user_text_preview, j.created_at
    FROM jobs j WHERE j.session_id = ? AND j.history_seq <= ? AND EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = j.session_id AND s.actor_id = ?)
    ${before ? "AND (j.created_at < ? OR (j.created_at = ? AND j.job_id < ?))" : ""}
    ORDER BY j.created_at DESC, j.job_id DESC LIMIT ?`, [sessionId, snapshot, actorId, ...(before ? [before.at, before.at, before.id] : []), page.limit + 1]);
  return finishHistoryPage(rows, page, "jobs", `${actorId}/${sessionId}`, snapshot, "job_id");
}

async function getJobHead(jobId) {
  const [rows] = await pool.query("SELECT job_id, session_id, status, next_seq - 1 AS last_seq FROM jobs WHERE job_id = ?", [jobId]);
  return rows[0] ?? null;
}

async function readJobEvents(jobId, after) {
  const head = await getJobHead(jobId);
  if (!head) return null;
  const [rows] = await pool.query(`SELECT seq, type, at, CASE WHEN OCTET_LENGTH(payload_json) <= 65536 THEN payload_json ELSE NULL END AS payload_json
    FROM job_events WHERE job_id = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT 32`, [jobId, after, head.last_seq]);
  return finishEventPage(head, rows, after);
}

async function assertExecutionLease(conn, sessionId, lease) {
  const [rows] = await conn.query("SELECT lease_until FROM jobs WHERE job_id = ? AND session_id = ? AND lease_owner = ? AND fence = ? AND status = 'running' AND cancel_requested = 0 FOR UPDATE", [lease.jobId, sessionId, lease.owner, lease.fence]);
  if (!rows[0] || !(await unexpired(conn, rows[0]))) throw new Error("execution_fence_rejected");
}

async function unexpired(conn, row) {
  const [times] = await conn.query(`SELECT ${DB_NOW_MS} AS now_ms`);
  return row.lease_until !== null && Number(row.lease_until) > Number(times[0].now_ms);
}

async function saveSession(session, lease) {
  return transaction(async (conn) => {
    if (lease) await assertExecutionLease(conn, session.session_id, lease);
    await conn.query("UPDATE sessions SET title = ?, slots_json = ?, bindings_json = ? WHERE session_id = ?", [
      session.title, JSON.stringify(session.slots), JSON.stringify(session.bindings), session.session_id,
    ]);
    return null;
  });
}

async function upsertContractBinding(sessionId, binding, role, actorId, lease) {
  return transaction(async (conn) => {
    if (lease) await assertExecutionLease(conn, sessionId, lease);
    const [rows] = await conn.query("SELECT role, actor_id, bindings_json FROM sessions WHERE session_id = ? FOR UPDATE", [sessionId]);
    const row = rows[0];
    if (!row || binding.session_id !== sessionId || row.role !== role || (row.actor_id ?? "") !== (actorId ?? "")) throw new Error("binding_session_changed");
    // The session row may have been locked until after this lease expired.
    if (lease) await assertExecutionLease(conn, sessionId, lease);
    const current = parseJson(row.bindings_json);
    if (!Array.isArray(current)) throw new Error("binding_state_invalid");
    const bindings = [...current.filter((item) => item.table !== binding.table), binding];
    await conn.query("UPDATE sessions SET bindings_json = ? WHERE session_id = ?", [JSON.stringify(bindings), sessionId]);
    if (lease) await assertExecutionLease(conn, sessionId, lease);
    return null;
  });
}

async function addMessage(message) {
  await pool.query("INSERT INTO messages (message_id, session_id, job_id, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
    message.message_id,
    message.session_id,
    message.job_id,
    message.role,
    message.text,
    message.created_at,
  ]);
  return null;
}

async function listMessages(sessionId) {
  const [rows] = await pool.query("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at", [sessionId]);
  return rows.map((row) => ({
    message_id: String(row.message_id),
    session_id: String(row.session_id),
    job_id: row.job_id ? String(row.job_id) : null,
    role: "user",
    text: String(row.text),
    created_at: String(row.created_at),
  }));
}

async function saveResource(resource, lease) {
  return transaction(async (conn) => {
    if (lease) {
      if (resource.job_id !== lease.jobId) throw new Error("execution_fence_rejected");
      await assertExecutionLease(conn, resource.session_id, lease);
    }
    await conn.query("INSERT INTO resources (resource_id, session_id, body_json) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE body_json = VALUES(body_json)", [resource.resource_id, resource.session_id, JSON.stringify(resource)]);
    return null;
  });
}

async function getResource(resourceId) {
  const [rows] = await pool.query("SELECT body_json FROM resources WHERE resource_id = ?", [resourceId]);
  return rows[0] ? parseJson(rows[0].body_json) : null;
}

async function countResources() {
  const [rows] = await pool.query("SELECT COUNT(*) AS n FROM resources");
  return Number(rows[0].n);
}

async function createJob(input) {
  return transaction(async (conn) => {
    const policy = await requireAuthority(conn);
    const [sessions] = await conn.query("SELECT session_id, actor_id FROM sessions WHERE session_id = ? FOR UPDATE", [input.job.session_id]);
    const admission = input.visitorAdmission;
    if (policy && !admission) { const e = new Error("visitor_required"); e.name = "visitor_required"; throw e; }
    if (!policy && admission) throw new Error("authority_mode_conflict");
    if (admission && (!sessions[0] || sessions[0].actor_id !== admission.visitorId)) { const error = new Error("visitor_not_owner"); error.name = "visitor_not_owner"; throw error; }
    if (admission) {
      await requireVisitor(conn, admission);
      if (!/^[0-9a-f]{64}$/u.test(admission.requestHash ?? "")) throw new Error("invalid_request_fingerprint");
      const [replayed] = await conn.query("SELECT j.job_id, j.session_id, j.user_text, j.model_id, j.reasoning, a.request_hash FROM visitor_admissions a JOIN jobs j ON j.job_id=a.job_id WHERE a.visitor_id=? AND a.idempotency_key=?", [admission.visitorId, input.job.idempotency_key]);
      if (replayed[0]) {
        if (!replayed[0].request_hash || replayed[0].request_hash !== admission.requestHash || replayed[0].session_id !== input.job.session_id || replayed[0].user_text !== input.job.user_text) { const error = new Error("idempotency_conflict"); error.name = "idempotency_conflict"; throw error; }
        return getJobOn(conn, String(replayed[0].job_id));
      }
    }
    const [existing] = await conn.query("SELECT job_id, user_text, model_id, reasoning FROM jobs WHERE session_id = ? AND idempotency_key = ?", [
      input.job.session_id,
      input.job.idempotency_key,
    ]);
    if (existing[0]) {
      if (policy) { const e = new Error("visitor_receipt_missing"); e.name = "visitor_receipt_missing"; throw e; }
      if (String(existing[0].user_text) !== input.job.user_text || (input.visitorAdmission && ((existing[0].model_id ?? null) !== (input.job.model_id ?? null) || (existing[0].reasoning ?? null) !== (input.job.reasoning ?? null)))) {
        const error = new Error("idempotency_conflict");
        error.name = "idempotency_conflict";
        throw error;
      }
      return getJobOn(conn, String(existing[0].job_id));
    }
    // Every creator takes this mutex so that controlled-mode capacity counts
    // cannot race another process using the same authoritative job table.
    await conn.query("SELECT singleton FROM visitor_admission_mutex WHERE singleton=1 FOR UPDATE");
    let acceptedMs = null;
    if (admission) {
      await requireVisitor(conn, admission);
      const [times] = await conn.query(`SELECT ${DB_NOW_MS} AS now_ms`); const now = Number(times[0].now_ms);
      const [accepted] = await conn.query("SELECT COUNT(*) AS n FROM visitor_admissions WHERE visitor_id=? AND accepted_ms > ?", [admission.visitorId, now - policy.windowMs]);
      const [activeVisitor] = await conn.query(`SELECT COUNT(*) AS n FROM jobs j JOIN sessions s ON s.session_id=j.session_id WHERE s.actor_id=? AND j.status NOT IN ${TERMINAL}`, [admission.visitorId]);
      const [activeGlobal] = await conn.query(`SELECT COUNT(*) AS n FROM jobs WHERE status NOT IN ${TERMINAL}`);
      const code = Number(accepted[0].n) >= policy.maxAccepted ? "visitor_rate_limit" : Number(activeVisitor[0].n) >= policy.maxActive ? "visitor_active_limit" : Number(activeGlobal[0].n) >= policy.maxGlobalActive ? "global_active_limit" : null;
      if (code) { const error = new Error(code); error.name = code; throw error; }
      acceptedMs = now;
    }
    // The session row above serializes all createJob calls for this session.
    // A locking range scan here additionally acquires InnoDB next-key/gap
    // locks in jobs, so concurrent inserts into *different* sessions can
    // deadlock one another. A consistent read after the session lock sees all
    // previously committed submissions for this session; a concurrently
    // finishing job can only make this check conservatively return busy.
    const [active] = await conn.query(`SELECT job_id FROM jobs WHERE session_id = ? AND status NOT IN ${TERMINAL}`, [input.job.session_id]);
    if (active[0]) {
      const error = new Error("session_busy");
      error.name = "session_busy";
      throw error;
    }
    await conn.query("UPDATE sessions SET title = ?, slots_json = ? WHERE session_id = ?", [
      input.session.title,
      JSON.stringify(input.session.slots),
      input.session.session_id,
    ]);
    // Only creation uses this short lock; event, heartbeat, cancellation and
    // provider writes do not contend on it. Keep the session -> history order.
    await conn.query("SELECT kind FROM history_writers WHERE kind = 'jobs' FOR UPDATE");
    if (admission) await requireVisitor(conn, admission);
    await conn.query(
      `INSERT INTO jobs (
        job_id, session_id, status, user_text, idempotency_key, turn_json, analysis_json, error_json, queued_ms,
        version, next_seq, fence, lease_owner, lease_until, cancel_requested, created_at, model_id, reasoning
      ) VALUES (?, ?, 'queued', ?, ?, ?, NULL, NULL, ${DB_NOW_MS}, 1, 2, 0, NULL, NULL, 0, ?, ?, ?)`,
      [input.job.job_id, input.job.session_id, input.job.user_text, input.job.idempotency_key, JSON.stringify(input.job.turn), input.job.created_at, input.job.model_id ?? null, input.job.reasoning ?? null],
    );
    await insertEvent(conn, input.job.job_id, 1, "job_queued", { status: "queued" });
    await conn.query("INSERT INTO messages (message_id, session_id, job_id, role, text, created_at) VALUES (?, ?, ?, 'user', ?, ?)", [
      input.message.message_id,
      input.message.session_id,
      input.job.job_id,
      input.message.text,
      input.message.created_at,
    ]);
    await conn.query(`INSERT INTO outbox (job_id, event_type, payload_json, created_at, created_ms) VALUES (?, 'job_queued', ?, ?, ${DB_NOW_MS})`, [
      input.job.job_id,
      JSON.stringify({ job_id: input.job.job_id }),
      input.job.created_at,
    ]);
    if (admission) await conn.query("INSERT INTO visitor_admissions (job_id, visitor_id, idempotency_key, accepted_ms, request_hash) VALUES (?,?,?,?,?)", [input.job.job_id, admission.visitorId, input.job.idempotency_key, acceptedMs, admission.requestHash]);
    return getJobOn(conn, input.job.job_id);
  }, jobCreationPool, true);
}

async function getJob(jobId) {
  return getJobOn(pool, jobId);
}

async function listJobs(sessionId) {
  const [rows] = await pool.query("SELECT * FROM jobs WHERE session_id = ? ORDER BY created_at", [sessionId]);
  const jobs = [];
  for (const row of rows) jobs.push(await jobFromRow(pool, row));
  return jobs;
}

async function claimNext(owner, _now, leaseMs) {
  return transaction(async (conn) => {
    const [rows] = await conn.query(
      `SELECT job_id FROM jobs
       WHERE status = 'queued' OR (status = 'running' AND lease_until IS NOT NULL AND lease_until < ${DB_NOW_MS})
       ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    if (!rows[0]) return null;
    return claimRow(conn, String(rows[0].job_id), owner, leaseMs);
  });
}

async function claimJob(jobId, owner, _now, leaseMs) {
  return transaction(async (conn) => claimRow(conn, jobId, owner, leaseMs));
}

async function claimRow(conn, jobId, owner, leaseMs) {
  const [updated] = await conn.query(
    `UPDATE jobs
     SET status = 'running', lease_owner = ?, lease_until = ${DB_NOW_MS} + ?, fence = fence + 1, version = version + 1,
         started_at = COALESCE(started_at, DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ'))
     WHERE job_id = ? AND (status = 'queued' OR (status = 'running' AND lease_until IS NOT NULL AND lease_until < ${DB_NOW_MS}))`,
    [owner, leaseMs, jobId],
  );
  if (updated.affectedRows !== 1) return null;
  const job = await getJobOn(conn, jobId);
  return { job, owner, fence: job.fence };
}

async function heartbeat(jobId, owner, fence, _now, leaseMs) {
  const [updated] = await pool.query(
    `UPDATE jobs SET lease_until = ${DB_NOW_MS} + ? WHERE job_id = ? AND lease_owner = ? AND fence = ? AND status = 'running' AND lease_until > ${DB_NOW_MS}`,
    [leaseMs, jobId, owner, fence],
  );
  const [rows] = await pool.query(
    `SELECT cancel_requested FROM jobs WHERE job_id = ? AND lease_owner = ? AND fence = ? AND status = 'running' AND lease_until > ${DB_NOW_MS}`,
    [jobId, owner, fence],
  );
  return { ok: updated.affectedRows === 1 && rows[0] !== undefined, cancel_requested: rows[0]?.cancel_requested === 1 };
}

async function appendEvent(jobId, owner, fence, type, payload) {
  return transaction(async (conn) => {
    const [rows] = await conn.query("SELECT fence, lease_owner, lease_until, status, next_seq FROM jobs WHERE job_id = ? FOR UPDATE", [jobId]);
    const row = rows[0];
    if (!row || Number(row.fence) !== fence || row.lease_owner !== owner || row.status !== "running" || !(await unexpired(conn, row))) return null;
    const event = await insertEvent(conn, jobId, Number(row.next_seq), type, payload);
    const [bumped] = await conn.query("UPDATE jobs SET next_seq = next_seq + 1 WHERE job_id = ? AND fence = ? AND lease_owner = ?", [jobId, fence, owner]);
    if (bumped.affectedRows !== 1) return null;
    return event;
  });
}

async function finish(jobId, owner, fence, status, analysis, error, usage) {
  return transaction(async (conn) => {
    const [rows] = await conn.query("SELECT fence, lease_owner, lease_until, status, next_seq, cancel_requested FROM jobs WHERE job_id = ? FOR UPDATE", [jobId]);
    const row = rows[0];
    if (!row || Number(row.fence) !== fence || row.lease_owner !== owner || row.status !== "running" || !(await unexpired(conn, row))) return false;
    let terminal = row.cancel_requested === 1 && status !== "timed_out" && status !== "failed" ? "cancelled" : status;
    // A publisher also locks this row before advancing the pointer. Holding it
    // until the job commit makes the check and delivery one ordered operation.
    // Only server-eligible sources can contribute facts to the rendered answer.
    if (analysis && terminal !== "cancelled" && terminal !== "failed" && terminal !== "timed_out") {
      const eligible = (Array.isArray(analysis.sources) ? analysis.sources : []).filter((source) => source.evidence_eligible === true);
      if (eligible.length) {
        const [current] = await conn.query("SELECT b.result_json FROM freshness_pointer p JOIN freshness_batches b ON b.version = p.version AND b.state = 'published' WHERE p.singleton = 1 FOR UPDATE");
        let publication = null;
        try { publication = current[0] ? JSON.parse(String(current[0].result_json)) : null; } catch { /* fail closed */ }
        const consistent = publication && eligible.every((source) =>
          Array.isArray(source.tables) && source.tables.length > 0 &&
          Array.isArray(source.freshness_receipts) && source.freshness_receipts.length === source.tables.length &&
          source.tables.every((table) => source.freshness_receipts.some((receipt) =>
            receipt.table === table && receipt.publication_id === publication.publication_id &&
            Number(receipt.version) === Number(publication.version) && receipt.status === 'fresh' &&
            publication.tables?.[table]?.status === 'fresh')));
        if (!consistent) {
          terminal = "failed";
          analysis = null;
          error = { code: "freshness_version_changed", message: "新鲜度版本已变化，或查询来源缺少有效的权威新鲜度回执，证据没有交付。" };
        }
      }
    }
    const type = terminal === "cancelled" ? "job_cancelled" : terminal === "timed_out" ? "job_timed_out" : terminal === "failed" ? "job_failed" : "job_finished";
    await insertEvent(conn, jobId, Number(row.next_seq), type, { status: terminal, error_code: error?.code ?? null });
    const [updated] = await conn.query(
      `UPDATE jobs
       SET status = ?, analysis_json = ?, error_json = ?, usage_json = ?, finished_at = ?, lease_owner = NULL, lease_until = NULL,
           version = version + 1, next_seq = next_seq + 1
       WHERE job_id = ? AND fence = ? AND lease_owner = ? AND status = 'running'`,
      [
        terminal,
        ["cancelled", "failed", "timed_out"].includes(terminal) || !analysis ? null : JSON.stringify(analysis),
        error ? JSON.stringify(error) : null,
        usage ? JSON.stringify(usage) : null,
        new Date().toISOString(),
        jobId,
        fence,
        owner,
      ],
    );
    return updated.affectedRows === 1;
  });
}

async function requestCancel(jobId) {
  return transaction(async (conn) => {
    const [queued] = await conn.query(
      "UPDATE jobs SET status = 'cancelled', cancel_requested = 1, finished_at = ?, version = version + 1 WHERE job_id = ? AND status = 'queued'",
      [new Date().toISOString(), jobId],
    );
    if (queued.affectedRows === 1) {
      const [seqRows] = await conn.query("SELECT next_seq FROM jobs WHERE job_id = ?", [jobId]);
      await insertEvent(conn, jobId, Number(seqRows[0].next_seq), "job_cancelled", { status: "cancelled" });
      await conn.query("UPDATE jobs SET next_seq = next_seq + 1 WHERE job_id = ?", [jobId]);
      return getJobOn(conn, jobId);
    }
    await conn.query(`UPDATE jobs SET cancel_requested = 1 WHERE job_id = ? AND status NOT IN ${TERMINAL}`, [jobId]);
    return getJobOn(conn, jobId);
  });
}

async function expireLease(jobId) {
  await pool.query("UPDATE jobs SET lease_until = 0 WHERE job_id = ? AND status = 'running'", [jobId]);
  return null;
}

async function listPendingOutbox(limit) {
  const [rows] = await pool.query(
    "SELECT outbox_id, job_id, event_type, payload_json, dispatch_attempts FROM outbox WHERE dispatched_at IS NULL ORDER BY outbox_id LIMIT ?",
    [limit],
  );
  return rows.map((row) => ({
    outbox_id: Number(row.outbox_id),
    job_id: String(row.job_id),
    event_type: String(row.event_type),
    payload: parseJson(row.payload_json),
    attempts: Number(row.dispatch_attempts),
  }));
}

async function markOutboxDispatched(outboxId) {
  const [updated] = await pool.query("UPDATE outbox SET dispatched_at = ? WHERE outbox_id = ? AND dispatched_at IS NULL", [
    new Date().toISOString(),
    outboxId,
  ]);
  return updated.affectedRows === 1;
}

function stepFromRow(row) {
  return {
    ...cacheUsageFromMetadata(row.response_metadata, row),
    step_id: String(row.step_id),
    session_id: String(row.session_id),
    job_id: String(row.job_id),
    actor_id: String(row.actor_id),
    fence: Number(row.fence),
    provider: String(row.provider),
    model: String(row.model),
    status: String(row.status),
    input_tokens: row.input_tokens === null || row.input_tokens === undefined ? null : Number(row.input_tokens),
    output_tokens: row.output_tokens === null || row.output_tokens === undefined ? null : Number(row.output_tokens),
    usage_source: String(row.usage_source),
    duration_ms: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    error_code: row.error_code === null || row.error_code === undefined ? null : String(row.error_code),
    estimated_input: Number(row.estimated_input ?? 0),
    reserved_output: Number(row.reserved_output ?? 0),
    reserved_total: Number(row.reserved_total ?? 0),
    estimate_source: row.estimate_source === "utf8_byte_estimate" ? "utf8_byte_estimate" : "char_estimate",
    settlement: String(row.settlement ?? "pending"),
  };
}

async function beginProviderStep(input) {
  return transaction(async (conn) => {
    const [rows] = await conn.query("SELECT fence, lease_owner, lease_until, status, session_id FROM jobs WHERE job_id = ? FOR UPDATE", [input.jobId]);
    const row = rows[0];
    if (!row || Number(row.fence) !== input.fence || row.lease_owner !== input.owner || row.status !== "running" || row.session_id !== input.sessionId || !(await unexpired(conn, row))) {
      return { ok: false, code: "provider_fence_rejected" };
    }
    const reserve = input.estimatedInput + input.reservedOutput;
    if (!Number.isInteger(input.estimatedInput) || input.estimatedInput < 1 || !Number.isInteger(input.reservedOutput) || input.reservedOutput < 1) {
      return { ok: false, code: "budget_exhausted" };
    }
    await conn.query(
      `INSERT INTO turn_budgets (
        job_id, actor_id, session_id, max_tokens, context_window, max_output_tokens, max_model_calls,
        max_tool_calls, wall_clock_ms, max_resource_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE job_id = job_id`,
      [input.jobId, input.actorId, input.sessionId, input.maxTokens, input.contextWindow, input.reservedOutput, input.maxModelCalls, input.maxToolCalls, input.wallClockMs, input.maxResourceBytes],
    );
    const [budgets] = await conn.query("SELECT * FROM turn_budgets WHERE job_id = ? FOR UPDATE", [input.jobId]);
    const budget = budgets[0];
    const rejectAttempt = async (code, reason = code) => {
      await conn.query(`INSERT INTO provider_steps (
        step_id, session_id, job_id, actor_id, fence, provider, model, status, usage_source, created_at,
        estimated_input, reserved_output, reserved_total, estimate_source, settlement, error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'not_dispatched', 'unknown', ?, ?, ?, 0, ?, 'settled', ?)
      ON DUPLICATE KEY UPDATE step_id = step_id`, [input.stepId, input.sessionId, input.jobId, input.actorId, input.fence, input.provider, input.model, new Date().toISOString(), input.estimatedInput, input.reservedOutput, input.estimateSource, reason]);
      return { ok: false, code };
    };
    const [held] = await conn.query("SELECT status FROM provider_steps WHERE job_id = ? AND settlement = 'held_unknown' FOR UPDATE", [input.jobId]);
    if (held.length > 0) {
      return rejectAttempt(held.some((step) => step.status === "outcome_unknown") ? "provider_outcome_unknown" : "token_budget_unknown");
    }
    if (reserve > Number(budget.context_window)) return rejectAttempt("context_window_exceeded");
    const committed = Number(budget.settled_input) + Number(budget.settled_output) + Number(budget.reserved_tokens);
    if (committed + reserve > Number(budget.max_tokens)) return rejectAttempt("budget_exhausted", "task_token_budget_exceeded");
    if (Number(budget.model_calls_settled) + Number(budget.model_calls_reserved) >= Number(budget.max_model_calls)) {
      return rejectAttempt("budget_exhausted", "task_model_calls_exceeded");
    }
    await conn.query(
      `INSERT INTO provider_steps (
        step_id, session_id, job_id, actor_id, fence, provider, model, status, usage_source, created_at,
        estimated_input, reserved_output, reserved_total, estimate_source, settlement
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'dispatched', 'unknown', ?, ?, ?, ?, ?, 'pending')`,
      [input.stepId, input.sessionId, input.jobId, input.actorId, input.fence, input.provider, input.model, new Date().toISOString(), input.estimatedInput, input.reservedOutput, reserve, input.estimateSource],
    );
    await conn.query(
      "UPDATE turn_budgets SET reserved_tokens = reserved_tokens + ?, model_calls_reserved = model_calls_reserved + 1 WHERE job_id = ?",
      [reserve, input.jobId],
    );
    return { ok: true, code: "reserved" };
  });
}

async function settleProviderStep(input) {
  return transaction(async (conn) => {
    const [jobs] = await conn.query("SELECT fence, lease_owner, lease_until, status FROM jobs WHERE job_id = ? FOR UPDATE", [input.jobId]);
    const [steps] = await conn.query("SELECT * FROM provider_steps WHERE step_id = ? FOR UPDATE", [input.stepId]);
    const job = jobs[0];
    const step = steps[0];
    if (!step) return { ok: false, code: "step_missing" };
    if (step.job_id !== input.jobId) return { ok: false, code: "provider_fence_rejected" };
    if (!job || job.lease_owner !== input.owner || job.status !== "running" || Number(job.fence) !== input.fence || !(await unexpired(conn, job))) {
      return { ok: false, code: "provider_fence_rejected" };
    }
    const settlement = String(step.settlement ?? "pending");
    const sameTokens = nullable(step.input_tokens) === input.inputTokens && nullable(step.output_tokens) === input.outputTokens;
    if (settlement === "settled") {
      return sameTokens && String(step.status) === input.status && String(step.usage_source) === input.usageSource && (input.status !== "not_dispatched" || (step.error_code ?? null) === input.errorCode)
        ? { ok: true, code: "idempotent" }
        : { ok: false, code: "settlement_conflict" };
    }
    if (settlement === "held_unknown") {
      const sameHold = String(step.status) === input.status && (step.error_code ?? null) === input.errorCode && input.inputTokens === null && input.outputTokens === null;
      return sameHold ? { ok: true, code: "idempotent" } : { ok: false, code: "settlement_conflict" };
    }
    if (input.status === "outcome_unknown") {
      if (input.inputTokens !== null || input.outputTokens !== null || input.usageSource !== "unknown") {
        return { ok: false, code: "settlement_conflict" };
      }
      await conn.query(
        `UPDATE provider_steps
         SET status = 'outcome_unknown', settlement = 'held_unknown', input_tokens = NULL, output_tokens = NULL,
             usage_source = 'unknown', duration_ms = ?, error_code = ?
         WHERE step_id = ? AND settlement = 'pending'`,
        [input.durationMs, input.errorCode, input.stepId],
      );
      return { ok: true, code: "held" };
    }
    if (Number(step.fence) !== input.fence || String(step.status) !== "dispatched") {
      return { ok: false, code: "provider_fence_rejected" };
    }
    const [budgets] = await conn.query("SELECT job_id FROM turn_budgets WHERE job_id = ? FOR UPDATE", [input.jobId]);
    if (!budgets[0]) return { ok: false, code: "step_missing" };
    if (input.status === "not_dispatched") {
      if (input.inputTokens !== null || input.outputTokens !== null || input.usageSource !== "unknown" || !(input.errorCode === "provider_cancelled" || input.errorCode?.startsWith("global_budget_"))) return { ok: false, code: "settlement_conflict" };
      await conn.query("UPDATE turn_budgets SET reserved_tokens = reserved_tokens - ?, model_calls_reserved = model_calls_reserved - 1 WHERE job_id = ?", [Number(step.reserved_total), input.jobId]);
      await conn.query("UPDATE provider_steps SET status = 'not_dispatched', settlement = 'settled', input_tokens = NULL, output_tokens = NULL, usage_source = 'unknown', duration_ms = ?, error_code = ? WHERE step_id = ? AND settlement = 'pending'", [input.durationMs, input.errorCode, input.stepId]);
      return { ok: true, code: "not_dispatched" };
    }
    const known = input.status === "completed" && ["simulated", "reported"].includes(input.usageSource) && input.inputTokens !== null && input.outputTokens !== null && input.inputTokens + input.outputTokens > 0;
    if (known) {
      await conn.query(
        `UPDATE turn_budgets
         SET reserved_tokens = reserved_tokens - ?, settled_input = settled_input + ?, settled_output = settled_output + ?,
             model_calls_reserved = model_calls_reserved - 1, model_calls_settled = model_calls_settled + 1
         WHERE job_id = ?`,
        [Number(step.reserved_total), input.inputTokens, input.outputTokens, input.jobId],
      );
      await conn.query(
        `UPDATE provider_steps
         SET status = 'completed', settlement = 'settled', input_tokens = ?, output_tokens = ?, usage_source = ?,
             duration_ms = ?, error_code = NULL
         WHERE step_id = ? AND settlement = 'pending'`,
        [input.inputTokens, input.outputTokens, input.usageSource, input.durationMs, input.stepId],
      );
      return { ok: true, code: "settled" };
    }
    await conn.query(
      `UPDATE provider_steps
       SET status = ?, settlement = 'held_unknown', input_tokens = NULL, output_tokens = NULL, usage_source = 'unknown',
           duration_ms = ?, error_code = ?
       WHERE step_id = ? AND settlement = 'pending'`,
      [input.status === "completed" ? "completed" : "error", input.durationMs, input.errorCode, input.stepId],
    );
    return { ok: true, code: "held" };
  });
}

function nullable(value) {
  return value === null || value === undefined ? null : Number(value);
}

async function reserveRevision(jobId, owner, fence) {
  return transaction(async (conn) => {
    const [jobs] = await conn.query("SELECT lease_until FROM jobs WHERE job_id = ? AND fence = ? AND lease_owner = ? AND status = 'running' FOR UPDATE", [jobId, fence, owner]);
    if (!jobs[0] || !(await unexpired(conn, jobs[0]))) return { ok: false, count: 0 };
    const [updated] = await conn.query(
      `UPDATE jobs SET revision_count = revision_count + 1
       WHERE job_id = ? AND fence = ? AND lease_owner = ? AND status = 'running'`,
      [jobId, fence, owner],
    );
    const [rows] = await conn.query("SELECT revision_count FROM jobs WHERE job_id = ?", [jobId]);
    const count = Number(rows[0]?.revision_count ?? 0);
    return updated.affectedRows === 1 ? { ok: true, count } : { ok: false, count };
  });
}

async function reserveToolCall(sessionId, lease, maxCalls) {
  return transaction(async (conn) => {
    try { await assertExecutionLease(conn, sessionId, lease); } catch { return "lost"; }
    await conn.query("UPDATE jobs SET tool_call_limit = COALESCE(tool_call_limit, ?) WHERE job_id = ?", [maxCalls, lease.jobId]);
    const [updated] = await conn.query(`UPDATE jobs SET tool_call_count = tool_call_count + 1
      WHERE job_id = ? AND tool_call_count < LEAST(tool_call_limit, ?)`, [lease.jobId, maxCalls]);
    return updated.affectedRows === 1 ? "ok" : "budget_exhausted";
  });
}

async function reserveAssetRead(sessionId, lease, bytes, maxBytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0) return "lost";
  try { return await transaction(async (conn) => {
    if (lease) { try { await assertExecutionLease(conn, sessionId, lease); } catch { return "lost"; } }
    const [sessions] = await conn.query("SELECT session_id FROM sessions WHERE session_id = ? FOR UPDATE", [sessionId]);
    if (!sessions[0]) return "lost";
    // Acquiring the session/budget locks may have taken longer than the lease.
    // Recheck with database time after waiting; the job row stays locked.
    if (lease) { try { await assertExecutionLease(conn, sessionId, lease); } catch { return "lost"; } }
    await conn.query("INSERT IGNORE INTO session_asset_budgets (session_id, used_bytes, max_bytes) VALUES (?, 0, ?)", [sessionId, maxBytes]);
    if (lease) { try { await assertExecutionLease(conn, sessionId, lease); } catch { throw new Error("asset_read_lease_expired"); } }
    const [updated] = await conn.query("UPDATE session_asset_budgets SET used_bytes = used_bytes + ? WHERE session_id = ? AND used_bytes + ? <= LEAST(max_bytes, ?)", [bytes, sessionId, bytes, maxBytes]);
    // An existing budget row can itself be locked by another transaction;
    // roll back even an executed UPDATE if the lease expired while waiting.
    if (lease) { try { await assertExecutionLease(conn, sessionId, lease); } catch { throw new Error("asset_read_lease_expired"); } }
    // MySQL can report zero changed rows for a valid zero-byte page.
    if (bytes === 0) {
      const [rows] = await conn.query("SELECT used_bytes, max_bytes FROM session_asset_budgets WHERE session_id = ?", [sessionId]);
      return Number(rows[0]?.used_bytes) <= Math.min(Number(rows[0]?.max_bytes), maxBytes) ? "ok" : "budget_exhausted";
    }
    return updated.affectedRows === 1 ? "ok" : "budget_exhausted";
  }); } catch (error) { if (error?.message === "asset_read_lease_expired") return "lost"; throw error; }
}

async function getTurnBudget(jobId) {
  const [rows] = await pool.query("SELECT * FROM turn_budgets WHERE job_id = ?", [jobId]);
  const row = rows[0];
  if (!row) return null;
  return {
    job_id: String(row.job_id),
    settled_input: Number(row.settled_input),
    settled_output: Number(row.settled_output),
    reserved_tokens: Number(row.reserved_tokens),
    model_calls_settled: Number(row.model_calls_settled),
    model_calls_reserved: Number(row.model_calls_reserved),
    max_tokens: Number(row.max_tokens),
    context_window: Number(row.context_window),
    max_output_tokens: Number(row.max_output_tokens),
    max_model_calls: Number(row.max_model_calls),
    max_tool_calls: Number(row.max_tool_calls),
    wall_clock_ms: Number(row.wall_clock_ms),
    max_resource_bytes: Number(row.max_resource_bytes),
  };
}

async function saveProviderPayload(input) {
  return transaction(async (conn) => {
    try { await assertExecutionLease(conn, input.sessionId, { jobId: input.jobId, owner: input.owner, fence: input.fence }); } catch { return false; }
    const [rows] = await conn.query("SELECT step_id FROM provider_steps WHERE step_id = ? AND job_id = ? AND session_id = ? AND actor_id = ? AND fence = ? FOR UPDATE", [input.stepId, input.jobId, input.sessionId, input.actorId, input.fence]);
    if (!rows[0]) return false;
    await conn.query(`INSERT INTO provider_payloads (payload_id, step_id, session_id, actor_id, job_id, kind, body, bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [input.payloadId, input.stepId, input.sessionId, input.actorId, input.jobId, input.kind, input.body, Buffer.byteLength(input.body)]);
    return true;
  });
}

async function listProviderPayloads(jobId, actorId) {
  const [rows] = await pool.query(
    "SELECT payload_id, step_id, job_id, session_id, kind, bytes FROM provider_payloads WHERE job_id = ? AND actor_id = ? ORDER BY payload_id",
    [jobId, actorId],
  );
  return rows.map((row) => ({
    payload_id: String(row.payload_id),
    step_id: String(row.step_id),
    job_id: String(row.job_id),
    session_id: String(row.session_id),
    kind: String(row.kind),
    bytes: Number(row.bytes),
  }));
}

async function readProviderPayload(input) {
  const [rows] = await pool.query("SELECT * FROM provider_payloads WHERE payload_id = ?", [input.payloadId]);
  const row = rows[0];
  if (!row || String(row.actor_id) !== input.actorId || String(row.session_id) !== input.sessionId) return null;
  const body = String(row.body);
  const offset = Math.max(0, input.offset);
  const limit = Math.max(0, input.limit);
  return {
    payload_id: String(row.payload_id),
    kind: String(row.kind),
    total_bytes: Number(row.bytes),
    offset,
    limit,
    text: body.slice(offset, offset + limit),
  };
}

async function listProviderSteps(jobId) {
  const [rows] = await pool.query("SELECT s.*, p.body AS response_metadata FROM provider_steps s LEFT JOIN provider_payloads p ON p.payload_id = CONCAT('res_', s.step_id) AND p.step_id = s.step_id AND p.job_id = s.job_id AND p.session_id = s.session_id AND p.actor_id = s.actor_id AND p.kind = 'response' WHERE s.job_id = ? ORDER BY s.created_at", [jobId]);
  return rows.map(stepFromRow);
}

async function saveAgentSnapshot(input) {
  return transaction(async (conn) => {
    const [rows] = await conn.query("SELECT fence, lease_owner, lease_until, status, session_id FROM jobs WHERE job_id = ? FOR UPDATE", [input.jobId]);
    const row = rows[0];
    if (!row || Number(row.fence) !== input.fence || row.lease_owner !== input.owner || row.status !== "running" || row.session_id !== input.sessionId || !(await unexpired(conn, row))) return false;
    await conn.query(
      "INSERT INTO agent_snapshots (session_id, job_id, fence, kind, body_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [input.sessionId, input.jobId, input.fence, input.kind, JSON.stringify(input.body), new Date().toISOString()],
    );
    return true;
  });
}

async function loadAgentSnapshot(sessionId, selector) {
  const clauses = ["session_id = ?"];
  const params = [sessionId];
  if (selector?.jobId) {
    clauses.push("job_id = ?");
    params.push(selector.jobId);
  }
  if (selector?.kind) {
    clauses.push("kind = ?");
    params.push(selector.kind);
  }
  const [rows] = await pool.query(`SELECT * FROM agent_snapshots WHERE ${clauses.join(" AND ")} ORDER BY snapshot_id DESC LIMIT 1`, params);
  const row = rows[0];
  if (!row) return null;
  return {
    session_id: String(row.session_id),
    job_id: String(row.job_id),
    fence: Number(row.fence),
    kind: String(row.kind),
    body: parseJson(row.body_json),
  };
}

async function recordOutboxAttempt(outboxId) {
  await pool.query("UPDATE outbox SET dispatch_attempts = dispatch_attempts + 1 WHERE outbox_id = ? AND dispatched_at IS NULL", [outboxId]);
  return null;
}

async function getJobOn(conn, jobId) {
  const [rows] = await conn.query("SELECT * FROM jobs WHERE job_id = ?", [jobId]);
  if (!rows[0]) return null;
  return jobFromRow(conn, rows[0]);
}

async function jobFromRow(conn, row) {
  const [events] = await conn.query("SELECT * FROM job_events WHERE job_id = ? ORDER BY seq", [row.job_id]);
  return {
    job_id: String(row.job_id),
    session_id: String(row.session_id),
    status: String(row.status),
    user_text: String(row.user_text),
    idempotency_key: String(row.idempotency_key),
    turn: parseJson(row.turn_json),
    events: events.map((event) => ({
      seq: Number(event.seq),
      type: String(event.type),
      at: String(event.at),
      payload: parseJson(event.payload_json),
    })),
    next_seq: Number(row.next_seq),
    version: Number(row.version),
    analysis: row.analysis_json ? parseJson(row.analysis_json) : null,
    error: row.error_json ? parseJson(row.error_json) : null,
    abort_reason: null,
    fence: Number(row.fence),
    lease_owner: row.lease_owner ? String(row.lease_owner) : null,
    lease_until: row.lease_until === null || row.lease_until === undefined ? null : Number(row.lease_until),
    cancel_requested: Number(row.cancel_requested) === 1,
    simulated: true,
    usage: row.usage_json ? parseJson(row.usage_json) : null,
    model_id: row.model_id ? String(row.model_id) : null,
    reasoning: row.reasoning ? String(row.reasoning) : null,
    created_at: String(row.created_at),
    ...(row.started_at ? { started_at: String(row.started_at) } : {}),
    ...(row.finished_at ? { finished_at: String(row.finished_at) } : {}),
  };
}

function sessionFromRow(row) {
  return {
    session_id: String(row.session_id),
    title: String(row.title),
    role: String(row.role),
    actor_id: row.actor_id ? String(row.actor_id) : "demo-analyst",
    created_at: String(row.created_at),
    slots: row.slots_json ? parseJson(row.slots_json) : null,
    bindings: parseJson(row.bindings_json),
  };
}

async function insertEvent(conn, jobId, seq, type, payload) {
  const at = new Date().toISOString();
  await conn.query("INSERT INTO job_events (job_id, seq, type, at, payload_json) VALUES (?, ?, ?, ?, ?)", [
    jobId,
    seq,
    type,
    at,
    JSON.stringify(payload),
  ]);
  return { seq, type, at, payload };
}

function parseJson(value) {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function isTerminal(status) {
  return ["completed", "needs_clarification", "partial", "failed", "cancelled", "timed_out"].includes(status);
}
