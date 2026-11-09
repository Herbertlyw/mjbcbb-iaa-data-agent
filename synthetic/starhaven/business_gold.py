"""Offline, Decimal-based business oracles; never registered as model knowledge."""

from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP, localcontext
import hashlib
import json
from pathlib import Path

from .business import business_catalog
from .reconcile import read_dataset, reconcile


def exact_sum(rows, column):
    """Return unknown for absent or NULL inputs, preserving observed zero."""
    if not rows or any(row.get(column) is None for row in rows):
        return None
    return sum((Decimal(str(row[column])) for row in rows), Decimal(0))


def rendered(value):
    return None if value is None else format(value, "f")


def ratio(numerator, denominator, factor=1):
    if numerator is None or denominator is None or denominator == 0:
        return None
    with localcontext() as context:
        context.prec = 76
        return format(
            (numerator / denominator * factor).quantize(
                Decimal("0.000001"), rounding=ROUND_HALF_UP
            ),
            "f",
        )


def query_rows(tables, query):
    """Evaluate declared filters and reductions in Python, independently of SQL."""
    rows = [
        row
        for row in tables[query["table"]]
        if all(row.get(key) == value for key, value in query["equals"].items())
        and (
            not query["date_column"]
            or query["start"] <= row[query["date_column"]] <= query["end"]
        )
    ]
    if query.get("join_dimension"):
        dimensions = {
            (row["dataset_version"], row["app_id"]): row
            for row in tables[query["join_dimension"]]
        }
        rows = [
            {
                **row,
                "game_name": dimensions[row["dataset_version"], row["app_id"]][
                    "game_name"
                ],
            }
            for row in rows
            if (row["dataset_version"], row["app_id"]) in dimensions
        ]
    if query["columns"]:
        result = [{key: row[key] for key in query["columns"]} for row in rows]
        result.sort(key=lambda row: json.dumps(list(row.values()), ensure_ascii=False))
    else:
        buckets = defaultdict(list)
        for row in rows:
            buckets[tuple(row[key] for key in query["groups"])].append(row)
        if not query["groups"] and not rows:
            buckets[()] = []
        result = []
        for key, bucket in buckets.items():
            output = dict(zip(query["groups"], key))
            for field in query["sums"]:
                # Match ClickHouse SUM transport semantics. The business layer
                # separately inspects NULLs rather than accepting this zero.
                values = [
                    Decimal(str(row[field])) for row in bucket if row[field] is not None
                ]
                output["total_" + field] = rendered(sum(values, Decimal(0)))
                output["nonnull_" + field] = str(len(values))
            output["source_rows"] = str(len(bucket))
            result.append(output)
        result.sort(
            key=lambda row: json.dumps(
                [row[key] for key in query["groups"]], ensure_ascii=False
            )
        )
    return result, rows


