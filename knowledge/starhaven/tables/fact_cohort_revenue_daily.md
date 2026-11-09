# fact_cohort_revenue_daily：分来源回收

粒度：dataset_version, cohort_date, revenue_date, app_id, acquisition_country_code, ua_channel_id, campaign_id, ad_group_id, ad_id, creative_id, revenue_source

SDK和AF是两种观测不能相加；首版是广告回收，不默认为IAP流水。

| 字段 | ClickHouse类型 | 单位 | 定义 |
|---|---|---|---|
| dataset_version | String | — | 不可变数据发布版本 |
| cohort_date | Date | — | cohort_date：UTC业务日期；角色由表粒度定义，不与其他日期混用。 |
| revenue_date | Date | — | revenue_date：UTC业务日期；角色由表粒度定义，不与其他日期混用。 |
| app_id | String | — | 虚构包体ID，一款产品的一个平台实例 |
| acquisition_country_code | String | — | 首次获客时国家，设备在本包体内分群固定 |
| ua_channel_id | String | — | 获客渠道ID，与广告变现network不同 |
| campaign_id | Nullable(String) | — | 全局唯一计划ID；自然来源不适用 |
| ad_group_id | Nullable(String) | — | 广告组ID；没有此层或自然来源为NULL |
| ad_id | Nullable(String) | — | 全局唯一广告ID；自然来源不适用 |
| creative_id | Nullable(String) | — | 素材ID，可被多个广告复用 |
| revenue_source | String | — | sdk或af，不可相加称总收入 |
| revenue_usd | Nullable(Decimal(24,6)) | USD | 本来源本范围的观测美元收入 |
| revenue_callback_count | Nullable(UInt64) | 计数 | 收入回调次数 |
| age_days | UInt32 | 天 | 观察日距cohort锚点的自然日 |
| observed_at | DateTime64(3, 'UTC') | — | 观测可见UTC时刻 |
| completeness_state | String | — | complete或partial；完整性与freshness分开 |

NULL表示缺失/不适用，0表示观测零；状态与单位必须一起解释。

不得跨revenue_source相加声称总收入。
