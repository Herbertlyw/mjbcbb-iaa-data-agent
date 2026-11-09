"""Run real ClickHouse checks in a new, private clickhouse-local data path."""

from decimal import Decimal
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

from .catalog import ddl, schema
from .queries import examples
from .reconcile import FOREIGN_KEYS, load_manifest


def literal(value):
    return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'") + "'"


def verification_sql(dataset, manifest, gold):
    dataset = Path(dataset).resolve()
    statements = [ddl()]
    checks = []

    def check(name, expression):
        checks.append(name)
        statements.append(
            f"SELECT {literal(name)} AS check, ({expression}) AS ok FORMAT JSONEachRow;"
        )

    models = schema()
    specs = {m["asset"]: m for m in models}
    for model in models:
        table = model["asset"]
        structure = ", ".join(c["name"] + " " + c["type"] for c in model["columns"])
        statements.append(
            f"INSERT INTO {table} SELECT * FROM file({literal(dataset/(table+'.jsonl'))}, 'JSONEachRow', {literal(structure)});"
        )
        statements.append(
            f"SELECT {literal('types.'+table)} AS check, groupArray(tuple(name,type)) AS columns FROM system.columns WHERE database=currentDatabase() AND table={literal(table)} FORMAT JSONEachRow;"
        )
        check(
            "count." + table,
            f"SELECT count()={manifest['tables'][table]['expected_rows']} FROM {table}",
        )
        key = ", ".join(["dataset_version"] + model["dimensions"])
        check("grain." + table, f"SELECT count()=uniqExact(tuple({key})) FROM {table}")
        check(
            "version." + table,
            f"SELECT countIf(dataset_version!={literal(manifest['dataset_version'])})=0 FROM {table}",
        )
    fks = list(FOREIGN_KEYS)
    for model in models:
        if model["asset"].startswith("dim_"):
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
            if key in model["declared_column_names"]:
                fks.append((model["asset"], key, dimension, key))
        for key in (
            "acquisition_country_code",
            "activity_country_code",
            "entry_country_code",
        ):
            if key in model["declared_column_names"]:
                fks.append((model["asset"], key, "dim_country", "country_code"))
    for table, key, dimension, target in fks:
        check(
            "fk." + table + "." + key,
            f"SELECT countIf(a.{key} IS NOT NULL AND b.{target} IS NULL)=0 FROM {table} a LEFT JOIN {dimension} b ON a.dataset_version=b.dataset_version AND a.{key}=b.{target} SETTINGS join_use_nulls=1",
        )

    def amount(value):
        number = Decimal(str(value))
        if not number.is_finite():
            raise ValueError("nonfinite_gold_amount")
        return "toDecimal128(" + literal(format(number, "f")) + ", 6)"

    check(
        "oracle.cost",
        f"SELECT sum(discounted_cost_usd)={amount(gold['totals']['discounted_cost_usd'])} FROM fact_delivery_daily",
    )
    check(
        "oracle.install_events",
        f"SELECT sum(unique_install_events)={int(gold['totals']['install_events_visible'])} FROM fact_acquisition_daily",
    )
    check(
        "oracle.active",
        f"SELECT sum(active_devices)={int(gold['totals']['active_device_days'])} FROM fact_activity_daily",
    )
    check(
        "oracle.games",
        f"SELECT sum(games_finished)={int(gold['totals']['game_count'])} FROM fact_gameplay_daily",
    )
    for table, col, where in [
        ("fact_ad_funnel_daily", "revenue_usd", ""),
        ("fact_activity_daily", "ad_revenue_usd", ""),
        ("fact_cohort_quality_daily", "ad_revenue_usd", ""),
        ("fact_cohort_revenue_daily", "revenue_usd", " WHERE revenue_source='sdk'"),
    ]:
        value = (
            gold["totals"]["cohort30_revenue_usd"]
            if table == "fact_cohort_quality_daily"
            else gold["totals"]["sdk_revenue_usd"]
        )
        check(
            "conserve." + table,
            f"SELECT sum({col})={amount(value)} FROM {table}{where}",
        )
    check(
        "conserve.cohort30",
        "SELECT (SELECT sum(ad_revenue_usd) FROM fact_cohort_quality_daily)=(SELECT sum(revenue_usd) FROM fact_cohort_revenue_daily WHERE revenue_source='sdk' AND age_days<=30)",
    )
    check(
        "fx.raw",
        "SELECT countIf(d.raw_cost_local IS NULL OR d.raw_cost_usd IS NULL OR f.source_currency_per_usd IS NULL OR d.raw_cost_local/f.source_currency_per_usd!=d.raw_cost_usd)=0 FROM fact_delivery_daily d LEFT JOIN fact_fx_rate_daily f ON d.dataset_version=f.dataset_version AND d.fx_rate_date=f.rate_date AND d.source_currency=f.source_currency SETTINGS join_use_nulls=1",
    )
    check(
        "fx.discounted",
        "SELECT countIf(d.discounted_cost_local IS NULL OR d.discounted_cost_usd IS NULL OR f.source_currency_per_usd IS NULL OR d.discounted_cost_local/f.source_currency_per_usd!=d.discounted_cost_usd)=0 FROM fact_delivery_daily d LEFT JOIN fact_fx_rate_daily f ON d.dataset_version=f.dataset_version AND d.fx_rate_date=f.rate_date AND d.source_currency=f.source_currency SETTINGS join_use_nulls=1",
    )
    check(
        "cohort.bounds",
        "SELECT countIf(retained_devices>cohort_size_devices OR age_days!=dateDiff('day',install_cohort_date,observe_date))=0 FROM fact_cohort_quality_daily",
    )
    check(
        "cohort.d0",
        f"SELECT sum(cohort_size_devices)={gold['private_devices']} FROM fact_cohort_quality_daily WHERE age_days=0",
    )
    check(
        "activity.windows",
        "SELECT countIf(active_devices>active_devices_7d OR active_devices_7d>active_devices_30d OR new_active_devices+returning_active_devices!=active_devices)=0 FROM fact_activity_daily",
    )
    for sample in gold["window_oracles"]:
        window = int(sample["window_days"])
        if window not in {7, 30}:
            raise ValueError("invalid_window_oracle")
        check(
            "activity.oracle." + sample["app_id"] + "." + str(window),
            f"SELECT sum(active_devices_{window}d)={int(sample['devices'])} FROM fact_activity_daily WHERE activity_date={literal(manifest['as_of'])} AND app_id={literal(sample['app_id'])}",
        )
    check(
        "install.subsets",
        "SELECT countIf(unique_install_events!=first_install_devices+reinstall_events OR late_install_events>unique_install_events)=0 FROM fact_acquisition_daily",
    )
    check(
        "experiment.anchors",
        "SELECT countIf(age_days!=dateDiff('day',entry_cohort_date,observe_date) OR active_units>enrolled_units)=0 FROM fact_experiment_cohort_daily",
    )
    check(
        "experiment.config",
        "SELECT countIf(c.experiment_id IS NULL OR c.anchor_type!=e.anchor_type)=0 FROM fact_experiment_cohort_daily e LEFT JOIN dim_experiment_arm c ON e.dataset_version=c.dataset_version AND e.experiment_id=c.experiment_id AND e.arm_id=c.arm_id AND e.config_version=c.config_version SETTINGS join_use_nulls=1",
    )
    check(
        "experiment.allocation",
        "SELECT countIf(total!=1)=0 FROM (SELECT experiment_id, config_version, sum(allocation_fraction) AS total FROM dim_experiment_arm GROUP BY experiment_id, config_version)",
    )
    check(
        "experiment.product_population",
        f"SELECT sum(enrolled_units)={gold['private_devices']} FROM fact_experiment_cohort_daily WHERE age_days=0 AND anchor_type='first_open'",
    )
    check(
        "funnel.bounds",
        "SELECT countIf(successful_load_attempts>completed_load_attempts OR completed_load_attempts>load_attempts OR ready_actions>show_actions OR successful_show_requests>completed_show_requests)=0 FROM fact_ad_funnel_daily",
    )
    check(
        "forecast.inputs",
        "SELECT countIf(toDate(input_cutoff)!=snapshot_date OR observed_age_days!=dateDiff('day',cohort_date,snapshot_date) OR observed_age_days>=horizon_days)=0 FROM fact_roi_forecast_snapshot",
    )
    check(
        "forecast.immature",
        "SELECT countIf(actual_revenue_usd IS NOT NULL OR actual_roi_pct IS NOT NULL OR roi_error_pp IS NOT NULL)=0 FROM fact_roi_forecast_evaluation WHERE maturity_state='immature'",
    )
    check(
        "forecast.error",
        "SELECT countIf(actual_roi_pct-predicted_roi_pct!=roi_error_pp)=0 FROM fact_roi_forecast_evaluation WHERE maturity_state='mature' AND input_revision_state='unchanged'",
    )
    check(
        "forecast.revised_not_model_error",
        "SELECT countIf(roi_error_pp IS NOT NULL OR cost_weight_usd IS NOT NULL)=0 FROM fact_roi_forecast_evaluation WHERE input_revision_state='input_revised'",
    )
    check(
        "forecast.fk",
        "SELECT countIf(p.prediction_id IS NULL OR p.predicted_roi_pct!=e.predicted_roi_pct OR p.horizon_days!=e.horizon_days OR p.model_version!=e.model_version)=0 FROM fact_roi_forecast_evaluation e LEFT JOIN fact_roi_forecast_snapshot p ON e.dataset_version=p.dataset_version AND e.prediction_id=p.prediction_id SETTINGS join_use_nulls=1",
    )
    for example in examples(
        manifest["dataset_version"], manifest["start_date"], manifest["as_of"]
    ):
        check(
            "example." + example["example_id"],
            "SELECT count()>0 FROM (" + example["sql"] + ")",
        )
    return "\n".join(statements), checks


