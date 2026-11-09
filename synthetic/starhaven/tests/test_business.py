"""Business oracles must retain cohort, source, denominator and maturity semantics."""

from copy import deepcopy
from decimal import Decimal
import json
from pathlib import Path
import tempfile
import unittest

from synthetic.starhaven.business import business_catalog, public_catalog
from synthetic.starhaven.business_gold import (
    business_values,
    evaluate_business,
    exact_sum,
    ratio,
)
from synthetic.starhaven.generate import generate
from synthetic.starhaven.knowledge import release_knowledge


class BusinessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="vv-business-tests-")
        cls.dataset = Path(cls.temporary.name) / "tiny"
        cls.manifest = generate(cls.dataset, profile="tiny", installs=4)
        cls.report = evaluate_business(cls.dataset)
        cls.catalog = business_catalog(
            cls.manifest["dataset_version"],
            cls.manifest["start_date"],
            cls.manifest["as_of"],
        )

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def case(self, identity):
        return next(
            case for case in self.catalog["scenarios"] if case["id"] == identity
        )

    def result(self, identity):
        return next(case for case in self.report["scenarios"] if case["id"] == identity)

    def test_six_topics_eighteen_cases_and_release_bound_dates(self):
        self.assertEqual(self.report["scenario_count"], 18)
        self.assertEqual(self.report["query_count"], 22)
        self.assertEqual(
            {case["category"] for case in self.catalog["scenarios"]},
            {"acquisition", "plans", "creative", "revenue", "retention", "value"},
        )
        self.assertEqual(len({case["id"] for case in self.catalog["scenarios"]}), 18)
        self.assertIn("2026-11-01", self.case("acquisition-daily")["text"])
        self.assertIn("2026-11-07", self.case("acquisition-daily")["text"])
        moved = business_catalog(
            self.manifest["dataset_version"], "2027-01-01", "2027-01-14"
        )
        self.assertIn("2027-01-07", moved["scenarios"][0]["text"])
        with self.assertRaises(ValueError):
            business_catalog("sv_' OR 1=1", "2026-10-26", "2026-11-08")
        with self.assertRaises(ValueError):
            business_catalog(
                self.manifest["dataset_version"], "2026-11-07", "2026-11-08"
            )

    def test_public_catalog_and_online_knowledge_contain_no_gold(self):
        public = public_catalog(self.catalog)
        for question in public["questions"]:
            self.assertEqual(
                set(question), {"id", "category", "label", "text", "scope", "note"}
            )
        self.assertNotIn("expected_business", json.dumps(public))
        knowledge = release_knowledge(self.dataset)
        self.assertEqual(
            json.loads((knowledge / "demo-catalog.json").read_text()), public
        )
        self.assertNotIn("business-gold", (knowledge / "registry.json").read_text())
        self.assertNotIn(
            "expected_business", (knowledge / "assets/business.md").read_text()
        )

    def test_weighted_cpi_is_ratio_of_totals_with_exact_decimal(self):
        case = self.case("acquisition-channel")
        row = {
            "ua_channel_id": "paid",
            "total_discounted_cost_usd": "30",
            "total_af_registers": "6",
            "nonnull_discounted_cost_usd": "2",
            "nonnull_af_registers": "2",
            "source_rows": "2",
        }
        result = business_values(case, [[row]], [[]], self.catalog["release"])
        self.assertEqual(result[0]["af_cpi_usd"], "5.000000")
        self.assertNotEqual(result[0]["af_cpi_usd"], "6.000000")  # mean(10/1,20/5)
        self.assertEqual(
            exact_sum([{"v": "90071992547409.91"}, {"v": "0.09"}], "v"),
            Decimal("90071992547410.00"),
        )
        self.assertIsNone(ratio(Decimal(1), Decimal(0)))
        self.assertIsNone(exact_sum([], "v"))
        self.assertIsNone(exact_sum([{"v": 1}, {"v": None}], "v"))
        self.assertEqual(exact_sum([{"v": 0}], "v"), 0)

    def test_retention_uses_one_age_and_weighted_base(self):
        case = self.case("retention-d7")
        rows = [
            {
                "cohort_size_devices": 10,
                "retained_devices": 1,
                "age_days": 7,
                "completeness_state": "complete",
            },
            {
                "cohort_size_devices": 90,
                "retained_devices": 45,
                "age_days": 7,
                "completeness_state": "complete",
            },
        ]
        result = business_values(case, [rows], [rows], self.catalog["release"])
        self.assertEqual(result["base_once"], "100")
        self.assertEqual(result["rr_pct"], "46.000000")
        rows[0]["age_days"] = 6
        self.assertIsNone(
            business_values(case, [rows], [rows], self.catalog["release"])["rr_pct"]
        )

    def test_ltv_base_is_d0_once_and_missing_day_is_unknown(self):
        result = self.result("ltv7")
        self.assertTrue(result["expected_business"]["window_complete"])
        base = result["queries"][0]["expected_rows"]
        window = result["queries"][1]["expected_rows"]
        expected_base = sum(row["cohort_size_devices"] for row in base)
        self.assertEqual(
            Decimal(result["expected_business"]["base_once"]), expected_base
        )
        self.assertEqual(
            sum(row["cohort_size_devices"] for row in window), expected_base * 7
        )
        broken = deepcopy(window)
        broken.pop()
        values = business_values(
            self.case("ltv7"), [base, broken], [base, broken], self.catalog["release"]
        )
        self.assertFalse(values["window_complete"])
        self.assertIsNone(values["ltv7_usd_per_device"])

    def test_roi_has_same_cohort_separate_source_and_outer_key_domain(self):
        case = self.case("roi7")
        self.assertEqual(case["queries"][0]["start"], "2026-11-01")
        self.assertEqual(case["queries"][1]["end"], "2026-11-07")
        self.assertEqual(case["queries"][1]["equals"]["revenue_source"], "sdk")
        left = [
            {
                "ua_channel_id": "paid",
                "total_discounted_cost_usd": "2",
                "source_rows": "1",
                "nonnull_discounted_cost_usd": "1",
            },
            {
                "ua_channel_id": "organic",
                "total_discounted_cost_usd": "0",
                "source_rows": "1",
                "nonnull_discounted_cost_usd": "1",
            },
        ]
        right = [
            {
                "ua_channel_id": "paid",
                "total_revenue_usd": "1",
                "source_rows": "1",
                "nonnull_revenue_usd": "1",
            }
        ]
        values = business_values(case, [left, right], [[], []], self.catalog["release"])
        by_channel = {row["ua_channel_id"]: row for row in values}
        self.assertEqual(by_channel["paid"]["roi_pct"], "50.000000")
        self.assertIsNone(by_channel["organic"]["roi_pct"])
        self.assertEqual(by_channel["organic"]["status"], "missing_side")

    def test_immature_roi30_never_receives_a_numeric_answer_or_prediction(self):
        result = self.result("roi-immature")["expected_business"]
        self.assertIsNone(result["actual_roi30_pct"])
        self.assertEqual(result["maturity"], "immature")
        self.assertEqual(result["observed_ages"], [0])
        self.assertFalse(result["forecast_substituted"])

    def test_source_gap_does_not_add_sources_or_replace_absent_source(self):
        case = self.case("revenue-source")
        row = {
            "revenue_source": "sdk",
            "total_revenue_usd": "1",
            "source_rows": "1",
            "nonnull_revenue_usd": "1",
        }
        result = business_values(case, [[row]], [[]], self.catalog["release"])
        self.assertEqual(result["sdk_usd"], "1")
        self.assertIsNone(result["af_usd"])
        self.assertIsNone(result["sdk_minus_af_usd"])

    def test_material_state_denominator_and_short_history_are_explicit(self):
        states = self.result("creative-readiness")["expected_business"]
        unassigned = next(row for row in states if row["ua_channel_id"] is None)
        self.assertGreater(unassigned["unassigned"], 0)
        self.assertIsNone(unassigned["graduation_pct"])
        anchor = self.result("activity-anchor")["expected_business"]
        self.assertFalse(anchor["complete_30d_history"])
        self.assertEqual(anchor["available_history_days"], 13)

    def test_bad_data_is_refused_before_generating_business_gold(self):
        invalid = Path(self.temporary.name) / "invalid"
        generate(invalid, profile="tiny", installs=2, scenario="null_cost")
        with self.assertRaisesRegex(
            ValueError, "business_dataset_reconciliation_failed"
        ):
            evaluate_business(invalid)


if __name__ == "__main__":
    unittest.main()
