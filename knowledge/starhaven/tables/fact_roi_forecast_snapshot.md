# fact_roi_forecast_snapshot：预测历史

粒度：dataset_version, snapshot_date, cohort_date, app_id, acquisition_country_code, ua_channel_id, campaign_id, horizon_days, model_version, revenue_source

预测只能使用input_cutoff之前可见数据；禁止写未来真实收入作模型输入。

| 字段 | ClickHouse类型 | 单位 | 定义 |
|---|---|---|---|
| dataset_version | String | — | 不可变数据发布版本 |
| snapshot_date | Date | — | 快照业务日期，不是收入发生日 |
| cohort_date | Date | — | cohort_date：UTC业务日期；角色由表粒度定义，不与其他日期混用。 |
| app_id | String | — | 虚构包体ID，一款产品的一个平台实例 |
| acquisition_country_code | String | — | 首次获客时国家，设备在本包体内分群固定 |
| ua_channel_id | String | — | 获客渠道ID，与广告变现network不同 |
| campaign_id | Nullable(String) | — | 全局唯一计划ID；自然来源不适用 |
| horizon_days | UInt32 | 天 | 累计业务天数N，对应日龄0..N-1 |
| model_version | String | — | baseline_linear_v1或baseline_tail_v2，不是公司模型 |
| revenue_source | String | — | sdk或af，不可相加称总收入 |
| cost_as_of_usd | Nullable(Decimal(24,6)) | USD | 预测当时已知成本 |
| predicted_revenue_usd | Nullable(Decimal(24,6)) | USD | 截至目标N日累计预测美元回收 |
| predicted_roi_pct | Nullable(Decimal(24,6)) | % | 预测收入/当时成本×100，不是实际ROI |
| prediction_id | String | — | 跨发布稳定的预测快照身份 |
| input_cutoff | DateTime64(3, 'UTC') | — | 预测输入截止，不得用之后真实值 |
| observed_age_days | UInt32 | 天 | 预测时已完整观察的cohort日数 |
| prediction_state | String | — | predicted，不是实际收入 |

NULL表示缺失/不适用，0表示观测零；状态与单位必须一起解释。

不得跨snapshot_date或model_version相加；选定一个预测视角。
