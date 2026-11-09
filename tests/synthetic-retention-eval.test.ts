import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);
test("留存金标准按同一队列分组加权，缺日、重复组和伪造答案失败关闭", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vv-retention-oracle-"));
  const write = (file: string, value: string) => writeFile(path.join(dir, file), value);
  try {
    const app = { dataset_version: "synthetic-test", app_id: "demo_ios", game_name: "演示", game_id: "demo", platform: "ios" };
    await write("dim_app.jsonl", JSON.stringify(app) + "\n");
    const rows = [
      { age: 1, group: "a", base: 2, retained: 2 }, { age: 1, group: "b", base: 8, retained: 3 },
      { age: 7, group: "a", base: 2, retained: 1 }, { age: 7, group: "b", base: 8, retained: 2 },
    ].map(item => ({ dataset_version: "synthetic-test", app_id: "demo_ios", install_cohort_date: "2026-10-01", observe_date: item.age === 1 ? "2026-10-02" : "2026-10-08", age_days: item.age, acquisition_country_code: "US", ua_channel_id: item.group, campaign_id: null, ad_group_id: null, ad_id: null, creative_id: null, cohort_size_devices: item.base, retained_devices: item.retained, completeness_state: "complete", maturity_state: "observed" }));
    const data = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
    await write("fact_cohort_quality_daily.jsonl", data);
    const tables: Record<string, { sha256: string; bytes: number }> = {};
    for (const name of ["dim_app", "fact_cohort_quality_daily"]) {
      const bytes = await readFile(path.join(dir, `${name}.jsonl`));
      tables[name] = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
    }
    await write("manifest.json", JSON.stringify({ dataset_version: "synthetic-test", as_of: "2026-11-08", tables }));
    const out = path.join(dir, "cases.json");
    const command = ["scripts/generate-synthetic-retention-eval.py", "--dataset", dir, "--seed", "1", "--output", out];
    await run("python3", command);
    const fixture = JSON.parse(await readFile(out, "utf8"));
    assert.deepEqual({ base: fixture.cases[0].oracle.cohort_size, day1: fixture.cases[0].oracle.rate_day1_percent, day7: fixture.cases[0].oracle.rate_day7_percent }, { base: 10, day1: "50.000000", day7: "30.000000" });
    fixture.cases[0].oracle.rate_day1_percent = "70.000000"; // average of group rates is wrong
    await write("forged.json", JSON.stringify(fixture));
    await write("reader.json", JSON.stringify({ url: "http://127.0.0.1:1", username: "starhaven_preflight_0123456789_reader", password: "fictional", database: "starhaven_preflight_0123456789" }));
    await assert.rejects(run("python3", ["scripts/check-synthetic-evals.py", "--dataset", dir, "--cases", path.join(dir, "forged.json"), "--reader-file", path.join(dir, "reader.json"), "--output", path.join(dir, "checked.json")], { env: { ...process.env, PYTHONPATH: process.cwd() } }), (error: any) => /oracle_value_mismatch/.test(error.stderr));
    const missingKey = rows.map((row, index) => { if (index !== 0) return row; const { campaign_id: _missing, ...rest } = row; return rest; });
    for (const bad of [rows.slice(0, 3), [...rows, rows[0]!], rows.map((row, index) => index === 0 ? { ...row, retained_devices: null } : row), rows.map((row, index) => index === 0 ? { ...row, age_days: true } : row), missingKey]) {
      await write("fact_cohort_quality_daily.jsonl", bad.map(row => JSON.stringify(row)).join("\n") + "\n");
      await assert.rejects(run("python3", ["scripts/generate-synthetic-retention-eval.py", "--dataset", dir, "--seed", "1", "--output", path.join(dir, "bad.json")]));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
