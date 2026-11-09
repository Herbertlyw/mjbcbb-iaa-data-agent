"""Independent structural and conservation checks over generated JSONL files."""

from collections import defaultdict
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
import hashlib
import json
from pathlib import Path
import re

from .catalog import schema

FOREIGN_KEYS = [
    ("dim_campaign", "app_id", "dim_app", "app_id"),
    ("dim_campaign", "account_id", "dim_ad_account", "account_id"),
    ("dim_ad_group", "campaign_id", "dim_campaign", "campaign_id"),
    ("dim_ad", "campaign_id", "dim_campaign", "campaign_id"),
    ("dim_ad", "ad_group_id", "dim_ad_group", "ad_group_id"),
    ("dim_ad", "primary_creative_id", "dim_creative", "creative_id"),
    ("dim_creative", "app_id", "dim_app", "app_id"),
    ("dim_experiment_arm", "app_id", "dim_app", "app_id"),
]


def load_manifest(directory):
    directory = Path(directory)
    manifest = json.loads((directory / "manifest.json").read_text())
    names = {m["asset"] for m in schema()}
    if set(manifest.get("tables", {})) != names or not re.fullmatch(
        r"sv_[a-f0-9]{20}", str(manifest.get("dataset_version", ""))
    ):
        raise ValueError("dataset_manifest_invalid")
    for name, info in manifest["tables"].items():
        file = directory / (name + ".jsonl")
        if (
            file.is_symlink()
            or not file.is_file()
            or file.resolve().parent != directory.resolve()
        ):
            raise ValueError("dataset_file_outside_release")
        if any(
            not isinstance(info.get(key), int)
            or isinstance(info[key], bool)
            or not 0 <= info[key] <= 5_000_000
            for key in ("rows", "expected_rows")
        ):
            raise ValueError("dataset_row_count_invalid")
        if not re.fullmatch(r"[a-f0-9]{64}", str(info.get("sha256", ""))):
            raise ValueError("dataset_hash_invalid")
    return manifest


def read_dataset(directory):
    directory = Path(directory)
    manifest = load_manifest(directory)
    tables = {}
    for name in manifest["tables"]:
        with (directory / (name + ".jsonl")).open() as stream:
            tables[name] = [json.loads(line) for line in stream]
    return manifest, tables


def dec(value):
    return Decimal(str(value)) if value is not None else None


def summed(rows, column):
    return sum(
        (dec(row[column]) for row in rows if row[column] is not None), Decimal(0)
    )


