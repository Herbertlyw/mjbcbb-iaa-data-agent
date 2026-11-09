未绑定发布：以下日期仅作模板，实际查询先读当前发布并替换范围。

# VV 业务分析场景

问题和 SQL 绑定同一不可变发布。先读取当前发布、指标口径和涉及的契约，再执行查询与计算。这里没有标准答案，也不绕过权限、预算、freshness 或证据门禁。

## 通用执行顺序

1. 先确认 game_id、app_id 和平台，读取当前发布与涉及表的契约。以下日期均为 UTC，数据截止日不是电脑当前日期。
2. SQL 显式筛选 dataset_version。事实表提供封闭日期，维表包含完整键；事实关联维表时同时连接版本键和对象键。两张事实明细不直接 JOIN。
3. 保存本任务 resource_id、execution_id、契约和 freshness 回执。计算使用完整保存资源；预览只有前几行时先续页，不把预览当总体。
4. SUM 必须同时检查 nonnull_字段与 source_rows。SUM 的传输值即使为 0，只要输入全 NULL 或无记录，就不能称观测零；部分 NULL 也要披露。
5. 比率先汇总分子和分母，再调用 calculate_session_cells 的 divide。使用本任务执行号和 row 或 aggregate，不用模型心算，也不平均分组比率。比例和百分数区分，百分比展示才乘 100。
6. 留存仅取同一 cohort、一个观察日。可先 transform/group，把 retained_devices 和 cohort_size_devices 各求和，再除；这种数学结果不自动认证业务名称。
7. 设备 LTV7 将 D0 基数单独 group 一次，另一份资源汇总同 cohort 日龄 0–6 的广告收入，再除。不能将窗口中重复七次的基数求和当分母。对账要求每个已存在 cohort 分群七日齐全且基数稳定。
8. ROI 成本按安装 cohort 日期取，收入按该 cohort 的回收日窗口取，明确 sdk 或 af，按键全集对齐。无收入侧保持未知；自然量成本为 0 时不计算 ROI。稀疏回收缺行不证明零。
9. 自然结束时引用所有必要结果，包括独立维表名称、数值和计算资源。服务端决定认证范围；未支持的业务证明保留数学观察或 partial，不通过改写模型标签获得认证。

下面每个案例的 SQL 是可执行参考，不要求真实模型照抄。真实模型采取其他合法形状时仍需重新审查。不要读取离线预期、生成器私有计数或验收报告来回答问题。

## acquisition-daily：新增与重装

拼格 GridFit iOS 在 2026-11-01 到 2026-11-07（UTC）的首次安装设备、安装事件、重装和晚到分别是多少？按日期展示，说明它们不能直接相加。

范围：2026-11-01–2026-11-07 · UTC

边界：首次安装设备与安装事件口径不同；重装、晚到是事件子集。

### installs

```sql
SELECT cohort_date, SUM(first_install_devices) AS total_first_install_devices, SUM(unique_install_events) AS total_unique_install_events, SUM(reinstall_events) AS total_reinstall_events, SUM(late_install_events) AS total_late_install_events, COUNT(first_install_devices) AS nonnull_first_install_devices, COUNT(unique_install_events) AS nonnull_unique_install_events, COUNT(reinstall_events) AS nonnull_reinstall_events, COUNT(late_install_events) AS nonnull_late_install_events, COUNT() AS source_rows FROM fact_acquisition_daily WHERE dataset_version = 'DATASET_VERSION' AND app_id = 'gridfit_ios' AND cohort_date BETWEEN '2026-11-01' AND '2026-11-07' GROUP BY cohort_date ORDER BY cohort_date
```
## acquisition-channel：渠道获客成本

拼格 GridFit iOS 在 2026-11-01 到 2026-11-07（UTC）各获客渠道的折后美元消耗和 AF 报表注册是多少？按汇总消耗除以汇总注册计算 CPI，零分母保持未知。

范围：2026-11-01–2026-11-07 · UTC

边界：CPI 的分母是 AF 报表注册，不是首次安装设备；不平均每日 CPI。

