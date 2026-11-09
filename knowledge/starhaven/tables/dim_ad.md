# dim_ad：广告对象

粒度：dataset_version, ad_id

首版每广告仅一个主素材；替换主素材创建新广告ID。素材可被多广告复用，多素材组合归因暂不承诺。

| 字段 | ClickHouse类型 | 单位 | 定义 |
|---|---|---|---|
| dataset_version | String | — | 不可变数据发布版本 |
| ad_id | String | — | 全局唯一广告ID；自然来源不适用 |
| media_code | String | — | 虚构投放媒体代码 |
| account_id | String | — | 全局唯一虚构广告账户ID；自然来源不适用 |
| campaign_id | String | — | 全局唯一计划ID；自然来源不适用 |
| ad_group_id | String | — | 广告组ID；没有此层或自然来源为NULL |
| ad_name | String | — | 虚构广告名称 |
| primary_creative_id | String | — | 该广告唯一主素材；替换时创建新广告ID |
| created_at | DateTime64(3, 'UTC') | — | 对象创建UTC时刻 |

NULL表示缺失/不适用，0表示观测零；状态与单位必须一起解释。


