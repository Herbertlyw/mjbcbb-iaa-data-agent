import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { repoRoot } from "../src/config.js";
import { openSimulatedDatabase } from "../src/database.js";
import { dimensionSnapshotMatches, freshnessManifest, freshnessPeriodKey, matchesFreshnessManifest, probeAndPublish, probeClickHouseFreshness, probeSqliteFreshness, readPublication } from "../src/freshness.js";
import { loadKnowledge } from "../src/knowledge.js";
import { createRuntime } from "../src/runtime.js";

test("六列规则快照以完整键绑定，NULL 不等于空字符串或其他值", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vv-dimension-probe-"));
  try {
    const knowledge = loadKnowledge(path.join(repoRoot(), "knowledge", "starhaven"));
    const release = JSON.parse(readFileSync(path.join(repoRoot(), "knowledge", "starhaven", "freshness-targets.json"), "utf8"));
    // Static knowledge is deliberately unpublished; select the generated target
    // shape from a test fixture rather than asserting freshness of a real DB.
    const contract = knowledge.contract_by_table.get("config_business_policy_snapshot")?.contract;
    assert.ok(contract);
    const keys = contract.grain!;
    const columns = contract.columns.map((column) => column.name);
    const target = { table: contract.table, engine: "clickhouse-local", kind: "dimension_snapshot", key_columns: keys, snapshot_columns: columns };
    const targetsPath = path.join(dir, "targets.json");
    writeFileSync(targetsPath, JSON.stringify({ ...release, valid_until: "2099-12-31", targets: [target] }));
    assert.equal(keys.length, 6);
    assert.deepEqual(freshnessManifest(knowledge, targetsPath).dimension_targets?.[contract.table]?.key_columns, keys);
    const row = columns.map((column) => column === "effective_to" ? null : column === "scope_key" ? "app_a" : column);
    const probe = async (rows: Array<Array<string | null>>) => probeClickHouseFreshness({ targetsPath, query: async () => rows.map((value) => ({ event_date: JSON.stringify(value) })) });
    const snapshot = (await probe([row])).tables[contract.table];
    assert.equal(snapshot?.status, "fresh");
    const key = Object.fromEntries(keys.map((name) => [name, row[columns.indexOf(name)] as string]));
    assert.equal(dimensionSnapshotMatches(snapshot, contract.table, key, "scope_key", "app_a"), true);
    assert.equal(dimensionSnapshotMatches(snapshot, contract.table, key, "effective_to", ""), false);
    assert.equal(dimensionSnapshotMatches(snapshot, contract.table, { ...key, scope_key: "app_b" }, "scope_key", "app_a"), false);
    assert.equal((await probe([row, row])).tables[contract.table]?.status, "probe_failed");
    const invalidKey = [...row]; invalidKey[columns.indexOf(keys[0]!)] = null;
    assert.equal((await probe([invalidKey])).tables[contract.table]?.status, "probe_failed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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

test("无业务日期的维表发布键值摘要；重复键、读取失败和标签变化不会冒充已发布观察", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dataagent-dimension-probe-"));
  const targetsPath = path.join(dir, "targets.json");
  const knowledge = loadKnowledge(path.join(repoRoot(), "knowledge", "harborlight"));
  const target = { table: "dim_fox_title", engine: "clickhouse-local", kind: "dimension_snapshot", key_columns: ["title_id"], snapshot_columns: ["title_id", "title_name", "genre", "launched_on"] };
  try {
    writeFileSync(targetsPath, JSON.stringify({ source: "synthetic", engine: "clickhouse-local", valid_until: "2027-04-01", targets: [target] }));
    const manifest = freshnessManifest(knowledge, targetsPath, { simulatedToday: "2026-10-29" });
    assert.deepEqual(manifest.target_tables, ["dim_fox_title"]);
    assert.ok(manifest.contract_hashes.dim_fox_title);
    assert.deepEqual(manifest.dimension_targets?.dim_fox_title?.key_columns, ["title_id"]);
    const revised = { ...knowledge, contract_by_table: new Map(knowledge.contract_by_table) };
    const asset = revised.contract_by_table.get("dim_fox_title");
    assert.ok(asset);
    revised.contract_by_table.set("dim_fox_title", { ...asset, content_hash: "a".repeat(64) });
    assert.equal(matchesFreshnessManifest(manifest, freshnessManifest(revised, targetsPath)), false, "契约内容变化不能沿用旧观察");
    const synthetic = [
      ["paper_lantern", "纸灯", "adventure", "2026-01-01"],
      ["glass_minnow", "玻璃鲦", "puzzle", "2026-01-02"],
    ];
    const probe = async (rows: string[][]) => probeClickHouseFreshness({ targetsPath, query: async (sql) => {
      assert.match(sql, /FROM dim_fox_title ORDER BY title_id LIMIT 1001/u);
      return rows.map((row) => ({ event_date: JSON.stringify(row) }));
    } });
    const observation = await probe(synthetic);
    const title = observation.tables.dim_fox_title;
    assert.equal(title?.status, "fresh");
    assert.ok(title && "kind" in title && title.kind === "dimension_snapshot");
    assert.ok(dimensionSnapshotMatches(title, "dim_fox_title", { title_id: "paper_lantern" }, "title_name", "纸灯"));
    assert.equal(dimensionSnapshotMatches(title, "dim_fox_title", { title_id: "paper_lantern" }, "title_name", "另一个合成标签"), false);
    assert.equal(dimensionSnapshotMatches(title, "dim_fox_title", { title_id: "not_published" }, "title_name", "纸灯"), false);
    assert.equal(dimensionSnapshotMatches(title, "dim_fox_title", { title_id: "paper_lantern" }, "unknown_column", "纸灯"), false);
    assert.equal(JSON.stringify(title).includes("paper_lantern"), false, "发布只保存观察摘要，不保存维表明文");
    if (title && "snapshot_cell_hashes" in title) {
      const tampered = { ...title, snapshot_cell_hashes: [...title.snapshot_cell_hashes].reverse() };
      assert.equal(dimensionSnapshotMatches(tampered, "dim_fox_title", { title_id: "paper_lantern" }, "title_name", "纸灯"), false);
    }
    assert.equal((await probe([...synthetic, ["paper_lantern", "另一个标签", "adventure", "2026-01-01"]])).tables.dim_fox_title?.status, "probe_failed");
    assert.equal((await probe([])).tables.dim_fox_title?.status, "missing");
    assert.equal((await probe(Array.from({ length: 1001 }, (_, index) => [`id_${index}`, "标签", "genre", "2026-01-01"]))).tables.dim_fox_title?.status, "probe_failed");
    assert.equal((await probe([["paper_lantern", "x".repeat(4097), "genre", "2026-01-01"]])).tables.dim_fox_title?.status, "probe_failed");
    const failed = await probeClickHouseFreshness({ targetsPath, query: async () => { throw new Error("synthetic_private_error_marker"); } });
    assert.equal(failed.tables.dim_fox_title?.status, "probe_failed");
    assert.equal(JSON.stringify(failed).includes("synthetic_private_error_marker"), false);
    const unsafe = { ...target, snapshot_columns: ["title_id", "not_a_contract_column"] };
    writeFileSync(targetsPath, JSON.stringify({ source: "synthetic", engine: "clickhouse-local", valid_until: "2027-04-01", targets: [unsafe] }));
    assert.throws(() => freshnessManifest(knowledge, targetsPath), /freshness_dimension_contract_mismatch/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
