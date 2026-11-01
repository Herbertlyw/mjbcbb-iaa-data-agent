import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { repoRoot } from "../src/config.js";
import { openSimulatedDatabase } from "../src/database.js";
import { probeAndPublish, readPublication } from "../src/freshness.js";
import { loadKnowledge } from "../src/knowledge.js";

test("新鲜度角色实际探测合成库，不把连接成功或上一版成功状态当成新发布", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lumenfox-probe-"));
  const databasePath = path.join(dir, "business.sqlite");
  const destination = path.join(dir, "freshness.json");
  const knowledge = loadKnowledge(path.join(repoRoot(), "knowledge", "lumenfox"));
  openSimulatedDatabase(databasePath, knowledge.seed_sql).close();
  const targetsPath = path.join(repoRoot(), "knowledge", "lumenfox", "freshness-targets.json");
  const first = probeAndPublish({ databasePath, targetsPath, destinationPath: destination });
  assert.equal(first.engine, "sqlite-local");
  assert.equal(first.tables.daily_installs?.status, "fresh");
  assert.equal(first.tables.daily_ad_revenue?.status, "fresh");
  assert.equal(first.tables.daily_unit_economics?.status, "fresh");
  assert.equal(first.tables.legacy_installs?.status, "stale");
  assert.equal(first.tables.legacy_installs && "failure_reason" in first.tables.legacy_installs && first.tables.legacy_installs.failure_reason, "expected_period_incomplete");
  assert.equal(first.tables.remote_ads_warehouse?.status, "probe_failed");
  assert.match(String(first.tables.remote_ads_warehouse && "failure_reason" in first.tables.remote_ads_warehouse ? first.tables.remote_ads_warehouse.failure_reason : ""), /maxcompute/);
  assert.ok(first.unimplemented_engines.includes("clickhouse"));
  const narrowTargets = path.join(dir, "targets.json");
  writeFileSync(narrowTargets, JSON.stringify({
    source: "lumenfox-synthetic",
    engine: "sqlite-local",
    valid_until: "2027-04-01",
    unimplemented_engines: ["maxcompute"],
    targets: [{ table: "table_that_is_not_seeded", engine: "sqlite-local", date_column: "event_date", expected_start: "2026-10-06", expected_end: "2026-10-06" }],
  }));
  const second = probeAndPublish({ databasePath, targetsPath: narrowTargets, destinationPath: destination });
  assert.equal(second.version, first.version + 1);
  assert.equal(second.tables.table_that_is_not_seeded?.status, "probe_failed");
  assert.equal(second.tables.daily_installs, undefined);
  const stored = readPublication(destination);
  assert.equal(stored?.publication_id, second.publication_id);
  assert.equal(stored?.tables.daily_installs, undefined);
});
