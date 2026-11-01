# 跨表连接

只允许知识库登记过的连接。

- `daily_installs` 与 `daily_ad_revenue`：`event_date`、`product_id`、`platform`、`country_code`。
- `daily_installs` 与 `daily_unit_economics`：上述字段再加 `channel`。

没有登记的表对不能出现在同一条 SQL 里。示例 SQL 本身仍然不是查询授权。
