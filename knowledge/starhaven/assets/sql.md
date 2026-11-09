# SQL模板

先读当前发布范围，将DATASET_VERSION和示例日期替换为本任务版本和有效范围。以下16类SQL验证数据可查询性，不代表宿主对每种结果均有完整业务认证能力。预测、去重窗口和重复基数的限制仍生效。

投放成本先SUM金额再算比率。RR7只取age_days=7，按相同cohort基数计算。SDK/AF分源，禁止事实明细直接JOIN。

## apps：三款游戏与两个平台有哪些包体？

```sql
SELECT app_id, game_id, game_name, platform, game_kind FROM dim_app WHERE dataset_version = 'DATASET_VERSION' ORDER BY app_id
```

以包体为分析实例；第三款玩法未确认。

## delivery：各包体和渠道的消耗及注册是多少？

```sql
SELECT app_id, ua_channel_id, SUM(discounted_cost_usd) AS cost_usd, SUM(af_registers) AS af_regs, SUM(media_registers) AS media_regs, SUM(impressions) AS impressions, SUM(clicks) AS clicks FROM fact_delivery_daily WHERE dataset_version = 'DATASET_VERSION' AND business_date BETWEEN '2026-10-01' AND '2026-10-14' GROUP BY app_id, ua_channel_id ORDER BY app_id, ua_channel_id
```

先汇总分子分母，再计算CPI/CTR；自然量零成本不定义ROI。

## installs：首次安装、重装和晚到事件有什么差别？

```sql
SELECT app_id, SUM(unique_install_events) AS events, SUM(first_install_devices) AS first_devices, SUM(reinstall_events) AS reinstalls, SUM(late_install_events) AS late_events FROM fact_acquisition_daily WHERE dataset_version = 'DATASET_VERSION' AND cohort_date BETWEEN '2026-10-01' AND '2026-10-14' GROUP BY app_id
```

重装与晚到是总安装的子集，不能重复相加。

## activity：某个锚点的DAU和近7/30日活跃如何？

```sql
SELECT app_id, SUM(active_devices) AS dau, SUM(active_devices_7d) AS active_7d, SUM(active_devices_30d) AS active_30d FROM fact_activity_daily WHERE dataset_version = 'DATASET_VERSION' AND activity_date = '2026-10-14' GROUP BY app_id
```

只取一个锚点日；宿主目前不自动认证窗口字段的加总。

## rr7：已观察到第7日的cohort留存分子和基数是多少？

```sql
SELECT app_id, SUM(retained_devices) AS retained, SUM(cohort_size_devices) AS cohort_base FROM fact_cohort_quality_daily WHERE dataset_version = 'DATASET_VERSION' AND observe_date BETWEEN '2026-10-01' AND '2026-10-14' AND age_days = 7 GROUP BY app_id
```

RR7是第7日；cohort基数只在一个日龄内加总。

## gameplay：各模式的局数、时长、胜负和复活分别怎样？

```sql
SELECT business_date, app_id, mode_code, score_unit, games_finished, gameplay_seconds, eligible_win_games, games_won, revive_prompts, revive_clicks FROM fact_gameplay_daily WHERE dataset_version = 'DATASET_VERSION' AND business_date BETWEEN '2026-10-01' AND '2026-10-14' ORDER BY business_date, app_id LIMIT 100
```

此SQL只作明细预览，不能代表完整总体。无胜负定义的模式保持NULL；避免SUM全NULL误写成0。

## ad_funnel：广告加载、ready和展示成功各是什么？

```sql
SELECT app_id, ad_format, network_code, SUM(load_attempts) AS loads, SUM(completed_load_attempts) AS completed_loads, SUM(successful_load_attempts) AS successful_loads, SUM(show_actions) AS show_actions, SUM(ready_actions) AS ready, SUM(completed_show_requests) AS completed_shows, SUM(successful_show_requests) AS successful_shows, SUM(revenue_usd) AS revenue_usd FROM fact_ad_funnel_daily WHERE dataset_version = 'DATASET_VERSION' AND business_date BETWEEN '2026-10-01' AND '2026-10-14' GROUP BY app_id, ad_format, network_code
```

成功率用对应已结束请求；UA媒体与变现network分开。

## roi7_revenue：各cohort前7日的分来源回收是多少？