### channels

```sql
SELECT ua_channel_id, SUM(discounted_cost_usd) AS total_discounted_cost_usd, SUM(af_registers) AS total_af_registers, COUNT(discounted_cost_usd) AS nonnull_discounted_cost_usd, COUNT(af_registers) AS nonnull_af_registers, COUNT() AS source_rows FROM fact_delivery_daily WHERE dataset_version = 'DATASET_VERSION' AND app_id = 'gridfit_ios' AND business_date BETWEEN '2026-11-01' AND '2026-11-07' GROUP BY ua_channel_id ORDER BY ua_channel_id
```
## acquisition-followup：同会话追问日本

沿用上一题拼格 iOS 的日期和 AF 注册口径，只看日本，按获客渠道重新计算 CPI。

范围：2026-11-01–2026-11-07 · UTC

边界：先在同一会话完成“渠道获客成本”；本轮重新查询，不复用上一任务证据。

### channels

```sql
SELECT ua_channel_id, SUM(discounted_cost_usd) AS total_discounted_cost_usd, SUM(af_registers) AS total_af_registers, COUNT(discounted_cost_usd) AS nonnull_discounted_cost_usd, COUNT(af_registers) AS nonnull_af_registers, COUNT() AS source_rows FROM fact_delivery_daily WHERE dataset_version = 'DATASET_VERSION' AND app_id = 'gridfit_ios' AND acquisition_country_code = 'JP' AND business_date BETWEEN '2026-11-01' AND '2026-11-07' GROUP BY ua_channel_id ORDER BY ua_channel_id
```
## plan-efficiency：计划消耗与转化

拼格 GridFit iOS 在 2026-11-01 到 2026-11-07（UTC）各计划的折后美元消耗、AF 注册、CTR 和 AF-CPI 如何？先汇总分子分母，再排序，保留没有计划的来源。

范围：2026-11-01–2026-11-07 · UTC

边界：NULL 计划单列；成本低不代表回收好，名称必须引用同版本维表。

### plans

```sql
SELECT campaign_id, SUM(discounted_cost_usd) AS total_discounted_cost_usd, SUM(af_registers) AS total_af_registers, SUM(impressions) AS total_impressions, SUM(clicks) AS total_clicks, COUNT(discounted_cost_usd) AS nonnull_discounted_cost_usd, COUNT(af_registers) AS nonnull_af_registers, COUNT(impressions) AS nonnull_impressions, COUNT(clicks) AS nonnull_clicks, COUNT() AS source_rows FROM fact_delivery_daily WHERE dataset_version = 'DATASET_VERSION' AND app_id = 'gridfit_ios' AND business_date BETWEEN '2026-11-01' AND '2026-11-07' GROUP BY campaign_id ORDER BY campaign_id
```

### names

```sql
SELECT dataset_version, campaign_id, campaign_name, app_id FROM dim_campaign WHERE dataset_version = 'DATASET_VERSION' AND app_id = 'gridfit_ios' ORDER BY dataset_version, campaign_id, campaign_name, app_id
```
## plan-app-names：三款游戏消耗

请按包体和产品名称汇总 2026-11-01 到 2026-11-07（UTC）的折后投放成本，保留 iOS 与 Android，说明币种和关联来源。

范围：2026-11-01–2026-11-07 · UTC

边界：关联必须同时使用 dataset_version 和 app_id；不合并成跨 App 去重玩家。

### apps

```sql
SELECT f.app_id, d.game_name, SUM(f.discounted_cost_usd) AS total_discounted_cost_usd, COUNT(f.discounted_cost_usd) AS nonnull_discounted_cost_usd, COUNT() AS source_rows FROM fact_delivery_daily f JOIN dim_app d ON f.dataset_version = d.dataset_version AND f.app_id = d.app_id WHERE f.dataset_version = 'DATASET_VERSION' AND f.business_date BETWEEN '2026-11-01' AND '2026-11-07' GROUP BY f.app_id, d.game_name ORDER BY f.app_id, d.game_name
```
## creative-efficiency：素材消耗与注册

