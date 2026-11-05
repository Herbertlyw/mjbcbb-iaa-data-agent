import { DatabaseSync } from "node:sqlite";
import { closeSync, constants, lstatSync, openSync } from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

// This is an independent durable cross-process gate, not the MySQL job state.
// Unknown results remain charged; no timeout or worker restart releases them.
const directory = lstatSync(path.dirname(workerData.path));
if (!directory.isDirectory() || directory.isSymbolicLink() || typeof process.getuid === "function" && directory.uid !== process.getuid()) throw new Error("global_budget_path_unsafe");
let created = false;
try {
  const existing = lstatSync(workerData.path);
  if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077) !== 0 || typeof process.getuid === "function" && existing.uid !== process.getuid()) throw new Error("global_budget_path_unsafe");
} catch (error) {
  if (error?.code !== "ENOENT" || workerData.mode !== "activate") throw error;
  try {
    const fd = openSync(workerData.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    closeSync(fd); created = true;
  } catch (creationError) {
    if (creationError?.code !== "EEXIST") throw creationError;
    const raced = lstatSync(workerData.path);
    if (!raced.isFile() || raced.isSymbolicLink() || (raced.mode & 0o077) !== 0 || typeof process.getuid === "function" && raced.uid !== process.getuid()) throw new Error("global_budget_path_unsafe");
  }
}
const db = new DatabaseSync(workerData.path, { readOnly: workerData.mode === "inspect" });
db.exec("PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON;");
// WAL recovery can transiently return SQLITE_BUSY_RECOVERY before SQLite's
// normal busy handler applies. Only retry these read-only startup probes.
async function probe(sql) {
  for (let attempt = 0; ; attempt++) {
    try { return db.prepare(sql).get(); }
    catch (error) {
      if (attempt >= 149 || ![5, 261, 517, 773].includes(error?.errcode)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
// Refuse to add tables or change journal settings on another application's
// database. A crash before marking a newly created file requires manual review.
const APP_ID = 1145136962;
if (created) db.exec(`PRAGMA application_id = ${APP_ID}`);
else if (Number((await probe("PRAGMA application_id"))?.application_id) !== APP_ID) throw new Error("global_budget_not_ours");
if (created) db.exec("PRAGMA journal_mode = WAL");
else if (String((await probe("PRAGMA journal_mode"))?.journal_mode).toLowerCase() !== "wal") throw new Error("global_budget_journal_invalid");
if (created) db.exec(`
  CREATE TABLE IF NOT EXISTS budget_scopes (
    budget_id TEXT PRIMARY KEY, max_requests INTEGER NOT NULL, max_tokens INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','closed')), created_at TEXT NOT NULL, closed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS active_budget (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), budget_id TEXT NOT NULL REFERENCES budget_scopes(budget_id)
  );
  CREATE TABLE IF NOT EXISTS global_provider_steps (
    step_id TEXT PRIMARY KEY, budget_id TEXT NOT NULL REFERENCES budget_scopes(budget_id), job_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','settled','held_unknown')),
    reserved_input INTEGER NOT NULL, reserved_output INTEGER NOT NULL,
    input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
    cache_hit_tokens INTEGER, cache_miss_tokens INTEGER,
    outcome TEXT, created_at TEXT NOT NULL, dispatched_at TEXT, settled_at TEXT
  );
  CREATE INDEX IF NOT EXISTS global_provider_steps_budget ON global_provider_steps(budget_id);
`);
else {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  if (["budget_scopes", "active_budget", "global_provider_steps"].some((name) => !tables.has(name))) throw new Error("global_budget_schema_invalid");
}
// Upgrade previously created ledgers without dropping scope history.
const columns = new Set(db.prepare("PRAGMA table_info(global_provider_steps)").all().map((row) => row.name));
if (["cache_hit_tokens", "cache_miss_tokens"].some((name) => !columns.has(name))) {
  if (workerData.mode === "inspect") throw new Error("global_budget_schema_upgrade_required");
  db.exec("BEGIN IMMEDIATE");
  try {
    const lockedColumns = new Set(db.prepare("PRAGMA table_info(global_provider_steps)").all().map((row) => row.name));
    for (const name of ["cache_hit_tokens", "cache_miss_tokens"]) if (!lockedColumns.has(name)) db.exec(`ALTER TABLE global_provider_steps ADD COLUMN ${name} INTEGER`);
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
}

const now = () => new Date().toISOString();
const text = (v) => typeof v === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(v);
const integer = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 1_000_000_000;
function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const value = fn(); db.exec("COMMIT"); return value; }
  catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
}
function active() {
  return db.prepare("SELECT s.* FROM active_budget a JOIN budget_scopes s ON s.budget_id = a.budget_id WHERE a.singleton = 1 AND s.status = 'active'").get();
}
function checkConfig(input) {
  if (!text(input.budgetId) || !integer(input.maxRequests) || input.maxRequests < 1 || !integer(input.maxTokens) || input.maxTokens < 1) throw new Error("global_budget_invalid");
}
function same(scope, input) {
  return scope && scope.budget_id === input.budgetId && Number(scope.max_requests) === input.maxRequests && Number(scope.max_tokens) === input.maxTokens;
}
function activate(input) {
  checkConfig(input);
  return tx(() => {
    const scope = active();
    if (scope) return same(scope, input) ? { ok: true, code: "already_active" } : { ok: false, code: "global_budget_active_mismatch" };
    if (db.prepare("SELECT budget_id FROM budget_scopes WHERE budget_id = ?").get(input.budgetId)) return { ok: false, code: "global_budget_id_used" };
    db.prepare("INSERT INTO budget_scopes (budget_id,max_requests,max_tokens,status,created_at) VALUES (?,?,?,'active',?)").run(input.budgetId,input.maxRequests,input.maxTokens,now());
    db.prepare("INSERT INTO active_budget(singleton,budget_id) VALUES (1,?)").run(input.budgetId);
    return { ok: true, code: "activated" };
  });
}
function verify(input) {
  checkConfig(input);
  return same(active(), input) ? { ok: true, code: "active" } : { ok: false, code: "global_budget_active_mismatch" };
}
function stats(id) {
  const scope = db.prepare("SELECT * FROM budget_scopes WHERE budget_id = ?").get(id);
  if (!scope) return null;
  const counts = db.prepare(`SELECT COUNT(*) AS requests_reserved,
    SUM(CASE WHEN dispatched_at IS NOT NULL THEN 1 ELSE 0 END) AS dispatched_count,
    COALESCE(SUM(CASE WHEN state='settled' THEN input_tokens + output_tokens ELSE MAX(reserved_input + reserved_output, COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) END),0) AS accounted_tokens,
    SUM(input_tokens) AS reported_input,
    SUM(output_tokens) AS reported_output,
    SUM(cache_hit_tokens) AS cache_hit_sum,
    SUM(CASE WHEN cache_hit_tokens IS NULL THEN 1 ELSE 0 END) AS cache_hit_missing,
    SUM(cache_miss_tokens) AS cache_miss_sum,
    SUM(CASE WHEN cache_miss_tokens IS NULL THEN 1 ELSE 0 END) AS cache_miss_missing,
    SUM(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END) AS usage_missing,
    SUM(CASE WHEN state='held_unknown' THEN 1 ELSE 0 END) AS unknown_count,
    SUM(CASE WHEN state IN ('reserved','dispatched') THEN 1 ELSE 0 END) AS pending_count
    FROM global_provider_steps WHERE budget_id = ?`).get(id);
  return { budget_id: id, status: scope.status, max_requests: Number(scope.max_requests), max_tokens: Number(scope.max_tokens), requests_reserved: Number(counts.requests_reserved), dispatched_count: Number(counts.dispatched_count ?? 0), accounted_tokens: Number(counts.accounted_tokens), reported_input: counts.reported_input === null ? null : Number(counts.reported_input), reported_output: counts.reported_output === null ? null : Number(counts.reported_output), cache_hit_tokens: counts.cache_hit_missing || counts.cache_hit_sum === null ? null : Number(counts.cache_hit_sum), cache_miss_tokens: counts.cache_miss_missing || counts.cache_miss_sum === null ? null : Number(counts.cache_miss_sum), usage_incomplete_count: Number(counts.usage_missing ?? 0), unknown_count: Number(counts.unknown_count ?? 0), pending_count: Number(counts.pending_count ?? 0) };
}
function reserve(input) {
  checkConfig(input);
  if (!text(input.stepId) || !text(input.jobId) || !integer(input.estimatedInput) || !integer(input.reservedOutput) || input.estimatedInput < 1 || input.reservedOutput < 1) throw new Error("global_budget_invalid");
  return tx(() => {
    if (!same(active(),input)) return { ok: false, code: "global_budget_active_mismatch" };
    // Duplicate IDs are never permission to dispatch twice, even after a timeout.
    if (db.prepare("SELECT step_id FROM global_provider_steps WHERE step_id = ?").get(input.stepId)) return { ok: false, code: "global_budget_step_exists" };
    const s = stats(input.budgetId);
    if (s.requests_reserved >= input.maxRequests || s.accounted_tokens + input.estimatedInput + input.reservedOutput > input.maxTokens) return { ok: false, code: "global_budget_exhausted" };
    db.prepare("INSERT INTO global_provider_steps (step_id,budget_id,job_id,state,reserved_input,reserved_output,created_at) VALUES (?,?,?,'reserved',?,?,?)").run(input.stepId,input.budgetId,input.jobId,input.estimatedInput,input.reservedOutput,now());
    return { ok: true, code: "reserved" };
  });
}
function dispatched(input) {
  if (!text(input.budgetId) || !text(input.stepId)) throw new Error("global_budget_invalid");
  return tx(() => {
    const scope = active();
    if (!scope || scope.budget_id !== input.budgetId) return { ok: false, code: "global_budget_active_mismatch" };
    const result = db.prepare("UPDATE global_provider_steps SET state='dispatched',dispatched_at=? WHERE step_id=? AND budget_id=? AND state='reserved'").run(now(),input.stepId,input.budgetId);
    return result.changes === 1 ? { ok: true, code: "dispatched" } : { ok: false, code: "global_budget_dispatch_rejected" };
  });
}
function settle(input) {
  if (!text(input.budgetId) || !text(input.stepId) || !["completed","error","cancelled","outcome_unknown"].includes(input.outcome)) throw new Error("global_budget_invalid");
  const tokenKeys = ["inputTokens","outputTokens","cacheReadTokens","cacheWriteTokens","cacheHitTokens","cacheMissTokens"];
  if (tokenKeys.some((key) => input[key] !== null && input[key] !== undefined && !integer(input[key]))) throw new Error("global_budget_invalid");
  return tx(() => {
    const row = db.prepare("SELECT * FROM global_provider_steps WHERE step_id=? AND budget_id=?").get(input.stepId,input.budgetId);
    if (!row) return { ok: false, code: "global_budget_step_missing" };
    const known = input.outcome === "completed" && integer(input.inputTokens) && integer(input.outputTokens) && input.inputTokens + input.outputTokens > 0;
    const inTokens = input.inputTokens ?? null, outTokens = input.outputTokens ?? null;
    const cacheRead = input.cacheReadTokens ?? null, cacheWrite = input.cacheWriteTokens ?? null, cacheHit = input.cacheHitTokens ?? null, cacheMiss = input.cacheMissTokens ?? null;
    if (["settled","held_unknown"].includes(row.state)) {
      const matches = row.state === (known ? "settled" : "held_unknown") && row.outcome === input.outcome && row.input_tokens === inTokens && row.output_tokens === outTokens && row.cache_read_tokens === cacheRead && row.cache_write_tokens === cacheWrite && row.cache_hit_tokens === cacheHit && row.cache_miss_tokens === cacheMiss;
      return matches ? { ok: true, code: "idempotent" } : { ok: false, code: "global_budget_settlement_conflict" };
    }
    if (inTokens !== null && ((cacheRead !== null && cacheRead > inTokens) || (cacheWrite !== null && cacheWrite > inTokens) || (cacheHit !== null && cacheHit > inTokens) || (cacheMiss !== null && cacheMiss > inTokens) || (cacheHit !== null && cacheMiss !== null && cacheHit + cacheMiss !== inTokens))) throw new Error("global_budget_invalid");
    if (row.state !== "dispatched") return { ok: false, code: "global_budget_dispatch_rejected" };
    db.prepare("UPDATE global_provider_steps SET state=?,input_tokens=?,output_tokens=?,cache_read_tokens=?,cache_write_tokens=?,cache_hit_tokens=?,cache_miss_tokens=?,outcome=?,settled_at=? WHERE step_id=? AND budget_id=?").run(known ? "settled" : "held_unknown",inTokens,outTokens,cacheRead,cacheWrite,cacheHit,cacheMiss,input.outcome,now(),input.stepId,input.budgetId);
    return { ok: true, code: known ? "settled" : "held_unknown" };
  });
}
function closeScope(input) {
  if (!text(input.budgetId) || input.confirm !== "close-budget-scope") throw new Error("global_budget_invalid");
  return tx(() => {
    const scope=active();
    if (!scope || scope.budget_id !== input.budgetId) return {ok:false,code:"global_budget_active_mismatch"};
    const s = stats(input.budgetId);
    if (s.pending_count) return {ok:false,code:"global_budget_pending"};
    if (s.unknown_count && input.acknowledgeUnknown !== true) return {ok:false,code:"global_budget_unknown_unacknowledged"};
    db.prepare("UPDATE budget_scopes SET status='closed',closed_at=? WHERE budget_id=?").run(now(),input.budgetId);
    db.prepare("DELETE FROM active_budget WHERE singleton=1 AND budget_id=?").run(input.budgetId);
    return {ok:true,code:"closed"};
  });
}
function acknowledgeInterrupted(input) {
  if (!text(input.budgetId) || !text(input.stepId) || input.confirm !== "retain-interrupted-as-unknown") throw new Error("global_budget_invalid");
  return tx(() => {
    const result = db.prepare("UPDATE global_provider_steps SET state='held_unknown',outcome='outcome_unknown',settled_at=? WHERE step_id=? AND budget_id=? AND state IN ('reserved','dispatched')").run(now(),input.stepId,input.budgetId);
    return result.changes === 1 ? {ok:true,code:"held_unknown"} : {ok:false,code:"global_budget_step_not_pending"};
  });
}
function run(op, input) {
  if (workerData.mode === "inspect" && !["verifyInspection", "stats", "pendingSteps", "step"].includes(op)) throw new Error("global_budget_read_only");
  if (op === "verifyInspection") {
    checkConfig(input);
    return same(db.prepare("SELECT * FROM budget_scopes WHERE budget_id = ?").get(input.budgetId), input)
      ? { ok: true, code: "inspectable" } : { ok: false, code: "global_budget_scope_mismatch" };
  }
  if (op === "activate") return activate(input);
  if (op === "verify") return verify(input);
  if (op === "reserve") return reserve(input);
  if (op === "dispatched") return dispatched(input);
  if (op === "settle") return settle(input);
  if (op === "stats") return stats(input.budgetId);
  if (op === "pendingSteps") {
    if (!text(input.budgetId) || !(input.afterStepId === "" || text(input.afterStepId)) || !integer(input.limit) || input.limit < 1 || input.limit > 1000) throw new Error("global_budget_invalid");
    return db.prepare("SELECT * FROM global_provider_steps WHERE budget_id=? AND state IN ('reserved','dispatched') AND step_id > ? ORDER BY step_id LIMIT ?").all(input.budgetId,input.afterStepId,input.limit);
  }
  if (op === "closeScope") return closeScope(input);
  if (op === "acknowledgeInterrupted") return acknowledgeInterrupted(input);
  if (op === "step") return db.prepare("SELECT * FROM global_provider_steps WHERE step_id = ? AND budget_id = ?").get(input.stepId,input.budgetId) ?? null;
  throw new Error("global_budget_operation_invalid");
}
parentPort.on("message", ({op,input,port}) => {
  try { port.postMessage({ok:true,result:run(op,input)}); }
  catch (error) { port.postMessage({ok:false, code: error?.message === "global_budget_invalid" ? "global_budget_invalid" : typeof error?.code === "string" && /^[A-Z0-9_]+$/u.test(error.code) ? error.code : "operation_error"}); }
  finally { port.close(); }
});
