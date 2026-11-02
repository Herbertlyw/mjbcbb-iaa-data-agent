import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { repoRoot } from "../src/config.js";
import { openSimulatedDatabase } from "../src/database.js";
import { freshnessManifest, freshnessPeriodKey, probeAndPublish, probeClickHouseFreshness, probeSqliteFreshness, readPublication } from "../src/freshness.js";
import { loadKnowledge } from "../src/knowledge.js";
import { createRuntime } from "../src/runtime.js";

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

test("滚动周期按契约时区和延迟计算，跨午夜后旧发布不能继续冒充新鲜", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lumenfox-rolling-probe-"));
  const databasePath = path.join(dir, "business.sqlite");
  const targetsPath = path.join(dir, "targets.json");
  const destinationPath = path.join(dir, "freshness.json");
  const knowledge = loadKnowledge(path.join(repoRoot(), "knowledge", "lumenfox"));
  const definition = {
    source: "synthetic-rolling", engine: "sqlite-local", valid_until: "2027-04-01", timezone: "America/Los_Angeles", valid_for_days: 0,
    targets: [{ table: "daily_installs", engine: "sqlite-local", date_column: "event_date", period: { timezone: "America/Los_Angeles", lag_days: 17, window_days: 7 } }],
  };
  try {
    writeFileSync(targetsPath, JSON.stringify(definition));
    openSimulatedDatabase(databasePath, knowledge.seed_sql).close();
    const before = { now: new Date("2026-10-30T06:59:00Z"), simulatedToday: "" };
    const after = { now: new Date("2026-10-30T07:01:00Z"), simulatedToday: "" };
    const first = probeSqliteFreshness({ databasePath, targetsPath, ...before });
    const next = probeSqliteFreshness({ databasePath, targetsPath, ...after });
    assert.equal(first.tables.daily_installs?.status, "fresh");
    assert.equal(first.tables.daily_installs && "expected_end" in first.tables.daily_installs && first.tables.daily_installs.expected_end, "2026-10-12");
    assert.equal(next.tables.daily_installs?.status, "stale");
    assert.deepEqual(next.tables.daily_installs && "missing_days" in next.tables.daily_installs && next.tables.daily_installs.missing_days, ["2026-10-13"]);
    assert.equal(first.valid_until, "2026-10-29");
    assert.notEqual(freshnessPeriodKey(targetsPath, before), freshnessPeriodKey(targetsPath, after));
    assert.notEqual(freshnessManifest(knowledge, targetsPath, before).target_hash, freshnessManifest(knowledge, targetsPath, after).target_hash);
    const seenQueries: string[] = [];
    const failed = await probeClickHouseFreshness({ targetsPath, ...before, query: async (sql) => { seenQueries.push(sql); throw new Error("synthetic failure"); } });
    assert.equal(failed.tables.daily_installs?.status, "probe_failed");
    assert.equal(seenQueries.length, 0, "SQLite 目标不能被 ClickHouse 探测器误判为成功");
    definition.targets[0]!.engine = "clickhouse-local";
    writeFileSync(targetsPath, JSON.stringify(definition));
    const queryFailed = await probeClickHouseFreshness({ targetsPath, ...before, query: async () => { throw new Error("synthetic failure"); } });
    assert.equal(queryFailed.tables.daily_installs?.status, "probe_failed");
    assert.equal(queryFailed.tables.daily_installs && "failure_reason" in queryFailed.tables.daily_installs && queryFailed.tables.daily_installs.failure_reason, "probe_query_failed");
    definition.targets[0]!.engine = "sqlite-local";
    writeFileSync(targetsPath, JSON.stringify(definition));
    const runtime = createRuntime({ databasePath, stateDatabasePath: path.join(dir, "state.sqlite"), freshnessPath: destinationPath, freshnessTargetsPath: targetsPath, simulatedToday: "2026-10-29", startWorker: false, ephemeralDir: undefined });
    try {
      assert.equal((await runtime.freshnessHealth()).status, "published");
      runtime.config.simulatedToday = "2026-10-30";
      assert.equal((await runtime.freshnessHealth()).status, "manifest_changed");
      const session = runtime.sessions.create("analyst");
      await runtime.tools.readDataContractView(session.session_id, { asset_id: "contract.daily_installs" });
      const result = await runtime.tools.query(session.session_id, { sql: "SELECT event_date, new_users FROM daily_installs WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-12'" });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, "freshness_manifest_changed");
    } finally { await runtime.close(); }
    definition.targets[0]!.period.timezone = "Asia/Shanghai";
    writeFileSync(targetsPath, JSON.stringify(definition));
    assert.throws(() => freshnessManifest(knowledge, targetsPath, before), /freshness_period_contract_mismatch/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
