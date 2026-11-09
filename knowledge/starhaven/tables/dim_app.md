# dim_app：产品包体

粒度：dataset_version, app_id

三款产品、iOS/Android分别有身份；第三款玩法未定，不猜TPT含义。

| 字段 | ClickHouse类型 | 单位 | 定义 |
|---|---|---|---|
| dataset_version | String | — | 不可变数据发布版本 |
| app_id | String | — | 虚构包体ID，一款产品的一个平台实例 |
| game_id | String | — | 虚构游戏ID，可对应iOS与Android包体 |
| game_name | String | — | 虚构游戏中文名 |
| game_kind | String | — | 玩法分类；未确认玩法为unconfirmed |
| platform | String | — | 平台，固定ios或android |
| bundle_id | String | — | 虚构包名，不对应真实应用 |
| launch_date | Date | — | launch_date：UTC业务日期；角色由表粒度定义，不与其他日期混用。 |
| business_timezone | String | — | 本数据包业务日统一UTC |
| supported_mode_codes | String | — | 该包体已定义模式，逗号分隔 |

NULL表示缺失/不适用，0表示观测零；状态与单位必须一起解释。