def business_values(case, queries, raw, release):
    """Check denominators, cohort windows and missing sides before reporting math."""
    recipe = case["recipe"]
    queries = [
        [
            {
                (key[6:] if key.startswith("total_") else key): value
                for key, value in row.items()
            }
            for row in rows
        ]
        for rows in queries
    ]
    first = queries[0] if queries else []
    complete = all(
        row.get("completeness_state", "complete") == "complete"
        for rows in raw
        for row in rows
    )
    if recipe in {"installs", "app_join"}:
        return first
    if recipe in {
        "cpi",
        "plan_efficiency",
        "creative_efficiency",
        "arpdau",
        "ad_funnel",
    }:
        values = []
        for row in first:
            output = dict(row)

            def measure(name):
                if not complete or row.get("nonnull_" + name) != row["source_rows"]:
                    return None
                return Decimal(str(row[name]))

            if recipe in {"cpi", "plan_efficiency", "creative_efficiency"}:
                output["af_cpi_usd"] = ratio(
                    measure("discounted_cost_usd"), measure("af_registers")
                )
                output["af_cpi_unit"] = "USD/AF报表注册"
            if recipe == "plan_efficiency":
                output["ctr_pct"] = ratio(
                    measure("clicks"), measure("impressions"), 100
                )
            if recipe == "arpdau":
                output["arpdau_usd"] = ratio(
                    measure("ad_revenue_usd"), measure("active_devices")
                )
                output["active_unit"] = "当日设备×App"
            if recipe == "ad_funnel":
                output["ecpm_usd"] = ratio(
                    measure("revenue_usd"), measure("impressions"), 1000
                )
                output["load_success_pct"] = ratio(
                    measure("successful_load_attempts"),
                    measure("completed_load_attempts"),
                    100,
                )
                output["load_completion_pct"] = ratio(
                    measure("completed_load_attempts"), measure("load_attempts"), 100
                )
                output["show_success_pct"] = ratio(
                    measure("successful_show_requests"),
                    measure("completed_show_requests"),
                    100,
                )
            values.append(output)
        return values
    if recipe == "creative_states":
        grouped = defaultdict(list)
        for row in first:
            grouped[row["ua_channel_id"]].append(row)
        return [
            dict(
                ua_channel_id=channel,
                eligible=len(
                    {row["creative_id"] for row in rows if row["is_eligible"] == 1}
                ),
                tested=len(
                    {row["creative_id"] for row in rows if row["is_tested"] == 1}
                ),
                observable=len(
                    {row["creative_id"] for row in rows if row["is_observable"] == 1}
                ),
                graduated=len(
                    {
                        row["creative_id"]
                        for row in rows
                        if row["is_observable"] == 1 and row["is_graduated"] == 1
                    }
                ),
                unassigned=len(
                    {
                        row["creative_id"]
                        for row in rows
                        if row["test_scope_state"] == "unassigned"
                    }
                ),
                graduation_pct=ratio(
                    Decimal(
                        len(
                            {
                                row["creative_id"]
                                for row in rows
                                if row["is_observable"] == 1
                                and row["is_graduated"] == 1
                            }
                        )
                    ),
                    Decimal(
                        len(
                            {
                                row["creative_id"]
                                for row in rows
                                if row["is_observable"] == 1
                            }
                        )
                    ),
                    100,
                ),
            )
            for channel, rows in sorted(grouped.items(), key=lambda pair: str(pair[0]))
        ]
    if recipe == "source_gap":
        values = {
            row["revenue_source"]: Decimal(row["revenue_usd"])
            for row in first
            if row["source_rows"] == row["nonnull_revenue_usd"]
        }
        sdk, af = values.get("sdk"), values.get("af")
        if not complete:
            sdk, af = None, None
        return dict(
            sdk_usd=rendered(sdk),
            af_usd=rendered(af),
            sdk_minus_af_usd=(
                rendered(sdk - af) if sdk is not None and af is not None else None
            ),
            missing_source_is_zero=False,
        )
    if recipe == "active_anchor":
        anchor = date.fromisoformat(first[0]["activity_date"]) if first else None
        history = (
            (anchor - date.fromisoformat(release["start_date"])).days + 1
            if anchor
            else 0
        )
        return dict(
            dau=rendered(exact_sum(first, "active_devices")),
            active_7d=rendered(exact_sum(first, "active_devices_7d")),
            active_30d_observed=rendered(exact_sum(first, "active_devices_30d")),
            available_history_days=history,
            complete_30d_history=history >= 30,
        )
    if recipe == "retention":
        cohort = case["queries"][0]["equals"]["install_cohort_date"]
        target_age = (
            date.fromisoformat(case["queries"][0]["start"]) - date.fromisoformat(cohort)
        ).days
        valid = all(
            row["age_days"] == target_age and row["completeness_state"] == "complete"
            for row in first
        )
        base, retained = exact_sum(first, "cohort_size_devices"), exact_sum(
            first, "retained_devices"
        )
        return dict(
            cohort_date=cohort,
            age_days=target_age,
            retained=rendered(retained),
            base_once=rendered(base),
            rr_pct=ratio(retained, base, 100) if valid else None,
            definition="point_retention_not_cumulative",
        )
    if recipe == "ltv7":
        base_rows, window = raw
        grain = (
            "app_id",
            "acquisition_country_code",
            "ua_channel_id",
            "campaign_id",
            "ad_group_id",
            "ad_id",
            "creative_id",
        )
        key = lambda row: tuple(row[field] for field in grain)
        bases = {key(row): row for row in base_rows}
        buckets = defaultdict(list)
        for row in window:
            buckets[key(row)].append(row)
        valid = bool(bases) and set(bases) == set(buckets)
        for identity, rows in buckets.items():
            base = bases.get(identity)
            valid = (
                valid
                and base is not None
                and len(rows) == 7
                and {row["age_days"] for row in rows} == set(range(7))
            )
            valid = valid and all(
                row["cohort_size_devices"] == base["cohort_size_devices"]
                and row["completeness_state"] == "complete"
                for row in rows
            )
        count = exact_sum(base_rows, "cohort_size_devices")
        revenue = exact_sum(window, "ad_revenue_usd")
        return dict(
            base_once=rendered(count),
            sdk_revenue_usd=rendered(revenue),
            ltv7_usd_per_device=ratio(revenue, count) if valid else None,
            window_complete=bool(valid),
            unit="USD/首次安装设备×App",
            ages=list(range(7)),
        )
    if recipe == "roi":
        costs, recovery = queries
        left = {row["ua_channel_id"]: row for row in costs}
        right = {row["ua_channel_id"]: row for row in recovery}
        values = []
        for channel in sorted(set(left) | set(right)):
            cost_row, revenue_row = left.get(channel), right.get(channel)
            cost = (
                Decimal(cost_row["discounted_cost_usd"])
                if cost_row
                and cost_row["nonnull_discounted_cost_usd"] == cost_row["source_rows"]
                else None
            )
            revenue = (
                Decimal(revenue_row["revenue_usd"])
                if revenue_row
                and revenue_row["nonnull_revenue_usd"] == revenue_row["source_rows"]
                else None
            )
            values.append(
                dict(
                    ua_channel_id=channel,
                    cost_usd=rendered(cost),
                    sdk_revenue_usd=rendered(revenue),
                    roi_pct=ratio(revenue, cost, 100) if complete else None,
                    status=(
                        "partial_source"
                        if not complete
                        else (
                            "missing_side"
                            if not cost_row or not revenue_row
                            else "zero_denominator" if cost == 0 else "observed_window"
                        )
                    ),
                )
            )
        return values
    if recipe == "immature":
        cohort = case["queries"][0]["equals"]["install_cohort_date"]
        target = (date.fromisoformat(cohort) + timedelta(days=29)).isoformat()
        return dict(
            actual_roi30_pct=None,
            maturity="immature",
            target_end=target,
            observed_ages=sorted({row["age_days"] for row in first}),
            forecast_substituted=False,
        )
    if recipe == "clarification":
        return dict(expected="needs_clarification", business_queries=0)
    raise ValueError("business_recipe_unknown")


