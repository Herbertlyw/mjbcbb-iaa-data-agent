"""The single schema/field policy used by DDL, exports and table cards."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REVISION = "starhaven-v1"
MODELS = json.loads((ROOT / "model-spec.json").read_text())
METRICS = json.loads((ROOT / "metrics.json").read_text())
SCALE = 1_000_000
DATES = set(
    "activity_date business_date cohort_date install_cohort_date observe_date entry_cohort_date revenue_date snapshot_date evaluation_as_of rate_date fx_rate_date launch_date first_test_date".split()
)
TIMES = set(
    "arrival_cutoff created_at upload_at eligible_at starts_at ends_at effective_at recorded_at input_cutoff observed_at effective_from effective_to".split()
)
FLAGS = set("is_paid is_eligible is_tested is_observable is_graduated".split())
DECIMALS = set(
    "allocation_fraction actual_roi_pct predicted_roi_pct roi_error_pp target_roi_pct warning_roi_pct source_currency_per_usd".split()
)
DEVICE_COUNTS = set(
    "active_devices active_devices_7d active_devices_30d new_active_devices returning_active_devices first_install_devices ad_viewing_devices cohort_size_devices retained_devices".split()
)
INSTALL_COUNTS = set(
    "unique_install_events reinstall_events late_install_events unattributed_install_events".split()
)
NULLABLE = set(
    "account_id campaign_id ad_group_id ad_id creative_id primary_creative_id first_test_date eligible_at effective_to control_arm_id old_value new_value is_graduated".split()
)
LABELS = dict(
    pair.split("=", 1)
    for pair in """dataset_version=不可变数据发布版本
