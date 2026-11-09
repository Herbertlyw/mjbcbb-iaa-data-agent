// Synthetic query rows, types and operations from the real grouped A trace.
import type { QueryResource } from "../src/types.js";
import type { CellOperation } from "../src/evidence.js";

export const GROUPED_A_PAYMENT_SQL =
  "SELECT title_id, platform, country_code, channel_id, SUM(amount_usd) AS amount_usd_sum, COUNT(*) AS rows_cnt FROM fact_fox_daily_payment WHERE event_date = toDate('2026-10-08') AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'US' AND channel_id = 'mist_ads' GROUP BY title_id, platform, country_code, channel_id";

export const GROUPED_A_SPEND_SQL =
  "SELECT title_id, platform, country_code, channel_id, is_predicted, SUM(spend_usd) AS spend_usd_sum, SUM(payback_usd) AS payback_usd_sum, COUNT(*) AS rows_cnt FROM fact_fox_daily_spend WHERE event_date = toDate('2026-10-08') AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'US' AND channel_id = 'mist_ads' GROUP BY title_id, platform, country_code, channel_id, is_predicted";

export const GROUPED_A_PAYMENT_OPERATIONS: CellOperation[] = [
  {
    op: "count_rows",
    column: "amount_usd_sum",
    as: "payment_rows",
  },
  {
    op: "count_null",
    column: "amount_usd_sum",
    as: "payment_null_cells",
  },
  {
    op: "count_zero",
    column: "amount_usd_sum",
    as: "payment_zero_cells",
  },
  {
    op: "sum",
    column: "amount_usd_sum",
    as: "payment_amount_sum",
  },
];

export const GROUPED_A_SPEND_OPERATIONS: CellOperation[] = [
  {
    op: "count_rows",
    column: "spend_usd_sum",
    as: "spend_rows",
  },
  {
    op: "count_null",
    column: "spend_usd_sum",
    predicted: "actual_only",
    as: "spend_null_cells",
  },
  {
    op: "sum",
    column: "spend_usd_sum",
    predicted: "actual_only",
    as: "spend_actual_sum",
  },
];

