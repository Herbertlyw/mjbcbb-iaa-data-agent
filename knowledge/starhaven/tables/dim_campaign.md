# dim_campaign：投放计划

粒度：dataset_version, campaign_id

首版身份/层级/目标不改写；预算与状态另用事件记录，不用any()猜历史最新。

| 字段 | ClickHouse类型 | 单位 | 定义 |
|---|---|---|---|
| dataset_version | String | — | 不可变数据发布版本 |
| campaign_id | String | — | 全局唯一计划ID；自然来源不适用 |
| media_code | String | — | 虚构投放媒体代码 |
| account_id | String | — | 全局唯一虚构广告账户ID；自然来源不适用 |
| app_id | String | — | 虚构包体ID，一款产品的一个平台实例 |
| campaign_name | String | — | 虚构计划名称 |
| objective_code | String | — | 计划固定优化目标 |
| budget_level | String | — | 预算所属层级，campaign |
| created_at | DateTime64(3, 'UTC') | — | 对象创建UTC时刻 |

NULL表示缺失/不适用，0表示观测零；状态与单位必须一起解释。


