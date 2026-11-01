# 实际 ROI

实际 ROI 的分子是 `is_predicted = 0` 且非空的 `payback_usd` 合计。分母是同一过滤条件下 `is_predicted = 0` 且非空的 `spend_usd` 合计。

- 预测回收不进入分子，预测成本也不进入分母。
- `NULL` 是缺失，不能当成 0 后参与除法。
- 分母合计为 0 时，比率不存在，要说明零分母，不能编造一个 ROI。
- 时间口径是 `event_date` 的封闭区间，时区 America/Los_Angeles。
- 这是同期观察的比值，不是因果，也不能据此自动改投放。
