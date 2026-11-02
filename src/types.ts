export type AssetKind =
  | "catalog"
  | "data_contract"
  | "metric"
  | "analysis_sop"
  | "example_sql"
  | "access_policy";

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "needs_clarification"
  | "partial"
  | "failed"
  | "cancelled"
  | "timed_out";

export type AnalysisStatus = "completed" | "needs_clarification" | "partial" | "failed";

export type TurnKind = "new_question" | "follow_up" | "correction" | "topic_switch";

export type TurnIntent = "performance" | "sensitive" | "unauthorized" | "retention_missing" | "unsupported";

export interface Freshness {
  as_of: string;
  status: "fresh" | "stale" | "unknown";
  note: string;
}

export interface ContractColumn {
  name: string;
  type: string;
  description: string;
  nullable?: boolean;
  unit?: string;
  null_means?: string;
  zero_means?: string;
}

export interface DataContract {
  asset_id: string;
  revision: string;
  table: string;
  engine: "sqlite-local" | "clickhouse-local";
  simulated: true;
  valid_from: string;
  valid_until: string;
  timezone: string;
  freshness: Freshness;
  must_filter: string[];
  series?: {
    date_column: string;
    dimensions: string[];
    metrics: string[];
    predicted_column?: string | null;
    prediction_mode?: "observed_only";
    prediction_values?: { actual: number; predicted: number };
  };
  derived_metrics?: Array<{ id: string; label: string; operation: "divide"; numerator: string; denominator: string; prediction: "actual_only"; unit: string }>;
  columns: ContractColumn[];
  sensitive_columns: string[];
  grain?: string[];
  notes: string;
}

export interface AssetRecord {
  asset_id: string;
  kind: AssetKind;
  title: string;
  summary: string;
  revision: string;
  status: "published" | "draft";
  discoverable: boolean;
  path: string;
  table?: string;
  body: string;
  content_hash: string;
  contract?: DataContract;
}

export interface JoinConstraint {
  join_id: string;
  tables: string[];
  keys: string[];
  note: string;
}

export interface AccessPolicy {
  policy_revision: string;
  simulated: true;
  note: string;
  roles: Record<string, { read: string[]; query_tables: string[] }>;
}

export interface KnowledgeBase {
  registry_revision: string;
  simulated: true;
  scenario: string;
  timezone: string;
  policy: AccessPolicy;
  assets: AssetRecord[];
  by_id: Map<string, AssetRecord>;
  contract_by_table: Map<string, AssetRecord>;
  table_mentions: Map<string, AssetRecord>;
  joins: JoinConstraint[];
  seed_sql: string;
}

export type MetricName = "new_users" | "ad_revenue" | "spend" | "actual_payback" | "predicted_payback" | "roi" | "active_users" | "retention";

export interface WarehouseBinding {
  table: string;
  date_column: string;
  title_column: string;
  platform_column: string;
  country_column: string;
  channel_column?: string;
  value_column: string;
  predicted_column?: string;
  select_columns: string[];
}

export interface Slots {
  game: string;
  platform?: string;
  country?: string;
  channel?: string;
  start?: string;
  end?: string;
  metrics: MetricName[];
  group_by?: "platform" | "country" | "channel" | "product";
  compare?: "previous_period";
  previous_start?: string;
  previous_end?: string;
}

export interface TurnResolution {
  kind: TurnKind;
  intent: TurnIntent;
  raw_text: string;
  slots: Slots;
  inherited: string[];
  replaced: string[];
  missing_slots: string[];
  search_query: string;
  read_asset_ids: string[];
  contract_asset_ids: string[];
  clarification_question: string | null;
  warehouse?: Partial<Record<MetricName, WarehouseBinding>>;
}

export interface ContractBinding {
  receipt_id: string;
  session_id: string;
  asset_id: string;
  table: string;
  contract_revision: string;
  registry_revision: string;
  content_hash: string;
  queryable: boolean;
  deny_reason?: string;
  allowed_columns: string[];
  sensitive_columns: string[];
  must_filter: string[];
  timezone: string;
  freshness: Freshness;
  valid_until: string;
  read_at: string;
}