const sources = {
  payment: {
    resource_id: "res_b2bf6f32-b889-4020-97be-b98ed2628176",
    session_id: "ses_adc51345-509f-4814-9bfd-c039055a0bc8",
    kind: "query_result",
    key_lineage_version: 1,
    result_semantics_version: 2,
    created_at: "2026-11-06T14:44:38.664Z",
    job_id: "job_c43136eb-dac2-4501-9366-b657d20c8c84",
    engine: "clickhouse-local",
    sql_review_engine: "clickhouse_ast_direct",
    review_plan: {
      version: 1,
      sql_hash:
        "f2cebbd45bef68e99f09c3bfe0d2561d92cfbbcb59fb5c5795511842517f2a4b",
      engine: "clickhouse_ast_direct",
      tables: ["fact_fox_daily_payment"],
      time_range: {
        start: "2026-10-08",
        end: "2026-10-08",
      },
      sql_limited: false,
    },
    elapsed_ms: 17,
    execution_id: "da88b35d-f6a2-4250-9575-c5706701f498",
    column_types: {
      title_id: "LowCardinality(String)",
      platform: "LowCardinality(String)",
      country_code: "LowCardinality(String)",
      channel_id: "LowCardinality(String)",
      amount_usd_sum: "Nullable(Decimal(38, 2))",
      rows_cnt: "UInt64",
    },
    execution_settings: {
      join_use_nulls: true,
    },
    scan_limit: 5000000,
    decimal_types: {
      "fact_fox_daily_payment.amount_usd": "Nullable(Decimal(18, 2))",
      "fact_fox_daily_payment.cost_usd": "Nullable(Decimal(18, 2))",
    },
    simulated: true,
    sql: "SELECT title_id, platform, country_code, channel_id, SUM(amount_usd) AS amount_usd_sum, COUNT(*) AS rows_cnt FROM fact_fox_daily_payment WHERE event_date = toDate('2026-10-08') AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'US' AND channel_id = 'mist_ads' GROUP BY title_id, platform, country_code, channel_id",
    executed_sql:
      "SELECT title_id, platform, country_code, channel_id, SUM(amount_usd) AS amount_usd_sum, COUNT(*) AS rows_cnt FROM fact_fox_daily_payment WHERE event_date = toDate('2026-10-08') AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'US' AND channel_id = 'mist_ads' GROUP BY title_id, platform, country_code, channel_id",
    tables: ["fact_fox_daily_payment"],
    contract_revisions: {
      fact_fox_daily_payment: "contract.fact_fox_daily_payment-r5",
    },
    asset_hashes: {
      "contract.fact_fox_daily_payment":
        "f5cf31ab57e4a6c70dc9b3299f7d38281f10bc9dad412d1f5398a48836d4060a",
    },
    registry_revision: "harborlight-registry-2026-11-04-r2",
    receipt_ids: ["rcpt_f1e1484a-a665-40b7-8c3b-6ebc3f5aaf33"],
    time_range: {
      start: "2026-10-08",
      end: "2026-10-08",
      timezone: "America/Los_Angeles",
    },
    freshness: [
      {
        as_of: null,
        status: "unknown",
        note: "查询只认已发布探测。",
      },
    ],
    truncated: false,
    sql_limited: false,
    total_rows: 1,
    total_rows_exact: true,
    returned_rows: 1,
    complete_population: true,
    value_semantics: {
      null: "missing",
      zero: "observed_zero",
      predicted_flag: "is_predicted",
    },
    columns: [
      "title_id",
      "platform",
      "country_code",
      "channel_id",
      "amount_usd_sum",
      "rows_cnt",
    ],
    rows: [
      {
        title_id: "paper_lantern",
        platform: "ios",
        country_code: "US",
        channel_id: "mist_ads",
        amount_usd_sum: "1",
        rows_cnt: "1",
      },
    ],
    coverage: {
      status: "known",
      reason:
        "过滤条件钉住了契约声明的序列维度，并按自然日核对。同一天可同时包含 NULL、零和不同预测标记；实际与预测日期表示标记，不保证值非空。",
      expected_days: 1,
      absent_dates: [],
      null_dates: [],
      zero_dates: [],
      predicted_dates: [],
      actual_dates: ["2026-10-08"],
      unknown_prediction_dates: [],
      groups: [],
      observation_hash:
        "9b4c6893d49b69acdcc3a36f20f14e2473fde97c699ba2e257bcb85a8541c970",
      table: "fact_fox_daily_payment",
      per_table: [
        {
          status: "known",
          reason:
            "过滤条件钉住了契约声明的序列维度，并按自然日核对。同一天可同时包含 NULL、零和不同预测标记；实际与预测日期表示标记，不保证值非空。",
          expected_days: 1,
          absent_dates: [],
          null_dates: [],
          zero_dates: [],
          predicted_dates: [],
          actual_dates: ["2026-10-08"],
          unknown_prediction_dates: [],
          groups: [],
          observation_hash:
            "9b4c6893d49b69acdcc3a36f20f14e2473fde97c699ba2e257bcb85a8541c970",
          table: "fact_fox_daily_payment",
          groups_total: 0,
          groups_has_more: false,
        },
      ],
      groups_total: 0,
      groups_has_more: false,
    },
    freshness_receipts: [
      {
        publication_id: "fp_1ed5cf76-93b0-4cfa-a724-13640af14445",
        version: 1,
        table: "fact_fox_daily_payment",
        status: "fresh",
        published_at: "2026-11-06T14:43:27.192000Z",
      },
    ],
  },
  spend: {
    resource_id: "res_63ce9217-4e81-44d9-96c3-021b43f5b391",
    session_id: "ses_adc51345-509f-4814-9bfd-c039055a0bc8",
    kind: "query_result",
    key_lineage_version: 1,
    result_semantics_version: 2,
    created_at: "2026-11-06T14:44:38.721Z",
    job_id: "job_c43136eb-dac2-4501-9366-b657d20c8c84",
    engine: "clickhouse-local",
    sql_review_engine: "clickhouse_ast_direct",
    review_plan: {
      version: 1,
      sql_hash:
        "e6d209a93c42863746f33b2cbc2ca015a421072f9dd47b82ef9d38f5362791df",
      engine: "clickhouse_ast_direct",
      tables: ["fact_fox_daily_spend"],
      time_range: {
        start: "2026-10-08",
        end: "2026-10-08",
      },
      sql_limited: false,
    },
    elapsed_ms: 9,
    execution_id: "313f40c5-f76b-4240-993d-498dc000bccf",
    column_types: {
      title_id: "LowCardinality(String)",
      platform: "LowCardinality(String)",
      country_code: "LowCardinality(String)",
      channel_id: "LowCardinality(String)",
      is_predicted: "UInt8",
      spend_usd_sum: "Nullable(Float64)",
      payback_usd_sum: "Nullable(Float64)",
      rows_cnt: "UInt64",
    },
    execution_settings: {
      join_use_nulls: true,
    },
    scan_limit: 5000000,
    simulated: true,
    sql: "SELECT title_id, platform, country_code, channel_id, is_predicted, SUM(spend_usd) AS spend_usd_sum, SUM(payback_usd) AS payback_usd_sum, COUNT(*) AS rows_cnt FROM fact_fox_daily_spend WHERE event_date = toDate('2026-10-08') AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'US' AND channel_id = 'mist_ads' GROUP BY title_id, platform, country_code, channel_id, is_predicted",
    executed_sql:
      "SELECT title_id, platform, country_code, channel_id, is_predicted, SUM(spend_usd) AS spend_usd_sum, SUM(payback_usd) AS payback_usd_sum, COUNT(*) AS rows_cnt FROM fact_fox_daily_spend WHERE event_date = toDate('2026-10-08') AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'US' AND channel_id = 'mist_ads' GROUP BY title_id, platform, country_code, channel_id, is_predicted",
    tables: ["fact_fox_daily_spend"],
    contract_revisions: {
      fact_fox_daily_spend: "contract.fact_fox_daily_spend-r3",
    },
    asset_hashes: {
      "contract.fact_fox_daily_spend":
        "cb05cb8272fdd3de2fa103beefc31c0bb2fe08984dab1eb94c2b26f9b7640ffb",
    },
    registry_revision: "harborlight-registry-2026-11-04-r2",
    receipt_ids: ["rcpt_e7a223ec-c4e0-4d70-8f64-1b18b2211ea1"],
    time_range: {
      start: "2026-10-08",
      end: "2026-10-08",
      timezone: "America/Los_Angeles",
    },
    freshness: [
      {
        as_of: null,
        status: "unknown",
        note: "查询只认已发布探测，不认这里的占位。",
      },
    ],
    truncated: false,
    sql_limited: false,
    total_rows: 1,
    total_rows_exact: true,
    returned_rows: 1,
    complete_population: true,
    value_semantics: {
      null: "missing",
      zero: "observed_zero",
      predicted_flag: "is_predicted",
    },
    columns: [
      "title_id",
      "platform",
      "country_code",
      "channel_id",
      "is_predicted",
      "spend_usd_sum",
      "payback_usd_sum",
      "rows_cnt",
    ],
    rows: [
      {
        title_id: "paper_lantern",
        platform: "ios",
        country_code: "US",
        channel_id: "mist_ads",
        is_predicted: 0,
        spend_usd_sum: null,
        payback_usd_sum: null,
        rows_cnt: "1",
      },
    ],
    coverage: {
      status: "known",
      reason:
        "过滤条件钉住了契约声明的序列维度，并按自然日核对。同一天可同时包含 NULL、零和不同预测标记；实际与预测日期表示标记，不保证值非空。",
      expected_days: 1,
      absent_dates: [],
      null_dates: ["2026-10-08"],
      zero_dates: [],
      predicted_dates: [],
      actual_dates: ["2026-10-08"],
      unknown_prediction_dates: [],
      groups: [],
      observation_hash:
        "79b14cd5fbfc8f87564bd02f203fa09b9aef83d8924dbaa1df00cee31cf345db",
      table: "fact_fox_daily_spend",
      per_table: [
        {
          status: "known",
          reason:
            "过滤条件钉住了契约声明的序列维度，并按自然日核对。同一天可同时包含 NULL、零和不同预测标记；实际与预测日期表示标记，不保证值非空。",
          expected_days: 1,
          absent_dates: [],
          null_dates: ["2026-10-08"],
          zero_dates: [],
          predicted_dates: [],
          actual_dates: ["2026-10-08"],
          unknown_prediction_dates: [],
          groups: [],
          observation_hash:
            "79b14cd5fbfc8f87564bd02f203fa09b9aef83d8924dbaa1df00cee31cf345db",
          table: "fact_fox_daily_spend",
          groups_total: 0,
          groups_has_more: false,
        },
      ],
      groups_total: 0,
      groups_has_more: false,
    },
    freshness_receipts: [
      {
        publication_id: "fp_1ed5cf76-93b0-4cfa-a724-13640af14445",
        version: 1,
        table: "fact_fox_daily_spend",
        status: "fresh",
        published_at: "2026-11-06T14:43:27.192000Z",
      },
    ],
  },
};

/** Old IDs are unit-test input only; tool/HTTP replays obtain new IDs. */
export function groupedAResource(kind: "payment" | "spend"): QueryResource {
  // The saved wire fixture includes legacy nullable freshness placeholders.
  return structuredClone(sources[kind]) as unknown as QueryResource;
}
