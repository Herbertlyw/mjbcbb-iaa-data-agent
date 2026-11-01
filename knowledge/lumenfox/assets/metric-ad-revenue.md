# 广告收入

`revenue_usd` 是虚构的广告收入，单位是演示用美元。

- `is_predicted = 0` 且数值非空：实际观测。
- `is_predicted = 0` 且数值为 `NULL`：实际缺失。
- 数值为 `0` 且 `is_predicted = 0`：观测到的真实零。
- `is_predicted = 1`：预测值。预测不能加进实际收入，也不能用来填补缺失。
