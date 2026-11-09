import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const EVALUATION_QUESTION_TOKEN_LIMIT = 10_000_000;
type Reservation = { ok: boolean; remaining: number; reason?: 'unresolved_attempt' | 'limit' | 'duplicate' };

/** Equivalent generated questions share an allowance even if reworded. */
export function syntheticQuestionKey(oracle: Record<string, any>, question: string): string {
  const kind = oracle.kind;
  const identity = kind === 'daily_sum' ? [kind, oracle.table, oracle.column, oracle.app_id, oracle.date]
    : kind === 'daily_comparison' ? [kind, oracle.table, oracle.column, oracle.app_id, ...[oracle.first_date, oracle.second_date].sort()]
      : kind === 'channel_cpi' ? [kind, oracle.app_id, oracle.date]
        : kind === 'cohort_retention' ? [kind, oracle.app_id, oracle.date]
        : kind === 'dimension_cost_group' ? [kind, oracle.date]
          : kind === 'clarification' ? [kind, question] : null;
  if (!identity || identity.some((value) => typeof value !== 'string' || !value)) throw new Error('question_budget_identity_invalid');
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

/** Local SQLite transaction across evaluation processes. A crash keeps the
 * full reservation; reported use replaces it only after a known settlement. */
export class EvaluationQuestionBudget {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS question_attempts (attempt_id TEXT PRIMARY KEY, question_key TEXT NOT NULL, reserved_tokens INTEGER NOT NULL, accounted_tokens INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN (\'reserved\',\'settled\',\'held_unknown\')), created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS question_attempts_key ON question_attempts(question_key);');
  }
  reserve(questionKey: string, attemptId: string, tokens: number): Reservation {
    if (!/^[a-f0-9]{64}$/u.test(questionKey) || !/^[a-zA-Z0-9_-]{1,180}$/u.test(attemptId) || !Number.isSafeInteger(tokens) || tokens < 1 || tokens > EVALUATION_QUESTION_TOKEN_LIMIT) throw new Error('question_budget_invalid');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare("SELECT COALESCE(SUM(accounted_tokens),0) AS used, COALESCE(SUM(CASE WHEN state != 'settled' THEN 1 ELSE 0 END),0) AS unresolved FROM question_attempts WHERE question_key=?").get(questionKey) as { used: number; unresolved: number };
      const remaining = Math.max(0, EVALUATION_QUESTION_TOKEN_LIMIT - Number(row.used));
      if (this.db.prepare('SELECT 1 FROM question_attempts WHERE attempt_id=?').get(attemptId)) { this.db.exec('ROLLBACK'); return { ok: false, remaining, reason: 'duplicate' }; }
      // A previous request may already have reached the provider. Additional
      // remaining budget is not permission to repeat an unknown outcome.
      if (Number(row.unresolved) > 0) { this.db.exec('ROLLBACK'); return { ok: false, remaining, reason: 'unresolved_attempt' }; }
      if (tokens > remaining) { this.db.exec('ROLLBACK'); return { ok: false, remaining, reason: 'limit' }; }
      this.db.prepare('INSERT INTO question_attempts VALUES (?,?,?,?,?,?)').run(attemptId, questionKey, tokens, tokens, 'reserved', new Date().toISOString());
      this.db.exec('COMMIT'); return { ok: true, remaining: remaining - tokens };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Record an already completed historical attempt. It cannot grant a new
   * dispatch; never omit prior actual use even when it exceeds today's limit. */
  importHistorical(questionKey: string, attemptId: string, actualTokens: number | null, unknownReservation: number): boolean {
    if (!/^[a-f0-9]{64}$/u.test(questionKey) || !/^[a-zA-Z0-9_-]{1,180}$/u.test(attemptId) || !Number.isSafeInteger(unknownReservation) || unknownReservation < 1 || unknownReservation > EVALUATION_QUESTION_TOKEN_LIMIT || (actualTokens !== null && (!Number.isSafeInteger(actualTokens) || actualTokens < 0))) throw new Error('question_budget_invalid');
    const accounted = actualTokens ?? unknownReservation;
    const result = this.db.prepare('INSERT OR IGNORE INTO question_attempts VALUES (?,?,?,?,?,?)').run(attemptId, questionKey, unknownReservation, accounted, actualTokens === null ? 'held_unknown' : 'settled', new Date().toISOString());
    return Number(result.changes) === 1;
  }
  settle(attemptId: string, actualTokens: number | null): void {
    if (actualTokens !== null && (!Number.isSafeInteger(actualTokens) || actualTokens < 0)) throw new Error('question_budget_invalid');
    const result = actualTokens === null
      ? this.db.prepare("UPDATE question_attempts SET state='held_unknown' WHERE attempt_id=? AND state='reserved'").run(attemptId)
      : this.db.prepare("UPDATE question_attempts SET state='settled',accounted_tokens=? WHERE attempt_id=? AND state='reserved'").run(actualTokens, attemptId);
    if (Number(result.changes) !== 1) throw new Error('question_budget_settlement_invalid');
  }
  hasAttempt(attemptId: string): boolean { return Boolean(this.db.prepare('SELECT 1 FROM question_attempts WHERE attempt_id=?').get(attemptId)); }
  close(): void { this.db.close(); }
}
