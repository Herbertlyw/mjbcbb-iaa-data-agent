"""Recompute local oracle values and compare them with isolated ClickHouse.

Output is an evaluator artifact; never include it in a model prompt.
"""
import argparse
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP, localcontext
import hashlib
import json
from pathlib import Path
import re

from synthetic.starhaven.load import LocalHttp

ALLOWED = {
    "fact_activity_daily": ("activity_date", {"active_devices", "ad_revenue_usd", "sessions", "game_count", "gameplay_seconds"}),
    "fact_acquisition_daily": ("cohort_date", {"first_install_devices", "unique_install_events", "reinstall_events", "late_install_events"}),
}


def check(dataset, cases, reader):
    manifest = (dataset / "manifest.json").read_bytes()
    metadata = json.loads(manifest)
    if cases.get("schema") != "synthetic-eval-cases-v1" or cases.get("dataset_version") != metadata.get("dataset_version") or cases.get("manifest_sha256") != hashlib.sha256(manifest).hexdigest():
        raise ValueError("dataset_fingerprint_mismatch")
    needed = {"dim_app"}
    for case in cases["cases"]:
        oracle = case["oracle"]
        if oracle.get("kind") == "cohort_retention":
            needed.add("fact_cohort_quality_daily")
        elif oracle.get("kind") in {"dimension_cost_group", "channel_cpi"}:
            needed.add("fact_delivery_daily")
        elif oracle.get("kind") in {"daily_sum", "daily_comparison"}:
            needed.add(oracle.get("table"))
    if any(table not in {"dim_app", "fact_delivery_daily", "fact_cohort_quality_daily", *ALLOWED} for table in needed):
        raise ValueError("unsupported_oracle_scope")
    for table in needed:
        descriptor = metadata.get("tables", {}).get(table, {})
        source = (dataset / f"{table}.jsonl").read_bytes()
        if descriptor.get("sha256") != hashlib.sha256(source).hexdigest() or descriptor.get("bytes") != len(source):
            raise ValueError("dataset_file_fingerprint_mismatch")
    if not re.fullmatch(r"starhaven_preflight_[a-f0-9]{10}", reader.get("database", "")) or reader.get("username") != reader["database"] + "_reader":
        raise ValueError("isolated_synthetic_reader_required")
    client = LocalHttp(reader["url"], reader["username"], reader["password"])
    checks = []
    for case in cases["cases"]:
        oracle = case["oracle"]
        if oracle["kind"] == "clarification":
            continue
        if oracle["kind"] == "cohort_retention":
            day, app = oracle["date"], oracle["app_id"]
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day) or not re.fullmatch(r"[a-z0-9_]{1,64}", app):
                raise ValueError("invalid_oracle_scope")
            first = date.fromisoformat(day)
            if first + timedelta(days=7) >= date.fromisoformat(metadata["as_of"]):
                raise ValueError("oracle_cohort_immature")
            keys = ("dataset_version", "acquisition_country_code", "ua_channel_id", "campaign_id", "ad_group_id", "ad_id", "creative_id")
            selected = defaultdict(dict)
            with (dataset / "fact_cohort_quality_daily.jsonl").open(encoding="utf-8") as file:
                for line in file:
                    row = json.loads(line)
                    if row["app_id"] != app or row["install_cohort_date"] != day or row.get("age_days") not in (1, 7):
                        continue
                    age = row["age_days"]
                    key = tuple(row.get(name) for name in keys)
                    if (type(age) is not int or any(name not in row for name in keys) or key in selected[age] or row.get("dataset_version") != metadata["dataset_version"] or
                        row.get("observe_date") != (first + timedelta(days=age)).isoformat() or
                        row.get("completeness_state") != "complete" or row.get("maturity_state") != "observed" or
                        type(row.get("cohort_size_devices")) is not int or type(row.get("retained_devices")) is not int or
                        not 0 <= row["retained_devices"] <= row["cohort_size_devices"]):
                        raise ValueError("oracle_missing_or_incomplete")
                    selected[age][key] = row
            if set(selected) != {1, 7} or not selected[1] or set(selected[1]) != set(selected[7]) or any(selected[1][key]["cohort_size_devices"] != selected[7][key]["cohort_size_devices"] for key in selected[1]):
                raise ValueError("oracle_cohort_mismatch")
            base = sum(row["cohort_size_devices"] for row in selected[1].values())
            retained = {age: sum(row["retained_devices"] for row in selected[age].values()) for age in (1, 7)}
            if base <= 0 or oracle["cohort_size"] != base or oracle["groups"] != len(selected[1]) or any(oracle[f"retained_day{age}"] != retained[age] or Decimal(oracle[f"rate_day{age}_percent"]) != (Decimal(retained[age]) * 100 / Decimal(base)).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP) for age in (1, 7)):
                raise ValueError("oracle_value_mismatch")
            columns = ",".join(keys)
            sql = (f"SELECT age_days,{columns},observe_date,toString(cohort_size_devices) AS cohort_size_devices,"
                   "toString(retained_devices) AS retained_devices,completeness_state,maturity_state FROM fact_cohort_quality_daily "
                   f"WHERE install_cohort_date=toDate('{day}') AND app_id='{app}' AND age_days IN (1,7) FORMAT JSONEachRow")
            actual = [json.loads(line) for line in client.request(sql, database=reader["database"]).splitlines()]
            expected = []
            for age in (1, 7):
                for row in selected[age].values():
                    expected.append({"age_days": age, **{key: row.get(key) for key in keys}, "observe_date": row["observe_date"],
                                     "cohort_size_devices": str(row["cohort_size_devices"]), "retained_devices": str(row["retained_devices"]),
                                     "completeness_state": row["completeness_state"], "maturity_state": row["maturity_state"]})
            canonical = lambda values: sorted(json.dumps(row, ensure_ascii=False, sort_keys=True) for row in values)
            if canonical(actual) != canonical(expected):
                raise ValueError("isolated_database_mismatch")
            checks.append({"id": case["id"], "date": day, "sql": sql, "cohort_size": base, "retained": retained, "matched": True})
            continue
        if oracle["kind"] == "channel_cpi":
            day, app = oracle["date"], oracle["app_id"]
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day) or not re.fullmatch(r"[a-z0-9_]{1,64}", app):
                raise ValueError("invalid_oracle_scope")
            with (dataset / "fact_delivery_daily.jsonl").open(encoding="utf-8") as file:
                facts = [json.loads(line) for line in file if line.strip()]
            groups = defaultdict(list)
            for row in facts:
                if row["business_date"] == day and row["app_id"] == app:
                    if row.get("ua_channel_id") is None or row.get("discounted_cost_usd") is None or row.get("af_registers") is None or row.get("completeness_state") != "complete":
                        raise ValueError("oracle_missing_or_incomplete")
                    groups[row["ua_channel_id"]].append(row)
            expected = []
            for channel, bucket in sorted(groups.items()):
                cost = sum((Decimal(str(row["discounted_cost_usd"])) for row in bucket), Decimal(0))
                count = sum(int(row["af_registers"]) for row in bucket)
                with localcontext() as ctx:
                    ctx.prec = 76
                    cpi = None if count == 0 else format((cost / count).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP), "f")
                expected.append({"ua_channel_id": channel, "discounted_cost_usd": format(cost, "f"), "af_registers": count, "cpi_usd_per_register": cpi, "rows": len(bucket)})
            if not expected or expected != oracle["groups"]:
                raise ValueError("oracle_value_mismatch")
            sql = ("SELECT ua_channel_id,toString(sum(discounted_cost_usd)),toString(sum(af_registers)),count(),"
                   "countIf(discounted_cost_usd IS NULL OR af_registers IS NULL) FROM fact_delivery_daily "
                   f"WHERE business_date=toDate('{day}') AND app_id='{app}' GROUP BY ua_channel_id ORDER BY ua_channel_id")
            actual = [line.split("\t") for line in client.request(sql, database=reader["database"]).splitlines()]
            if len(actual) != len(expected) or any(len(row) != 5 or row[0] != item["ua_channel_id"] or Decimal(row[1]) != Decimal(item["discounted_cost_usd"]) or int(row[2]) != item["af_registers"] or int(row[3]) != item["rows"] or int(row[4]) != 0 for row, item in zip(actual, expected)):
                raise ValueError("isolated_database_mismatch")
            checks.append({"id": case["id"], "date": day, "sql": sql, "groups": expected, "matched": True})
            continue
        if oracle["kind"] == "dimension_cost_group":
            day = oracle["date"]
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
                raise ValueError("invalid_oracle_date")
            with (dataset / "dim_app.jsonl").open(encoding="utf-8") as file:
                dimensions = [json.loads(line) for line in file if line.strip()]
            lookup = {(row["dataset_version"], row["app_id"]): row for row in dimensions}
            if len(lookup) != len(dimensions):
                raise ValueError("dimension_key_ambiguous")
            with (dataset / "fact_delivery_daily.jsonl").open(encoding="utf-8") as file:
                facts = [json.loads(line) for line in file if line.strip()]
            groups = defaultdict(list)
            for row in facts:
                if row["business_date"] == day:
                    if (row["dataset_version"], row["app_id"]) not in lookup or row.get("discounted_cost_usd") is None or row.get("completeness_state") != "complete":
                        raise ValueError("oracle_missing_or_incomplete")
                    groups[row["app_id"]].append(row)
            expected = []
            for app, bucket in sorted(groups.items()):
                dimension = lookup[(bucket[0]["dataset_version"], app)]
                expected.append({"app_id": app, "game_name": dimension["game_name"], "platform": dimension["platform"],
                                 "discounted_cost_usd": format(sum((Decimal(str(row["discounted_cost_usd"])) for row in bucket), Decimal(0)), "f"), "rows": len(bucket)})
            if not expected or expected != oracle["groups"]:
                raise ValueError("oracle_value_mismatch")
            sql = ("SELECT f.app_id,d.game_name,d.platform,toString(sum(f.discounted_cost_usd)),count(),countIf(f.discounted_cost_usd IS NULL) "
                   "FROM fact_delivery_daily f INNER JOIN dim_app d ON f.dataset_version=d.dataset_version AND f.app_id=d.app_id "
                   f"WHERE f.business_date=toDate('{day}') GROUP BY f.app_id,d.game_name,d.platform ORDER BY f.app_id")
            actual = [line.split("\t") for line in client.request(sql, database=reader["database"]).splitlines()]
            if len(actual) != len(expected) or any(len(row) != 6 or row[:3] != [item["app_id"], item["game_name"], item["platform"]] or Decimal(row[3]) != Decimal(item["discounted_cost_usd"]) or int(row[4]) != item["rows"] or int(row[5]) != 0 for row, item in zip(actual, expected)):
                raise ValueError("isolated_database_mismatch")
            checks.append({"id": case["id"], "date": day, "sql": sql, "groups": expected, "matched": True})
            continue
        table, column, app = oracle["table"], oracle["column"], oracle["app_id"]
        if table not in ALLOWED or column not in ALLOWED[table][1] or not re.fullmatch(r"[a-z0-9_]{1,64}", app):
            raise ValueError("unsupported_oracle_scope")
        date_column = ALLOWED[table][0]
        points = ([(oracle["date"], oracle["value"])] if oracle["kind"] == "daily_sum" else
                  [(oracle["first_date"], oracle["first_value"]), (oracle["second_date"], oracle["second_value"])] if oracle["kind"] == "daily_comparison" else None)
        if points is None:
            raise ValueError("unsupported_oracle_kind")
        with (dataset / f"{table}.jsonl").open(encoding="utf-8") as file:
            records = [json.loads(line) for line in file if line.strip()]
        for day, expected in points:
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
                raise ValueError("invalid_oracle_date")
            rows = [row for row in records if row.get("app_id") == app and row.get(date_column) == day]
            if not rows or any(row.get(column) is None or row.get("completeness_state") != "complete" for row in rows):
                raise ValueError("oracle_missing_or_incomplete")
            independent = sum((Decimal(str(row[column])) for row in rows), Decimal(0))
            if independent != Decimal(expected):
                raise ValueError("oracle_value_mismatch")
            sql = f"SELECT toString(sum({column})), count(), countIf({column} IS NULL) FROM {table} WHERE app_id = '{app}' AND {date_column} = toDate('{day}')"
            actual = client.request(sql, database=reader["database"]).strip().split("\t")
            if len(actual) != 3 or Decimal(actual[0]) != independent or int(actual[1]) != len(rows) or int(actual[2]) != 0:
                raise ValueError("isolated_database_mismatch")
            checks.append({"id": case["id"], "date": day, "sql": sql, "value": actual[0], "rows": len(rows), "nulls": 0, "matched": True})
        if oracle["kind"] == "daily_comparison" and Decimal(oracle["difference_second_minus_first"]) != Decimal(oracle["second_value"]) - Decimal(oracle["first_value"]):
            raise ValueError("oracle_difference_mismatch")
    return {"schema": "synthetic-eval-check-v1", "dataset_version": metadata["dataset_version"], "checks": checks}


def main():
    parser = argparse.ArgumentParser()
    for name in ("dataset", "cases", "reader-file", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    case_bytes = args.cases.read_bytes()
    result = check(args.dataset, json.loads(case_bytes), json.loads(args.reader_file.read_text(encoding="utf-8")))
    result["cases_sha256"] = hashlib.sha256(case_bytes).hexdigest()
    with args.output.open("x", encoding="utf-8") as file:
        json.dump(result, file, ensure_ascii=False, indent=2)
    print(json.dumps({"status": "passed", "checked_points": len(result["checks"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
