"""Render one reproducible knowledge package from schema and metric definitions."""

import hashlib
import json
import re
from pathlib import Path
import shutil

from .catalog import ROOT, REVISION, METRICS, ddl, schema
from .business import CATEGORIES, business_catalog, business_markdown, public_catalog
from .queries import examples
from .reconcile import reconcile

REPO = ROOT.parents[1]
TARGET = REPO / "knowledge/starhaven"
BRANDING = json.loads((ROOT / "settings.json").read_text())
TOPICS = {
    "overview": (
        "业务全景",
        BRANDING["application_name"]
        + " 是本项目的应用名称，分析对象为三款完全虚构的手游："
        + "、".join(
            game["name"]
            + "（"
            + game["english_name"]
            + "，game_id="
            + game["id"]
            + "）"
            for game in BRANDING["games"]
        )
        + "。拼格=拖消，落块=落消，叠叠乐玩法尚未确认。三款各有ios/android包体。先用dim_app确认App，不把game_id、app_id或bundle_id互换。\n\n数据链：投放→安装与归因→设备活跃及cohort→玩法和广告→分来源回收→实验与预测复验。MySQL任务与Redis调度属于控制面，不是这些业务事实。",
    ),
    "identity": (
        "身份、粒度与关联",
        "公开表不含用户/设备原值。计量单位是设备×App、安装事件、报表注册等，不是跨App真实玩家。对象ID在合成包中全局唯一；维表主键还包含dataset_version。事实对维表只允许登记键；两个事实不得直接明细JOIN。分别按契约共同键汇总后用受控计算对齐。\n\n主素材一广告一份，多广告可复用素材。原始标签拆开会放大事实；不要用拆标签后的行数当素材数。",
    ),
    "time": (
        "时间、到达与成熟度",
        "所有业务日UTC。cohort_date/安装日、observe_date/观察日、revenue_date/收入日、snapshot_date/快照日和arrival_cutoff/到达截止不同。\n\nRR7是第7日；累计ROI7是日龄0..6。未成熟不是0。AF回调比SDK延迟，fresh不证明任意cohort成熟。最后一天可存在未到AF事件，用completeness_state与发布目标分别判断。",
    ),
    "currency": (
        "金额与汇率",
        "所有金额为Decimal(24,6)，生成与对账使用整数微单位和Decimal，不经float。source_currency_per_usd=1美元兑换原币数；USD=local/rate。XCU是虚构货币，其汇率不是市场报价。逐行换汇再汇总，原始/折后成本分别保留。\n\n除零未知，NULL不补零；显示舍入不改原始六位金额。大规模溢出仍受Decimal(24,6)边界约束。",
    ),
    "acquisition": (
        "获客、注册与安装",
        "af_registers是投放报表计数；media_registers来自媒体报表；unique_install_events是去重安装事件，包含重装。first_install_devices是首次安装设备，new_active_devices是行为D0。四者不强制相等。\n\nreinstall_events、late_install_events和unattributed_install_events是安装子集，不额外加到总安装。自然来源没有投放账户或计划，其成本可以是已观测0；unknown不当自然量。",
    ),
    "engagement": (
        "活跃与留存",
        "DAU跨日求和是设备日。active_devices_7d窗口D-6..D，active_devices_30d窗口D-29..D；同一App同一锚点按固定首次获客国家/渠道分群，可分群汇总，不能跨锚点相加或声称跨App玩家去重。\n\n设备质量和实验观察只保存age_days=0..30；更长回收用分来源回收表。cohort_size_devices在多个observe_date重复；只对同一age的cohort基数汇总。留存使用相同cohort分子分母，不能按所有观察日SUM基数。",
    ),
    "gameplay": (
        "玩法、局与模式",
        "第一版只提供局/日聚合，不生成完整游戏引擎、轮块盘面日志。gameplay_seconds是已结束局的秒数；games_started可以大于games_finished。\n\n胜率=games_won/eligible_win_games，无胜负定义时games_won为NULL。复活点击不等于成功看完广告或复活。不同game/模式score_unit不能直接比较。第三款unconfirmed模式不提供胜率。",
    ),
    "monetization": (
        "广告商业化",
        "获客ua_channel_id与游戏内network_code不是同一维度。事件schema为synthetic_ad_v1。load_attempt、show_request、ready和展示分别计数。\n\n加载成功率=successful_load_attempts/completed_load_attempts，同时报告结束覆盖completed_load_attempts/load_attempts。ready_actions/show_actions不是show成功率。预加载/缓存可以跨日，因此不假定当日load始终多于show。\n\n广告ARPDAU、观看渗透率、eCPM分别定义。funnel没有获客计划维度，不准按日期国家拼接投放明细归因加载失败。",
    ),
    "roi": (
        "分来源回收、LTV与ROI",
        "收入来源sdk与af是不同观测，不能相加当总收入。本包IAA广告回收不等于IAP支付流水。\n\n实际ROI_N=同cohort/来源日龄0..N-1累计收入/折后消耗×100。设备LTV和AF报表注册分母LTV分别标明单位；自然量0成本的ROI未知。设备质量表只覆盖日龄0..30，因此设备LTV_N仅支持1≤N≤31。更长实际回收使用分来源回收表。\n\n分来源回收表按有活动的设备日稀疏聚合；缺行本身不证明零。只有独立知道目标cohort、到达截止和完整处理范围时，才可解释已处理窗口的无回调。AF最后一个业务日尚未到达，不能补0。\n\n跨表先聚合对齐范围，保留NULL、完整性和来源；不能直接事实明细JOIN，也不能用预测补充实际收入。",
    ),
    "creative": (
        "素材生产与测试",
        "素材文件、投放事实和测试快照职责不同。测试状态来自投放和可观测窗口，不独立随机造。first_test_date不是出坡日期，未分配test_scope_state=unassigned不是测试失败。\n\n出坡率分母为可观测素材，状态按rule_version解释。跨媒体素材数量去重；素材年龄关联不是疲劳因果或停投指令。",
    ),
    "experiment": (
        "实验配置与观察",
        "dim_experiment_arm明确control_arm_id、allocation_unit、config_version和anchor_type。product以first_open为锚点；monetization以first_ad_show为锚点，触发可能晚于安装。\n\nenrolled_units跨观察日重复不可累加。不同experiment可重叠，不得相加称全部用户。组间差异不自动代表统计显著或推广到所有玩家。",
    ),
    "operations": (
        "配置、状态和操作关联",
        "一次operation_event_id可变更多个field_name，操作次数需去重。预算/状态变化生效时间与记录时间分开。先看时间窗事实，再查同窗操作；前后变化只是候选关联，不证明因果。\n\n目标和警戒线来自config_business_policy_snapshot，是虚构规则，不是公司目标、净利润或自动投放指令。日志空不证明无人操作。",
    ),
    "forecast": (
        "预测与复验",
        "baseline_linear_v1和baseline_tail_v2是透明合成基线，不是公司算法。prediction_id固定快照、cohort、范围、来源、horizon和版本。input_cutoff之后的收入不能作为输入。\n\n只在目标成熟且完整时计算实际误差。成本输入回刷需标input_revision_state，不能直接归为模型错误；权重用cost_weight_usd。旧预测不被最新预测覆盖，行均值不能代替成本加权总体误差。",
    ),
    "quality": (
        "版本、覆盖和不可回答",
        "每个任务应绑定不可变dataset_version。manifest/哈希用于完整性，不是生产认证签名；ClickHouse写入与MySQL发布不是一个跨库原子事务。发布只在对账通过之后。\n\nNULL、真零、缺行、预测、未成熟分别保留。对象有效期与计划状态决定期望域，不能生成全局笛卡尔积来猜缺行。模型不能读private-gold、生成器隐藏参数或评测答案。\n\n宿主对声明的受限维度执行保守聚合检查；其他不可加字段仍不进入可认证series.metrics。结构体检通过不代表任意SQL和派生解释已获认证。",
    ),
}
NON_ADDITIVE = {
    "fact_delivery_daily": {
        "raw_cost_local": ["source_currency"],
        "discounted_cost_local": ["source_currency"],
    },
    "fact_gameplay_daily": {
        "total_score": ["app_id", "mode_code", "score_unit"],
    },
    "fact_activity_daily": {
        "active_devices_7d": ["activity_date"],
        "active_devices_30d": ["activity_date"],
    },
    "fact_cohort_quality_daily": {"cohort_size_devices": ["observe_date", "age_days"]},
    "fact_experiment_cohort_daily": {
        "enrolled_units": ["observe_date", "age_days"],
        "observed_units": ["observe_date", "age_days"],
    },
    "fact_creative_test_snapshot": {
        "test_window_cost_usd": ["snapshot_date"],
        "test_window_registers": ["snapshot_date"],
        "test_window_revenue_usd": ["snapshot_date"],
    },
    "fact_roi_forecast_snapshot": {
        "cost_as_of_usd": ["snapshot_date", "model_version", "horizon_days"],
        "predicted_revenue_usd": ["snapshot_date", "model_version", "horizon_days"],
        "predicted_roi_pct": ["snapshot_date", "model_version", "horizon_days"],
    },
    "fact_roi_forecast_evaluation": {
        "actual_cost_usd": ["evaluation_as_of", "prediction_id"],
        "actual_revenue_usd": ["evaluation_as_of", "prediction_id"],
        "actual_roi_pct": ["evaluation_as_of", "prediction_id"],
        "predicted_roi_pct": ["evaluation_as_of", "prediction_id"],
        "roi_error_pp": ["evaluation_as_of", "prediction_id"],
        "cost_weight_usd": ["evaluation_as_of", "prediction_id"],
    },
    "fact_fx_rate_daily": {"source_currency_per_usd": ["rate_date", "source_currency"]},
}
SOURCE_AGGREGATION_POLICY = {
    "fact_cohort_revenue_daily": {
        "revenue_usd": ["revenue_source"],
        "revenue_callback_count": ["revenue_source"],
    },
}
DATE_COLUMNS = {
    "fact_delivery_daily": "business_date",
    "fact_acquisition_daily": "cohort_date",
    "fact_activity_daily": "activity_date",
    "fact_cohort_quality_daily": "observe_date",
    "fact_gameplay_daily": "business_date",
    "fact_ad_funnel_daily": "business_date",
    "fact_cohort_revenue_daily": "revenue_date",
    "fact_creative_test_snapshot": "snapshot_date",
    "fact_experiment_cohort_daily": "observe_date",
    "fact_ad_operation_event": "effective_at",
    "fact_roi_forecast_snapshot": "snapshot_date",
    "fact_roi_forecast_evaluation": "evaluation_as_of",
    "fact_fx_rate_daily": "rate_date",
}


