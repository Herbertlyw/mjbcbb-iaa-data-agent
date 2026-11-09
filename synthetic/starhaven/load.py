"""Load only a new VV Data Agent database on an explicitly supplied loopback server."""

import base64
import json
import os
from pathlib import Path
import re
import secrets
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from .catalog import ddl
from .reconcile import reconcile, load_manifest


class ClickHouseHttpError(RuntimeError):
    def __init__(self, status, server_code=None):
        self.status = status
        self.server_code = server_code
        super().__init__(
            "clickhouse_http_status_"
            + str(status)
            + "_code_"
            + str(server_code or "unknown")
        )


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise ValueError("clickhouse_redirect_forbidden")


class LocalHttp:
    def __init__(self, url, user, password):
        parsed = urlsplit(url)
        if (
            parsed.scheme != "http"
            or parsed.hostname != "127.0.0.1"
            or not parsed.port
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.path not in {"", "/"}
        ):
            raise ValueError("explicit_loopback_http_port_required")
        self.url = url.rstrip("/")
        self.auth = (
            "Basic " + base64.b64encode((user + ":" + password).encode()).decode()
        )
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def request(self, sql, database=None, data=None):
        query = {"database": database} if database else {}
        if data is not None:
            query["query"] = sql
            payload = data
        else:
            payload = sql.encode()
        request = Request(
            self.url + "/?" + urlencode(query),
            data=payload,
            headers={
                "Authorization": self.auth,
                "Content-Type": "application/octet-stream",
            },
            method="POST",
        )
        try:
            with self.opener.open(request, timeout=60) as response:
                return response.read().decode()
        except HTTPError as error:
            # The server can echo a CREATE USER statement. Never expose its body.
            body = error.read(4096).decode("utf-8", errors="replace")
            code = re.search(r"^Code: (\d+)\.", body)
            raise ClickHouseHttpError(
                error.code, int(code.group(1)) if code else None
            ) from None


def quoted(value):
    return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'") + "'"


def load_release(dataset, url, admin_user, password_file, database, credentials_out):
    dataset = Path(dataset)
    manifest = load_manifest(dataset)
    report = reconcile(dataset)
    if report["status"] != "passed":
        raise ValueError("dataset_reconciliation_failed")
    if not re.fullmatch(r"starhaven_[a-z0-9_]{1,40}", database):
        raise ValueError("new_database_must_use_starhaven_prefix")
    credentials_out = Path(credentials_out)
    if credentials_out.exists():
        raise ValueError("credentials_output_exists")
    password = Path(password_file).read_text().strip()
    client = LocalHttp(url, admin_user, password)
    # CREATE without IF NOT EXISTS is an atomic refusal to overwrite an old DB.
    client.request("CREATE DATABASE " + database)
    for statement in ddl().split(";"):
        if statement.strip():
            client.request(statement, database)
    for table in manifest["tables"]:
        data = (dataset / (table + ".jsonl")).read_bytes()
        client.request("INSERT INTO " + table + " FORMAT JSONEachRow", database, data)
    reader = database + "_reader"
    reader_password = secrets.token_urlsafe(32)
    client.request(
        "CREATE USER "
        + reader
        + " IDENTIFIED WITH sha256_password BY "
        + quoted(reader_password)
        + " SETTINGS readonly=1, max_execution_time=3, max_rows_to_read=5000000, read_overflow_mode='throw', join_use_nulls=1, output_format_json_quote_decimals=1, max_block_size=1024"
    )
    client.request("GRANT SELECT ON " + database + ".* TO " + reader)
    readonly = LocalHttp(url, reader, reader_password)
    for table, info in manifest["tables"].items():
        count = int(readonly.request("SELECT count() FROM " + table, database).strip())
        if count != info["rows"]:
            raise RuntimeError("loaded_table_count_invalid: " + table)
    setting = int(readonly.request("SELECT getSetting('readonly')", database).strip())
    if setting != 1:
        raise RuntimeError("reader_setting_invalid")
    denied = False
    try:
        readonly.request(
            "INSERT INTO dim_country SELECT * FROM dim_country WHERE 0", database
        )
    except ClickHouseHttpError as error:
        denied = error.server_code in {164, 497}
    if not denied:
        raise RuntimeError("reader_write_was_not_denied")
    credentials_out.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(credentials_out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(
            dict(
                url=url,
                database=database,
                username=reader,
                password=reader_password,
                dataset_version=manifest["dataset_version"],
            ),
            stream,
            ensure_ascii=False,
            indent=2,
        )
        stream.write("\n")
    return dict(
        status="passed",
        database=database,
        reader=reader,
        loaded_tables=len(manifest["tables"]),
        readonly_insert_denied=True,
        dataset_version=manifest["dataset_version"],
        credentials_file=str(credentials_out),
        publication="unpublished_requires_freshness_and_host_policy",
    )
