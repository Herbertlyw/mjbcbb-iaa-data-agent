# fact_roi_forecast_evaluation：预测复验

粒度：dataset_version, prediction_id, evaluation_as_of, snapshot_date, cohort_date, app_id, acquisition_country_code, ua_channel_id, campaign_id, horizon_days, model_version, revenue_source

从同一个预测ID复制不可变范围及预测值，方便单表查询；仅成熟完整且输入成本可比时评估模型误差，输入回刷单列。

| 字段 | ClickHouse类型 | 单位 | 定义 |
|---|---|---|---|
| dataset_version | String | — | 不可变数据发布版本 |
| prediction_id | String | — | 跨发布稳定的预测快照身份 |
| evaluation_as_of | Date | — | 复验截止业务日 |
| snapshot_date | Date | — | 快照业务日期，不是收入发生日 |
| cohort_date | Date | — | cohort_date：UTC业务日期；角色由表粒度定义，不与其他日期混用。 |
| app_id | String | — | 虚构包体ID，一款产品的一个平台实例 |
| acquisition_country_code | String | — | 首次获客时国家，设备在本包体内分群固定 |
| ua_channel_id | String | — | 获客渠道ID，与广告变现network不同 |
| campaign_id | Nullable(String) | — | 全局唯一计划ID；自然来源不适用 |
| horizon_days | UInt32 | 天 | 累计业务天数N，对应日龄0..N-1 |
| model_version | String | — | baseline_linear_v1或baseline_tail_v2，不是公司模型 |
| revenue_source | String | — | sdk或af，不可相加称总收入 |
| predicted_roi_pct | Nullable(Decimal(24,6)) | % | 预测收入/当时成本×100，不是实际ROI |
| actual_revenue_usd | Nullable(Decimal(24,6)) | USD | 成熟目标窗口实际SDK观测收入 |
| actual_cost_usd | Nullable(Decimal(24,6)) | USD | 复验时对应cohort完整成本 |
| actual_roi_pct | Nullable(Decimal(24,6)) | % | 成熟收入/完整成本×100 |
| roi_error_pp | Nullable(Decimal(24,6)) | 百分点 | 实际ROI减预测ROI，百分点 |
| cost_weight_usd | Nullable(Decimal(24,6)) | USD | 成本加权误差权重 |
| maturity_state | String | — | observed、mature或immature，不是freshness |
| input_revision_state | String | — | unchanged或input_revised；回刷与模型误差分开 |
| completeness_state | String | — | complete或partial；完整性与freshness分开 |

NULL表示缺失/不适用，0表示观测零；状态与单位必须一起解释。