落块 BlockFall Android 在 2026-11-01 到 2026-11-07（UTC）各素材的折后成本、AF 注册和 AF-CPI 是多少？按素材汇总，避免同素材在多个广告中重复计数。

范围：2026-11-01–2026-11-07 · UTC

边界：同一素材可被多个广告复用；观察到的低 CPI 不证明素材质量或因果。

### creatives

```sql
SELECT creative_id, SUM(discounted_cost_usd) AS total_discounted_cost_usd, SUM(af_registers) AS total_af_registers, COUNT(discounted_cost_usd) AS nonnull_discounted_cost_usd, COUNT(af_registers) AS nonnull_af_registers, COUNT() AS source_rows FROM fact_delivery_daily WHERE dataset_version = 'DATASET_VERSION' AND app_id = 'blockfall_android' AND business_date BETWEEN '2026-11-01' AND '2026-11-07' GROUP BY creative_id ORDER BY creative_id
```

### names

```sql
SELECT dataset_version, creative_id, creative_name, app_id FROM dim_creative WHERE dataset_version = 'DATASET_VERSION' AND app_id = 'blockfall_android' ORDER BY dataset_version, creative_id, creative_name, app_id
```
## creative-readiness：素材测试成熟度

截至 2026-11-08（UTC），叠叠乐 StackJoy iOS 的素材分别处于未分配、未测试、待观察还是可判定状态？按素材和媒体列出，出坡率只用可观测素材做分母。

范围：快照 2026-11-08 · UTC

边界：不把未分配记作失败；同素材跨媒体的状态不折叠成一个虚构状态。

### states

```sql
SELECT dataset_version, snapshot_date, app_id, creative_id, ua_channel_id, test_scope_state, is_eligible, is_tested, is_observable, is_graduated, rule_version, completeness_state FROM fact_creative_test_snapshot WHERE dataset_version = 'DATASET_VERSION' AND app_id = 'stackjoy_ios' AND snapshot_date BETWEEN '2026-11-08' AND '2026-11-08' ORDER BY dataset_version, snapshot_date, app_id, creative_id, ua_channel_id, test_scope_state, is_eligible, is_tested, is_observable, is_graduated, rule_version, completeness_state
```
## revenue-daily：每日广告收入

落块 BlockFall iOS 在 2026-11-01 到 2026-11-07（UTC）的每日 SDK 广告收入、广告展示和活跃设备分别是多少？计算每日 ARPDAU，跨日活跃合计标为设备日。

范围：2026-11-01–2026-11-07 · UTC

边界：本项目是 IAA 广告收入，不是 IAP 流水；DAU 跨日求和是设备日。

### daily

```sql
SELECT activity_date, SUM(ad_revenue_usd) AS total_ad_revenue_usd, SUM(ad_impressions) AS total_ad_impressions, SUM(active_devices) AS total_active_devices, COUNT(ad_revenue_usd) AS nonnull_ad_revenue_usd, COUNT(ad_impressions) AS nonnull_ad_impressions, COUNT(active_devices) AS nonnull_active_devices, COUNT() AS source_rows FROM fact_activity_daily WHERE dataset_version = 'DATASET_VERSION' AND app_id = 'blockfall_ios' AND activity_date BETWEEN '2026-11-01' AND '2026-11-07' GROUP BY activity_date ORDER BY activity_date
```
## revenue-network：变现网络与广告漏斗

落块 BlockFall Android 在 2026-11-01 到 2026-11-07（UTC），按变现 network 和广告格式比较广告收入、eCPM、加载成功率、加载结束覆盖和展示成功率。请明确各自分母。

范围：2026-11-01–2026-11-07 · UTC

边界：变现 network 不是获客渠道；成功率以对应已结束请求为分母。

### networks

