# fact_ad_operation_event：操作变化

粒度：dataset_version, operation_event_id, field_name

行数是字段变更数，操作次数按event_id去重；不保存原始平台JSON或真实人员。

| 字段 | ClickHouse类型 | 单位 | 定义 |
|---|---|---|---|
| dataset_version | String | — | 不可变数据发布版本 |
| operation_event_id | String | — | 操作ID，一次操作多字段只计一次操作 |
| field_name | String | — | 受控变更字段名 |
| app_id | String | — | 虚构包体ID，一款产品的一个平台实例 |
| media_code | String | — | 虚构投放媒体代码 |
| account_id | Nullable(String) | — | 全局唯一虚构广告账户ID；自然来源不适用 |
| entity_type | String | — | 操作对象层级，campaign |
| entity_id | String | — | 对应受控对象ID |
| effective_at | DateTime64(3, 'UTC') | — | 操作生效UTC时刻 |
| recorded_at | DateTime64(3, 'UTC') | — | 日志可见UTC时刻 |
| old_value | Nullable(String) | — | 由value_type声明的旧值，初始化可为NULL |
| new_value | Nullable(String) | — | 由value_type声明的新值 |
| value_type | String | — | decimal或state |
| unit | String | — | 原币、百分比、状态等值单位 |
| change_source | String | — | synthetic_controlled_operation |

NULL表示缺失/不适用，0表示观测零；状态与单位必须一起解释。


