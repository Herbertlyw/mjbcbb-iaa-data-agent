"""Check deterministic projections, time travel and meaningful failure cases."""

from copy import deepcopy
from datetime import date
import json
from pathlib import Path
import tempfile
import unittest

from synthetic.starhaven.catalog import METRICS, ddl, schema
from synthetic.starhaven.generate import generate
from synthetic.starhaven.knowledge import (
    bind_knowledge,
    package_files,
    release_knowledge,
    render,
)
from synthetic.starhaven.reconcile import load_manifest, read_dataset, reconcile


class DatasetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="starhaven-tests-")
        cls.directory = Path(cls.temporary.name)
        cls.dataset = cls.directory / "baseline"
        cls.manifest = generate(cls.dataset, profile="tiny", installs=2)
        _, cls.tables = read_dataset(cls.dataset)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_schema_and_metrics_have_one_definition(self):
        models = schema()
        self.assertEqual(len(models), 23)
        self.assertEqual(sum(len(model["columns"]) for model in models), 309)
        self.assertEqual(len(METRICS), 43)
        self.assertEqual(ddl().count("CREATE TABLE IF NOT EXISTS"), 23)
        by_name = {model["asset"]: model for model in models}
        for metric in METRICS:
            for reference in metric["inputs"]:
                table, column = reference.split(".")
                self.assertIn(column, by_name[table]["declared_column_names"])
        for model in models:
            self.assertEqual(
                len(model["declared_column_names"]),
                len(set(model["declared_column_names"])),
            )
            self.assertTrue(all(column["description"] for column in model["columns"]))

    def test_clean_release_reconciles(self):
        report = reconcile(self.dataset)
        self.assertEqual(report["failed"], [])
        self.assertGreater(report["checks"], 280)

    def test_identical_inputs_produce_identical_bytes(self):
        output = self.directory / "identical"
        manifest = generate(output, profile="tiny", installs=2)
        self.assertEqual(manifest, self.manifest)
        for table in manifest["tables"]:
            self.assertEqual(
                (output / (table + ".jsonl")).read_bytes(),
                (self.dataset / (table + ".jsonl")).read_bytes(),
            )
        self.assertEqual(
            (output / "private-gold.json").read_bytes(),
            (self.dataset / "private-gold.json").read_bytes(),
        )

    def test_seed_changes_version_and_outcomes(self):
        output = self.directory / "different-seed"
        manifest = generate(output, profile="tiny", installs=2, seed=91)
        self.assertNotEqual(
            manifest["dataset_version"], self.manifest["dataset_version"]
        )
        self.assertNotEqual(
            manifest["tables"]["fact_activity_daily"]["sha256"],
            self.manifest["tables"]["fact_activity_daily"]["sha256"],
        )
        self.assertEqual(reconcile(output)["status"], "passed")

    def test_advance_preserves_observed_history_and_old_predictions(self):
        output = self.directory / "advanced"
        manifest = generate(
            output,
            days=self.manifest["days"] + 2,
            installs=2,
            seed=self.manifest["seed"],
            start_date=self.manifest["start_date"],
        )
        _, tables = read_dataset(output)
        self.assertNotEqual(
            manifest["dataset_version"], self.manifest["dataset_version"]
        )
        for table, date_column in [
            ("fact_delivery_daily", "business_date"),
            ("fact_activity_daily", "activity_date"),
            ("fact_ad_funnel_daily", "business_date"),
            ("fact_gameplay_daily", "business_date"),
        ]:

            def old_rows(rows):
                return sorted(
                    [
                        {
                            key: value
                            for key, value in row.items()
                            if key != "dataset_version"
                        }
                        for row in rows
                        if row[date_column] <= self.manifest["as_of"]
                    ],
                    key=lambda row: json.dumps(row, sort_keys=True),
                )

            self.assertEqual(
                old_rows(tables[table]), old_rows(self.tables[table]), table
            )
        predictions = {
            row["prediction_id"]: row for row in tables["fact_roi_forecast_snapshot"]
        }
        self.assertTrue(predictions)
        for previous in self.tables["fact_roi_forecast_snapshot"]:
            current = predictions[previous["prediction_id"]]
            self.assertEqual(
                {
                    key: value
                    for key, value in current.items()
                    if key != "dataset_version"
                },
                {
                    key: value
                    for key, value in previous.items()
                    if key != "dataset_version"
                },
            )
        self.assertEqual(reconcile(output)["status"], "passed")

    def test_reinstalls_do_not_reset_quality_cohort(self):
        installs = self.tables["fact_acquisition_daily"]
        self.assertGreater(sum(row["reinstall_events"] for row in installs), 0)
        bases = sum(
            row["cohort_size_devices"]
            for row in self.tables["fact_cohort_quality_daily"]
            if row["age_days"] == 0
        )
        gold = json.loads((self.dataset / "private-gold.json").read_text())
        self.assertEqual(bases, gold["private_devices"])

    def test_unknown_and_not_applicable_are_not_zero(self):
        channel = next(
            row
            for row in self.tables["dim_ua_channel"]
            if row["ua_channel_id"] == "unknown"
        )
        self.assertIsNone(channel["is_paid"])
        unknown_game = [
            row
            for row in self.tables["fact_gameplay_daily"]
            if row["mode_code"] == "unconfirmed"
        ]
        self.assertTrue(unknown_game)
        self.assertTrue(
            all(
                row["games_won"] is None and row["total_score"] is None
                for row in unknown_game
            )
        )
        immature = [
            row
            for row in self.tables["fact_roi_forecast_evaluation"]
            if row["maturity_state"] == "immature"
        ]
        self.assertTrue(immature)
        self.assertTrue(
            all(
                row["actual_revenue_usd"] is None and row["roi_error_pp"] is None
                for row in immature
            )
        )

    def test_eligible_untested_and_unassigned_creatives_are_distinct(self):
        rows = self.tables["fact_creative_test_snapshot"]
        self.assertTrue(
            any(row["is_eligible"] == 1 and row["is_tested"] == 0 for row in rows)
        )
        unassigned = [row for row in rows if row["test_scope_state"] == "unassigned"]
        self.assertTrue(unassigned)
        self.assertTrue(
            all(
                row["ua_channel_id"] is None and row["is_graduated"] is None
                for row in unassigned
            )
        )

    def test_experiment_observations_are_bounded_by_entry_not_install(self):
        rows = self.tables["fact_experiment_cohort_daily"]
        self.assertEqual(
            {row["anchor_type"] for row in rows}, {"first_open", "first_ad_show"}
        )
        self.assertTrue(all(0 <= row["age_days"] <= 30 for row in rows))
        self.assertTrue(
            all(
                row["age_days"]
                == (
                    date.fromisoformat(row["observe_date"])
                    - date.fromisoformat(row["entry_cohort_date"])
                ).days
                for row in rows
            )
        )

    def test_known_faults_fail_meaningful_checks(self):
        expected = {
            "null_cost": "oracle.cost",
            "missing_day": "row_count.fact_delivery_daily",
            "duplicate_dimension": "grain.dim_app",
        }
        for scenario, check in expected.items():
            with self.subTest(scenario=scenario):
                output = self.directory / scenario
                generate(output, profile="tiny", installs=2, scenario=scenario)
                result = reconcile(output)
                self.assertEqual(result["status"], "failed")
                self.assertIn(check, result["failed"])

    def test_backfill_is_not_silently_scored_as_model_error(self):
        output = self.directory / "late-cost"
        generate(output, profile="tiny", installs=2, scenario="late_cost")
        self.assertEqual(reconcile(output)["failed"], [])
        _, tables = read_dataset(output)
        revised = [
            row
            for row in tables["fact_roi_forecast_evaluation"]
            if row["input_revision_state"] == "input_revised"
        ]
        self.assertTrue(revised)
        self.assertTrue(
            all(
                row["roi_error_pp"] is None and row["cost_weight_usd"] is None
                for row in revised
            )
        )

    def test_existing_output_and_budget_overflow_do_not_overwrite(self):
        before = (self.dataset / "manifest.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "output_exists"):
            generate(self.dataset, profile="tiny")
        output = self.directory / "over-budget"
        with self.assertRaisesRegex(ValueError, "published_row_budget_exceeded"):
            generate(output, profile="tiny", row_budget=10)
        self.assertFalse(output.exists())
        self.assertEqual(before, (self.dataset / "manifest.json").read_bytes())

    def test_unsafe_manifest_table_and_symlink_are_rejected(self):
        with tempfile.TemporaryDirectory(prefix="starhaven-wire-") as directory:
            destination = Path(directory)
            manifest = deepcopy(self.manifest)
            manifest["tables"]["../escape"] = manifest["tables"].pop("dim_app")
            (destination / "manifest.json").write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "dataset_manifest_invalid"):
                load_manifest(destination)
            (destination / "manifest.json").write_text(json.dumps(self.manifest))
            for table in self.manifest["tables"]:
                (destination / (table + ".jsonl")).symlink_to(
                    self.dataset / (table + ".jsonl")
                )
            with self.assertRaisesRegex(ValueError, "dataset_file_outside_release"):
                load_manifest(destination)

    def test_knowledge_generated_once_and_gold_is_not_registered(self):
        with tempfile.TemporaryDirectory(prefix="starhaven-knowledge-") as directory:
            destination = Path(directory)
            count = render(target=destination)
            self.assertEqual(count, render(check=True, target=destination))
            files = package_files()
            semantics = json.loads(files["semantics.json"])
            self.assertEqual(semantics["application_name"], "VV Data Agent")
            self.assertEqual(
                [
                    (game["game_id"], game["name"], game["english_name"])
                    for game in semantics["games"]
                ],
                [
                    ("gridfit", "拼格", "GridFit"),
                    ("blockfall", "落块", "BlockFall"),
                    ("stackjoy", "叠叠乐", "StackJoy"),
                ],
            )
            self.assertEqual(
                {row["game_id"] for row in self.tables["dim_app"]},
                {"gridfit", "blockfall", "stackjoy"},
            )
            registry = json.loads(files["registry.json"])
            self.assertEqual(
                sum(asset["kind"] == "data_contract" for asset in registry["assets"]),
                23,
            )
            self.assertEqual(
                len([name for name in files if name.startswith("tables/")]), 23
            )
            self.assertFalse(
                any(
                    "private-gold" in asset["path"]
                    or "cases.json" in asset["path"]
                    or "settings.json" in asset["path"]
                    for asset in registry["assets"]
                )
            )
            contract = json.loads(files["contracts/fact_activity_daily.json"])
            self.assertEqual(contract["must_filter"], ["activity_date"])
            self.assertNotIn("active_devices_30d", contract["series"]["metrics"])
            forecast = json.loads(files["contracts/fact_roi_forecast_snapshot.json"])
            self.assertNotIn("series", forecast)
            (destination / "assets/roi.md").write_text("drift")
            with self.assertRaisesRegex(ValueError, "knowledge_generated_files_drift"):
                render(check=True, target=destination)

    def test_bound_knowledge_declares_actual_version_without_auto_fresh(self):
        destination = release_knowledge(self.dataset)
        text = (destination / "assets/release.md").read_text()
        self.assertIn(self.manifest["dataset_version"], text)
        self.assertIn(self.manifest["as_of"], text)
        targets = json.loads((destination / "freshness-targets.json").read_text())[
            "targets"
        ]
        self.assertEqual(len(targets), 22)
        self.assertNotIn(
            "fact_roi_forecast_snapshot", {target["table"] for target in targets}
        )
        contract = json.loads(
            (destination / "contracts/fact_delivery_daily.json").read_text()
        )
        self.assertEqual(contract["freshness"]["status"], "unknown")

    def test_rebind_uses_new_directory_and_preserves_data_and_old_knowledge(self):
        old = release_knowledge(self.dataset)
        before = (old / "contracts/fact_activity_daily.json").read_bytes()
        manifest = (self.dataset / "manifest.json").read_bytes()
        output = self.directory / "contracts-v2"
        result = bind_knowledge(self.dataset, output)
        self.assertEqual(result["publication"], "unpublished_requires_freshness")
        contract = json.loads(
            (output / "contracts/fact_activity_daily.json").read_text()
        )
        self.assertEqual(contract["revision"], "contract.fact_activity_daily-v2")
        self.assertIn("dataset_version", contract["series"]["dimensions"])
        self.assertEqual(
            (old / "contracts/fact_activity_daily.json").read_bytes(), before
        )
        self.assertEqual((self.dataset / "manifest.json").read_bytes(), manifest)
        with self.assertRaisesRegex(ValueError, "knowledge_output_exists"):
            bind_knowledge(self.dataset, output)
        invalid = self.directory / "rebind-invalid-dataset"
        generate(invalid, profile="tiny", installs=2, scenario="null_cost")
        refused = self.directory / "rebind-refused"
        with self.assertRaisesRegex(ValueError, "dataset_reconciliation_failed"):
            bind_knowledge(invalid, refused)
        self.assertFalse(refused.exists())


if __name__ == "__main__":
    unittest.main()
