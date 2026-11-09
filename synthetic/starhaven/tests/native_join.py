"""Run the receiving machine's JOIN through actual host tools and an owned DB."""

import argparse
from collections import defaultdict
from decimal import Decimal
import json
import os
from pathlib import Path
import subprocess

from synthetic.starhaven.catalog import ROOT
from synthetic.starhaven.knowledge import release_knowledge
from .native_loader import verify_loader


def verify_host_join(binary):
    def run_host(work, dataset, credentials):
        manifest = json.loads((dataset / "manifest.json").read_text())
        knowledge = release_knowledge(dataset)
        totals = defaultdict(Decimal)
        with (dataset / "fact_delivery_daily.jsonl").open() as rows:
            for line in rows:
                row = json.loads(line)
                if "2026-11-01" <= row["business_date"] <= "2026-11-08":
                    totals[row["app_id"]] += Decimal(row["discounted_cost_usd"])
        gold = work / "gold.json"
        gold.write_text(
            json.dumps(
                dict(
                    dataset_version=manifest["dataset_version"],
                    app_costs={
                        app: format(value, ".6f")
                        for app, value in sorted(totals.items())
                    },
                ),
                ensure_ascii=False,
            )
            + "\n"
        )
        report_path = work / "host-report.json"
        environment = {
            name: value
            for name, value in os.environ.items()
            if name in {"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT"}
        }
        host = subprocess.run(
            [
                "node",
                "--import",
                "tsx",
                "tests/vv-join-native.ts",
                str(credentials),
                str(knowledge),
                str(gold),
                str(work / "host"),
                str(report_path),
            ],
            cwd=ROOT.parents[1],
            env=environment,
            capture_output=True,
            text=True,
            timeout=90,
        )
        if host.returncode:
            raise RuntimeError(
                "native_host_join_failed: " + host.stdout[-1000:] + host.stderr[-5000:]
            )
        return json.loads(report_path.read_text())

    loaded = verify_loader(binary, after_load=run_host)
    report = loaded.pop("host")
    report["engine_version"] = loaded["engine_version"]
    report["loader"] = loaded
    report["scope"] = (
        "Owned native ClickHouse HTTP + actual domain query/evidence/delivery; SQLite control state, no MySQL/Redis/Pi/model/browser"
    )
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True)
    parser.add_argument("--report")
    args = parser.parse_args()
    report = verify_host_join(args.binary)
    if args.report:
        Path(args.report).write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n"
        )
    print(json.dumps(report, ensure_ascii=False))
