// Bound and memoize a single recursive evidence evaluation.
import { type ArithmeticValue } from "./exact-arithmetic.js";
import { type ResultTable } from "./result-transform.js";

export type EvaluatedResult = {
  table: ResultTable;
  hashes: Record<string, string>;
  leaves: string[];
  partial: boolean;
  expression_only?: boolean;
  aggregate_input?: boolean;
  partial_reason?: "alignment_incomplete" | "transform_coverage_incomplete" | "transform_undefined_division";
  partial_reasons?: Array<"alignment_incomplete" | "transform_coverage_incomplete" | "transform_undefined_division">;
};

export type EvaluatedValue = { value: ArithmeticValue; hashes: Record<string, string>; leaves: string[] };

export type EvaluationContext = {
  completed: Map<string, EvaluatedResult>;
  values: Map<string, EvaluatedValue>;
  seen: Set<string>;
  rows: number;
  bytes: number;
};

export const evaluationContext = (): EvaluationContext => ({
  completed: new Map(),
  values: new Map(),
  seen: new Set(),
  rows: 0,
  bytes: 0,
});
