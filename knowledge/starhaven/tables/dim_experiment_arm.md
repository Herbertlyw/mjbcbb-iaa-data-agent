# dim_experiment_arm：实验与分组配置

粒度：dataset_version, experiment_id, arm_id, config_version

产品实验和商业化实验使用明确type；入组锚点不是统一install_date。商业化配置只作补充参考。

| 字段 | ClickHouse类型 | 单位 | 定义 |
|---|---|---|---|
| dataset_version | String | — | 不可变数据发布版本 |
| experiment_id | String | — | 虚构实验ID |
| arm_id | String | — | 实验组ID，control或variant |
| config_version | String | — | 冻结实验配置版本 |
| app_id | String | — | 虚构包体ID，一款产品的一个平台实例 |
| experiment_type | String | — | product或monetization |
| allocation_unit | String | — | 分配单位，synthetic_device_app |
| allocation_fraction | Decimal(24,6) | 比例 | 分配比例；同一实验配置所有组之和为1 |
| eligibility_code | String | — | 虚构参与条件版本 |
| anchor_type | String | — | first_open或first_ad_show，不是统一安装日 |
| control_arm_id | String | — | 明确对照组ID |
| starts_at | DateTime64(3, 'UTC') | — | 实验开始UTC时刻 |
| ends_at | DateTime64(3, 'UTC') | — | 实验结束UTC时刻 |

NULL表示缺失/不适用，0表示观测零；状态与单位必须一起解释。


