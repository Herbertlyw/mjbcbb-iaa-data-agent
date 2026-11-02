import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { KnowledgeBase } from "./types.js";
import type { FreshnessManifest } from "./mysql-freshness.js";
import { isCalendarDate } from "./config.js";

export interface TableFreshness {
  status: "fresh" | "stale" | "missing" | "probe_failed";
  as_of: string | null;
  engine: string;
  probed_at: string;
  expected_start: string;
  expected_end: string;
  observed_start: string | null;
  observed_end: string | null;
  observed_days: number;
  missing_days: string[];
  failure_reason: string | null;
}

export interface FreshnessPublication {
  publication_id: string;
  version: number;
  published_at: string;
  source: string;
  engine: string;
  valid_until: string;
  unimplemented_engines: string[];
  tables: Record<string, TableFreshness | { status: string; as_of: string | null; failure_reason?: string | null }>;
}

interface ProbeTarget {
  table: string;
  engine: string;
  date_column: string;
  expected_start: string;
  expected_end: string;
}

interface TargetFile {
  source: string;
  engine: string;
  valid_until: string;
  unimplemented_engines?: string[];
  targets: ProbeTarget[];
}

export type FreshnessObservation = Omit<FreshnessPublication, "publication_id" | "version" | "published_at">;

export function freshnessManifest(knowledge: KnowledgeBase, targetsPath: string): FreshnessManifest {
  const raw = readFileSync(targetsPath, "utf8");
  const targets = JSON.parse(raw) as TargetFile;
  const targetTables = targets.targets.map((target) => target.table);
  const contractHashes: Record<string, string> = {};
  for (const table of targetTables) {
    const asset = knowledge.contract_by_table.get(table);
    if (asset) contractHashes[table] = asset.content_hash;
  }
  return { registry_revision: knowledge.registry_revision, target_hash: createHash("sha256").update(raw).digest("hex"), contract_hashes: contractHashes, target_tables: targetTables };
}

export function matchesFreshnessManifest(actual: FreshnessManifest, expected: FreshnessManifest): boolean {
  return actual.registry_revision === expected.registry_revision && actual.target_hash === expected.target_hash
    && JSON.stringify([...actual.target_tables].sort()) === JSON.stringify([...expected.target_tables].sort())
    && JSON.stringify(Object.entries(actual.contract_hashes).sort()) === JSON.stringify(Object.entries(expected.contract_hashes).sort());
}

export function publishFreshness(sourcePath: string, destinationPath: string): FreshnessPublication {
  const source = JSON.parse(readFileSync(sourcePath, "utf8")) as Omit<FreshnessPublication, "publication_id" | "version" | "published_at">;
  const previous = readPublication(destinationPath);
  const publication: FreshnessPublication = {
    publication_id: `fp_${Date.now().toString(36)}`,
    version: (previous?.version ?? 0) + 1,
    published_at: new Date().toISOString(),
    source: source.source,
    engine: source.engine ?? "sqlite-local",
    valid_until: source.valid_until,
    unimplemented_engines: source.unimplemented_engines ?? [],
    tables: source.tables,
  };
  writeAtomic(destinationPath, publication);
  return publication;
}

export function probeAndPublish(input: { databasePath: string; targetsPath: string; destinationPath: string }): FreshnessPublication {
  const observation = probeSqliteFreshness(input);
  const previous = readPublication(input.destinationPath);
  const publication: FreshnessPublication = { ...observation, publication_id: `fp_${Date.now().toString(36)}`, version: (previous?.version ?? 0) + 1, published_at: new Date().toISOString() };
  writeAtomic(input.destinationPath, publication);
  return publication;
}

export function probeSqliteFreshness(input: { databasePath: string; targetsPath: string }): FreshnessObservation {
  const targets = JSON.parse(readFileSync(input.targetsPath, "utf8")) as TargetFile;
  const probedAt = new Date().toISOString();
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(input.databasePath, { readOnly: true });
  } catch {
    throw new Error("合成库无法只读打开，本次不发布。");
  }
  try {
    const tables: FreshnessPublication["tables"] = {};
    for (const target of targets.targets) {
      tables[target.table] = probeTarget(database, target, probedAt);
    }
    return {
      source: targets.source,
      engine: targets.engine,
      valid_until: targets.valid_until,
      unimplemented_engines: targets.unimplemented_engines ?? [],
      tables,
    };
  } finally {
    database.close();
  }
}

export async function probeClickHouseAndPublish(input: {
  query: (sql: string) => Promise<Array<{ event_date: string }>>;
  targetsPath: string;
  destinationPath: string;
}): Promise<FreshnessPublication> {
  const observation = await probeClickHouseFreshness(input);
  const previous = readPublication(input.destinationPath);
  const publication: FreshnessPublication = { ...observation, publication_id: `fp_${Date.now().toString(36)}`, version: (previous?.version ?? 0) + 1, published_at: new Date().toISOString() };
  writeAtomic(input.destinationPath, publication);
  return publication;
}

