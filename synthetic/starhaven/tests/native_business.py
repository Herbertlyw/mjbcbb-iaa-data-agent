"""Check all VV SQL and local Pi recipes on an owned ClickHouse HTTP server."""

import argparse
import json
import os
from pathlib import Path
import subprocess

from synthetic.starhaven.business_gold import evaluate_business
from synthetic.starhaven.catalog import ROOT
from synthetic.starhaven.knowledge import release_knowledge
from .native_loader import verify_loader


def verify_business(binary, browser=False):
    def after_load(work, dataset, credentials):
        knowledge = release_knowledge(dataset)
        gold_path = work / "business-gold.json"
        gold_path.write_text(
            json.dumps(evaluate_business(dataset), ensure_ascii=False) + "\n"
        )
        report_path = work / "business-host.json"
        environment = {
            name: value
            for name, value in os.environ.items()
            if name in {"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT"}
        }
        command = [
            "node",
            "--import",
            "tsx",
            "tests/vv-business-native.ts",
            str(credentials),
            str(knowledge),
            str(gold_path),
            str(work / "host"),
            str(report_path),
        ]
        if browser:
            subprocess.run(
                command + ["browser"], cwd=ROOT.parents[1], env=environment, check=True
            )
        else:
            result = subprocess.run(
                command,
                cwd=ROOT.parents[1],
                env=environment,
                capture_output=True,
                text=True,
                timeout=300,
            )
            if result.returncode:
                raise RuntimeError(
                    "business_native_failed: "
                    + result.stdout[-2000:]
                    + result.stderr[-9000:]
                )
        return json.loads(report_path.read_text())

    loaded = verify_loader(binary, after_load=after_load)
    report = loaded.pop("host")
    return dict(**report, engine_version=loaded["engine_version"], loader=loaded)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument(
        "--browser",
        action="store_true",
        help="Print the owned API URL and wait for its stop file",
    )
    args = parser.parse_args()
    result = verify_business(args.binary, args.browser)
    destination = Path(args.report)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(
        json.dumps(
            {
                key: result[key]
                for key in (
                    "status",
                    "scenario_count",
                    "query_count",
                    "engine_version",
                    "external_model_requests",
                )
            },
            ensure_ascii=False,
        )
    )
