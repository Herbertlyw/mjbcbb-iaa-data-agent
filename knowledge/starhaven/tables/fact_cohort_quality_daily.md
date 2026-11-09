# fact_cohort_quality_daily：留存与获客后质量

粒度：dataset_version, install_cohort_date, observe_date, app_id, acquisition_country_code, ua_channel_id, campaign_id, ad_group_id, ad_id, creative_id

cohort_size跨观察日重复不可累加；UTC设备cohort不冒充AF报表cohort。

| 字段 | ClickHouse类型 | 单位 | 定义 |
|---|---|---|---|
| dataset_version | String | — | 不可变数据发布版本 |
| install_cohort_date | Date | — | install_cohort_date：UTC业务日期；角色由表粒度定义，不与其他日期混用。 |
| observe_date | Date | — | observe_date：UTC业务日期；角色由表粒度定义，不与其他日期混用。 |
| app_id | String | — | 虚构包体ID，一款产品的一个平台实例 |
| acquisition_country_code | String | — | 首次获客时国家，设备在本包体内分群固定 |
| ua_channel_id | String | — | 获客渠道ID，与广告变现network不同 |
| campaign_id | Nullable(String) | — | 全局唯一计划ID；自然来源不适用 |
| ad_group_id | Nullable(String) | — | 广告组ID；没有此层或自然来源为NULL |
| ad_id | Nullable(String) | — | 全局唯一广告ID；自然来源不适用 |
| creative_id | Nullable(String) | — | 素材ID，可被多个广告复用 |
| cohort_size_devices | Nullable(UInt64) | 设备×App | cohort设备基数，在多观察日重复，不跨观察日累加 |
| retained_devices | Nullable(UInt64) | 设备×App | 本cohort在观察日活跃设备数 |
| game_count | Nullable(UInt64) | 局 | 已结束局数 |
| gameplay_seconds | Nullable(UInt64) | 秒 | 已结束局时长总秒数 |
| usage_seconds | Nullable(UInt64) | 秒 | 使用时长总秒数，包含局外时间 |
| ad_impressions | Nullable(UInt64) | 计数 | 游戏内广告展示次数 |
| ad_revenue_usd | Nullable(Decimal(24,6)) | USD | 广告美元收入，不含IAP |
| age_days | UInt32 | 天 | 观察日距cohort锚点的自然日 |
| maturity_state | String | — | observed、mature或immature，不是freshness |
| completeness_state | String | — | complete或partial；完整性与freshness分开 |

NULL表示缺失/不适用，0表示观测零；状态与单位必须一起解释。

cohort_size_devices不可跨observe_date或age_days相加。
retained_devices按单一age或明确观察日使用，留存率从同cohort分母重算。
