# fact_creative_test_snapshot：素材测试

粒度：dataset_version, snapshot_date, app_id, creative_id, ua_channel_id

状态从投放与成熟度派生，不独立随机造；汇总跨媒体素材数要去重。

| 字段 | ClickHouse类型 | 单位 | 定义 |
|---|---|---|---|
| dataset_version | String | — | 不可变数据发布版本 |
| snapshot_date | Date | — | 快照业务日期，不是收入发生日 |
| app_id | String | — | 虚构包体ID，一款产品的一个平台实例 |
| creative_id | Nullable(String) | — | 素材ID，可被多个广告复用 |
| ua_channel_id | Nullable(String) | — | 获客渠道ID，与广告变现network不同 |
| test_window_cost_usd | Nullable(Decimal(24,6)) | USD | 首次测试窗口折后美元消耗 |
| test_window_registers | Nullable(UInt64) | 报表注册 | 同窗口AF报表注册 |
| test_window_revenue_usd | Nullable(Decimal(24,6)) | USD | 同cohort窗口内SDK美元回收 |
| first_test_date | Nullable(Date) | — | 此素材在媒体首次投放日，未测试为NULL |
| test_scope_state | String | — | assigned或unassigned，未分配不等于失败 |
| is_eligible | UInt8 | — | 是否属于适用测试范围 |
| eligible_at | Nullable(DateTime64(3, 'UTC')) | — | 进入适用测试范围的UTC时刻 |
| is_tested | UInt8 | — | 是否观察到投放 |
| is_observable | UInt8 | — | 窗口是否成熟且有足够证据 |
| is_graduated | Nullable(UInt8) | — | 是否达到虚构出坡规则，证据不足为NULL |
| rule_version | String | — | 合成状态规则版本 |
| completeness_state | String | — | complete或partial；完整性与freshness分开 |

NULL表示缺失/不适用，0表示观测零；状态与单位必须一起解释。

跨UA渠道的素材数须按creative_id去重；不能相加状态快照。
