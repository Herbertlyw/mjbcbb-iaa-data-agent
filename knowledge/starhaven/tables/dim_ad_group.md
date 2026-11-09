# dim_ad_group：广告组

粒度：dataset_version, ad_group_id

没有广告组层的媒体允许该键NULL，不虚构一个真实组。

| 字段 | ClickHouse类型 | 单位 | 定义 |
|---|---|---|---|
| dataset_version | String | — | 不可变数据发布版本 |
| ad_group_id | String | — | 广告组ID；没有此层或自然来源为NULL |
| media_code | String | — | 虚构投放媒体代码 |
| account_id | String | — | 全局唯一虚构广告账户ID；自然来源不适用 |
| campaign_id | String | — | 全局唯一计划ID；自然来源不适用 |
| ad_group_name | String | — | 虚构广告组名称 |
| optimization_event_code | String | — | 虚构优化事件定义，不是事件发生次数 |
| created_at | DateTime64(3, 'UTC') | — | 对象创建UTC时刻 |

NULL表示缺失/不适用，0表示观测零；状态与单位必须一起解释。


