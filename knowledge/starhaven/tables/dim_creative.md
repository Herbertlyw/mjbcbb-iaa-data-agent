# dim_creative：素材

粒度：dataset_version, creative_id

用合成标题和标签，不复用真实文件路径、上传人或素材文件。

| 字段 | ClickHouse类型 | 单位 | 定义 |
|---|---|---|---|
| dataset_version | String | — | 不可变数据发布版本 |
| creative_id | String | — | 素材ID，可被多个广告复用 |
| app_id | String | — | 虚构包体ID，一款产品的一个平台实例 |
| creative_name | String | — | 虚构素材名称 |
| format_code | String | — | 素材格式，video或image |
| upload_at | DateTime64(3, 'UTC') | — | 素材上传UTC时刻 |
| duration_seconds | UInt32 | 秒 | 素材时长秒，图片为0 |
| aspect_ratio | String | — | 素材宽高比标签 |
| tag_codes | String | — | 受控标签，逗号分隔；拆标签后不可直接累加事实 |

NULL表示缺失/不适用，0表示观测零；状态与单位必须一起解释。


