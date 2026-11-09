# fact_activity_daily：产品活跃

粒度：dataset_version, activity_date, app_id, acquisition_country_code, ua_channel_id

首版按首次获客国家/渠道固定分群；7/30日活跃在私有模拟设备上精确去重，只在同一锚点使用，不跨日相加或声称跨App人数。

| 字段 | ClickHouse类型 | 单位 | 定义 |
|---|---|---|---|
| dataset_version | String | — | 不可变数据发布版本 |
| activity_date | Date | — | activity_date：UTC业务日期；角色由表粒度定义，不与其他日期混用。 |
| app_id | String | — | 虚构包体ID，一款产品的一个平台实例 |
| acquisition_country_code | String | — | 首次获客时国家，设备在本包体内分群固定 |
| ua_channel_id | String | — | 获客渠道ID，与广告变现network不同 |
| active_devices | Nullable(UInt64) | 设备×App | 当日活跃设备×App；跨天相加为设备日 |
| active_devices_7d | Nullable(UInt64) | 设备×App | 锚点D-6..D精确去重活跃，不跨锚点相加 |
| active_devices_30d | Nullable(UInt64) | 设备×App | 锚点D-29..D精确去重活跃，不跨锚点相加 |
| new_active_devices | Nullable(UInt64) | 设备×App | 当日首次活跃设备×App |
| returning_active_devices | Nullable(UInt64) | 设备×App | 当日活跃中此前已活跃的设备 |
| sessions | Nullable(UInt64) | 计数 | 启动会话次数，不是去重设备 |
| gameplay_seconds | Nullable(UInt64) | 秒 | 已结束局时长总秒数 |
| game_count | Nullable(UInt64) | 局 | 已结束局数 |
| ad_viewing_devices | Nullable(UInt64) | 设备×App | 当日至少观看一次广告的去重设备 |
| ad_impressions | Nullable(UInt64) | 计数 | 游戏内广告展示次数 |
| ad_revenue_usd | Nullable(Decimal(24,6)) | USD | 广告美元收入，不含IAP |
| device_identity_rule | String | — | synthetic_device_app_first_install_v1 |
| completeness_state | String | — | complete或partial；完整性与freshness分开 |

NULL表示缺失/不适用，0表示观测零；状态与单位必须一起解释。

active_devices_7d/30d不可跨activity_date相加；同一App、同一锚点的固定获客分群才可汇总。
日活跨天求和是设备日，不是窗口去重设备。
