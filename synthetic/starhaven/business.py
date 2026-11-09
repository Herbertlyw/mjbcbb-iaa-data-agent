"""Executable VV business scenarios, with release-bound dates and no answers."""

from datetime import date, timedelta
import re

CATEGORIES = [
    ("acquisition", "获客"),
    ("plans", "计划效果"),
    ("creative", "素材效果"),
    ("revenue", "广告收入"),
    ("retention", "活跃与留存"),
    ("value", "LTV / ROI"),
]


def business_catalog(version, start, as_of):
    """Describe scenarios against one immutable release; never declare it fresh."""
    if not re.fullmatch(r"sv_[a-f0-9]{20}", version):
        raise ValueError("business_version_invalid")
    first, last = date.fromisoformat(start), date.fromisoformat(as_of)
    if last - first < timedelta(days=13):
        raise ValueError("business_release_needs_fourteen_days")
    end = (last - timedelta(days=1)).isoformat()
    begin = (last - timedelta(days=7)).isoformat()
    cohort = begin
    cohort_end = (last - timedelta(days=1)).isoformat()
    app = "gridfit_ios"
    scope = f"{begin}–{end} · UTC"
    cases = []

    def query(
        identity, table, day, lower, upper, sums=(), groups=(), equals=None, columns=()
    ):
        equality = {"dataset_version": version, **(equals or {})}
        predicates = [f"{name} = {literal(value)}" for name, value in equality.items()]
        if day:
            predicates.append(f"{day} BETWEEN '{lower}' AND '{upper}'")
        if columns:
            projection = ", ".join(columns)
            order = list(columns)
        else:
            projection = ", ".join(
                list(groups)
                + [f"SUM({name}) AS total_{name}" for name in sums]
                + [f"COUNT({name}) AS nonnull_{name}" for name in sums]
                + ["COUNT() AS source_rows"]
            )
            order = list(groups)
        sql = f"SELECT {projection} FROM {table} WHERE " + " AND ".join(predicates)
        if not columns and groups:
            sql += " GROUP BY " + ", ".join(groups)
        if order:
            sql += " ORDER BY " + ", ".join(order)
        return dict(
            query_id=identity,
            table=table,
            date_column=day,
            start=lower,
            end=upper,
            equals=equality,
            sums=list(sums),
            groups=list(groups),
            columns=list(columns),
            sql=sql,
        )

    def item(
        identity, category, label, question, queries, recipe, note, case_scope=scope
    ):
        cases.append(
            dict(
                id=identity,
                category=category,
                label=label,
                text=question,
                scope=case_scope,
                note=note,
                queries=queries,
                recipe=recipe,
                validation="offline_recipe_not_model_acceptance",
            )
        )

    def delivery(identity, groups, fields, country=None):
        equals = {"app_id": app}
        if country:
            equals["acquisition_country_code"] = country
        return query(
            identity,
            "fact_delivery_daily",
            "business_date",
            begin,
            end,
            fields,
            groups,
            equals,
        )

    item(
        "acquisition-daily",
        "acquisition",
        "新增与重装",
        f"拼格 GridFit iOS 在 {begin} 到 {end}（UTC）的首次安装设备、安装事件、重装和晚到分别是多少？按日期展示，说明它们不能直接相加。",
        [
            query(
                "installs",
                "fact_acquisition_daily",
                "cohort_date",
                begin,
                end,
                (
                    "first_install_devices",
                    "unique_install_events",
                    "reinstall_events",
                    "late_install_events",
                ),
                ("cohort_date",),
                {"app_id": app},
            )
        ],
        "installs",
        "首次安装设备与安装事件口径不同；重装、晚到是事件子集。",
    )
    item(
        "acquisition-channel",
        "acquisition",
        "渠道获客成本",
        f"拼格 GridFit iOS 在 {begin} 到 {end}（UTC）各获客渠道的折后美元消耗和 AF 报表注册是多少？按汇总消耗除以汇总注册计算 CPI，零分母保持未知。",
        [
            delivery(
                "channels", ("ua_channel_id",), ("discounted_cost_usd", "af_registers")
            )
        ],
        "cpi",
        "CPI 的分母是 AF 报表注册，不是首次安装设备；不平均每日 CPI。",
    )
    item(
        "acquisition-followup",
        "acquisition",
        "同会话追问日本",
        "沿用上一题拼格 iOS 的日期和 AF 注册口径，只看日本，按获客渠道重新计算 CPI。",
        [
            delivery(
                "channels",
                ("ua_channel_id",),
                ("discounted_cost_usd", "af_registers"),
                "JP",
            )
        ],
        "cpi",
        "先在同一会话完成“渠道获客成本”；本轮重新查询，不复用上一任务证据。",
    )

    fields = ("discounted_cost_usd", "af_registers", "impressions", "clicks")
    item(
        "plan-efficiency",
        "plans",
        "计划消耗与转化",
        f"拼格 GridFit iOS 在 {begin} 到 {end}（UTC）各计划的折后美元消耗、AF 注册、CTR 和 AF-CPI 如何？先汇总分子分母，再排序，保留没有计划的来源。",
        [
            delivery("plans", ("campaign_id",), fields),
            query(
                "names",
                "dim_campaign",
                None,
                None,
                None,
                equals={"app_id": app},
                columns=("dataset_version", "campaign_id", "campaign_name", "app_id"),
            ),
        ],
        "plan_efficiency",
        "NULL 计划单列；成本低不代表回收好，名称必须引用同版本维表。",
    )
    item(
        "plan-app-names",
        "plans",
        "三款游戏消耗",
        f"请按包体和产品名称汇总 {begin} 到 {end}（UTC）的折后投放成本，保留 iOS 与 Android，说明币种和关联来源。",
        [],
        "app_join",
        "关联必须同时使用 dataset_version 和 app_id；不合并成跨 App 去重玩家。",
    )

    item(
        "creative-efficiency",
        "creative",
        "素材消耗与注册",
        f"落块 BlockFall Android 在 {begin} 到 {end}（UTC）各素材的折后成本、AF 注册和 AF-CPI 是多少？按素材汇总，避免同素材在多个广告中重复计数。",
        [
            query(
                "creatives",
                "fact_delivery_daily",
                "business_date",
                begin,
                end,
                ("discounted_cost_usd", "af_registers"),
                ("creative_id",),
                {"app_id": "blockfall_android"},
            ),
            query(
                "names",
                "dim_creative",
                None,
                None,
                None,
                equals={"app_id": "blockfall_android"},
                columns=("dataset_version", "creative_id", "creative_name", "app_id"),
            ),
        ],
        "creative_efficiency",
        "同一素材可被多个广告复用；观察到的低 CPI 不证明素材质量或因果。",
    )
    creative_columns = (
        "dataset_version",
        "snapshot_date",
        "app_id",
        "creative_id",
        "ua_channel_id",
        "test_scope_state",
        "is_eligible",
        "is_tested",
        "is_observable",
        "is_graduated",
        "rule_version",
        "completeness_state",
    )
    item(
        "creative-readiness",
        "creative",
        "素材测试成熟度",
        f"截至 {as_of}（UTC），叠叠乐 StackJoy iOS 的素材分别处于未分配、未测试、待观察还是可判定状态？按素材和媒体列出，出坡率只用可观测素材做分母。",
        [
            query(
                "states",
                "fact_creative_test_snapshot",
                "snapshot_date",
                as_of,
                as_of,
                equals={"app_id": "stackjoy_ios"},
                columns=creative_columns,
            )
        ],
        "creative_states",
        "不把未分配记作失败；同素材跨媒体的状态不折叠成一个虚构状态。",
        f"快照 {as_of} · UTC",
    )

    item(
        "revenue-daily",
        "revenue",
        "每日广告收入",
        f"落块 BlockFall iOS 在 {begin} 到 {end}（UTC）的每日 SDK 广告收入、广告展示和活跃设备分别是多少？计算每日 ARPDAU，跨日活跃合计标为设备日。",
        [
            query(
                "daily",
                "fact_activity_daily",
                "activity_date",
                begin,
                end,
                ("ad_revenue_usd", "ad_impressions", "active_devices"),
                ("activity_date",),
                {"app_id": "blockfall_ios"},
            )
        ],
        "arpdau",
        "本项目是 IAA 广告收入，不是 IAP 流水；DAU 跨日求和是设备日。",
    )
    item(
        "revenue-network",
        "revenue",
        "变现网络与广告漏斗",
        f"落块 BlockFall Android 在 {begin} 到 {end}（UTC），按变现 network 和广告格式比较广告收入、eCPM、加载成功率、加载结束覆盖和展示成功率。请明确各自分母。",
        [
            query(
                "networks",
                "fact_ad_funnel_daily",
                "business_date",
                begin,
                end,
                (
                    "revenue_usd",
                    "impressions",
                    "load_attempts",
                    "completed_load_attempts",
                    "successful_load_attempts",
                    "completed_show_requests",
                    "successful_show_requests",
                ),
                ("network_code", "ad_format"),
                {"app_id": "blockfall_android"},
            )
        ],
        "ad_funnel",
        "变现 network 不是获客渠道；成功率以对应已结束请求为分母。",
    )
    item(
        "revenue-source",
        "revenue",
        "SDK 与 AF 对照",
        f"拼格 GridFit iOS 的 {cohort} 安装 cohort 在日龄 0–6 的 SDK 与 AF 广告回收分别是多少？比较差额，分别列来源和到达截止，不把两者相加为总收入。",
        [
            query(
                "sources",
                "fact_cohort_revenue_daily",
                "revenue_date",
                cohort,
                cohort_end,
                ("revenue_usd",),
                ("revenue_source",),
                {"app_id": app, "cohort_date": cohort},
            )
        ],
        "source_gap",
        "稀疏来源缺行不能补零；差额不自动说明丢数或收入下降。",
        f"安装 cohort {cohort} · 日龄 0–6 · UTC",
    )

    item(
        "activity-anchor",
        "retention",
        "单日活跃与窗口",
        f"截至 {end}（UTC），叠叠乐 StackJoy Android 的 DAU、近 7 日和近 30 日活跃分别是多少？只使用这个锚点，不跨日累加窗口去重设备，并说明数据起始日限制。",
        [
            query(
                "anchor",
                "fact_activity_daily",
                "activity_date",
                end,
                end,
                equals={"app_id": "stackjoy_android"},
                columns=(
                    "dataset_version",
                    "activity_date",
                    "app_id",
                    "acquisition_country_code",
                    "ua_channel_id",
                    "active_devices",
                    "active_devices_7d",
                    "active_devices_30d",
                    "completeness_state",
                ),
            )
        ],
        "active_anchor",
        "只在同一 App、同一锚点汇总固定获客分群；发布不足 30 天时不声称完整 30 日历史。",
        f"活跃锚点 {end} · UTC",
    )
    quality_columns = (
        "dataset_version",
        "install_cohort_date",
        "observe_date",
        "app_id",
        "acquisition_country_code",
        "ua_channel_id",
        "campaign_id",
        "ad_group_id",
        "ad_id",
        "creative_id",
        "cohort_size_devices",
        "retained_devices",
        "ad_revenue_usd",
        "age_days",
        "completeness_state",
    )
    for age in (1, 7):
        observed = (date.fromisoformat(cohort) + timedelta(days=age)).isoformat()
        item(
            f"retention-d{age}",
            "retention",
            f"第 {age} 日留存",
            f"叠叠乐 StackJoy iOS 的 {cohort} 安装 cohort，第 {age} 日（{observed}，UTC）留存设备和基数是多少？按同一 cohort 的分子、分母计算 RR{age}，不能把多个观察日的基数相加。",
            [
                query(
                    "retention",
                    "fact_cohort_quality_daily",
                    "observe_date",
                    observed,
                    observed,
                    equals={"app_id": "stackjoy_ios", "install_cohort_date": cohort},
                    columns=quality_columns,
                )
            ],
            "retention",
            f"RR{age} 是第 {age} 日，不是前 {age} 日累计；缺行、NULL 和未成熟不当零。",
            f"安装 cohort {cohort} · 第 {age} 日 {observed} · UTC",
        )

    item(
        "ltv7",
        "value",
        "设备 LTV7",
        f"拼格 GridFit iOS 的 {cohort} 安装 cohort，前 7 日（日龄 0–6）SDK 广告回收和设备 LTV7 是多少？设备基数仅取一次 D0，保留分母单位和缺失情况。",
        [
            query(
                "base",
                "fact_cohort_quality_daily",
                "observe_date",
                cohort,
                cohort,
                equals={"app_id": app, "install_cohort_date": cohort},
                columns=quality_columns,
            ),
            query(
                "window",
                "fact_cohort_quality_daily",
                "observe_date",
                cohort,
                cohort_end,
                equals={"app_id": app, "install_cohort_date": cohort},
                columns=quality_columns,
            ),
        ],
        "ltv7",
        "单位 USD/首次安装设备×App；不是 AF 报表注册 LTV；基数不乘以 7。",
        f"安装 cohort {cohort} · 日龄 0–6 · UTC",
    )
    for horizon in (3, 7):
        revenue_end = (
            date.fromisoformat(cohort) + timedelta(days=horizon - 1)
        ).isoformat()
        item(
            f"roi{horizon}",
            "value",
            f"实际 ROI{horizon}",
            f"拼格 GridFit iOS 的 {cohort} 安装 cohort，按获客渠道计算实际 SDK ROI{horizon}：累计日龄 0–{horizon - 1} 收入除以同 cohort 折后成本。先分别汇总再对齐，不能直接连接两张事实明细，缺侧保持未知，自然量零成本单列。",
            [
                query(
                    "cost",
                    "fact_delivery_daily",
                    "business_date",
                    cohort,
                    cohort,
                    ("discounted_cost_usd",),
                    ("ua_channel_id",),
                    {"app_id": app},
                ),
                query(
                    "recovery",
                    "fact_cohort_revenue_daily",
                    "revenue_date",
                    cohort,
                    revenue_end,
                    ("revenue_usd",),
                    ("ua_channel_id",),
                    {"app_id": app, "cohort_date": cohort, "revenue_source": "sdk"},
                ),
            ],
            "roi",
            f"ROI{horizon} 用日龄 0–{horizon - 1}，按成本加权，不能平均渠道 ROI；自然量零成本未知。",
            f"安装 cohort {cohort} · 日龄 0–{horizon - 1} · SDK · UTC",
        )
    item(
        "roi-immature",
        "value",
        "未成熟 ROI30",
        f"拼格 GridFit iOS 的 {as_of} 安装 cohort，现在能给出实际 ROI30 吗？请核对目标窗口，说明已观察日龄和未成熟边界，不用预测或零填满未来收入。",
        [
            query(
                "observed",
                "fact_cohort_quality_daily",
                "observe_date",
                as_of,
                as_of,
                equals={"app_id": app, "install_cohort_date": as_of},
                columns=quality_columns,
            )
        ],
        "immature",
        "目标需日龄 0–29；当前只有 D0，实际 ROI30 未成熟。",
        f"安装 cohort {as_of} · 目标 30 日 · UTC",
    )
    item(
        "revenue-clarify",
        "revenue",
        "先澄清口径",
        "帮我看看收入。",
        [],
        "clarification",
        "应先询问游戏/包体、统计时间及收入来源；澄清不依赖业务查询。",
        "需要补充范围",
    )

    # Keep the previously validated composite-key JOIN as a complete recipe.
    joined = next(case for case in cases if case["id"] == "plan-app-names")
    joined["queries"] = [
        dict(
            query_id="apps",
            table="fact_delivery_daily",
            date_column="business_date",
            start=begin,
            end=end,
            equals={"dataset_version": version},
            sums=["discounted_cost_usd"],
            groups=["app_id", "game_name"],
            columns=[],
            join_dimension="dim_app",
            sql="SELECT f.app_id, d.game_name, SUM(f.discounted_cost_usd) AS total_discounted_cost_usd, "
            "COUNT(f.discounted_cost_usd) AS nonnull_discounted_cost_usd, COUNT() AS source_rows "
            "FROM fact_delivery_daily f JOIN dim_app d ON f.dataset_version = d.dataset_version AND f.app_id = d.app_id "
            f"WHERE f.dataset_version = '{version}' AND f.business_date BETWEEN '{begin}' AND '{end}' "
            "GROUP BY f.app_id, d.game_name ORDER BY f.app_id, d.game_name",
        )
    ]
    return dict(
        schema_version=1,
        application="VV Data Agent",
        release=dict(
            dataset_version=version, start_date=start, as_of=as_of, timezone="UTC"
        ),
        categories=[dict(id=identity, label=label) for identity, label in CATEGORIES],
        scenarios=cases,
    )


def literal(value):
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", value):
        raise ValueError("business_filter_invalid")
    return "'" + value + "'"


def public_catalog(catalog):
    """Expose questions and scope, never evaluator results or SQL execution."""
    return dict(
        schema_version=1,
        application=catalog["application"],
        release=catalog["release"],
        categories=catalog["categories"],
        questions=[
            {
                key: case[key]
                for key in ("id", "category", "label", "text", "scope", "note")
            }
            for case in catalog["scenarios"]
        ],
    )


def business_markdown(catalog):
    text = """# VV 业务分析场景

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

"""
    for case in catalog["scenarios"]:
        text += f"## {case['id']}：{case['label']}\n\n{case['text']}\n\n范围：{case['scope']}\n\n边界：{case['note']}\n"
        for query in case["queries"]:
            text += f"\n### {query['query_id']}\n\n```sql\n{query['sql']}\n```\n"
    return text