```sql
SELECT network_code, ad_format, SUM(revenue_usd) AS total_revenue_usd, SUM(impressions) AS total_impressions, SUM(load_attempts) AS total_load_attempts, SUM(completed_load_attempts) AS total_completed_load_attempts, SUM(successful_load_attempts) AS total_successful_load_attempts, SUM(completed_show_requests) AS total_completed_show_requests, SUM(successful_show_requests) AS total_successful_show_requests, COUNT(revenue_usd) AS nonnull_revenue_usd, COUNT(impressions) AS nonnull_impressions, COUNT(load_attempts) AS nonnull_load_attempts, COUNT(completed_load_attempts) AS nonnull_completed_load_attempts, COUNT(successful_load_attempts) AS nonnull_successful_load_attempts, COUNT(completed_show_requests) AS nonnull_completed_show_requests, COUNT(successful_show_requests) AS nonnull_successful_show_requests, COUNT() AS source_rows FROM fact_ad_funnel_daily WHERE dataset_version = 'DATASET_VERSION' AND app_id = 'blockfall_android' AND business_date BETWEEN '2026-11-01' AND '2026-11-07' GROUP BY network_code, ad_format ORDER BY network_code, ad_format
```
## revenue-source：SDK 与 AF 对照

拼格 GridFit iOS 的 2026-11-01 安装 cohort 在日龄 0–6 的 SDK 与 AF 广告回收分别是多少？比较差额，分别列来源和到达截止，不把两者相加为总收入。

范围：安装 cohort 2026-11-01 · 日龄 0–6 · UTC

边界：稀疏来源缺行不能补零；差额不自动说明丢数或收入下降。

### sources

```sql
SELECT revenue_source, SUM(revenue_usd) AS total_revenue_usd, COUNT(revenue_usd) AS nonnull_revenue_usd, COUNT() AS source_rows FROM fact_cohort_revenue_daily WHERE dataset_version = 'DATASET_VERSION' AND app_id = 'gridfit_ios' AND cohort_date = '2026-11-01' AND revenue_date BETWEEN '2026-11-01' AND '2026-11-07' GROUP BY revenue_source ORDER BY revenue_source
```
## activity-anchor：单日活跃与窗口

截至 2026-11-07（UTC），叠叠乐 StackJoy Android 的 DAU、近 7 日和近 30 日活跃分别是多少？只使用这个锚点，不跨日累加窗口去重设备，并说明数据起始日限制。

范围：活跃锚点 2026-11-07 · UTC

边界：只在同一 App、同一锚点汇总固定获客分群；发布不足 30 天时不声称完整 30 日历史。

### anchor

```sql
SELECT dataset_version, activity_date, app_id, acquisition_country_code, ua_channel_id, active_devices, active_devices_7d, active_devices_30d, completeness_state FROM fact_activity_daily WHERE dataset_version = 'DATASET_VERSION' AND app_id = 'stackjoy_android' AND activity_date BETWEEN '2026-11-07' AND '2026-11-07' ORDER BY dataset_version, activity_date, app_id, acquisition_country_code, ua_channel_id, active_devices, active_devices_7d, active_devices_30d, completeness_state
```
## retention-d1：第 1 日留存

叠叠乐 StackJoy iOS 的 2026-11-01 安装 cohort，第 1 日（2026-11-02，UTC）留存设备和基数是多少？按同一 cohort 的分子、分母计算 RR1，不能把多个观察日的基数相加。

范围：安装 cohort 2026-11-01 · 第 1 日 2026-11-02 · UTC

边界：RR1 是第 1 日，不是前 1 日累计；缺行、NULL 和未成熟不当零。

### retention

```sql
SELECT dataset_version, install_cohort_date, observe_date, app_id, acquisition_country_code, ua_channel_id, campaign_id, ad_group_id, ad_id, creative_id, cohort_size_devices, retained_devices, ad_revenue_usd, age_days, completeness_state FROM fact_cohort_quality_daily WHERE dataset_version = 'DATASET_VERSION' AND app_id = 'stackjoy_ios' AND install_cohort_date = '2026-11-01' AND observe_date BETWEEN '2026-11-02' AND '2026-11-02' ORDER BY dataset_version, install_cohort_date, observe_date, app_id, acquisition_country_code, ua_channel_id, campaign_id, ad_group_id, ad_id, creative_id, cohort_size_devices, retained_devices, ad_revenue_usd, age_days, completeness_state
```
## retention-d7：第 7 日留存

