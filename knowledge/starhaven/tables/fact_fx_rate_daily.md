# fact_fx_rate_daily：汇率

粒度：dataset_version, rate_date, source_currency

定义为1 USD兑换多少原币；USD金额=原币金额/该rate。正数和缺失规则单独校验。

| 字段 | ClickHouse类型 | 单位 | 定义 |
|---|---|---|---|
| dataset_version | String | — | 不可变数据发布版本 |
| rate_date | Date | — | 汇率UTC业务日 |
| source_currency | String | — | 原始币种代码；XCU完全虚构 |
| source_currency_per_usd | Nullable(Decimal(24,6)) | 原币/USD | 1美元兑换原币数，美元=原币/该正数 |
| rate_status | String | — | known或missing |

NULL表示缺失/不适用，0表示观测零；状态与单位必须一起解释。

汇率不可求和或不加说明地取平均。
