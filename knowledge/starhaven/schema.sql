CREATE TABLE IF NOT EXISTS dim_app (
  dataset_version String,
  app_id String,
  game_id String,
  game_name String,
  game_kind String,
  platform String,
  bundle_id String,
  launch_date Date,
  business_timezone String,
  supported_mode_codes String
) ENGINE = MergeTree ORDER BY (dataset_version, app_id) SETTINGS allow_nullable_key = 1;

CREATE TABLE IF NOT EXISTS dim_country (
  dataset_version String,
  country_code String,
  country_name String,
  region String,
  tier_code String
) ENGINE = MergeTree ORDER BY (dataset_version, country_code) SETTINGS allow_nullable_key = 1;

CREATE TABLE IF NOT EXISTS dim_ua_channel (
  dataset_version String,
  ua_channel_id String,
  channel_name String,
  media_code String,
  channel_category String,
  is_paid Nullable(UInt8),
  classification_version String
) ENGINE = MergeTree ORDER BY (dataset_version, ua_channel_id) SETTINGS allow_nullable_key = 1;

CREATE TABLE IF NOT EXISTS dim_ad_account (
  dataset_version String,
  account_id String,
  media_code String,
  account_name String,
  account_currency String,
  account_timezone String
) ENGINE = MergeTree ORDER BY (dataset_version, account_id) SETTINGS allow_nullable_key = 1;

CREATE TABLE IF NOT EXISTS dim_campaign (
  dataset_version String,
  campaign_id String,
  media_code String,
  account_id String,
  app_id String,
  campaign_name String,
  objective_code String,
  budget_level String,
  created_at DateTime64(3, 'UTC')
) ENGINE = MergeTree ORDER BY (dataset_version, campaign_id) SETTINGS allow_nullable_key = 1;

CREATE TABLE IF NOT EXISTS dim_ad_group (
  dataset_version String,
  ad_group_id String,
  media_code String,
  account_id String,
  campaign_id String,
  ad_group_name String,
  optimization_event_code String,
  created_at DateTime64(3, 'UTC')
) ENGINE = MergeTree ORDER BY (dataset_version, ad_group_id) SETTINGS allow_nullable_key = 1;

CREATE TABLE IF NOT EXISTS dim_ad (
  dataset_version String,
  ad_id String,
  media_code String,
  account_id String,
  campaign_id String,
  ad_group_id String,
  ad_name String,
  primary_creative_id String,
  created_at DateTime64(3, 'UTC')
) ENGINE = MergeTree ORDER BY (dataset_version, ad_id) SETTINGS allow_nullable_key = 1;

CREATE TABLE IF NOT EXISTS dim_creative (
  dataset_version String,
  creative_id String,
  app_id String,
  creative_name String,
  format_code String,
  upload_at DateTime64(3, 'UTC'),
  duration_seconds UInt32,
  aspect_ratio String,
  tag_codes String
) ENGINE = MergeTree ORDER BY (dataset_version, creative_id) SETTINGS allow_nullable_key = 1;

CREATE TABLE IF NOT EXISTS dim_experiment_arm (
  dataset_version String,
  experiment_id String,
  arm_id String,
  config_version String,
  app_id String,
  experiment_type String,
  allocation_unit String,
  allocation_fraction Decimal(24,6),
  eligibility_code String,
  anchor_type String,
  control_arm_id String,
  starts_at DateTime64(3, 'UTC'),
  ends_at DateTime64(3, 'UTC')
) ENGINE = MergeTree ORDER BY (dataset_version, experiment_id, arm_id, config_version) SETTINGS allow_nullable_key = 1;

