# 指标唯一维护来源

由synthetic/starhaven/metrics.json生成。字段单位、范围与边界是公式的一部分。

## raw_cost_usd — 原始消耗USD

公式：SUM(raw_cost_usd)

单位：USD

边界：先逐行换汇再汇总，不把原币跨币种相加。

## discounted_cost_usd — 折后消耗USD

公式：SUM(discounted_cost_usd)

单位：USD

边界：与原始消耗分开；缺汇率的行不能被SUM静默忽略为完整。

## impressions — 投放曝光

公式：SUM(impressions)

单位：次

边界：按投放报表日与约定归属统计，不等于游戏内广告展示。

## clicks — 投放点击

公式：SUM(clicks)

单位：次

边界：与游戏内广告点击分开。

## af_registers — AF报表注册

公式：SUM(af_registers)

单位：报表注册

边界：不是AF ODS去重安装事件，也不是行为D0。

## media_registers — 媒体报表注册

公式：SUM(media_registers)

单位：报表注册

边界：按媒体口径保留来源。

## ctr — 投放CTR

公式：SUM(clicks) / SUM(impressions)

单位：比例

边界：分母0为未知；展示时才转百分比，不平均每日比率。

## af_cvr — AF注册/点击比

公式：SUM(af_registers) / SUM(clicks)

单位：比例

边界：非纯点击归因时不称点击转化概率，不机械限制<=1。

## af_ipm — AF注册IPM

公式：SUM(af_registers) / SUM(impressions) * 1000

单位：报表注册/千次曝光

边界：分子身份固定，跨天先汇总分子分母。

## af_cpi_usd — AF报表CPI

公式：SUM(discounted_cost_usd) / SUM(af_registers)

单位：USD/报表注册

边界：不把分母自动替换成unique_install_events。

## cpm_usd — 投放CPM

公式：SUM(discounted_cost_usd) / SUM(impressions) * 1000

单位：USD/千次曝光

边界：0分母为未知，与变现eCPM分开。

## unique_install_events — 去重安装事件

公式：SUM(unique_install_events)

单位：安装事件

边界：按合成install_event_id去重；重装仍是事件，不能叫新增设备。

## first_install_devices — 首次安装设备

公式：SUM(first_install_devices)

单位：设备×App

边界：首次安装与首次活跃不强制相等；跨App不声称物理设备去重。

## dnu_active_devices — 行为D0设备

公式：SUM(new_active_devices)

单位：设备×App

边界：当日首次活跃口径，不代替媒体注册。

## dau_devices — DAU设备

公式：SUM(active_devices) for one activity_date

单位：设备×App

边界：跨天求和只是设备日；国家/UA按固定首次获客分群。

## active_7d_devices — 最近7日活跃设备

公式：SUM(active_devices_7d) at a single anchor day

单位：去重设备×App

边界：窗口为D-6..D；不是自然周，不可跨锚点日期相加。

## active_30d_devices — 最近30日活跃设备

公式：SUM(active_devices_30d) at a single anchor day

单位：去重设备×App

边界：窗口为D-29..D；不是自然月，不可跨锚点日期相加。

## daily_to_30d_active — DAU/近30日活跃

公式：DAU(D) / Active30D(D)

单位：比例

边界：同一App、同一锚点、同一固定分群。

## device_rr_n — 设备安装cohort RR_N

公式：SUM(retained_devices at age=N) / SUM(cohort_size_devices once per cohort)

单位：比例

边界：第N日而非前N日累计；仅支持0≤N≤30；未成熟不补0；不能称AF报表留存。

## games_per_active_device — 活跃设备人均局数

公式：SUM(game_count) / SUM(active_devices)

单位：局/设备日

边界：跨日分母为设备日，标签不写去重用户。

## finished_game_mean_seconds — 已结束局平均时长

公式：SUM(gameplay_seconds for finished games) / SUM(games_finished)

单位：秒/已结束局

边界：时长仅属于已结束局；不得用包含进行中时长的口径替换。

## mode_win_rate — 可判胜负局胜率

公式：SUM(games_won) / SUM(eligible_win_games)

单位：比例

边界：没有胜负定义的模式为不适用；不把未结束局当失败。

## revive_click_rate — 复活提示点击率

公式：SUM(revive_clicks) / SUM(revive_prompts)

单位：比例

边界：点击不是看完激励广告或成功复活。

## arpdau_usd — 广告ARPDAU

公式：SUM(ad_revenue_usd) / SUM(active_devices)

单位：USD/设备日

边界：只含广告收入；不把IAP加进同一已定义指标。

