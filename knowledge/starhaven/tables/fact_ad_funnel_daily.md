# fact_ad_funnel_daily：广告商业化链路

粒度：dataset_version, business_date, app_id, activity_country_code, ad_format, network_code, event_schema_version

新合成事件字典定义attempt/request身份；load、ready、show不能互换，不直接命名成通用fill rate。

| 字段 | ClickHouse类型 | 单位 | 定义 |
|---|---|---|---|
| dataset_version | String | — | 不可变数据发布版本 |
| business_date | Date | — | business_date：UTC业务日期；角色由表粒度定义，不与其他日期混用。 |
| app_id | String | — | 虚构包体ID，一款产品的一个平台实例 |
| activity_country_code | String | — | 事件发生时国家；不能自动替代获客国家 |
| ad_format | String | — | interstitial、rewarded或banner |
| network_code | String | — | 虚构变现network，不是获客媒体 |
| event_schema_version | String | — | synthetic_ad_v1 |
| load_attempts | Nullable(UInt64) | 计数 | 开始的加载尝试 |
| completed_load_attempts | Nullable(UInt64) | 计数 | 已结束加载尝试，含成功失败 |
| successful_load_attempts | Nullable(UInt64) | 计数 | 已结束尝试中成功的数量 |
| show_actions | Nullable(UInt64) | 计数 | 调用show次数 |
| ready_actions | Nullable(UInt64) | 计数 | 调用show时ready次数，不是展示成功 |
| completed_show_requests | Nullable(UInt64) | 计数 | 已结束的show请求 |
| successful_show_requests | Nullable(UInt64) | 计数 | 已结束请求中展示成功数量 |
| impressions | Nullable(UInt64) | 计数 | 本事实范围的曝光或展示；投放与游戏内广告不是同一事件 |
| clicks | Nullable(UInt64) | 计数 | 本事实范围的点击次数，不是去重点击用户 |
| revenue_usd | Nullable(Decimal(24,6)) | USD | 本来源本范围的观测美元收入 |
| completeness_state | String | — | complete或partial；完整性与freshness分开 |

NULL表示缺失/不适用，0表示观测零；状态与单位必须一起解释。


