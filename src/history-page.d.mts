import type { JobEvent, JobStatus } from './types.js';

export type HistoryKind = 'sessions' | 'jobs';
export interface HistoryCursor { v: 1; kind: HistoryKind; scope: string; snapshot: string; at: string; id: string }
export interface HistoryPageInput { limit: number; cursor: HistoryCursor | null }
export interface HistoryPage<T> { items: T[]; has_more: boolean; next_cursor: string | null }
export interface SessionSummary { session_id: string; title: string; role: string; actor_id: string; created_at: string }
export interface SessionMetadata extends SessionSummary { active_job_id: string | null }
export interface JobSummary { job_id: string; session_id: string; status: JobStatus; user_text_preview: string; created_at: string }
export interface JobHead { job_id: string; session_id: string; status: JobStatus; last_seq: number }
export interface JobEventPage { head: JobHead; events: JobEvent[]; has_more: boolean }
export class HistoryPageError extends Error { constructor(code: string) }
export function parseHistoryPage(params: URLSearchParams, kind: HistoryKind, scope: string): HistoryPageInput;
export function finishHistoryPage<T extends { created_at: string }>(rows: T[], input: HistoryPageInput, kind: HistoryKind, scope: string, snapshot: string | number, idKey: keyof T): HistoryPage<T>;
export function parseEventAfter(params: URLSearchParams): number;
export function finishEventPage(head: JobHead, rows: Array<{ seq: unknown; type: unknown; at: unknown; payload_json: unknown }>, after: number): JobEventPage;
