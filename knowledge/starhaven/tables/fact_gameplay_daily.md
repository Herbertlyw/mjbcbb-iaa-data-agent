# fact_gameplay_daily：玩法汇总

粒度：dataset_version, business_date, app_id, activity_country_code, mode_code, level_bucket

没有胜负定义的模式相关字段为不适用；不造轮/块明细，也不跨游戏直接比较分数。

| 字段 | ClickHouse类型 | 单位 | 定义 |
|---|---|---|---|
| dataset_version | String | — | 不可变数据发布版本 |
| business_date | Date | — | business_date：UTC业务日期；角色由表粒度定义，不与其他日期混用。 |
| app_id | String | — | 虚构包体ID，一款产品的一个平台实例 |
| activity_country_code | String | — | 事件发生时国家；不能自动替代获客国家 |
| mode_code | String | — | 产品内已定义模式 |
| level_bucket | String | — | 关卡区间，无关卡模式为not_applicable |
| games_started | Nullable(UInt64) | 局 | 开局次数 |
| games_finished | Nullable(UInt64) | 局 | 已结束局数 |
| eligible_win_games | Nullable(UInt64) | 局 | 可判胜负的已结束局数 |
| games_won | Nullable(UInt64) | 局 | 可判胜负局中的胜利数，不适用为NULL |
| gameplay_seconds | Nullable(UInt64) | 秒 | 已结束局时长总秒数 |
| total_score | Nullable(UInt64) | 计数 | 同一产品/模式/单位的分数和，不跨游戏比较 |
| revive_prompts | Nullable(UInt64) | 计数 | 复活提示次数 |
| revive_clicks | Nullable(UInt64) | 计数 | 复活点击次数，不等于成功看完广告 |
| successful_revives | Nullable(UInt64) | 计数 | 成功复活次数 |
| score_unit | String | — | 产品与模式专用分数单位 |
| gameplay_schema_version | String | — | 合成玩法事件版本 |
| completeness_state | String | — | complete或partial；完整性与freshness分开 |

NULL表示缺失/不适用，0表示观测零；状态与单位必须一起解释。