export interface CoverageGroup {
  dimension: string;
  value: string;
  absent_dates: string[];
  null_dates: string[];
  zero_dates: string[];
  predicted_dates: string[];
  actual_dates: string[];
  unknown_prediction_dates: string[];
}

export interface CoverageReport {
  status: "known" | "unknown";
  reason: string;
  table?: string;
  expected_days: number | null;
  absent_dates: string[];
  null_dates: string[];
  zero_dates: string[];
  predicted_dates: string[];
  actual_dates: string[];
  unknown_prediction_dates: string[];
  groups: CoverageGroup[];
  groups_total?: number;
  groups_has_more?: boolean;
  /** Digest of the bounded coverage observation, not a database snapshot. */
  observation_hash?: string;
  per_table?: CoverageReport[];
}

export interface FreshnessReceipt {
  publication_id: string;
  version: number;
  table: string;
  status: string;
  published_at: string;
}

export interface QueryResource {
  resource_id: string;
  session_id: string;
  kind: "query_result";
  created_at: string;
  job_id?: string;
  engine: "sqlite-local" | "clickhouse-local";
  simulated: true;
  elapsed_ms?: number;
  execution_id?: string;
  column_types?: Record<string, string>;
  scan_limit?: number;
  decimal_types?: Record<string, string>;
  sql: string;
  tables: string[];
  contract_revisions: Record<string, string>;
  asset_hashes: Record<string, string>;
  registry_revision: string;
  receipt_ids: string[];
  time_range: { start: string; end: string; timezone: string };
  freshness: Freshness[];
  truncated: boolean;
  sql_limited?: boolean;
  total_rows: number;
  total_rows_exact?: boolean;
  returned_rows: number;
  complete_population: boolean;
  value_semantics: {
    null: "missing";
    zero: "observed_zero";
    predicted_flag: "is_predicted";
  };
  columns: string[];
  rows: Array<Record<string, unknown>>;
  coverage: CoverageReport;
  freshness_receipts: FreshnessReceipt[];
}

export interface CalculationResource {
  resource_id: string;
  session_id: string;
  kind: "calculation";
  created_at: string;
  job_id?: string;
  source_resource_id: string;
  cells: Record<string, number | string | null>;
  operations?: Record<string, import("./evidence.js").CellOperation>;
  input_truncated: boolean;
  complete_population: boolean;
  null_means: "missing";
  zero_means: "observed_zero";
  predicted_means: "forecast_not_actual";
  notes: string[];
}

export interface ArithmeticRef { resource_id: string; cell: string; group?: Record<string, string>; execution_id?: string; row?: number; aggregate?: "sum" }
export interface ArithmeticResource {
  resource_id: string;
  session_id: string;
  job_id: string;
  kind: "arithmetic";
  created_at: string;
  operation: import("./exact-arithmetic.js").ArithmeticOp;
  left: ArithmeticRef;
  right: ArithmeticRef;
  input_hashes: Record<string, string>;
  result: import("./exact-arithmetic.js").ArithmeticValue;
  input_truncated: false;
  complete_population: true;
}

export interface TransformResource {
  resource_id: string;
  session_id: string;
  job_id: string;
  kind: "transform";
  created_at: string;
  source_resource_id: string;
  steps: import("./result-transform.js").TransformStep[];
  input_hashes: Record<string, string>;
  result: import("./result-transform.js").ResultTable;
  input_truncated: false;
  complete_population: true;
}

export interface AlignmentResource {
  resource_id: string;
  session_id: string;
  job_id: string;
  kind: "alignment";
  created_at: string;
  spec: import("./result-alignment.js").AlignmentSpec;
  input_hashes: Record<string, string>;
  rows: import("./result-alignment.js").AlignedRow[];
  input_truncated: false;
  complete_population: true;
}

export type SessionResource = QueryResource | CalculationResource | ArithmeticResource | TransformResource | AlignmentResource;