export async function probeClickHouseFreshness(input: {
  query: (sql: string) => Promise<Array<{ event_date: string }>>;
  targetsPath: string;
}): Promise<FreshnessObservation> {
  const targets = JSON.parse(readFileSync(input.targetsPath, "utf8")) as TargetFile;
  const probedAt = new Date().toISOString();
  const tables: FreshnessPublication["tables"] = {};
  for (const target of targets.targets) {
    tables[target.table] = await probeClickHouseTarget(input.query, target, probedAt);
  }
  return {
    source: targets.source,
    engine: "clickhouse-local",
    valid_until: targets.valid_until,
    unimplemented_engines: targets.unimplemented_engines ?? [],
    tables,
  };
}

async function probeClickHouseTarget(
  query: (sql: string) => Promise<Array<{ event_date: string }>>,
  target: ProbeTarget,
  probedAt: string,
): Promise<TableFreshness> {
  const base: TableFreshness = {
    status: "probe_failed",
    as_of: null,
    engine: "clickhouse-local",
    probed_at: probedAt,
    expected_start: target.expected_start,
    expected_end: target.expected_end,
    observed_start: null,
    observed_end: null,
    observed_days: 0,
    missing_days: [],
    failure_reason: null,
  };
  if (target.engine !== "clickhouse-local") return { ...base, failure_reason: `engine_not_implemented:${target.engine}` };
  if (!/^[a-z_][a-z0-9_]*$/u.test(target.table) || !/^[a-z_][a-z0-9_]*$/u.test(target.date_column)) {
    return { ...base, failure_reason: "unsafe_identifier" };
  }
  const expected = enumerateDates(target.expected_start, target.expected_end);
  if (!expected) return { ...base, failure_reason: "expected_period_invalid" };
  let rows: Array<{ event_date: string }>;
  try {
    rows = await query(
      `SELECT toString(${target.date_column}) AS event_date FROM ${target.table} WHERE ${target.date_column} >= '${target.expected_start}' AND ${target.date_column} <= '${target.expected_end}'`,
    );
  } catch {
    return { ...base, failure_reason: "probe_query_failed" };
  }
  const seen = [...new Set(rows.map((row) => String(row.event_date).slice(0, 10)))].sort();
  const missing = expected.filter((date) => !seen.includes(date));
  const shared = { ...base, observed_start: seen[0] ?? null, observed_end: seen.at(-1) ?? null, observed_days: seen.length, missing_days: missing };
  if (missing.length === 0) return { ...shared, status: "fresh", failure_reason: null };
  return { ...shared, status: "stale", failure_reason: "expected_period_incomplete" };
}

export function readPublication(destinationPath: string): FreshnessPublication | null {
  try {
    return JSON.parse(readFileSync(destinationPath, "utf8")) as FreshnessPublication;
  } catch {
    return null;
  }
}

function probeTarget(database: DatabaseSync, target: ProbeTarget, probedAt: string): TableFreshness {
  const base: TableFreshness = {
    status: "probe_failed",
    as_of: null,
    engine: target.engine,
    probed_at: probedAt,
    expected_start: target.expected_start,
    expected_end: target.expected_end,
    observed_start: null,
    observed_end: null,
    observed_days: 0,
    missing_days: [],
    failure_reason: null,
  };
  if (target.engine !== "sqlite-local") {
    return { ...base, failure_reason: `engine_not_implemented:${target.engine}` };
  }
  if (!/^[a-z_][a-z0-9_]*$/u.test(target.table) || !/^[a-z_][a-z0-9_]*$/u.test(target.date_column)) {
    return { ...base, failure_reason: "unsafe_identifier" };
  }
  const expected = enumerateDates(target.expected_start, target.expected_end);
  if (!expected) return { ...base, failure_reason: "expected_period_invalid" };
  let rows: Array<{ event_date: string }>;
  try {
    rows = database
      .prepare(`SELECT ${target.date_column} AS event_date FROM ${target.table} WHERE ${target.date_column} >= ? AND ${target.date_column} <= ?`)
      .all(target.expected_start, target.expected_end) as Array<{ event_date: string }>;
  } catch {
    return { ...base, failure_reason: "probe_query_failed" };
  }
  const seen = [...new Set(rows.map((row) => String(row.event_date)))].sort();
  const missing = expected.filter((date) => !seen.includes(date));
  const shared = {
    ...base,
    as_of: null,
    observed_start: seen[0] ?? null,
    observed_end: seen.at(-1) ?? null,
    observed_days: seen.length,
    missing_days: missing,
  };
  if (missing.length === 0) return { ...shared, status: "fresh", failure_reason: null };
  return { ...shared, status: "stale", failure_reason: "expected_period_incomplete" };
}

function enumerateDates(start: string, end: string): string[] | null {
  if (!isCalendarDate(start) || !isCalendarDate(end) || start > end) return null;
  const dates: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor.getTime() <= last.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (dates.length > 400) return null;
  }
  return dates;
}

function writeAtomic(destinationPath: string, publication: FreshnessPublication): void {
  mkdirSync(path.dirname(destinationPath), { recursive: true });
  const temporary = `${destinationPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(publication));
  renameSync(temporary, destinationPath);
}
