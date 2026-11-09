// In-process analysis receipts and direct-call revision fallback.
import { type AnalysisDeclaration } from "./analysis-declaration.js";
import type { AnalysisRecord, AnalysisStatus } from "./types.js";

const sessionAnalysisMap = new Map<string, AnalysisRecord[]>();

export const revisionAttempts = new Map<string, number>();

export function sessionAnalyses(session: { session_id: string }): AnalysisRecord[] {
  let list = sessionAnalysisMap.get(session.session_id);
  if (!list) {
    list = [];
    sessionAnalysisMap.set(session.session_id, list);
  }
  return list;
}

export interface AnalysisFinding {
  label: string;
  value: number | null;
  kind: "actual" | "missing" | "absent" | "zero" | "predicted";
  resource_id: string;
  cell?: string;
  group?: Record<string, string>;
  time_range?: { start: string; end: string };
}

export interface AnalysisInput {
  suggested_status: AnalysisStatus;
  draft_answer: string;
  resource_ids?: string[];
  clarification_question?: string;
  limitations?: string[];
  findings?: AnalysisFinding[];
  comparisons?: Array<{
    left: { resource_id: string; cell: string };
    right: { resource_id: string; cell: string };
  }>;
  declaration?: AnalysisDeclaration;
}