CREATE TABLE IF NOT EXISTS fact_delivery_daily (
  dataset_version String,
  business_date Date,
  app_id String,
  acquisition_country_code String,
  ua_channel_id String,
  account_id Nullable(String),
  campaign_id Nullable(String),
  ad_group_id Nullable(String),
  ad_id Nullable(String),
  creative_id Nullable(String),
  raw_cost_local Nullable(Decimal(24,6)),
  discounted_cost_local Nullable(Decimal(24,6)),
  raw_cost_usd Nullable(Decimal(24,6)),
  discounted_cost_usd Nullable(Decimal(24,6)),
  impressions Nullable(UInt64),
  clicks Nullable(UInt64),
  media_registers Nullable(UInt64),
  af_registers Nullable(UInt64),
  source_currency String,
  fx_rate_date Date,
  cost_scope String,
  completeness_state String
) ENGINE = MergeTree ORDER BY (dataset_version, business_date, app_id, acquisition_country_code, ua_channel_id, account_id, campaign_id, ad_group_id, ad_id, creative_id) SETTINGS allow_nullable_key = 1;

CREATE TABLE IF NOT EXISTS fact_acquisition_daily (
  dataset_version String,
  cohort_date Date,
  app_id String,
  acquisition_country_code String,
  ua_channel_id String,
  campaign_id Nullable(String),
  ad_group_id Nullable(String),
  ad_id Nullable(String),
  creative_id Nullable(String),
  unique_install_events Nullable(UInt64),
  first_install_devices Nullable(UInt64),
  reinstall_events Nullable(UInt64),
  late_install_events Nullable(UInt64),
  unattributed_install_events Nullable(UInt64),
  arrival_cutoff DateTime64(3, 'UTC'),
  completeness_state String
) ENGINE = MergeTree ORDER BY (dataset_version, cohort_date, app_id, acquisition_country_code, ua_channel_id, campaign_id, ad_group_id, ad_id, creative_id) SETTINGS allow_nullable_key = 1;

CREATE TABLE IF NOT EXISTS fact_activity_daily (
  dataset_version String,
  activity_date Date,
  app_id String,
  acquisition_country_code String,
  ua_channel_id String,
  active_devices Nullable(UInt64),
  active_devices_7d Nullable(UInt64),
  active_devices_30d Nullable(UInt64),
  new_active_devices Nullable(UInt64),
  returning_active_devices Nullable(UInt64),
  sessions Nullable(UInt64),
  gameplay_seconds Nullable(UInt64),
  game_count Nullable(UInt64),
  ad_viewing_devices Nullable(UInt64),
  ad_impressions Nullable(UInt64),
  ad_revenue_usd Nullable(Decimal(24,6)),
  device_identity_rule String,
  completeness_state String
) ENGINE = MergeTree ORDER BY (dataset_version, activity_date, app_id, acquisition_country_code, ua_channel_id) SETTINGS allow_nullable_key = 1;

CREATE TABLE IF NOT EXISTS fact_cohort_quality_daily (
  dataset_version String,
  install_cohort_date Date,
  observe_date Date,
  app_id String,
  acquisition_country_code String,
  ua_channel_id String,
  campaign_id Nullable(String),
  ad_group_id Nullable(String),
  ad_id Nullable(String),
  creative_id Nullable(String),
  cohort_size_devices Nullable(UInt64),
  retained_devices Nullable(UInt64),
  game_count Nullable(UInt64),
  gameplay_seconds Nullable(UInt64),
  usage_seconds Nullable(UInt64),
  ad_impressions Nullable(UInt64),
  ad_revenue_usd Nullable(Decimal(24,6)),
  age_days UInt32,
  maturity_state String,
  completeness_state String
) ENGINE = MergeTree ORDER BY (dataset_version, install_cohort_date, observe_date, app_id, acquisition_country_code, ua_channel_id, campaign_id, ad_group_id, ad_id, creative_id) SETTINGS allow_nullable_key = 1;