def package_files():
    files = {}
    assets = []

    def register(identity, kind, title, summary, path, content, table=None):
        files[path] = (
            content
            if isinstance(content, str)
            else json.dumps(content, ensure_ascii=False, indent=2) + "\n"
        )
        assets.append(
            dict(
                asset_id=identity,
                kind=kind,
                title=title,
                summary=summary,
                revision=(
                    content.get("revision", identity + "-v1")
                    if isinstance(content, dict)
                    else identity + "-v1"
                ),
                status="published",
                discoverable=True,
                path=path,
                **({"table": table} if table else {})
            )
        )

    files["schema.sql"] = ddl()
    files["semantics.json"] = (
        json.dumps(
            {
                "simulated": True,
                "note": "仅用于Pi原话模式；不提供槽位编译器默认问题或标准答案。",
                "application_name": BRANDING["application_name"],
                "default_game": BRANDING["games"][0]["id"],
                "games": [
                    {
                        "game_id": game["id"],
                        "name": game["name"],
                        "english_name": game["english_name"],
                    }
                    for game in BRANDING["games"]
                ],
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    for topic, (title, body) in TOPICS.items():
        register(
            "starhaven." + topic,
            "catalog" if topic == "overview" else "analysis_sop",
            title,
            title,
            "assets/" + topic + ".md",
            "# " + title + "\n\n" + body + "\n",
        )
    register(
        "starhaven.release",
        "catalog",
        "当前合成数据发布范围",
        "先确认版本、起止日期和独立数据库，再选择业务范围。",
        "assets/release.md",
        "# 当前发布\n\n尚未绑定具体发布；此静态包不能证明任何表已装载或fresh。生成数据后的release-knowledge会填入实际版本和日期。\n",
    )
    register(
        "starhaven.business",
        "analysis_sop",
        "VV完整业务场景与分析步骤",
        "获客、计划、素材、广告收入、留存、LTV与ROI的口径和SQL。",
        "assets/business.md",
        "未绑定发布：以下日期仅作模板，实际查询先读当前发布并替换范围。\n\n"
        + business_markdown(
            business_catalog("sv_00000000000000000000", "2026-10-26", "2026-11-08")
        ).replace("sv_00000000000000000000", "DATASET_VERSION"),
    )
    files["demo-catalog.json"] = (
        json.dumps(
            dict(
                schema_version=1,
                application="VV Data Agent",
                release=None,
                categories=[
                    dict(id=identity, label=label) for identity, label in CATEGORIES
                ],
                questions=[],
            ),
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    metric_body = "# 指标唯一维护来源\n\n由synthetic/starhaven/metrics.json生成。字段单位、范围与边界是公式的一部分。\n"
    for metric in METRICS:
        metric_body += (
            "\n## "
            + metric["metric_id"]
            + " — "
            + metric["label"]
            + "\n\n公式："
            + metric["formula"]
            + "\n\n单位："
            + metric["unit"]
            + "\n\n边界："
            + metric["guard"]
            + "\n"
        )
    register(
        "starhaven.metrics",
        "metric",
        "43项指标定义",
        "指标公式、分母、单位和限制。",
        "assets/metrics.md",
        metric_body,
    )
    models = schema()
    for model in models:
        table = model["asset"]
        day = DATE_COLUMNS.get(table)
        excluded = set(NON_ADDITIVE.get(table, {}))
        # Unsafe statistical semantics stay un-certified by the legacy host.
        safe = [name for name in model["measures"] if name not in excluded]
        if table in {"fact_roi_forecast_snapshot", "fact_roi_forecast_evaluation"}:
            safe = []
        contract = dict(
            asset_id="contract." + table,
            revision="contract." + table + "-v1",
            table=table,
            engine="clickhouse-local",
            simulated=True,
            valid_from="2020-01-01",
            valid_until="2099-12-31",
            timezone="UTC",
            freshness=dict(
                as_of=None, status="unknown", note="仅使用受控发布；本文件不授予fresh。"
            ),
            must_filter=(
                []
                if table.startswith("dim_")
                else ["dataset_version"] + ([day] if day else [])
            ),
            grain=["dataset_version"] + model["dimensions"],
            columns=model["columns"],
            sensitive_columns=[],
            notes=model["grain"] + "。" + model["boundary"],
            aggregation_policy={**NON_ADDITIVE.get(table, {}), **SOURCE_AGGREGATION_POLICY.get(table, {})},
            dataset_policy="one_immutable_release_per_database",
            certified_metric_exclusions=sorted(excluded),
        )
        if day and day not in {"effective_at"}:
            contract["series"] = dict(
                date_column=day,
                dimensions=["dataset_version"]
                + [n for n in model["dimensions"] if n != day],
                metrics=safe,
                predicted_column=None,
                prediction_mode="observed_only",
            )
            # Only direct, single-table ratios of the same observed group are
            # represented. Natural-language guard text and missing business
            # dimensions are never promoted into complete-scope certification.
            columns = {item["name"]: item for item in model["columns"]}
            derived = []
            for metric in METRICS:
                match = re.fullmatch(r"SUM\(([a-z_][a-z0-9_]*)\) / SUM\(([a-z_][a-z0-9_]*)\)", metric["formula"])
                if not match:
                    continue
                numerator, denominator = match.groups()
                if metric["inputs"] != [table + "." + numerator, table + "." + denominator] or numerator not in safe or denominator not in safe:
                    continue
                nu = columns[numerator].get("unit"); de = columns[denominator].get("unit")
                if not nu or not de:
                    continue
                derived.append(dict(id=metric["metric_id"], label=metric["label"], operation="divide", numerator=numerator, denominator=denominator, prediction="actual_only", unit="比值" if nu == de else "(" + nu + ")/(" + de + ")", scope="observed_partial_only"))
            if derived:
                contract["derived_metrics"] = derived
        if table == "fact_roi_forecast_snapshot":
            contract.pop("series", None)
            contract["notes"] += " 预测观测无实际指标series，不允许冒充实际收入。"
        if contract.get("series"):
            contract["revision"] = "contract." + table + "-v2"
            contract[
                "notes"
            ] += " dataset_version属于完整物理粒度和关联键，列入series.dimensions；日期分区仍只使用date_column。"
            if table == "fact_cohort_revenue_daily":
                contract["revision"] = "contract." + table + "-v3"
                contract["series"]["coverage_semantics"] = "sparse_observations"
        # The current host interprets must_filter exclusively as a Date partition.
        # Version isolation is enforced by loading exactly one release per new DB.
        contract["must_filter"] = [day] if contract.get("series") else []
        register(
            contract["asset_id"],
            "data_contract",
            model["role"] + "契约",
            model["boundary"],
            "contracts/" + table + ".json",
            contract,
            table,
        )
        body = (
            "# "
            + table
            + "："
            + model["role"]
            + "\n\n粒度："
            + ", ".join(contract["grain"])
            + "\n\n"
            + model["boundary"]
            + "\n\n| 字段 | ClickHouse类型 | 单位 | 定义 |\n|---|---|---|---|\n"
        )
        for c in model["columns"]:
            body += (
                "| "
                + c["name"]
                + " | "
                + c["type"]
                + " | "
                + c.get("unit", "—")
                + " | "
                + c["description"]
                + " |\n"
            )
        body += "\nNULL表示缺失/不适用，0表示观测零；状态与单位必须一起解释。\n\n"
        body += "\n".join(model.get("aggregation_rules", [])) + "\n"
        register(
            "table." + table,
            "catalog",
            model["role"] + "表卡",
            table + "粒度、字段与适用边界。",
            "tables/" + table + ".md",
            body,
        )
    joins = []
    for model in models:
        if model["asset"].startswith("dim_"):
            continue
        for dimension, key in [
            ("dim_app", "app_id"),
            ("dim_ua_channel", "ua_channel_id"),
            ("dim_ad_account", "account_id"),
            ("dim_campaign", "campaign_id"),
            ("dim_ad_group", "ad_group_id"),
            ("dim_ad", "ad_id"),
            ("dim_creative", "creative_id"),
        ]:
            if key in model["declared_column_names"]:
                joins.append(
                    dict(
                        join_id="starhaven." + model["asset"] + "." + dimension,
                        tables=[model["asset"], dimension],
                        keys=["dataset_version", key],
                        note="仅一对多维表查找；维键唯一且同发布版本。",
                    )
                )
    files["joins.json"] = (
        json.dumps(
            dict(
                revision=REVISION,
                simulated=True,
                joins=joins,
                role_mappings={
                    "acquisition_country_code": "dim_country.country_code",
                    "activity_country_code": "dim_country.country_code",
                    "entry_country_code": "dim_country.country_code",
                },
                role_mapping_note="异名角色外键已参与离线和数据库对账，但当前宿主登记JOIN只消费同名keys；不能据此自动放行异名SQL JOIN。",
            ),
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    files["verified-sql.json"] = (
        json.dumps(
            dict(
                simulated=True,
                validation_status="parameterized_families_validated_on_generated_release_not_all_values_or_runtime_shapes",
                examples=examples(),
            ),
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    register(
        "starhaven.sql",
        "example_sql",
        "参数化SQL与适用边界",
        "替换版本和日期后重新审查；不是固定题答案。",
        "assets/sql.md",
        "# SQL模板\n\n先读当前发布范围，将DATASET_VERSION和示例日期替换为本任务版本和有效范围。以下16类SQL验证数据可查询性，不代表宿主对每种结果均有完整业务认证能力。预测、去重窗口和重复基数的限制仍生效。\n\n投放成本先SUM金额再算比率。RR7只取age_days=7，按相同cohort基数计算。SDK/AF分源，禁止事实明细直接JOIN。\n"
        + "".join(
            "\n## "
            + sample["example_id"]
            + "："
            + sample["question"]
            + "\n\n```sql\n"
            + sample["sql"]
            + "\n```\n\n"
            + sample["note"]
            + "\n"
            for sample in examples()
        ),
    )
    policy = dict(
        policy_revision=REVISION,
        simulated=True,
        note="只读合成数据。认证series不包含非加性窗口字段；任意数学结果不能自动认证业务含义。",
        roles={
            "analyst": dict(
                read=[a["asset_id"] for a in assets],
                query_tables=[m["asset"] for m in models],
            ),
            "viewer": dict(read=["starhaven.overview"], query_tables=[]),
        },
    )
    files["policy.json"] = json.dumps(policy, ensure_ascii=False, indent=2) + "\n"
    files["registry.json"] = (
        json.dumps(
            dict(
                registry_revision=REVISION,
                simulated=True,
                scenario=BRANDING["application_name"]
                + " 独立合成移动游戏数据；非公司数据；Pi原话模式。",
                timezone="UTC",
                policy_path="policy.json",
                seed_path="schema.sql",
                joins_path="joins.json",
                assets=assets,
            ),
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    files["freshness-targets.json"] = (
        json.dumps(
            dict(
                source=REVISION,
                engine="clickhouse-local",
                valid_until="2099-12-31",
                targets=[],
                note="未绑定具体发布，拒绝在线新鲜度；生成器输出release-knowledge时填充。",
            ),
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    return files


def render(check=False, target=TARGET):
    files = package_files()
    mismatches = []
    for relative, text in files.items():
        destination = target / relative
        if check:
            if not destination.is_file() or destination.read_text() != text:
                mismatches.append(relative)
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(text)
    if check and mismatches:
        raise ValueError("knowledge_generated_files_drift: " + ", ".join(mismatches))
    return len(files)


def bind_knowledge(dataset, output):
    """Bind current contracts in a new directory without rewriting old releases."""
    dataset = Path(dataset)
    output = Path(output)
    if output.exists() or output.is_symlink():
        raise ValueError("knowledge_output_exists")
    if reconcile(dataset)["status"] != "passed":
        raise ValueError("dataset_reconciliation_failed")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.mkdir()
    try:
        release_knowledge(dataset, output)
    except BaseException:
        shutil.rmtree(output, ignore_errors=True)
        raise
    return dict(
        status="passed",
        knowledge_dir=str(output),
        publication="unpublished_requires_freshness",
    )


def release_knowledge(dataset, destination=None):
    dataset = Path(dataset)
    manifest = json.loads((dataset / "manifest.json").read_text())
    destination = (
        dataset / "release-knowledge" if destination is None else Path(destination)
    )
    render(target=destination)
    targets = []
    for model in schema():
        table = model["asset"]
        if model["asset"].startswith("dim_") or table in {
            "config_business_policy_snapshot",
            "fact_ad_operation_event",
            "fact_roi_forecast_snapshot",
        }:
            targets.append(
                dict(
                    table=table,
                    engine="clickhouse-local",
                    kind="dimension_snapshot",
                    key_columns=["dataset_version"] + model["dimensions"],
                    snapshot_columns=model["declared_column_names"],
                )
            )
        else:
            day = DATE_COLUMNS[table]
            dates = [
                json.loads(line)[day]
                for line in (dataset / (table + ".jsonl")).read_text().splitlines()
            ]
            if not dates:
                continue
            targets.append(
                dict(
                    table=table,
                    engine="clickhouse-local",
                    date_column=day,
                    expected_start=min(dates),
                    expected_end=max(dates),
                )
            )
    # Forecast snapshots can exceed the host dimension budget. Their online
    # formal delivery remains disabled until a bounded version-aware policy exists.
    targets = [t for t in targets if t["table"] != "fact_roi_forecast_snapshot"]
    (destination / "freshness-targets.json").write_text(
        json.dumps(
            dict(
                source=manifest["dataset_version"],
                engine="clickhouse-local",
                valid_until="2099-12-31",
                targets=targets,
                note="声明周期，不证明分群完整；预测快照不开放在线认证。",
            ),
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    (destination / "release.json").write_text(
        json.dumps(
            dict(
                dataset_version=manifest["dataset_version"],
                start_date=manifest["start_date"],
                as_of=manifest["as_of"],
                manifest_sha256=hashlib.sha256(
                    (dataset / "manifest.json").read_bytes()
                ).hexdigest(),
            ),
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    catalog = business_catalog(
        manifest["dataset_version"], manifest["start_date"], manifest["as_of"]
    )
    (destination / "demo-catalog.json").write_text(
        json.dumps(public_catalog(catalog), ensure_ascii=False, indent=2) + "\n"
    )
    (destination / "assets/business.md").write_text(business_markdown(catalog))
    (destination / "assets/release.md").write_text(
        "# 当前合成数据发布\n\n版本："
        + manifest["dataset_version"]
        + "\n\nUTC起始业务日："
        + manifest["start_date"]
        + "\n\nUTC截止业务日："
        + manifest["as_of"]
        + "\n\n每个新数据库只装载这一版。SQL仍应显式筛选dataset_version；该字段不是日期分区。装载成功不自动表示fresh，必须由宿主发布并回读对应回执。不要把上述全局日期解释为所有cohort或实验都已成熟。\n"
    )
    return destination