def reconcile(directory, report_path=None):
    directory = Path(directory)
    manifest, tables = read_dataset(directory)
    gold = json.loads((directory / "private-gold.json").read_text())
    checks = []

    def check(name, passed, **evidence):
        checks.append(dict(check=name, passed=bool(passed), **evidence))

    specs = {m["asset"]: m for m in schema()}
    for table, rows in tables.items():
        spec = specs[table]
        keys = ["dataset_version"] + spec["dimensions"]
        primary = [tuple(row[k] for k in keys) for row in rows]
        check(
            "grain." + table,
            len(set(primary)) == len(rows),
            rows=len(rows),
            unique_keys=len(set(primary)),
        )
        check(
            "version." + table,
            all(row["dataset_version"] == manifest["dataset_version"] for row in rows),
        )
        check(
            "row_count." + table,
            len(rows) == manifest["tables"][table]["expected_rows"],
        )
        check(
            "file_hash." + table,
            hashlib.sha256((directory / (table + ".jsonl")).read_bytes()).hexdigest()
            == manifest["tables"][table]["sha256"],
        )
        check(
            "schema." + table,
            all(set(row) == set(spec["declared_column_names"]) for row in rows),
        )
        check(
            "nonnull." + table,
            all(
                row[c["name"]] is not None
                for row in rows
                for c in spec["columns"]
                if not c["nullable"]
            ),
        )
        for column in spec["measures"]:
            check(
                "null_state." + table + "." + column,
                all(
                    row[column] is not None
                    or row.get("completeness_state") == "partial"
                    or table == "fact_roi_forecast_evaluation"
                    and (
                        row["maturity_state"] == "immature"
                        or row["input_revision_state"] == "input_revised"
                        and column in {"roi_error_pp", "cost_weight_usd"}
                    )
                    or table == "fact_gameplay_daily"
                    and column == "games_won"
                    and row["eligible_win_games"] == 0
                    or table == "fact_gameplay_daily"
                    and column == "total_score"
                    and row["score_unit"] == "not_applicable"
                    for row in rows
                ),
            )
    foreign = list(FOREIGN_KEYS)
    for table, spec in specs.items():
        if table.startswith("dim_"):
            continue
        for key, dimension in [
            ("app_id", "dim_app"),
            ("ua_channel_id", "dim_ua_channel"),
            ("account_id", "dim_ad_account"),
            ("campaign_id", "dim_campaign"),
            ("ad_group_id", "dim_ad_group"),
            ("ad_id", "dim_ad"),
            ("creative_id", "dim_creative"),
        ]:
            if key in spec["declared_column_names"]:
                foreign.append((table, key, dimension, key))
        for key in (
            "acquisition_country_code",
            "activity_country_code",
            "entry_country_code",
        ):
            if key in spec["declared_column_names"]:
                foreign.append((table, key, "dim_country", "country_code"))
    for fact, key, dim, target in foreign:
        allowed = {r[target] for r in tables[dim]}
        check(
            "fk." + fact + "." + key,
            all(row[key] is None or row[key] in allowed for row in tables[fact]),
        )
    check(
        "oracle.cost",
        summed(tables["fact_delivery_daily"], "discounted_cost_usd")
        == dec(gold["totals"]["discounted_cost_usd"]),
    )
    check(
        "oracle.install_events",
        summed(tables["fact_acquisition_daily"], "unique_install_events")
        == dec(gold["totals"]["install_events_visible"]),
    )
    check(
        "oracle.active_device_days",
        summed(tables["fact_activity_daily"], "active_devices")
        == dec(gold["totals"]["active_device_days"]),
    )
    check(
        "oracle.games",
        summed(tables["fact_gameplay_daily"], "games_finished")
        == dec(gold["totals"]["game_count"]),
    )
    expected_revenue = dec(gold["totals"]["sdk_revenue_usd"])
    revenue_projections = {
        "funnel": summed(tables["fact_ad_funnel_daily"], "revenue_usd"),
        "activity": summed(tables["fact_activity_daily"], "ad_revenue_usd"),
        "cohort": summed(tables["fact_cohort_quality_daily"], "ad_revenue_usd"),
        "sdk_receipt": summed(
            [
                r
                for r in tables["fact_cohort_revenue_daily"]
                if r["revenue_source"] == "sdk"
            ],
            "revenue_usd",
        ),
    }
    for projection, value in revenue_projections.items():
        comparable = (
            dec(gold["totals"]["cohort30_revenue_usd"])
            if projection == "cohort"
            else expected_revenue
        )
        check(
            "revenue_conservation." + projection,
            value == comparable,
            actual=str(value),
            expected=str(comparable),
        )
    check(
        "revenue_conservation.cohort30_sdk",
        revenue_projections["cohort"]
        == summed(
            [
                r
                for r in tables["fact_cohort_revenue_daily"]
                if r["revenue_source"] == "sdk" and r["age_days"] <= 30
            ],
            "revenue_usd",
        ),
    )
    rates = {
        (r["rate_date"], r["source_currency"]): dec(r["source_currency_per_usd"])
        for r in tables["fact_fx_rate_daily"]
    }
    check("fx.positive", all(value > 0 for value in rates.values()))
    for raw, usd in [
        ("raw_cost_local", "raw_cost_usd"),
        ("discounted_cost_local", "discounted_cost_usd"),
    ]:
        check(
            "fx." + usd,
            all(
                r[raw] is not None
                and r[usd] is not None
                and dec(r[raw]) / rates[(r["fx_rate_date"], r["source_currency"])]
                == dec(r[usd])
                for r in tables["fact_delivery_daily"]
            ),
        )
    ad_to_creative = {r["ad_id"]: r["primary_creative_id"] for r in tables["dim_ad"]}
    group_to_campaign = {
        r["ad_group_id"]: r["campaign_id"] for r in tables["dim_ad_group"]
    }
    check(
        "hierarchy.ad_creative",
        all(
            r["ad_id"] is None or ad_to_creative[r["ad_id"]] == r["creative_id"]
            for r in tables["fact_delivery_daily"]
        ),
    )
    check(
        "hierarchy.group_campaign",
        all(
            r["ad_group_id"] is None
            or group_to_campaign[r["ad_group_id"]] == r["campaign_id"]
            for r in tables["fact_delivery_daily"]
        ),
    )
    check(
        "cohort.age",
        all(
            (
                date.fromisoformat(r["observe_date"])
                - date.fromisoformat(r["install_cohort_date"])
            ).days
            == r["age_days"]
            for r in tables["fact_cohort_quality_daily"]
        ),
    )
    check(
        "cohort.bounded",
        all(
            0 <= r["retained_devices"] <= r["cohort_size_devices"]
            for r in tables["fact_cohort_quality_daily"]
        ),
    )
    d0 = sum(
        r["cohort_size_devices"]
        for r in tables["fact_cohort_quality_daily"]
        if r["age_days"] == 0
    )
    check(
        "cohort.first_devices",
        d0 == gold["private_devices"],
        cohort_d0_base=d0,
        private_devices=gold["private_devices"],
    )
    check(
        "activity.window_bounds",
        all(
            0
            <= r["new_active_devices"]
            <= r["active_devices"]
            <= r["active_devices_7d"]
            <= r["active_devices_30d"]
            for r in tables["fact_activity_daily"]
        ),
    )
    check(
        "activity.partition",
        all(
            r["new_active_devices"] + r["returning_active_devices"]
            == r["active_devices"]
            for r in tables["fact_activity_daily"]
        ),
    )
    for sample in gold["window_oracles"]:
        actual = sum(
            row["active_devices_" + str(sample["window_days"]) + "d"]
            for row in tables["fact_activity_daily"]
            if row["app_id"] == sample["app_id"]
            and row["activity_date"] == manifest["as_of"]
        )
        check(
            "activity.window_oracle."
            + sample["app_id"]
            + "."
            + str(sample["window_days"]),
            actual == sample["devices"],
        )
    check(
        "acquisition.subsets",
        all(
            r["unique_install_events"]
            == r["first_install_devices"] + r["reinstall_events"]
            and r["late_install_events"] <= r["unique_install_events"]
            and r["unattributed_install_events"] <= r["unique_install_events"]
            for r in tables["fact_acquisition_daily"]
        ),
    )
    check(
        "gameplay.bounded",
        all(
            r["games_finished"] <= r["games_started"]
            and (r["games_won"] is None or r["games_won"] <= r["eligible_win_games"])
            and r["successful_revives"] <= r["revive_clicks"] <= r["revive_prompts"]
            for r in tables["fact_gameplay_daily"]
        ),
    )
    check(
        "funnel.bounded",
        all(
            r["successful_load_attempts"]
            <= r["completed_load_attempts"]
            <= r["load_attempts"]
            and r["ready_actions"] <= r["show_actions"]
            and r["successful_show_requests"] <= r["completed_show_requests"]
            for r in tables["fact_ad_funnel_daily"]
        ),
    )
    exp_config = {
        (r["experiment_id"], r["arm_id"], r["config_version"]): r
        for r in tables["dim_experiment_arm"]
    }
    check(
        "experiment.config_fk",
        all(
            (r["experiment_id"], r["arm_id"], r["config_version"]) in exp_config
            for r in tables["fact_experiment_cohort_daily"]
        ),
    )
    check(
        "experiment.anchor",
        all(
            r["anchor_type"]
            == exp_config[(r["experiment_id"], r["arm_id"], r["config_version"])][
                "anchor_type"
            ]
            and r["age_days"]
            == (
                date.fromisoformat(r["observe_date"])
                - date.fromisoformat(r["entry_cohort_date"])
            ).days
            for r in tables["fact_experiment_cohort_daily"]
        ),
    )
    check(
        "experiment.bounds",
        all(
            0 <= r["active_units"] <= r["observed_units"] <= r["enrolled_units"]
            for r in tables["fact_experiment_cohort_daily"]
        ),
    )
    allocations = defaultdict(Decimal)
    for row in tables["dim_experiment_arm"]:
        allocations[(row["experiment_id"], row["config_version"])] += dec(
            row["allocation_fraction"]
        )
    check("experiment.allocation", all(value == 1 for value in allocations.values()))
    check(
        "experiment.product_population",
        sum(
            row["enrolled_units"]
            for row in tables["fact_experiment_cohort_daily"]
            if row["age_days"] == 0 and row["anchor_type"] == "first_open"
        )
        == gold["private_devices"],
    )
    check(
        "experiment.monetization_population",
        sum(
            row["enrolled_units"]
            for row in tables["fact_experiment_cohort_daily"]
            if row["age_days"] == 0 and row["anchor_type"] == "first_ad_show"
        )
        <= gold["private_devices"],
    )
    prediction = {r["prediction_id"]: r for r in tables["fact_roi_forecast_snapshot"]}
    scope_columns = (
        "cohort_date",
        "app_id",
        "acquisition_country_code",
        "ua_channel_id",
        "campaign_id",
    )
    revenue_by_scope = defaultdict(lambda: defaultdict(Decimal))
    for row in tables["fact_cohort_revenue_daily"]:
        if row["revenue_source"] == "sdk":
            revenue_by_scope[tuple(row[key] for key in scope_columns)][
                row["age_days"]
            ] += dec(row["revenue_usd"])
    forecast_values_match = True
    mature_values_match = True
    for row in prediction.values():
        ages = revenue_by_scope[tuple(row[key] for key in scope_columns)]
        visible = sum(
            (value for age, value in ages.items() if age < row["observed_age_days"]),
            Decimal(0),
        )
        observed, horizon = row["observed_age_days"], row["horizon_days"]
        factor = (
            Decimal(horizon) / observed
            if row["model_version"] == "baseline_linear_v1"
            else Decimal(1) + Decimal(horizon - observed) / (observed + 30)
        )
        forecast_values_match &= (visible * factor).quantize(
            Decimal(".000001"), rounding=ROUND_HALF_UP
        ) == dec(row["predicted_revenue_usd"])
    for row in tables["fact_roi_forecast_evaluation"]:
        if row["maturity_state"] == "mature":
            ages = revenue_by_scope[tuple(row[key] for key in scope_columns)]
            actual = sum(
                (value for age, value in ages.items() if age < row["horizon_days"]),
                Decimal(0),
            )
            mature_values_match &= actual == dec(row["actual_revenue_usd"])
    check("prediction.only_pre_cutoff_inputs", forecast_values_match)
    check("prediction.mature_revenue", mature_values_match)
    check(
        "prediction.ids", len(prediction) == len(tables["fact_roi_forecast_snapshot"])
    )
    check(
        "prediction.cutoff",
        all(
            r["input_cutoff"].startswith(r["snapshot_date"])
            and r["observed_age_days"]
            == (
                date.fromisoformat(r["snapshot_date"])
                - date.fromisoformat(r["cohort_date"])
            ).days
            and r["horizon_days"] > r["observed_age_days"]
            for r in prediction.values()
        ),
    )
    copied = [
        "snapshot_date",
        "cohort_date",
        "app_id",
        "acquisition_country_code",
        "ua_channel_id",
        "campaign_id",
        "horizon_days",
        "model_version",
        "revenue_source",
        "predicted_roi_pct",
    ]
    check(
        "prediction.evaluation_fk",
        all(
            r["prediction_id"] in prediction
            and all(r[k] == prediction[r["prediction_id"]][k] for k in copied)
            for r in tables["fact_roi_forecast_evaluation"]
        ),
    )
    check(
        "prediction.immature_null",
        all(
            r["actual_revenue_usd"] is None
            and r["actual_roi_pct"] is None
            and r["roi_error_pp"] is None
            for r in tables["fact_roi_forecast_evaluation"]
            if r["maturity_state"] == "immature"
        ),
    )
    check(
        "prediction.error",
        all(
            dec(r["actual_roi_pct"]) - dec(r["predicted_roi_pct"])
            == dec(r["roi_error_pp"])
            for r in tables["fact_roi_forecast_evaluation"]
            if r["maturity_state"] == "mature"
            and r["input_revision_state"] == "unchanged"
        ),
    )
    check(
        "prediction.revised_not_model_error",
        all(
            r["roi_error_pp"] is None and r["cost_weight_usd"] is None
            for r in tables["fact_roi_forecast_evaluation"]
            if r["input_revision_state"] == "input_revised"
        ),
    )
    check(
        "creative.graduation",
        all(
            r["is_graduated"] is None if not r["is_observable"] else r["is_tested"] == 1
            for r in tables["fact_creative_test_snapshot"]
        ),
    )
    failed = [c["check"] for c in checks if not c["passed"]]
    report = dict(
        status="passed" if not failed else "failed",
        dataset_version=manifest["dataset_version"],
        checks=len(checks),
        failed=failed,
        results=checks,
        verification="Python offline structure and cross-projection reconciliation; not database execution",
    )
    if report_path:
        Path(report_path).write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n"
        )
    return report