export interface AnalysisSource {
  resource_id: string;
  execution_id?: string;
  observed_at?: string;
  data_capture_hash?: string;
  sql: string;
  tables: string[];
  contract_revisions: Record<string, string>;
  asset_hashes: Record<string, string>;
  time_range: QueryResource["time_range"];
  freshness: Freshness[];
  truncated: boolean;
  total_rows: number;
  total_rows_exact?: boolean;
  returned_rows: number;
  complete_population: boolean;
  simulated: true;
  engine: "sqlite-local" | "clickhouse-local";
  rows: Array<Record<string, unknown>>;
  coverage: CoverageReport;
  freshness_receipts: FreshnessReceipt[];
  evidence_eligible?: boolean;
  preview_has_more?: boolean;
}

export interface AnalysisRecord {
  analysis_id: string;
  job_id: string;
  session_id: string;
  status: AnalysisStatus;
  answer: string;
  limitations: string[];
  clarification_question: string | null;
  citations: Array<{ resource_id: string; note: string }>;
  resource_hashes?: Record<string, string>;
  sources: AnalysisSource[];
  calculations: Array<{
    resource_id: string;
    source_resource_id: string;
    cells: Record<string, number | string>;
    verified_cells?: import("./evidence.js").VerifiedCell[];
    verified_decimal_cells?: import("./decimal-cell-evidence.js").VerifiedDecimalCell[];
    input_truncated: boolean;
    complete_population: boolean;
  }>;
  comparisons?: import("./evidence-comparison.js").VerifiedComparison[];
  aggregate_comparisons?: import("./aggregate-comparison.js").AggregateComparison[];
  arithmetic_results?: Array<{ resource_id: string; operation: import("./exact-arithmetic.js").ArithmeticOp; left: ArithmeticRef; right: ArithmeticRef; result: import("./exact-arithmetic.js").ArithmeticValue }>;
  transform_results?: Array<{ resource_id: string; source_resource_id: string; steps: import("./result-transform.js").TransformStep[]; result: import("./result-transform.js").ResultTable; total_rows?: number; preview_has_more?: boolean }>;
  alignment_results?: Array<{ resource_id: string; spec: import("./result-alignment.js").AlignmentSpec; rows: import("./result-alignment.js").AlignedRow[]; total_rows?: number; preview_has_more?: boolean }>;
  aggregates?: import("./aggregate-evidence.js").VerifiedAggregate[];
  aggregate_total?: number;
  aggregates_has_more?: boolean;
  analysis_declaration?: {
    provenance: "model_declared";
    declaration: import("./analysis-declaration.js").AnalysisDeclaration;
    excerpts_checked: number;
    verified_cells: Array<{ resource_id: string; execution_id: string; row: number; column: string; field: string; unit: string; value: string | boolean | null }>;
  };
  model_suggested_status: string;
  model_draft: string;
  server_reasons: string[];
  simulated: true;
}

export interface JobEvent {
  seq: number;
  type: string;
  at: string;
  payload: Record<string, unknown>;
}

export interface JobRecord {
  job_id: string;
  session_id: string;
  status: JobStatus;
  user_text: string;
  idempotency_key: string;
  turn: TurnResolution;
  events: JobEvent[];
  next_seq: number;
  version: number;
  analysis: AnalysisRecord | null;
  error: { code: string; message: string } | null;
  abort_reason: "cancel" | "timeout" | null;
  fence: number;
  lease_owner: string | null;
  lease_until: number | null;
  cancel_requested: boolean;
  simulated: true;
  model_id?: string | null;
  reasoning?: string | null;
  created_at: string;
  usage?: {
    model_calls: number;
    tool_calls: number;
    input_tokens: number | null;
    output_tokens: number | null;
    cost: number | null;
    usage_source?: string;
  } | null;
  started_at?: string;
  finished_at?: string;
}

export interface ToolFailure {
  ok: false;
  code: string;
  message: string;
  [key: string]: unknown;
}

export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set([
  "completed",
  "needs_clarification",
  "partial",
  "failed",
  "cancelled",
  "timed_out",
]);

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
