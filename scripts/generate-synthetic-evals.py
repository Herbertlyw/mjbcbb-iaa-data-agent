"""Generate independent question/answer pairs from published synthetic JSONL.

The model must receive only `question`; expected values stay in the local evaluator.
"""
import argparse
from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP, localcontext
import hashlib
import json
from pathlib import Path
import random

QUESTION_TEMPLATES = (
    "请问 {title} 在 {day}（UTC）的{metric}是多少？请说明单位和数据来源。",
    "查一下 {day} UTC，{title} 的{metric}，给出数值、单位和来源。",
    "{title} 在 UTC 日期 {day} 的{metric}有多少？请附上可核对的数据来源和单位。",
)

def rows(path):
    with path.open(encoding="utf-8") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def generate(dataset, seed):
    release = json.loads((dataset / "manifest.json").read_text(encoding="utf-8"))
    app_rows = rows(dataset / "dim_app.jsonl")
    apps = {r["app_id"]: r for r in app_rows}
    if len(apps) != len(app_rows) or any(row.get("dataset_version") != release["dataset_version"] for row in app_rows):
        raise ValueError("synthetic_dimension_version_or_key_invalid")
    rng = random.Random(seed)
    date_upper = release["as_of"]
    cases = []

    def make_daily(table, date_key, field, display, unit, index, *, optional=False):
        grouped = defaultdict(list)
        for row in rows(dataset / f"{table}.jsonl"):
            if row[date_key] < date_upper and row["app_id"] in apps:
                grouped[(row["app_id"], row[date_key])].append(row)
        candidates = [(key, bucket) for key, bucket in sorted(grouped.items())
                      if bucket and all(r.get(field) is not None and r.get("completeness_state") == "complete" for r in bucket)]
        if not candidates and optional:
            return
        if not candidates:
            raise ValueError(f"no_complete_synthetic_samples:{table}:{field}")
        (app_id, day), bucket = rng.choice(candidates)
        app = apps[app_id]
        value = sum((Decimal(str(r[field])) for r in bucket), Decimal(0))
        title = f"{app['game_name']} {app['game_id']} {app['platform']}"
        cases.append({
            "id": f"daily-{index}",
            "question": rng.choice(QUESTION_TEMPLATES).format(title=title, day=day, metric=display),
            "oracle": {"kind": "daily_sum", "table": table, "column": field, "app_id": app_id,
                       "date": day, "value": format(value, "f"), "unit": unit,
                       "rows": len(bucket), "null_count": 0, "source": "synthetic JSONL; Decimal sum"},
        })

    make_daily("fact_activity_daily", "activity_date", "active_devices", "日活跃设备数", "设备×App", 1)
    make_daily("fact_activity_daily", "activity_date", "ad_revenue_usd", "SDK 广告收入", "USD", 2)
    make_daily("fact_acquisition_daily", "cohort_date", "first_install_devices", "首次安装设备数", "设备×App", 3)
    activity = defaultdict(list)
    for row in rows(dataset / "fact_activity_daily.jsonl"):
        if row["activity_date"] < date_upper and row["app_id"] in apps:
            activity[(row["app_id"], row["activity_date"])].append(row)
    by_app = defaultdict(list)
    for (app_id, day), bucket in sorted(activity.items()):
        if bucket and all(r.get("active_devices") is not None and r.get("completeness_state") == "complete" for r in bucket):
            by_app[app_id].append((day, bucket))
    viable = sorted(app for app, days in by_app.items() if len(days) >= 2)
    if viable:
        app_id = rng.choice(viable)
        first, second = sorted(rng.sample(by_app[app_id], 2))
        a = sum((Decimal(str(row["active_devices"])) for row in first[1]), Decimal(0))
        b = sum((Decimal(str(row["active_devices"])) for row in second[1]), Decimal(0))
        app = apps[app_id]
        cases.append({"id": "daily-comparison-1",
            "question": f"比较 {app['game_name']} {app['game_id']} {app['platform']} 在 {first[0]} 和 {second[0]}（UTC）的日活跃设备数，分别是多少？后一天比前一天多还是少多少？请说明单位和来源。",
            "oracle": {"kind": "daily_comparison", "table": "fact_activity_daily", "column": "active_devices", "app_id": app_id,
                       "first_date": first[0], "first_value": format(a, "f"), "second_date": second[0], "second_value": format(b, "f"),
                       "difference_second_minus_first": format(b-a, "f"), "unit": "设备×App", "source": "synthetic JSONL; Decimal sums"}})
    delivery = defaultdict(list)
    for row in rows(dataset / "fact_delivery_daily.jsonl"):
        if row["business_date"] < date_upper and row["app_id"] in apps:
            delivery[row["business_date"]].append(row)
    viable_days = sorted(day for day, bucket in delivery.items() if bucket and all(
        row.get("discounted_cost_usd") is not None and row.get("completeness_state") == "complete" for row in bucket))
    if viable_days:
        day = rng.choice(viable_days)
        groups = defaultdict(list)
        for row in delivery[day]:
            groups[row["app_id"]].append(row)
        expected = []
        for app_id, bucket in sorted(groups.items()):
            app = apps[app_id]
            expected.append({"app_id": app_id, "game_name": app["game_name"], "platform": app["platform"],
                             "discounted_cost_usd": format(sum((Decimal(str(row["discounted_cost_usd"])) for row in bucket), Decimal(0)), "f"),
                             "rows": len(bucket)})
        cases.append({"id": "product-cost-join-1",
            "question": f"请按产品名称和平台，列出 {day}（UTC）有投放记录的各包体折后美元投放成本，并说明币种和产品名称来源。",
            "oracle": {"kind": "dimension_cost_group", "date": day, "unit": "USD", "groups": expected,
                       "source": "synthetic JSONL; product dimension joined by dataset_version and app_id; Decimal sums"}})
    channel_sets = defaultdict(list)
    for day, bucket in delivery.items():
        for row in bucket:
            channel_sets[(row["app_id"], day)].append(row)
    viable_channels = [(key, bucket) for key, bucket in sorted(channel_sets.items()) if bucket and all(
        row.get("ua_channel_id") is not None and row.get("af_registers") is not None and row.get("discounted_cost_usd") is not None and row.get("completeness_state") == "complete" for row in bucket)]
    if viable_channels:
        (app_id, day), bucket = rng.choice(viable_channels)
        channels = defaultdict(list)
        for row in bucket:
            channels[row["ua_channel_id"]].append(row)
        groups = []
        for channel, selected in sorted(channels.items()):
            cost = sum((Decimal(str(row["discounted_cost_usd"])) for row in selected), Decimal(0))
            registrations = sum(int(row["af_registers"]) for row in selected)
            with localcontext() as ctx:
                ctx.prec = 76
                cpi = None if registrations == 0 else format((cost / registrations).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP), "f")
            groups.append({"ua_channel_id": channel, "discounted_cost_usd": format(cost, "f"), "af_registers": registrations, "cpi_usd_per_register": cpi, "rows": len(selected)})
        app = apps[app_id]
        cases.append({"id": "channel-cpi-1",
            "question": f"{app['game_name']} {app['game_id']} {app['platform']} 在 {day}（UTC）各获客渠道的折后美元消耗、AF 报表注册和 CPI 分别是多少？先汇总分子分母再计算，CPI 保留六位小数；零注册请说明未知。",
            "oracle": {"kind": "channel_cpi", "app_id": app_id, "date": day, "unit": "USD/AF报表注册", "groups": groups,
                       "source": "synthetic JSONL; Decimal cost / summed AF registrations; zero denominator unknown"}})
    # Additional questions use independently summed, explicitly named fields.
    # The generator remains compatible with older synthetic releases lacking
    # these optional columns; missing or incomplete samples never become zero.
    for args in (
        ("fact_activity_daily", "activity_date", "sessions", "启动会话次数（不是去重设备数）", "计数", 4),
        ("fact_activity_daily", "activity_date", "game_count", "已结束游戏局数", "局", 5),
        ("fact_activity_daily", "activity_date", "gameplay_seconds", "已结束游戏局的总时长（秒）", "秒", 6),
        ("fact_acquisition_daily", "cohort_date", "unique_install_events", "去重安装事件数（包含重装）", "安装事件", 7),
        ("fact_acquisition_daily", "cohort_date", "reinstall_events", "重装安装事件数（安装事件的子集）", "安装事件", 8),
        ("fact_acquisition_daily", "cohort_date", "late_install_events", "晚到安装事件数（安装事件的子集）", "安装事件", 9),
    ):
        make_daily(*args, optional=True)
    cases.append({"id": "clarification-1", "question": "帮我看一下收入。",
                  "oracle": {"kind": "clarification", "expected": "需要询问产品、时间及收入来源等缺失范围，不应擅自查询或编造默认条件"}})
    return {"schema": "synthetic-eval-cases-v1", "dataset_version": release["dataset_version"],
            "as_of": date_upper, "seed": seed, "cases": cases}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seed", type=int, required=True)
    args = parser.parse_args()
    data = generate(args.dataset, args.seed)
    manifest = args.dataset / "manifest.json"
    if manifest.is_file():
        data["manifest_sha256"] = hashlib.sha256(manifest.read_bytes()).hexdigest()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)
    print(json.dumps({"dataset_version": data["dataset_version"], "questions": len(data["cases"]), "output": str(args.output)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
