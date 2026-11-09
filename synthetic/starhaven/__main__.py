"""Command line entry point for the local VV Data Agent data lifecycle."""

import argparse
import json
from pathlib import Path
import sys

from .catalog import ROOT
from .business_gold import evaluate_business
from .clickhouse import verify_native
from .generate import generate, digest, implementation_fingerprint
from .knowledge import bind_knowledge, render, release_knowledge
from .load import load_release
from .reconcile import load_manifest, reconcile


def main():
    parser = argparse.ArgumentParser(
        description="本地 VV Data Agent 合成游戏数据，不连接公司服务或模型"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build", help="生成不可变合成发布，输出目录必须不存在")
    build.add_argument("--output", required=True)
    build.add_argument(
        "--profile", choices=["tiny", "demo", "standard", "scale"], default="demo"
    )
    dates = build.add_mutually_exclusive_group()
    dates.add_argument("--as-of", default="2026-11-08")
    dates.add_argument("--start-date")
    build.add_argument("--days", type=int)
    build.add_argument("--installs-per-app-day", type=int)
    build.add_argument("--seed", type=int, default=20261108)
    build.add_argument("--row-budget", type=int)
    build.add_argument(
        "--scenario",
        choices=[
            "clean",
            "null_cost",
            "missing_day",
            "duplicate_dimension",
            "late_cost",
        ],
        default="clean",
    )
    advance = commands.add_parser(
        "advance", help="从旧发布的seed和起点重建更长的新版本，不修改旧发布"
    )
    advance.add_argument("--from", dest="previous", required=True)
    advance.add_argument("--output", required=True)
    advance.add_argument("--days", type=int, default=1)
    advance.add_argument("--row-budget", type=int)
    check = commands.add_parser("reconcile", help="离线Python跨表对账，失败退出码2")
    check.add_argument("--dataset", required=True)
    check.add_argument("--report")
    native = commands.add_parser(
        "verify-clickhouse", help="独立clickhouse-local真实建表、灌数、类型与SQL对账"
    )
    native.add_argument("--dataset", required=True)
    native.add_argument("--binary", required=True)
    native.add_argument("--report")
    native.add_argument("--timeout", type=int, default=240)
    knowledge = commands.add_parser("knowledge", help="重建或检查生成的知识文件")
    knowledge.add_argument("--write", action="store_true")
    binding = commands.add_parser(
        "bind-knowledge", help="为已有数据创建新契约目录，不覆盖旧知识或重造数据"
    )
    binding.add_argument("--dataset", required=True)
    binding.add_argument("--output", required=True)
    business = commands.add_parser(
        "business-check", help="离线业务预期与可执行SQL，不调用模型或改写数据"
    )
    business.add_argument("--dataset", required=True)
    business.add_argument("--report", required=True)
    loader = commands.add_parser(
        "load", help="只向显式指定的回环端口创建全新starhaven_数据库"
    )
    loader.add_argument("--dataset", required=True)
    loader.add_argument("--url", required=True)
    loader.add_argument("--admin-user", default="default")
    loader.add_argument("--admin-password-file", required=True)
    loader.add_argument("--database", required=True)
    loader.add_argument("--credentials-out", required=True)
    args = parser.parse_args()
    if args.command == "business-check":
        report = evaluate_business(args.dataset)
        destination = Path(args.report)
        if destination.exists() or destination.is_symlink():
            raise ValueError("business_report_exists")
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open("x") as output:
            output.write(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(
            json.dumps(
                {
                    key: report[key]
                    for key in (
                        "status",
                        "dataset_version",
                        "scenario_count",
                        "query_count",
                        "model_requests",
                    )
                },
                ensure_ascii=False,
            )
        )
        return 0
    if args.command == "bind-knowledge":
        print(json.dumps(bind_knowledge(args.dataset, args.output), ensure_ascii=False))
        return 0
    if args.command == "knowledge":
        count = render(check=not args.write)
        print(
            json.dumps(
                dict(
                    status="passed",
                    files=count,
                    mode="write" if args.write else "check",
                ),
                ensure_ascii=False,
            )
        )
        return 0
    if args.command == "load":
        result = load_release(
            args.dataset,
            args.url,
            args.admin_user,
            args.admin_password_file,
            args.database,
            args.credentials_out,
        )
        print(json.dumps(result, ensure_ascii=False))
        return 0
    if args.command in {"build", "advance"}:
        if args.command == "advance":
            previous = load_manifest(args.previous)
            if args.days < 1 or previous["scenario"] != "clean":
                raise ValueError("advance_requires_positive_days_and_clean_source")
            current_config = digest(
                json.dumps(
                    json.loads((ROOT / "settings.json").read_text()),
                    sort_keys=True,
                    ensure_ascii=False,
                )
            )
            if (
                current_config != previous["config_sha256"]
                or implementation_fingerprint() != previous["implementation_sha256"]
            ):
                raise ValueError(
                    "advance_generator_revision_changed: rebuild explicitly as a new baseline"
                )
            manifest = generate(
                args.output,
                days=previous["days"] + args.days,
                installs=previous["installs_per_app_day"],
                seed=previous["seed"],
                start_date=previous["start_date"],
                row_budget=(
                    previous["row_budget"]
                    if args.row_budget is None
                    else args.row_budget
                ),
            )
            if (
                manifest["config_sha256"] != previous["config_sha256"]
                or manifest["implementation_sha256"]
                != previous["implementation_sha256"]
            ):
                raise ValueError(
                    "advance_generator_revision_changed: output was rebuilt, not published; inspect it as a new baseline"
                )
        else:
            manifest = generate(
                args.output,
                profile=args.profile,
                end=args.as_of or "2026-11-08",
                start_date=args.start_date,
                days=args.days,
                installs=args.installs_per_app_day,
                seed=args.seed,
                scenario=args.scenario,
                row_budget=args.row_budget,
            )
        release_knowledge(args.output)
        report = reconcile(
            args.output, Path(args.output) / "python-reconciliation.json"
        )
        print(
            json.dumps(
                dict(
                    dataset_version=manifest["dataset_version"],
                    rows=sum(info["rows"] for info in manifest["tables"].values()),
                    tables=len(manifest["tables"]),
                    reconciliation=report["status"],
                    failed=report["failed"],
                    publication="unpublished",
                    release_knowledge=str(Path(args.output) / "release-knowledge"),
                ),
                ensure_ascii=False,
            )
        )
        return 0 if report["status"] == "passed" else 2
    if args.command == "reconcile":
        report = reconcile(
            args.dataset,
            args.report or Path(args.dataset) / "python-reconciliation.json",
        )
    else:
        report = verify_native(
            args.dataset,
            args.binary,
            args.report or Path(args.dataset) / "clickhouse-reconciliation.json",
            args.timeout,
        )
    print(
        json.dumps(
            {k: v for k, v in report.items() if k not in {"results"}},
            ensure_ascii=False,
        )
    )
    return 0 if report["status"] == "passed" else 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, RuntimeError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