CREATE TABLE IF NOT EXISTS fact_gameplay_daily (
  dataset_version String,
  business_date Date,
  app_id String,
  activity_country_code String,
  mode_code String,
  level_bucket String,
  games_started Nullable(UInt64),
  games_finished Nullable(UInt64),
  eligible_win_games Nullable(UInt64),
  games_won Nullable(UInt64),
  gameplay_seconds Nullable(UInt64),
  total_score Nullable(UInt64),
  revive_prompts Nullable(UInt64),
  revive_clicks Nullable(UInt64),
  successful_revives Nullable(UInt64),
  score_unit String,
  gameplay_schema_version String,
  completeness_state String
) ENGINE = MergeTree ORDER BY (dataset_version, business_date, app_id, activity_country_code, mode_code, level_bucket) SETTINGS allow_nullable_key = 1;

CREATE TABLE IF NOT EXISTS fact_ad_funnel_daily (
  dataset_version String,
  business_date Date,
  app_id String,
  activity_country_code String,
  ad_format String,
  network_code String,
  event_schema_version String,
  load_attempts Nullable(UInt64),
  completed_load_attempts Nullable(UInt64),
  successful_load_attempts Nullable(UInt64),
  show_actions Nullable(UInt64),
  ready_actions Nullable(UInt64),
  completed_show_requests Nullable(UInt64),
  successful_show_requests Nullable(UInt64),
  impressions Nullable(UInt64),
  clicks Nullable(UInt64),
  revenue_usd Nullable(Decimal(24,6)),
  completeness_state String
) ENGINE = MergeTree ORDER BY (dataset_version, business_date, app_id, activity_country_code, ad_format, network_code, event_schema_version) SETTINGS allow_nullable_key = 1;

CREATE TABLE IF NOT EXISTS fact_cohort_revenue_daily (
  dataset_version String,
  cohort_date Date,
  revenue_date Date,
  app_id String,
  acquisition_country_code String,
  ua_channel_id String,
  campaign_id Nullable(String),
  ad_group_id Nullable(String),
  ad_id Nullable(String),
  creative_id Nullable(String),
  revenue_source String,
  revenue_usd Nullable(Decimal(24,6)),
  revenue_callback_count Nullable(UInt64),
  age_days UInt32,
  observed_at DateTime64(3, 'UTC'),
  completeness_state String
) ENGINE = MergeTree ORDER BY (dataset_version, cohort_date, revenue_date, app_id, acquisition_country_code, ua_channel_id, campaign_id, ad_group_id, ad_id, creative_id, revenue_source) SETTINGS allow_nullable_key = 1;

CREATE TABLE IF NOT EXISTS fact_creative_test_snapshot (
  dataset_version String,
  snapshot_date Date,
  app_id String,
  creative_id Nullable(String),
  ua_channel_id Nullable(String),
  test_window_cost_usd Nullable(Decimal(24,6)),
  test_window_registers Nullable(UInt64),
  test_window_revenue_usd Nullable(Decimal(24,6)),
  first_test_date Nullable(Date),
  test_scope_state String,
  is_eligible UInt8,
  eligible_at Nullable(DateTime64(3, 'UTC')),
  is_tested UInt8,
  is_observable UInt8,
  is_graduated Nullable(UInt8),
  rule_version String,
  completeness_state String
) ENGINE = MergeTree ORDER BY (dataset_version, snapshot_date, app_id, creative_id, ua_channel_id) SETTINGS allow_nullable_key = 1;

CREATE TABLE IF NOT EXISTS fact_experiment_cohort_daily (
  dataset_version String,
  experiment_id String,
  arm_id String,
  config_version String,
  app_id String,
  entry_cohort_date Date,
  observe_date Date,
  entry_country_code String,
  enrolled_units Nullable(UInt64),
  observed_units Nullable(UInt64),
  active_units Nullable(UInt64),
  gameplay_seconds Nullable(UInt64),
  ad_impressions Nullable(UInt64),
  ad_revenue_usd Nullable(Decimal(24,6)),
  anchor_type String,
  age_days UInt32,
  assignment_version String,
  completeness_state String
) ENGINE = MergeTree ORDER BY (dataset_version, experiment_id, arm_id, config_version, app_id, entry_cohort_date, observe_date, entry_country_code) SETTINGS allow_nullable_key = 1;