```sql
SELECT cohort_date, app_id, ua_channel_id, revenue_source, SUM(revenue_usd) AS revenue_usd FROM fact_cohort_revenue_daily WHERE dataset_version = 'DATASET_VERSION' AND revenue_date BETWEEN '2026-10-01' AND '2026-10-14' AND age_days < 7 GROUP BY cohort_date, app_id, ua_channel_id, revenue_source
```

这里只返回收入分量；另外取相同cohort成本，检查成熟及到达范围后再计算ROI。SDK与AF不可相加。

## creative：哪些素材未分配、未测试或尚不可判定？

```sql
SELECT app_id, creative_id, ua_channel_id, test_scope_state, is_eligible, is_tested, is_observable, is_graduated, test_window_cost_usd FROM fact_creative_test_snapshot WHERE dataset_version = 'DATASET_VERSION' AND snapshot_date = '2026-10-14'
```

只取一个快照；未分配不算测试失败，同素材跨渠道去重。

## experiment：实验第7日留存的分子分母分别是多少？

```sql
SELECT experiment_id, arm_id, config_version, anchor_type, SUM(active_units) AS active, SUM(enrolled_units) AS enrolled FROM fact_experiment_cohort_daily WHERE dataset_version = 'DATASET_VERSION' AND observe_date BETWEEN '2026-10-01' AND '2026-10-14' AND age_days = 7 GROUP BY experiment_id, arm_id, config_version, anchor_type
```

product与monetization入组锚点不同，不能合并为同一安装cohort。

## operations：哪些预算和状态变更可能与事实变化有关？

```sql
SELECT operation_event_id, field_name, entity_id, effective_at, old_value, new_value, unit FROM fact_ad_operation_event WHERE dataset_version = 'DATASET_VERSION' AND effective_at >= '2026-10-01 00:00:00' AND effective_at <= '2026-10-14 23:59:59' ORDER BY effective_at, operation_event_id
```

一次操作多字段只计一次；前后变化不证明因果。

## forecast：各预测快照使用什么窗口和当时输入？

```sql
SELECT prediction_id, app_id, cohort_date, snapshot_date, input_cutoff, observed_age_days, horizon_days, model_version, predicted_revenue_usd, cost_as_of_usd FROM fact_roi_forecast_snapshot WHERE dataset_version = 'DATASET_VERSION' AND snapshot_date BETWEEN '2026-10-01' AND '2026-10-14' AND horizon_days = 30 ORDER BY snapshot_date LIMIT 50
```

展示预测观测，不能认证为实际回收；同一cohort的多个预测快照不可累加。

## forecast_evaluation：哪些预测目标成熟，哪些发生了输入回刷？

```sql
SELECT app_id, horizon_days, model_version, maturity_state, input_revision_state, COUNT(*) AS predictions FROM fact_roi_forecast_evaluation WHERE dataset_version = 'DATASET_VERSION' AND evaluation_as_of = '2026-10-14' GROUP BY app_id, horizon_days, model_version, maturity_state, input_revision_state
```

误差须固定目标和版本并按成本加权，不能简单平均；未成熟保持NULL。

## fx：这天的虚构原币兑美元方向是什么？

```sql
SELECT rate_date, source_currency, source_currency_per_usd, rate_status FROM fact_fx_rate_daily WHERE dataset_version = 'DATASET_VERSION' AND rate_date = '2026-10-14'
```

local/USD_rate=USD；XCU完全虚构，不是市场报价。

## policy：合成经营目标和可观测规则是什么？

```sql
SELECT scope_key, policy_version, target_roi_pct, warning_roi_pct, minimum_sample_units, test_window_days FROM config_business_policy_snapshot WHERE dataset_version = 'DATASET_VERSION'
```

只描述合成规则，不是公司目标或自动操作建议。

## dimension_join：按产品名称汇总投放美元消耗？

```sql
SELECT f.app_id, d.game_name, SUM(f.discounted_cost_usd) AS cost_usd FROM fact_delivery_daily f JOIN dim_app d ON f.dataset_version = d.dataset_version AND f.app_id = d.app_id WHERE f.dataset_version = 'DATASET_VERSION' AND f.business_date BETWEEN '2026-10-01' AND '2026-10-14' GROUP BY f.app_id, d.game_name
```

同一版本的事实对唯一维表查找；不把两个事实明细直接JOIN。
