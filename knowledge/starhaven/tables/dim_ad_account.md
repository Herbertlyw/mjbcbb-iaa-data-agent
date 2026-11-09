# dim_ad_account：广告账户

粒度：dataset_version, account_id

账户和币种均虚构；首版报表统一UTC业务日，源时区保留元数据。

| 字段 | ClickHouse类型 | 单位 | 定义 |
|---|---|---|---|
| dataset_version | String | — | 不可变数据发布版本 |
| account_id | String | — | 全局唯一虚构广告账户ID；自然来源不适用 |
| media_code | String | — | 虚构投放媒体代码 |
| account_name | String | — | 虚构广告账户名称 |
| account_currency | String | — | 原币，USD或完全虚构的XCU |
| account_timezone | String | — | 账户报表时区元数据；生成器从UTC过程汇总 |

NULL表示缺失/不适用，0表示观测零；状态与单位必须一起解释。