def evaluate_business(dataset):
    """Build offline expected rows and business values from reconciled JSONL."""
    if reconcile(dataset)["status"] != "passed":
        raise ValueError("business_dataset_reconciliation_failed")
    manifest, tables = read_dataset(dataset)
    catalog = business_catalog(
        manifest["dataset_version"], manifest["start_date"], manifest["as_of"]
    )
    cases = []
    for case in catalog["scenarios"]:
        expected, raw = [], []
        for query in case["queries"]:
            rows, inputs = query_rows(tables, query)
            if len(rows) > 10_000 or len(json.dumps(rows).encode()) > 2_000_000:
                raise ValueError(
                    "business_recipe_result_budget_exceeded: " + case["id"]
                )
            expected.append(rows)
            raw.append(inputs)
        cases.append(
            dict(
                id=case["id"],
                category=case["category"],
                recipe=case["recipe"],
                queries=[
                    dict(**query, expected_rows=rows)
                    for query, rows in zip(case["queries"], expected)
                ],
                expected_business=business_values(
                    case, expected, raw, catalog["release"]
                ),
                limitation=case["note"],
                authority="offline_oracle_not_runtime_certification",
            )
        )
    return dict(
        schema_version=1,
        status="passed",
        dataset_version=manifest["dataset_version"],
        release=catalog["release"],
        manifest_sha256=hashlib.sha256(
            (Path(dataset) / "manifest.json").read_bytes()
        ).hexdigest(),
        scenario_count=len(cases),
        query_count=sum(len(case["queries"]) for case in cases),
        model_requests=0,
        scenarios=cases,
    )
