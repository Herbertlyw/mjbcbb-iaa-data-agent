# fact_delivery_daily：投放前端事实

粒度：dataset_version, business_date, app_id, acquisition_country_code, ua_channel_id, account_id, campaign_id, ad_group_id, ad_id, creative_id

af_registers是报表计数，不改名成ODS去重安装；原币成本不跨币种相加。

| 字段 | ClickHouse类型 | 单位 | 定义 |
|---|---|---|---|
| dataset_version | String | — | 不可变数据发布版本 |
| business_date | Date | — | business_date：UTC业务日期；角色由表粒度定义，不与其他日期混用。 |
| app_id | String | — | 虚构包体ID，一款产品的一个平台实例 |
| acquisition_country_code | String | — | 首次获客时国家，设备在本包体内分群固定 |
| ua_channel_id | String | — | 获客渠道ID，与广告变现network不同 |
| account_id | Nullable(String) | — | 全局唯一虚构广告账户ID；自然来源不适用 |
| campaign_id | Nullable(String) | — | 全局唯一计划ID；自然来源不适用 |
| ad_group_id | Nullable(String) | — | 广告组ID；没有此层或自然来源为NULL |
| ad_id | Nullable(String) | — | 全局唯一广告ID；自然来源不适用 |
| creative_id | Nullable(String) | — | 素材ID，可被多个广告复用 |
| raw_cost_local | Nullable(Decimal(24,6)) | 原币 | 未折扣原币消耗，不能跨币种直接相加 |
| discounted_cost_local | Nullable(Decimal(24,6)) | 原币 | 折后原币消耗，不是美元 |
| raw_cost_usd | Nullable(Decimal(24,6)) | USD | 逐行按汇率换算的原始美元消耗 |
| discounted_cost_usd | Nullable(Decimal(24,6)) | USD | 逐行换算的折后美元消耗 |
| impressions | Nullable(UInt64) | 计数 | 本事实范围的曝光或展示；投放与游戏内广告不是同一事件 |
| clicks | Nullable(UInt64) | 计数 | 本事实范围的点击次数，不是去重点击用户 |
| media_registers | Nullable(UInt64) | 报表注册 | 媒体报表注册，不等于AF报表注册或设备 |
| af_registers | Nullable(UInt64) | 报表注册 | AF报表注册计数，不是ODS安装事件数 |
| source_currency | String | — | 原始币种代码；XCU完全虚构 |
| fx_rate_date | Date | — | 汇率UTC业务日 |
| cost_scope | String | — | 成本范围，discounted_media_delivery |
| completeness_state | String | — | complete或partial；完整性与freshness分开 |

NULL表示缺失/不适用，0表示观测零；状态与单位必须一起解释。


