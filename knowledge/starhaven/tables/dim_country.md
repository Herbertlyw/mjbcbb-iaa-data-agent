# dim_country：地域

粒度：dataset_version, country_code

国家代码、中文名和区域分别定义；tier是明确配置，不推导为全球统一标准。

| 字段 | ClickHouse类型 | 单位 | 定义 |
|---|---|---|---|
| dataset_version | String | — | 不可变数据发布版本 |
| country_code | String | — | ISO国家代码，国家名与国家层级另列 |
| country_name | String | — | 国家显示名 |
| region | String | — | 区域显示分组 |
| tier_code | String | — | 本合成包配置层级，不是外部通用标准 |

NULL表示缺失/不适用，0表示观测零；状态与单位必须一起解释。


