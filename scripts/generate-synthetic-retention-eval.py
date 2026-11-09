"""Build one retention question from public synthetic rows, without hidden generator inputs."""
import argparse
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP
import hashlib
import json
from pathlib import Path
import random

KEYS = ("dataset_version", "acquisition_country_code", "ua_channel_id", "campaign_id", "ad_group_id", "ad_id", "creative_id")


def generate(dataset, seed):
    manifest_bytes = (dataset / "manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    app_rows = list(map(json.loads, (dataset / "dim_app.jsonl").read_text().splitlines()))
    apps = {r["app_id"]: r for r in app_rows}
    if len(apps) != len(app_rows) or any(row.get("dataset_version") != manifest["dataset_version"] for row in app_rows):
        raise ValueError("synthetic_dimension_version_or_key_invalid")
    grouped = defaultdict(lambda: defaultdict(dict))
    invalid = set()
    for row in map(json.loads, (dataset / "fact_cohort_quality_daily.jsonl").read_text().splitlines()):
        age = row.get("age_days")
        if age not in (1, 7) or row.get("app_id") not in apps:
            continue
        identity = (row["app_id"], row["install_cohort_date"])
        key = tuple(row.get(name) for name in KEYS)
        expected = date.fromisoformat(identity[1]) + timedelta(days=age)
        if (type(age) is not int or any(name not in row for name in KEYS) or row.get("dataset_version") != manifest["dataset_version"] or row.get("observe_date") != expected.isoformat()
            or row.get("completeness_state") != "complete" or row.get("maturity_state") != "observed"
            or row.get("cohort_size_devices") is None or row.get("retained_devices") is None
            or type(row["cohort_size_devices"]) is not int or type(row["retained_devices"]) is not int
            or not 0 <= row["retained_devices"] <= row["cohort_size_devices"] or key in grouped[identity][age]):
            invalid.add(identity)
        grouped[identity][age][key] = row
    candidates = []
    for identity, ages in grouped.items():
        if identity in invalid or set(ages) != {1, 7} or set(ages[1]) != set(ages[7]):
            continue
        if date.fromisoformat(identity[1]) + timedelta(days=7) >= date.fromisoformat(manifest["as_of"]):
            continue
        if any(ages[1][k]["cohort_size_devices"] != ages[7][k]["cohort_size_devices"] for k in ages[1]):
            continue
        base = sum(row["cohort_size_devices"] for row in ages[1].values())
        if base <= 0:
            continue
        retained = {age: sum(row["retained_devices"] for row in ages[age].values()) for age in (1, 7)}
        candidates.append((identity, len(ages[1]), base, retained))
    if not candidates:
        raise ValueError("no_complete_mature_retention_cohort")
    (app_id, day), groups, base, retained = random.Random(seed).choice(sorted(candidates))
    app = apps[app_id]
    percent = lambda age: format((Decimal(retained[age]) * 100 / Decimal(base)).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP), "f")
    return {"schema": "synthetic-eval-cases-v1", "dataset_version": manifest["dataset_version"], "as_of": manifest["as_of"], "seed": seed,
            "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(), "cases": [{"id": "cohort-retention-1",
            "question": f"请计算 {app['game_name']} {app['game_id']} {app['platform']} 在 {day}（UTC）首次安装设备队列的次日及第七日留存率，分别列出留存设备、队列设备基数、百分比和数据来源。",
            "oracle": {"kind": "cohort_retention", "app_id": app_id, "date": day, "cohort_size": base, "groups": groups,
                       "retained_day1": retained[1], "retained_day7": retained[7], "rate_day1_percent": percent(1), "rate_day7_percent": percent(7),
                       "unit": "%", "source": "synthetic JSONL; matched full cohort grain; Decimal ratios"}}]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seed", type=int, required=True)
    args = parser.parse_args()
    result = generate(args.dataset, args.seed)
    with args.output.open("x", encoding="utf8") as out:
        json.dump(result, out, ensure_ascii=False, indent=2)
    print(json.dumps({"dataset_version": result["dataset_version"], "questions": len(result["cases"])}))