CREATE TABLE IF NOT EXISTS fact_ad_operation_event (
  dataset_version String,
  operation_event_id String,
  field_name String,
  app_id String,
  media_code String,
  account_id Nullable(String),
  entity_type String,
  entity_id String,
  effective_at DateTime64(3, 'UTC'),
  recorded_at DateTime64(3, 'UTC'),
  old_value Nullable(String),
  new_value Nullable(String),
  value_type String,
  unit String,
  change_source String
) ENGINE = MergeTree ORDER BY (dataset_version, operation_event_id, field_name) SETTINGS allow_nullable_key = 1;

CREATE TABLE IF NOT EXISTS fact_roi_forecast_snapshot (
  dataset_version String,
  snapshot_date Date,
  cohort_date Date,
  app_id String,
  acquisition_country_code String,
  ua_channel_id String,
  campaign_id Nullable(String),
  horizon_days UInt32,
  model_version String,
  revenue_source String,
  cost_as_of_usd Nullable(Decimal(24,6)),
  predicted_revenue_usd Nullable(Decimal(24,6)),
  predicted_roi_pct Nullable(Decimal(24,6)),
  prediction_id String,
  input_cutoff DateTime64(3, 'UTC'),
  observed_age_days UInt32,
  prediction_state String
) ENGINE = MergeTree ORDER BY (dataset_version, snapshot_date, cohort_date, app_id, acquisition_country_code, ua_channel_id, campaign_id, horizon_days, model_version, revenue_source) SETTINGS allow_nullable_key = 1;

CREATE TABLE IF NOT EXISTS fact_roi_forecast_evaluation (
  dataset_version String,
  prediction_id String,
  evaluation_as_of Date,
  snapshot_date Date,
  cohort_date Date,
  app_id String,
  acquisition_country_code String,
  ua_channel_id String,
  campaign_id Nullable(String),
  horizon_days UInt32,
  model_version String,
  revenue_source String,
  predicted_roi_pct Nullable(Decimal(24,6)),
  actual_revenue_usd Nullable(Decimal(24,6)),
  actual_cost_usd Nullable(Decimal(24,6)),
  actual_roi_pct Nullable(Decimal(24,6)),
  roi_error_pp Nullable(Decimal(24,6)),
  cost_weight_usd Nullable(Decimal(24,6)),
  maturity_state String,
  input_revision_state String,
  completeness_state String
) ENGINE = MergeTree ORDER BY (dataset_version, prediction_id, evaluation_as_of, snapshot_date, cohort_date, app_id, acquisition_country_code, ua_channel_id, campaign_id, horizon_days, model_version, revenue_source) SETTINGS allow_nullable_key = 1;

CREATE TABLE IF NOT EXISTS fact_fx_rate_daily (
  dataset_version String,
  rate_date Date,
  source_currency String,
  source_currency_per_usd Nullable(Decimal(24,6)),
  rate_status String
) ENGINE = MergeTree ORDER BY (dataset_version, rate_date, source_currency) SETTINGS allow_nullable_key = 1;

CREATE TABLE IF NOT EXISTS config_business_policy_snapshot (
  dataset_version String,
  policy_id String,
  policy_version String,
  effective_from DateTime64(3, 'UTC'),
  scope_type String,
  scope_key String,
  effective_to Nullable(DateTime64(3, 'UTC')),
  target_roi_pct Decimal(24,6),
  warning_roi_pct Decimal(24,6),
  minimum_sample_units UInt32,
  test_window_days UInt32,
  maturity_days UInt32
) ENGINE = MergeTree ORDER BY (dataset_version, policy_id, policy_version, effective_from, scope_type, scope_key) SETTINGS allow_nullable_key = 1;
