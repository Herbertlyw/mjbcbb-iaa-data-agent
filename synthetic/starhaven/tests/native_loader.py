"""Validate the loader on an owned, temporary ClickHouse server.

Run explicitly: python3 -m synthetic.starhaven.tests.native_loader --binary PATH
This starts one new process, binds only 127.0.0.1, and removes its own data.
"""

import argparse
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
from urllib.error import URLError

from synthetic.starhaven.generate import generate
from synthetic.starhaven.load import ClickHouseHttpError, LocalHttp, load_release


def verify_loader(binary, after_load=None):
    binary = Path(binary).resolve()
    if not binary.is_file():
        raise ValueError("clickhouse_binary_missing")
    with tempfile.TemporaryDirectory(prefix="starhaven-loader-") as directory:
        work = Path(directory)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        # A fresh random password prevents accidentally using an unrelated server.
        password = secrets.token_hex(24)
        password_file = work / "admin-password"
        password_file.write_text(password)
        os.chmod(password_file, 0o600)
        config = work / "config.xml"
        config.write_text(
            "<clickhouse><logger><level>warning</level><console>1</console></logger>"
            f"<http_port>{port}</http_port><listen_host>127.0.0.1</listen_host>"
            f"<path>{work}/state/</path><tmp_path>{work}/tmp/</tmp_path>"
            f"<access_control_path>{work}/access/</access_control_path>"
            f"<user_files_path>{work}/files/</user_files_path>"
            "<background_schedule_pool_size>16</background_schedule_pool_size>"
            "<mark_cache_size>16777216</mark_cache_size>"
            "<max_server_memory_usage>1073741824</max_server_memory_usage>"
            "<profiles><default><max_threads>2</max_threads></default></profiles>"
            "<users><default>"
            f"<password>{password}</password>"
            "<networks><ip>127.0.0.1</ip></networks>"
            "<profile>default</profile><quota>default</quota>"
            "<access_management>1</access_management>"
            "</default></users><quotas><default/></quotas></clickhouse>"
        )
        os.chmod(config, 0o600)
        dataset = work / "dataset"
        manifest = generate(dataset, profile="tiny", installs=2)
        url = "http://127.0.0.1:" + str(port)
        admin = LocalHttp(url, "default", password)
        with (work / "server.log").open("w") as log:
            process = subprocess.Popen(
                [str(binary), "server", "--config-file", str(config)],
                stdout=log,
                stderr=log,
            )
            try:
                deadline = time.monotonic() + 40
                while True:
                    if process.poll() is not None:
                        raise RuntimeError("owned_clickhouse_server_exited")
                    try:
                        if admin.request("SELECT 1").strip() == "1":
                            break
                    except (OSError, URLError, ClickHouseHttpError):
                        pass
                    if time.monotonic() >= deadline:
                        raise RuntimeError("owned_clickhouse_server_not_ready")
                    time.sleep(0.05)
                credentials = work / "credentials.json"
                report = load_release(
                    dataset,
                    url,
                    "default",
                    password_file,
                    "starhaven_owned_validation",
                    credentials,
                )
                if credentials.stat().st_mode & 0o777 != 0o600:
                    raise RuntimeError("reader_credentials_permissions_invalid")
                if manifest["dataset_version"] != report["dataset_version"]:
                    raise RuntimeError("loaded_version_mismatch")
                try:
                    load_release(
                        dataset,
                        url,
                        "default",
                        password_file,
                        "starhaven_owned_validation",
                        work / "second.json",
                    )
                except ClickHouseHttpError as error:
                    if error.server_code != 82:
                        raise
                else:
                    raise RuntimeError("existing_database_was_not_refused")
                report = dict(
                    status="passed",
                    tables=report["loaded_tables"],
                    readonly_insert_denied=report["readonly_insert_denied"],
                    credentials_mode="0600",
                    existing_database_refused=True,
                    engine_version=subprocess.check_output(
                        [str(binary), "local", "--version"],
                        text=True,
                    ).strip(),
                    scope="Owned native loopback HTTP server; not Docker or API/Pi/model validation",
                )
                if after_load is not None:
                    report["host"] = after_load(work, dataset, credentials)
                return report
            finally:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True)
    parser.add_argument("--report")
    args = parser.parse_args()
    result = verify_loader(args.binary)
    if args.report:
        Path(args.report).write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n"
        )
    print(json.dumps(result, ensure_ascii=False))
