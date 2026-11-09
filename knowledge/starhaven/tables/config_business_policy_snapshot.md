# config_business_policy_snapshot：合成经营规则

粒度：dataset_version, policy_id, policy_version, effective_from, scope_type, scope_key

所有阈值是新虚构配置；不复制公司红黄线，也不把阈值判断等同可执行投放建议。

| 字段 | ClickHouse类型 | 单位 | 定义 |
|---|---|---|---|
| dataset_version | String | — | 不可变数据发布版本 |
| policy_id | String | — | 合成经营规则身份 |
| policy_version | String | — | 合成规则版本 |
| effective_from | DateTime64(3, 'UTC') | — | 规则生效UTC时刻 |
| scope_type | String | — | app |
| scope_key | String | — | 适用App ID |
| effective_to | Nullable(DateTime64(3, 'UTC')) | — | 规则结束UTC时刻，无结束为NULL |
| target_roi_pct | Decimal(24,6) | % | 虚构目标回收百分比，不是公司目标 |
| warning_roi_pct | Decimal(24,6) | % | 虚构观察线，不是投放指令 |
| minimum_sample_units | UInt32 | — | 最小样本数，合成参数 |
| test_window_days | UInt32 | 天 | 首次测试窗口日数 |
| maturity_days | UInt32 | 天 | 规则要求成熟日数 |

NULL表示缺失/不适用，0表示观测零；状态与单位必须一起解释。