叠叠乐 StackJoy iOS 的 2026-11-01 安装 cohort，第 7 日（2026-11-08，UTC）留存设备和基数是多少？按同一 cohort 的分子、分母计算 RR7，不能把多个观察日的基数相加。

范围：安装 cohort 2026-11-01 · 第 7 日 2026-11-08 · UTC

边界：RR7 是第 7 日，不是前 7 日累计；缺行、NULL 和未成熟不当零。

### retention

```sql
SELECT dataset_version, install_cohort_date, observe_date, app_id, acquisition_country_code, ua_channel_id, campaign_id, ad_group_id, ad_id, creative_id, cohort_size_devices, retained_devices, ad_revenue_usd, age_days, completeness_state FROM fact_cohort_quality_daily WHERE dataset_version = 'DATASET_VERSION' AND app_id = 'stackjoy_ios' AND install_cohort_date = '2026-11-01' AND observe_date BETWEEN '2026-11-08' AND '2026-11-08' ORDER BY dataset_version, install_cohort_date, observe_date, app_id, acquisition_country_code, ua_channel_id, campaign_id, ad_group_id, ad_id, creative_id, cohort_size_devices, retained_devices, ad_revenue_usd, age_days, completeness_state
```
## ltv7：设备 LTV7

拼格 GridFit iOS 的 2026-11-01 安装 cohort，前 7 日（日龄 0–6）SDK 广告回收和设备 LTV7 是多少？设备基数仅取一次 D0，保留分母单位和缺失情况。

范围：安装 cohort 2026-11-01 · 日龄 0–6 · UTC

边界：单位 USD/首次安装设备×App；不是 AF 报表注册 LTV；基数不乘以 7。

### base

```sql
SELECT dataset_version, install_cohort_date, observe_date, app_id, acquisition_country_code, ua_channel_id, campaign_id, ad_group_id, ad_id, creative_id, cohort_size_devices, retained_devices, ad_revenue_usd, age_days, completeness_state FROM fact_cohort_quality_daily WHERE dataset_version = 'DATASET_VERSION' AND app_id = 'gridfit_ios' AND install_cohort_date = '2026-11-01' AND observe_date BETWEEN '2026-11-01' AND '2026-11-01' ORDER BY dataset_version, install_cohort_date, observe_date, app_id, acquisition_country_code, ua_channel_id, campaign_id, ad_group_id, ad_id, creative_id, cohort_size_devices, retained_devices, ad_revenue_usd, age_days, completeness_state
```

### window

```sql
SELECT dataset_version, install_cohort_date, observe_date, app_id, acquisition_country_code, ua_channel_id, campaign_id, ad_group_id, ad_id, creative_id, cohort_size_devices, retained_devices, ad_revenue_usd, age_days, completeness_state FROM fact_cohort_quality_daily WHERE dataset_version = 'DATASET_VERSION' AND app_id = 'gridfit_ios' AND install_cohort_date = '2026-11-01' AND observe_date BETWEEN '2026-11-01' AND '2026-11-07' ORDER BY dataset_version, install_cohort_date, observe_date, app_id, acquisition_country_code, ua_channel_id, campaign_id, ad_group_id, ad_id, creative_id, cohort_size_devices, retained_devices, ad_revenue_usd, age_days, completeness_state
```
## roi3：实际 ROI3

拼格 GridFit iOS 的 2026-11-01 安装 cohort，按获客渠道计算实际 SDK ROI3：累计日龄 0–2 收入除以同 cohort 折后成本。先分别汇总再对齐，不能直接连接两张事实明细，缺侧保持未知，自然量零成本单列。

范围：安装 cohort 2026-11-01 · 日龄 0–2 · SDK · UTC

边界：ROI3 用日龄 0–2，按成本加权，不能平均渠道 ROI；自然量零成本未知。

### cost

