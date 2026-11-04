import { parentPort, workerData } from "node:worker_threads";
import mysql from "mysql2/promise";

const config = workerData;
const pool = mysql.createPool({
  host: config.host,
  port: config.port,
  user: config.user,
  password: config.password,
  database: config.database,
  waitForConnections: true,
  connectionLimit: 8,
  queueLimit: 64,
  connectTimeout: 5000,
  multipleStatements: false,
  dateStrings: true,
});

const TERMINAL = "('completed','needs_clarification','partial','failed','cancelled','timed_out')";
// SYSDATE is evaluated by MySQL at execution time, not supplied by the worker.
const DB_NOW_MS = "CAST(UNIX_TIMESTAMP(SYSDATE(3)) * 1000 AS UNSIGNED)";

const statements = `
  CREATE TABLE IF NOT EXISTS sessions (
    session_id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    role VARCHAR(64) NOT NULL,
    actor_id VARCHAR(64) NOT NULL,
    slots_json LONGTEXT NULL,
    bindings_json LONGTEXT NOT NULL,
    created_at VARCHAR(40) NOT NULL
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
  for (const [column, definition] of [["tool_call_count", "INT NOT NULL DEFAULT 0"], ["tool_call_limit", "INT NULL"]]) {
    const [existing] = await pool.query("SHOW COLUMNS FROM jobs LIKE ?", [column]);
    if (!existing.length) {
      try { await pool.query(`ALTER TABLE jobs ADD COLUMN ${column} ${definition}`); }
      catch (error) { if (error?.code !== "ER_DUP_FIELDNAME") throw error; }
    }
  }
})();

parentPort.on("message", (message) => {
  void ready.then(() => handle(message)).catch((error) => {
    message.port.postMessage({ ok: false, name: "schema_failed", message: error instanceof Error ? error.message : "schema failed" });
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
  if (op === "close") {
    await pool.end();
    return "closed";
  }
  if (op === "createSession") return createSession(args[0]);
  if (op === "getSession") return getSession(args[0]);
  if (op === "listSessions") return listSessions();
  if (op === "saveSession") return saveSession(args[0], args[1]);
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
  if (op === "saveProviderPayload") return saveProviderPayload(args[0]);
  if (op === "listProviderPayloads") return listProviderPayloads(args[0], args[1]);
  if (op === "readProviderPayload") return readProviderPayload(args[0]);
  throw new Error(`未知状态操作 ${op}`);
}

async function transaction(fn) {
  const conn = await pool.getConnection();
  try {
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

async function createSession(session) {
  await pool.query(
    "INSERT INTO sessions (session_id, title, role, actor_id, slots_json, bindings_json, created_at) VALUES (?, ?, ?, ?, ?, '[]', ?)",
    [session.session_id, session.title, session.role, session.actor_id || "demo-analyst", JSON.stringify(session.slots), session.created_at],
  );
  return session;
}

async function getSession(sessionId) {
  const [rows] = await pool.query("SELECT * FROM sessions WHERE session_id = ?", [sessionId]);
  return rows[0] ? sessionFromRow(rows[0]) : null;
}

async function listSessions() {
  const [rows] = await pool.query("SELECT * FROM sessions ORDER BY created_at");
  return rows.map(sessionFromRow);
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
    await conn.query("SELECT session_id FROM sessions WHERE session_id = ? FOR UPDATE", [input.job.session_id]);
    const [existing] = await conn.query("SELECT job_id, user_text FROM jobs WHERE session_id = ? AND idempotency_key = ?", [
      input.job.session_id,
      input.job.idempotency_key,
    ]);
    if (existing[0]) {
      if (String(existing[0].user_text) !== input.job.user_text) {
        const error = new Error("idempotency_conflict");
        error.name = "idempotency_conflict";
        throw error;
      }
      return getJobOn(conn, String(existing[0].job_id));
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
    await conn.query(
      `INSERT INTO jobs (
        job_id, session_id, status, user_text, idempotency_key, turn_json, analysis_json, error_json,
        version, next_seq, fence, lease_owner, lease_until, cancel_requested, created_at, model_id, reasoning
      ) VALUES (?, ?, 'queued', ?, ?, ?, NULL, NULL, 1, 2, 0, NULL, NULL, 0, ?, ?, ?)`,
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
    await conn.query("INSERT INTO outbox (job_id, event_type, payload_json, created_at) VALUES (?, 'job_queued', ?, ?)", [
      input.job.job_id,
      JSON.stringify({ job_id: input.job.job_id }),
      input.job.created_at,
    ]);
    return getJobOn(conn, input.job.job_id);
  });
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
    const [held] = await conn.query("SELECT status FROM provider_steps WHERE job_id = ? AND settlement = 'held_unknown' FOR UPDATE", [input.jobId]);
    if (held.length > 0) {
      return { ok: false, code: held.some((step) => step.status === "outcome_unknown") ? "provider_outcome_unknown" : "token_budget_unknown" };
    }
    if (reserve > Number(budget.context_window)) return { ok: false, code: "context_window_exceeded" };
    const committed = Number(budget.settled_input) + Number(budget.settled_output) + Number(budget.reserved_tokens);
    if (committed + reserve > Number(budget.max_tokens)) return { ok: false, code: "budget_exhausted" };
    if (Number(budget.model_calls_settled) + Number(budget.model_calls_reserved) >= Number(budget.max_model_calls)) {
      return { ok: false, code: "budget_exhausted" };
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
    if (!job || job.lease_owner !== input.owner || job.status !== "running" || Number(job.fence) !== input.fence || !(await unexpired(conn, job))) {
      return { ok: false, code: "provider_fence_rejected" };
    }
    const settlement = String(step.settlement ?? "pending");
    const sameTokens = nullable(step.input_tokens) === input.inputTokens && nullable(step.output_tokens) === input.outputTokens;
    if (settlement === "settled") {
      return sameTokens && String(step.status) === input.status && String(step.usage_source) === input.usageSource
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
  const [rows] = await pool.query("SELECT * FROM provider_steps WHERE job_id = ? ORDER BY created_at", [jobId]);
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