## ad_view_penetration — 广告观看渗透率

公式：SUM(ad_viewing_devices) / SUM(active_devices)

单位：比例

边界：不是load成功率或fill rate。

## monetization_ecpm_usd — 广告变现eCPM

公式：SUM(revenue_usd) / SUM(impressions) * 1000

单位：USD/千次展示

边界：统一格式、network与事件版本；收入回调缺失导致partial。

## load_success_rate — 已结束加载尝试成功率

公式：SUM(successful_load_attempts) / SUM(completed_load_attempts)

单位：比例

边界：新合成定义；不沿用公司另一请求分母的fill rate名称。

## load_completion_coverage — 加载尝试结束覆盖

公式：SUM(completed_load_attempts) / SUM(load_attempts)

单位：比例

边界：与成功率分列，避免未结束尝试被忽略。

## action_ready_rate — 调用show时ready比例

公式：SUM(ready_actions) / SUM(show_actions)

单位：比例

边界：ready不等于show成功；不能与另一事件族混合。

## show_success_rate — 已结束展示请求成功率

公式：SUM(successful_show_requests) / SUM(completed_show_requests)

单位：比例

边界：请求与展示/点击事件分别计数；不能要求跨日load数始终大于展示数。

## sdk_ltv_n_per_af_register — 实际SDK累计LTV_N（AF注册分母）

公式：SDK revenue at age 0..N-1 / AF registers for same cohorts

单位：USD/报表注册

边界：显式指定来源、cohort范围和成熟度；不是设备cohort LTV。

## sdk_device_ltv_n — 设备cohort广告LTV_N

公式：SUM(ad_revenue_usd at age 0..N-1) / cohort_size counted once

单位：USD/设备×App

边界：仅支持1≤N≤31，累计日龄0..N-1；保留设备身份，不与AF注册LTV直接替换。

## actual_roi_n_pct — 实际累计ROI_N

公式：SUM(revenue_usd for selected source at age 0..N-1) / SUM(discounted_cost_usd for cohorts) * 100

单位：%

边界：ROI7对应0..6；自然量零成本时ROI未知；不得混入预测或多个收入来源。

## predicted_roi_n_pct — 快照预测ROI_N

公式：predicted_revenue_usd / cost_as_of_usd * 100

单位：%

边界：固定snapshot、horizon、model_version、revenue_source；零成本未知。

## forecast_error_pp — 预测误差百分点

公式：actual_roi_pct - predicted_roi_pct for same prediction_id

单位：百分点

边界：仅成熟且完整、input_revision_state可比的同一快照目标；成本输入回刷不能直接归为模型错误。

## cost_weighted_forecast_error_pp — 成本加权预测误差

公式：SUM(roi_error_pp * cost_weight_usd) / SUM(cost_weight_usd)

单位：百分点

边界：同目标窗口和版本；不以简单AVG替代；正负方向与forecast_error_pp一致。

## forecast_target_surplus_usd — 预测目标回收差额

公式：predicted_revenue_usd - cost_as_of_usd * target_roi_pct / 100

单位：USD

边界：是合成经营目标差额，不称税后净利润或可执行投放指令。

## creative_test_rate — 适用素材测试率

公式：COUNT DISTINCT tested creative_id / COUNT DISTINCT eligible uploaded creative_id

单位：比例

边界：明确适用上传窗/媒体计划与成熟度；未分配测试范围单列，不能把同素材多媒体行相加。

## creative_graduation_rate — 可观测素材出坡率

公式：COUNT DISTINCT graduated creative_id / COUNT DISTINCT observable creative_id

单位：比例

边界：同规则版本；证据缺失时状态未知，不写未通过。

## experiment_rr_n — 实验入组cohort留存

公式：active_units at age=N / enrolled_units once per entry cohort

单位：比例

边界：仅支持0≤N≤30；anchor_type固定；商业化触发日不改名为安装日；成熟度按实验锚点判断。

## experiment_revenue_per_enrolled — 实验单位累计广告收入

公式：SUM(ad_revenue_usd in observation window) / enrolled_units once

单位：USD/分配单位

边界：分配单位明确；差异不自动等于显著性，不自动推广到全部玩家。

## operation_count — 操作次数

公式：COUNT DISTINCT operation_event_id

单位：操作

边界：多字段变更仍是一笔操作；未发现日志不证明无人操作。

## sdk_af_revenue_gap — SDK与AF回收差额

公式：SUM(SDK revenue) - SUM(AF revenue) under matching scope

单位：USD

边界：差额用于对照；不自动解释为丢数或真实收入下降。
