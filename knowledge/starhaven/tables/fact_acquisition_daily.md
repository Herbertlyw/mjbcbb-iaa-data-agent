# fact_acquisition_daily：安装与归因

粒度：dataset_version, cohort_date, app_id, acquisition_country_code, ua_channel_id, campaign_id, ad_group_id, ad_id, creative_id

保留事件、首次设备、重装和迟到的不同身份；私有模拟标识不在公开表中输出。

| 字段 | ClickHouse类型 | 单位 | 定义 |
|---|---|---|---|
| dataset_version | String | — | 不可变数据发布版本 |
| cohort_date | Date | — | cohort_date：UTC业务日期；角色由表粒度定义，不与其他日期混用。 |
| app_id | String | — | 虚构包体ID，一款产品的一个平台实例 |
| acquisition_country_code | String | — | 首次获客时国家，设备在本包体内分群固定 |
| ua_channel_id | String | — | 获客渠道ID，与广告变现network不同 |
| campaign_id | Nullable(String) | — | 全局唯一计划ID；自然来源不适用 |
| ad_group_id | Nullable(String) | — | 广告组ID；没有此层或自然来源为NULL |
| ad_id | Nullable(String) | — | 全局唯一广告ID；自然来源不适用 |
| creative_id | Nullable(String) | — | 素材ID，可被多个广告复用 |
| unique_install_events | Nullable(UInt64) | 安装事件 | 去重安装事件，含重装 |
| first_install_devices | Nullable(UInt64) | 设备×App | 首次安装设备×App数量，不是跨App玩家 |
| reinstall_events | Nullable(UInt64) | 安装事件 | 重装安装事件子集，不额外加到安装总计 |
| late_install_events | Nullable(UInt64) | 安装事件 | 晚于业务日到达的安装子集，不额外相加 |
| unattributed_install_events | Nullable(UInt64) | 安装事件 | 无明确获客计划的安装子集 |
| arrival_cutoff | DateTime64(3, 'UTC') | — | 本发布可见的到达时间截止 |
| completeness_state | String | — | complete或partial；完整性与freshness分开 |

NULL表示缺失/不适用，0表示观测零；状态与单位必须一起解释。


