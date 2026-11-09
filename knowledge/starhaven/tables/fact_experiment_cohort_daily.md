# fact_experiment_cohort_daily：实验观察

粒度：dataset_version, experiment_id, arm_id, config_version, app_id, entry_cohort_date, observe_date, entry_country_code

入组基数跨日不可累加；产品安装锚点与商业化触发锚点分开；不自动给显著性/全量上线结论。

| 字段 | ClickHouse类型 | 单位 | 定义 |
|---|---|---|---|
| dataset_version | String | — | 不可变数据发布版本 |
| experiment_id | String | — | 虚构实验ID |
| arm_id | String | — | 实验组ID，control或variant |
| config_version | String | — | 冻结实验配置版本 |
| app_id | String | — | 虚构包体ID，一款产品的一个平台实例 |
| entry_cohort_date | Date | — | entry_cohort_date：UTC业务日期；角色由表粒度定义，不与其他日期混用。 |
| observe_date | Date | — | observe_date：UTC业务日期；角色由表粒度定义，不与其他日期混用。 |
| entry_country_code | String | — | 实验入组时国家 |
| enrolled_units | Nullable(UInt64) | 实验分配单位 | 入组基数，重复观察日不可累加 |
| observed_units | Nullable(UInt64) | 实验分配单位 | 本观察日有完整观测条件的入组单位 |
| active_units | Nullable(UInt64) | 实验分配单位 | 本观察日活跃入组单位 |
| gameplay_seconds | Nullable(UInt64) | 秒 | 已结束局时长总秒数 |
| ad_impressions | Nullable(UInt64) | 计数 | 游戏内广告展示次数 |
| ad_revenue_usd | Nullable(Decimal(24,6)) | USD | 广告美元收入，不含IAP |
| anchor_type | String | — | first_open或first_ad_show，不是统一安装日 |
| age_days | UInt32 | 天 | 观察日距cohort锚点的自然日 |
| assignment_version | String | — | 实验哈希分配规则版本 |
| completeness_state | String | — | complete或partial；完整性与freshness分开 |

NULL表示缺失/不适用，0表示观测零；状态与单位必须一起解释。

enrolled_units不可跨observe_date或age_days相加。
不同experiment_id的样本可能重叠，不能相加称全部用户。