def verify_native(dataset, binary, report_path=None, timeout=240):
    dataset = Path(dataset).resolve()
    binary = Path(binary).resolve()
    if not binary.is_file():
        raise ValueError("clickhouse_binary_missing")
    manifest = load_manifest(dataset)
    gold = json.loads((dataset / "private-gold.json").read_text())
    sql, expected = verification_sql(dataset, manifest, gold)
    version = subprocess.run(
        [str(binary), "local", "--version"],
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
    ).stdout.strip()
    with tempfile.TemporaryDirectory(prefix="starhaven-clickhouse-") as directory:
        work = Path(directory)
        query_file = work / "verification.sql"
        query_file.write_text(sql)
        result = subprocess.run(
            [
                str(binary),
                "local",
                "--path",
                str(work / "state"),
                "--max_threads",
                "2",
                "--queries-file",
                str(query_file),
                "--multiquery",
            ],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    if result.returncode:
        raise RuntimeError("isolated_clickhouse_failed: " + result.stderr[-5000:])
    rows = [
        json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")
    ]
    outcomes = {row["check"]: row for row in rows}
    failures = []
    for name in expected:
        if name not in outcomes or str(outcomes[name].get("ok")) not in {
            "1",
            "True",
            "true",
        }:
            failures.append(name)
    for model in schema():
        name = "types." + model["asset"]
        actual = {
            n: t.replace(" ", "") for n, t in outcomes.get(name, {}).get("columns", [])
        }
        expected_columns = {
            c["name"]: c["type"].replace(" ", "") for c in model["columns"]
        }
        if actual != expected_columns:
            failures.append(name)
    report = dict(
        status="passed" if not failures else "failed",
        engine_version=version,
        binary_sha256=hashlib.sha256(binary.read_bytes()).hexdigest(),
        dataset_version=manifest["dataset_version"],
        rows=sum(t["rows"] for t in manifest["tables"].values()),
        checks=len(expected) + len(schema()),
        failed=failures,
        results=rows,
        scope="Native isolated clickhouse-local, actual DDL/INSERT/types/SQL reconciliation. Not Docker, API/worker/MySQL/Redis or model validation.",
    )
    if report_path:
        Path(report_path).with_suffix(".sql").write_text(sql)
        Path(report_path).write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n"
        )
    return report
