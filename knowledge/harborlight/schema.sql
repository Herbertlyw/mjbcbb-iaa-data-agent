CREATE TABLE IF NOT EXISTS dim_fox_title (
  title_id LowCardinality(String),
  title_name String,
  genre LowCardinality(String),
  launched_on Date
) ENGINE = MergeTree
ORDER BY (title_id);
CREATE TABLE IF NOT EXISTS dim_fox_channel (
  channel_id LowCardinality(String),
  channel_name String,
  channel_kind LowCardinality(String)
) ENGINE = MergeTree
ORDER BY (channel_id);
CREATE TABLE IF NOT EXISTS fact_fox_daily_install (
  event_date Date,
  title_id LowCardinality(String),
  platform LowCardinality(String),
  country_code LowCardinality(String),
  channel_id LowCardinality(String),
  new_users Nullable(Int32),
  device_token Nullable(String)
) ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_date, title_id, platform, country_code, channel_id);
CREATE TABLE IF NOT EXISTS fact_fox_daily_active (
  event_date Date,
  title_id LowCardinality(String),
  platform LowCardinality(String),
  country_code LowCardinality(String),
  channel_id LowCardinality(String),
  active_users Nullable(Int32)
) ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_date, title_id, platform, country_code, channel_id);
CREATE TABLE IF NOT EXISTS fact_fox_retention_cohort (
  cohort_date Date,
  title_id LowCardinality(String),
  platform LowCardinality(String),
  country_code LowCardinality(String),
  day_n UInt16,
  retained_users Nullable(Int32)
) ENGINE = MergeTree
PARTITION BY toYYYYMM(cohort_date)
ORDER BY (cohort_date, title_id, platform, country_code);
CREATE TABLE IF NOT EXISTS fact_fox_ad_receipt (
  event_date Date,
  title_id LowCardinality(String),
  platform LowCardinality(String),
  country_code LowCardinality(String),
  placement LowCardinality(String),
  revenue_usd Nullable(Float64),
  is_predicted UInt8
) ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_date, title_id, platform, country_code, placement);
CREATE TABLE IF NOT EXISTS fact_fox_daily_spend (
  event_date Date,
  title_id LowCardinality(String),
  platform LowCardinality(String),
  country_code LowCardinality(String),
  channel_id LowCardinality(String),
  spend_usd Nullable(Float64),
  payback_usd Nullable(Float64),
  is_predicted UInt8
) ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_date, title_id, platform, country_code, channel_id);
CREATE TABLE IF NOT EXISTS fact_fox_cohort_payback (
  cohort_date Date,
  title_id LowCardinality(String),
  platform LowCardinality(String),
  country_code LowCardinality(String),
  channel_id LowCardinality(String),
  horizon_day UInt16,
  payback_usd Nullable(Float64),
  is_predicted UInt8
) ENGINE = MergeTree
PARTITION BY toYYYYMM(cohort_date)
ORDER BY (cohort_date, title_id, platform, country_code, channel_id);
CREATE TABLE IF NOT EXISTS fact_fox_experiment_arm (
  assigned_on Date,
  title_id LowCardinality(String),
  platform LowCardinality(String),
  country_code LowCardinality(String),
  experiment_id LowCardinality(String),
  variant_id LowCardinality(String),
  assigned_users Nullable(Int32)
) ENGINE = MergeTree
PARTITION BY toYYYYMM(assigned_on)
ORDER BY (assigned_on, title_id, platform, country_code);
CREATE TABLE IF NOT EXISTS fact_fox_experiment_metric (
  event_date Date,
  title_id LowCardinality(String),
  platform LowCardinality(String),
  country_code LowCardinality(String),
  experiment_id LowCardinality(String),
  variant_id LowCardinality(String),
  metric_name LowCardinality(String),
  metric_value Nullable(Float64)
) ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_date, title_id, platform, country_code);