```sql
SELECT ua_channel_id, SUM(discounted_cost_usd) AS total_discounted_cost_usd, COUNT(discounted_cost_usd) AS nonnull_discounted_cost_usd, COUNT() AS source_rows FROM fact_delivery_daily WHERE dataset_version = 'DATASET_VERSION' AND app_id = 'gridfit_ios' AND business_date BETWEEN '2026-11-01' AND '2026-11-01' GROUP BY ua_channel_id ORDER BY ua_channel_id
```

### recovery

```sql
SELECT ua_channel_id, SUM(revenue_usd) AS total_revenue_usd, COUNT(revenue_usd) AS nonnull_revenue_usd, COUNT() AS source_rows FROM fact_cohort_revenue_daily WHERE dataset_version = 'DATASET_VERSION' AND app_id = 'gridfit_ios' AND cohort_date = '2026-11-01' AND revenue_source = 'sdk' AND revenue_date BETWEEN '2026-11-01' AND '2026-11-03' GROUP BY ua_channel_id ORDER BY ua_channel_id
```
## roi7：实际 ROI7

拼格 GridFit iOS 的 2026-11-01 安装 cohort，按获客渠道计算实际 SDK ROI7：累计日龄 0–6 收入除以同 cohort 折后成本。先分别汇总再对齐，不能直接连接两张事实明细，缺侧保持未知，自然量零成本单列。

范围：安装 cohort 2026-11-01 · 日龄 0–6 · SDK · UTC

边界：ROI7 用日龄 0–6，按成本加权，不能平均渠道 ROI；自然量零成本未知。

### cost

```sql
SELECT ua_channel_id, SUM(discounted_cost_usd) AS total_discounted_cost_usd, COUNT(discounted_cost_usd) AS nonnull_discounted_cost_usd, COUNT() AS source_rows FROM fact_delivery_daily WHERE dataset_version = 'DATASET_VERSION' AND app_id = 'gridfit_ios' AND business_date BETWEEN '2026-11-01' AND '2026-11-01' GROUP BY ua_channel_id ORDER BY ua_channel_id
```

### recovery

```sql
SELECT ua_channel_id, SUM(revenue_usd) AS total_revenue_usd, COUNT(revenue_usd) AS nonnull_revenue_usd, COUNT() AS source_rows FROM fact_cohort_revenue_daily WHERE dataset_version = 'DATASET_VERSION' AND app_id = 'gridfit_ios' AND cohort_date = '2026-11-01' AND revenue_source = 'sdk' AND revenue_date BETWEEN '2026-11-01' AND '2026-11-07' GROUP BY ua_channel_id ORDER BY ua_channel_id
```
## roi-immature：未成熟 ROI30

拼格 GridFit iOS 的 2026-11-08 安装 cohort，现在能给出实际 ROI30 吗？请核对目标窗口，说明已观察日龄和未成熟边界，不用预测或零填满未来收入。

范围：安装 cohort 2026-11-08 · 目标 30 日 · UTC

边界：目标需日龄 0–29；当前只有 D0，实际 ROI30 未成熟。

### observed

```sql
SELECT dataset_version, install_cohort_date, observe_date, app_id, acquisition_country_code, ua_channel_id, campaign_id, ad_group_id, ad_id, creative_id, cohort_size_devices, retained_devices, ad_revenue_usd, age_days, completeness_state FROM fact_cohort_quality_daily WHERE dataset_version = 'DATASET_VERSION' AND app_id = 'gridfit_ios' AND install_cohort_date = '2026-11-08' AND observe_date BETWEEN '2026-11-08' AND '2026-11-08' ORDER BY dataset_version, install_cohort_date, observe_date, app_id, acquisition_country_code, ua_channel_id, campaign_id, ad_group_id, ad_id, creative_id, cohort_size_devices, retained_devices, ad_revenue_usd, age_days, completeness_state
```
## revenue-clarify：先澄清口径

帮我看看收入。

范围：需要补充范围

边界：应先询问游戏/包体、统计时间及收入来源；澄清不依赖业务查询。
