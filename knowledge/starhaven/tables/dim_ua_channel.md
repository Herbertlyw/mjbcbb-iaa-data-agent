# dim_ua_channel：获客渠道

粒度：dataset_version, ua_channel_id

获客渠道与广告变现network是两种不同维度。unknown不改叫organic。

| 字段 | ClickHouse类型 | 单位 | 定义 |
|---|---|---|---|
| dataset_version | String | — | 不可变数据发布版本 |
| ua_channel_id | String | — | 获客渠道ID，与广告变现network不同 |
| channel_name | String | — | 虚构获客渠道名称 |
| media_code | String | — | 虚构投放媒体代码 |
| channel_category | String | — | paid_ads、organic或unknown |
| is_paid | Nullable(UInt8) | — | 是否按本包配置属于买量 |
| classification_version | String | — | 渠道分类版本 |

NULL表示缺失/不适用，0表示观测零；状态与单位必须一起解释。