app_id=虚构包体ID，一款产品的一个平台实例
game_id=虚构游戏ID，可对应iOS与Android包体
game_name=虚构游戏中文名
game_kind=玩法分类；未确认玩法为unconfirmed
platform=平台，固定ios或android
bundle_id=虚构包名，不对应真实应用
business_timezone=本数据包业务日统一UTC
supported_mode_codes=该包体已定义模式，逗号分隔
country_code=ISO国家代码，国家名与国家层级另列
acquisition_country_code=首次获客时国家，设备在本包体内分群固定
activity_country_code=事件发生时国家；不能自动替代获客国家
entry_country_code=实验入组时国家
country_name=国家显示名
region=区域显示分组
tier_code=本合成包配置层级，不是外部通用标准
ua_channel_id=获客渠道ID，与广告变现network不同
channel_name=虚构获客渠道名称
media_code=虚构投放媒体代码
channel_category=paid_ads、organic或unknown
is_paid=是否按本包配置属于买量
classification_version=渠道分类版本
account_id=全局唯一虚构广告账户ID；自然来源不适用
account_name=虚构广告账户名称
account_currency=原币，USD或完全虚构的XCU
account_timezone=账户报表时区元数据；生成器从UTC过程汇总
campaign_id=全局唯一计划ID；自然来源不适用
campaign_name=虚构计划名称
objective_code=计划固定优化目标
budget_level=预算所属层级，campaign
ad_group_id=广告组ID；没有此层或自然来源为NULL
ad_group_name=虚构广告组名称
optimization_event_code=虚构优化事件定义，不是事件发生次数
ad_id=全局唯一广告ID；自然来源不适用
ad_name=虚构广告名称
primary_creative_id=该广告唯一主素材；替换时创建新广告ID
creative_id=素材ID，可被多个广告复用
creative_name=虚构素材名称
format_code=素材格式，video或image
upload_at=素材上传UTC时刻
duration_seconds=素材时长秒，图片为0
aspect_ratio=素材宽高比标签
tag_codes=受控标签，逗号分隔；拆标签后不可直接累加事实
experiment_id=虚构实验ID
arm_id=实验组ID，control或variant
config_version=冻结实验配置版本
experiment_type=product或monetization
allocation_unit=分配单位，synthetic_device_app
allocation_fraction=分配比例；同一实验配置所有组之和为1
eligibility_code=虚构参与条件版本
anchor_type=first_open或first_ad_show，不是统一安装日
control_arm_id=明确对照组ID
starts_at=实验开始UTC时刻
ends_at=实验结束UTC时刻
raw_cost_local=未折扣原币消耗，不能跨币种直接相加
discounted_cost_local=折后原币消耗，不是美元
raw_cost_usd=逐行按汇率换算的原始美元消耗
discounted_cost_usd=逐行换算的折后美元消耗
impressions=本事实范围的曝光或展示；投放与游戏内广告不是同一事件
clicks=本事实范围的点击次数，不是去重点击用户
media_registers=媒体报表注册，不等于AF报表注册或设备
af_registers=AF报表注册计数，不是ODS安装事件数
source_currency=原始币种代码；XCU完全虚构
fx_rate_date=汇率UTC业务日
cost_scope=成本范围，discounted_media_delivery
completeness_state=complete或partial；完整性与freshness分开
unique_install_events=去重安装事件，含重装
first_install_devices=首次安装设备×App数量，不是跨App玩家
reinstall_events=重装安装事件子集，不额外加到安装总计
late_install_events=晚于业务日到达的安装子集，不额外相加
unattributed_install_events=无明确获客计划的安装子集
arrival_cutoff=本发布可见的到达时间截止
active_devices=当日活跃设备×App；跨天相加为设备日
active_devices_7d=锚点D-6..D精确去重活跃，不跨锚点相加
active_devices_30d=锚点D-29..D精确去重活跃，不跨锚点相加
new_active_devices=当日首次活跃设备×App
returning_active_devices=当日活跃中此前已活跃的设备
sessions=启动会话次数，不是去重设备
gameplay_seconds=已结束局时长总秒数
game_count=已结束局数
ad_viewing_devices=当日至少观看一次广告的去重设备
ad_impressions=游戏内广告展示次数
ad_revenue_usd=广告美元收入，不含IAP
device_identity_rule=synthetic_device_app_first_install_v1
cohort_size_devices=cohort设备基数，在多观察日重复，不跨观察日累加
retained_devices=本cohort在观察日活跃设备数
usage_seconds=使用时长总秒数，包含局外时间
age_days=观察日距cohort锚点的自然日
maturity_state=observed、mature或immature，不是freshness
mode_code=产品内已定义模式
level_bucket=关卡区间，无关卡模式为not_applicable
games_started=开局次数
games_finished=已结束局数
eligible_win_games=可判胜负的已结束局数
games_won=可判胜负局中的胜利数，不适用为NULL
total_score=同一产品/模式/单位的分数和，不跨游戏比较
revive_prompts=复活提示次数
revive_clicks=复活点击次数，不等于成功看完广告
successful_revives=成功复活次数
score_unit=产品与模式专用分数单位
gameplay_schema_version=合成玩法事件版本
ad_format=interstitial、rewarded或banner
network_code=虚构变现network，不是获客媒体
event_schema_version=synthetic_ad_v1
load_attempts=开始的加载尝试
completed_load_attempts=已结束加载尝试，含成功失败
successful_load_attempts=已结束尝试中成功的数量
show_actions=调用show次数
ready_actions=调用show时ready次数，不是展示成功
completed_show_requests=已结束的show请求
successful_show_requests=已结束请求中展示成功数量
revenue_usd=本来源本范围的观测美元收入
revenue_callback_count=收入回调次数
revenue_source=sdk或af，不可相加称总收入
observed_at=观测可见UTC时刻
first_test_date=此素材在媒体首次投放日，未测试为NULL
test_scope_state=assigned或unassigned，未分配不等于失败
is_eligible=是否属于适用测试范围
eligible_at=进入适用测试范围的UTC时刻
is_tested=是否观察到投放
is_observable=窗口是否成熟且有足够证据
is_graduated=是否达到虚构出坡规则，证据不足为NULL
rule_version=合成状态规则版本
test_window_cost_usd=首次测试窗口折后美元消耗
test_window_registers=同窗口AF报表注册
test_window_revenue_usd=同cohort窗口内SDK美元回收
enrolled_units=入组基数，重复观察日不可累加
observed_units=本观察日有完整观测条件的入组单位
active_units=本观察日活跃入组单位
assignment_version=实验哈希分配规则版本
operation_event_id=操作ID，一次操作多字段只计一次操作
field_name=受控变更字段名
entity_type=操作对象层级，campaign
entity_id=对应受控对象ID
effective_at=操作生效UTC时刻
recorded_at=日志可见UTC时刻
old_value=由value_type声明的旧值，初始化可为NULL
new_value=由value_type声明的新值
value_type=decimal或state
unit=原币、百分比、状态等值单位
change_source=synthetic_controlled_operation
prediction_id=跨发布稳定的预测快照身份
snapshot_date=快照业务日期，不是收入发生日
input_cutoff=预测输入截止，不得用之后真实值
observed_age_days=预测时已完整观察的cohort日数
horizon_days=累计业务天数N，对应日龄0..N-1
model_version=baseline_linear_v1或baseline_tail_v2，不是公司模型
cost_as_of_usd=预测当时已知成本
predicted_revenue_usd=截至目标N日累计预测美元回收
predicted_roi_pct=预测收入/当时成本×100，不是实际ROI
prediction_state=predicted，不是实际收入
evaluation_as_of=复验截止业务日
actual_revenue_usd=成熟目标窗口实际SDK观测收入
actual_cost_usd=复验时对应cohort完整成本
actual_roi_pct=成熟收入/完整成本×100
roi_error_pp=实际ROI减预测ROI，百分点
cost_weight_usd=成本加权误差权重
input_revision_state=unchanged或input_revised；回刷与模型误差分开
rate_date=汇率UTC业务日
source_currency_per_usd=1美元兑换原币数，美元=原币/该正数
rate_status=known或missing
policy_id=合成经营规则身份
policy_version=合成规则版本
effective_from=规则生效UTC时刻
effective_to=规则结束UTC时刻，无结束为NULL
scope_type=app
scope_key=适用App ID
target_roi_pct=虚构目标回收百分比，不是公司目标
warning_roi_pct=虚构观察线，不是投放指令
minimum_sample_units=最小样本数，合成参数
test_window_days=首次测试窗口日数
maturity_days=规则要求成熟日数
created_at=对象创建UTC时刻""".splitlines()
    if "=" in pair
)


def column(table, name):
    model = next(m for m in MODELS if m["asset"] == table)
    nullable = name in NULLABLE and not table.startswith("dim_") or name == "is_paid"
    if table == "fact_creative_test_snapshot" and name == "ua_channel_id":
        nullable = True
    if name in model["measures"] and table.startswith("fact_"):
        nullable = True
    if name in DATES:
        kind = "Date"
    elif name in TIMES:
        kind = "DateTime64(3, 'UTC')"
    elif name in FLAGS:
        kind = "UInt8"
    elif name in DECIMALS:
        kind = "Decimal(24,6)"
    elif name in model["measures"]:
        kind = "Decimal(24,6)" if name.endswith(("_usd", "_local")) else "UInt64"
    elif name in {
        "age_days",
        "observed_age_days",
        "horizon_days",
        "duration_seconds",
        "test_window_days",
        "maturity_days",
        "minimum_sample_units",
    }:
        kind = "UInt32"
    else:
        kind = "String"
    if name in {
        "actual_cost_usd",
        "actual_revenue_usd",
        "actual_roi_pct",
        "roi_error_pp",
        "cost_weight_usd",
        "games_won",
    }:
        nullable = True
    if nullable:
        kind = f"Nullable({kind})"
    if name not in LABELS and name not in DATES and name not in TIMES:
        raise ValueError(f"Undefined meaning: {table}.{name}")
    description = LABELS.get(
        name, f"{name}：UTC业务日期；角色由表粒度定义，不与其他日期混用。"
    )
    unit = (
        "原币/USD"
        if name == "source_currency_per_usd"
        else (
            "USD"
            if name.endswith("_usd")
            else (
                "原币"
                if name.endswith("_local")
                else (
                    "百分点"
                    if name == "roi_error_pp"
                    else (
                        "%"
                        if name.endswith("_pct")
                        else (
                            "比例"
                            if name == "allocation_fraction"
                            else (
                                "秒"
                                if name.endswith("_seconds")
                                else "计数" if name in model["measures"] else None
                            )
                        )
                    )
                )
            )
        )
    )
    if name in DEVICE_COUNTS:
        unit = "设备×App"
    elif name in INSTALL_COUNTS:
        unit = "安装事件"
    elif name in {"media_registers", "af_registers", "test_window_registers"}:
        unit = "报表注册"
    elif name in {"enrolled_units", "observed_units", "active_units"}:
        unit = "实验分配单位"
    elif name in {
        "game_count",
        "games_started",
        "games_finished",
        "eligible_win_games",
        "games_won",
    }:
        unit = "局"
    elif name in {
        "age_days",
        "observed_age_days",
        "horizon_days",
        "test_window_days",
        "maturity_days",
    }:
        unit = "天"
    return {
        "name": name,
        "type": kind,
        "description": description,
        "nullable": nullable,
        **({"unit": unit} if unit else {}),
    }


def schema():
    return [
        {
            **model,
            "columns": [
                column(model["asset"], name) for name in model["declared_column_names"]
            ],
        }
        for model in MODELS
    ]


def ddl():
    statements = []
    for model in schema():
        cols = ",\n".join(f"  {c['name']} {c['type']}" for c in model["columns"])
        keys = ["dataset_version"] + model["dimensions"]
        statements.append(
            f"CREATE TABLE IF NOT EXISTS {model['asset']} (\n{cols}\n) ENGINE = MergeTree ORDER BY ({', '.join(keys)}) SETTINGS allow_nullable_key = 1;"
        )
    return "\n\n".join(statements) + "\n"
