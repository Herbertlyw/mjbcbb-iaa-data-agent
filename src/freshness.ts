import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { KnowledgeBase } from "./types.js";
import type { FreshnessManifest } from "./mysql-freshness.js";
import { currentCalendarDate, isCalendarDate } from "./config.js";

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

/** A publication is an observed, bounded dimension snapshot, not an atomic
 * ClickHouse/MySQL transaction or an immutable database version. Only hashes
 * of non-sensitive key/column values are persisted. */
export interface DimensionSnapshotFreshness {
  kind: "dimension_snapshot";
  status: "fresh" | "missing" | "probe_failed";
  as_of: string | null;
  engine: "clickhouse-local";
  probed_at: string;
  key_columns: string[];
  snapshot_columns: string[];
  observed_rows: number;
  snapshot_cell_hashes: string[];
  snapshot_hash: string | null;
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
  tables: Record<string, TableFreshness | DimensionSnapshotFreshness | { status: string; as_of: string | null; failure_reason?: string | null }>;
  period_key?: string;
}

interface ProbeTarget {
  table: string;
  engine: string;
  date_column: string;
  expected_start: string;
  expected_end: string;
  kind?: "dimension_snapshot";
  key_columns?: string[];
  snapshot_columns?: string[];
}

interface TargetDefinition extends Omit<ProbeTarget, "expected_start" | "expected_end" | "date_column"> {
  date_column?: string;
  expected_start?: string;
  expected_end?: string;
  period?: { timezone: string; lag_days: number; window_days: number };
}

interface TargetFile {
  source: string;
  engine: string;
  valid_until: string;
  valid_for_days?: number;
  timezone?: string;
  unimplemented_engines?: string[];
  targets: TargetDefinition[];
}

interface ProbeClock { now?: Date; simulatedToday?: string }
interface ResolvedTargetFile extends Omit<TargetFile, "targets"> { targets: ProbeTarget[] }

export type FreshnessObservation = Omit<FreshnessPublication, "publication_id" | "version" | "published_at">;

export function freshnessManifest(knowledge: KnowledgeBase, targetsPath: string, clock: ProbeClock = {}): FreshnessManifest {
  const raw = readFileSync(targetsPath, "utf8");
  const definition = JSON.parse(raw) as TargetFile;
  const targets = resolveTargets(definition, clock);
  if (definition.valid_for_days !== undefined && definition.timezone !== knowledge.timezone) throw new Error("freshness_validity_timezone_mismatch");
  const targetTables = targets.targets.map((target) => target.table);
  const contractHashes: Record<string, string> = {};
  const dimensionTargets: NonNullable<FreshnessManifest["dimension_targets"]> = {};
  for (const target of definition.targets) {
    const asset = knowledge.contract_by_table.get(target.table);
    if (asset) contractHashes[target.table] = asset.content_hash;
    if (target.kind === "dimension_snapshot") {
      const contract = asset?.contract;
      const keys = target.key_columns; const columns = target.snapshot_columns;
      if (!contract || contract.engine !== "clickhouse-local" || target.engine !== contract.engine || contract.series || !Array.isArray(contract.grain) || !keys || !columns || !validSnapshotColumns(keys, columns) || [...contract.grain].sort().join("|") !== [...keys].sort().join("|") || columns.some((name) => !contract.columns.some((column) => column.name === name) || contract.sensitive_columns.includes(name))) throw new Error("freshness_dimension_contract_mismatch");
      dimensionTargets[target.table] = { key_columns: [...keys], snapshot_columns: [...columns] };
    }
    if (target.period && (!asset?.contract || !target.date_column || asset.contract.timezone !== target.period.timezone || !asset.contract.must_filter.includes(target.date_column))) {
      throw new Error("freshness_period_contract_mismatch");
    }
  }
  const periodIdentity = resolvedPeriodKey(definition, targets) ?? "";
  return { registry_revision: knowledge.registry_revision, target_hash: createHash("sha256").update(raw).update(periodIdentity).digest("hex"), contract_hashes: contractHashes, target_tables: targetTables, ...(Object.keys(dimensionTargets).length ? { dimension_targets: dimensionTargets } : {}) };
}

function resolvedPeriodKey(definition: TargetFile, resolved: ResolvedTargetFile): string | null {
  if (!definition.targets.some((target) => target.period) && definition.valid_for_days === undefined) return null;
  const identity = { valid_until: resolved.valid_until, targets: resolved.targets.map(({ table, expected_start, expected_end }) => ({ table, expected_start, expected_end })) };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function freshnessPeriodKey(targetsPath: string, clock: ProbeClock = {}): string | null {
  const definition = JSON.parse(readFileSync(targetsPath, "utf8")) as TargetFile;
  return resolvedPeriodKey(definition, resolveTargets(definition, clock));
}

function resolveTargets(definition: TargetFile, clock: ProbeClock): ResolvedTargetFile {
  const now = clock.now ?? new Date();
  const simulatedToday = clock.simulatedToday ?? process.env.SIMULATED_TODAY ?? "";
  if (simulatedToday && !isCalendarDate(simulatedToday)) throw new Error("freshness_clock_invalid");
  const calendar = (timezone: string) => currentCalendarDate({ simulatedToday }, timezone, now);
  const shift = (date: string, days: number) => {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  };
  const targets = definition.targets.map((target): ProbeTarget => {
    if (target.kind === "dimension_snapshot") {
      if (target.date_column || target.expected_start || target.expected_end || target.period || !validSnapshotColumns(target.key_columns, target.snapshot_columns)) throw new Error("freshness_dimension_target_invalid");
      return { ...target, date_column: "", expected_start: "", expected_end: "" };
    }
    if (!target.period) return { ...target, date_column: target.date_column ?? "", expected_start: target.expected_start ?? "", expected_end: target.expected_end ?? "" };
    const { timezone, lag_days, window_days } = target.period;
    if (target.expected_start || target.expected_end || !Number.isInteger(lag_days) || lag_days < 0 || lag_days > 3660 || !Number.isInteger(window_days) || window_days < 1 || window_days > 400) throw new Error("freshness_period_invalid");
    // Validate timezone even when a test clock supplies a calendar date.
    new Intl.DateTimeFormat("en", { timeZone: timezone });
    const expected_end = shift(calendar(timezone), -lag_days);
    return { table: target.table, engine: target.engine, date_column: target.date_column ?? "", expected_start: shift(expected_end, 1 - window_days), expected_end };
  });
  let valid_until = definition.valid_until;
  if (definition.valid_for_days !== undefined) {
    if (!Number.isInteger(definition.valid_for_days) || definition.valid_for_days < 0 || definition.valid_for_days > 30 || !definition.timezone) throw new Error("freshness_validity_invalid");
    new Intl.DateTimeFormat("en", { timeZone: definition.timezone });
    valid_until = shift(calendar(definition.timezone), definition.valid_for_days);
  }
  if (!isCalendarDate(valid_until)) throw new Error("freshness_validity_invalid");
  return { ...definition, valid_until, targets };
}

export function matchesFreshnessManifest(actual: FreshnessManifest, expected: FreshnessManifest): boolean {
  return actual.registry_revision === expected.registry_revision && actual.target_hash === expected.target_hash
    && JSON.stringify([...actual.target_tables].sort()) === JSON.stringify([...expected.target_tables].sort())
    && JSON.stringify(Object.entries(actual.contract_hashes).sort()) === JSON.stringify(Object.entries(expected.contract_hashes).sort())
    && JSON.stringify(Object.entries(actual.dimension_targets ?? {}).sort()) === JSON.stringify(Object.entries(expected.dimension_targets ?? {}).sort());
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

export function probeAndPublish(input: { databasePath: string; targetsPath: string; destinationPath: string } & ProbeClock): FreshnessPublication {
  const observation = probeSqliteFreshness(input);
  const previous = readPublication(input.destinationPath);
  const publication: FreshnessPublication = { ...observation, publication_id: `fp_${Date.now().toString(36)}`, version: (previous?.version ?? 0) + 1, published_at: new Date().toISOString() };
  writeAtomic(input.destinationPath, publication);
  return publication;
}

export function probeSqliteFreshness(input: { databasePath: string; targetsPath: string } & ProbeClock): FreshnessObservation {
  const definition = JSON.parse(readFileSync(input.targetsPath, "utf8")) as TargetFile;
  const targets = resolveTargets(definition, input);
  const periodKey = resolvedPeriodKey(definition, targets);
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
      ...(periodKey ? { period_key: periodKey } : {}),
    };
  } finally {
    database.close();
  }
}

export async function probeClickHouseAndPublish(input: {
  query: (sql: string) => Promise<Array<{ event_date: string }>>;
  targetsPath: string;
  destinationPath: string;
} & ProbeClock): Promise<FreshnessPublication> {
  const observation = await probeClickHouseFreshness(input);
  const previous = readPublication(input.destinationPath);
  const publication: FreshnessPublication = { ...observation, publication_id: `fp_${Date.now().toString(36)}`, version: (previous?.version ?? 0) + 1, published_at: new Date().toISOString() };
  writeAtomic(input.destinationPath, publication);
  return publication;
}

export async function probeClickHouseFreshness(input: {
  query: (sql: string) => Promise<Array<{ event_date: string }>>;
  targetsPath: string;
} & ProbeClock): Promise<FreshnessObservation> {
  const definition = JSON.parse(readFileSync(input.targetsPath, "utf8")) as TargetFile;
  const targets = resolveTargets(definition, input);
  const periodKey = resolvedPeriodKey(definition, targets);
  const probedAt = new Date().toISOString();
  const tables: FreshnessPublication["tables"] = {};
  for (const target of targets.targets) {
    tables[target.table] = target.kind === "dimension_snapshot"
      ? await probeDimensionSnapshot(input.query, target, probedAt)
      : await probeClickHouseTarget(input.query, target, probedAt);
  }
  return {
    source: targets.source,
    engine: "clickhouse-local",
    valid_until: targets.valid_until,
    unimplemented_engines: targets.unimplemented_engines ?? [],
    tables,
    ...(periodKey ? { period_key: periodKey } : {}),
  };
}

const SNAPSHOT_MAX_ROWS = 1000;
const SNAPSHOT_MAX_BYTES = 2_000_000;
const SNAPSHOT_IDENTIFIER = /^[a-z_][a-z0-9_]*$/u;

function validSnapshotColumns(keys: unknown, columns: unknown): keys is string[] {
  return Array.isArray(keys) && keys.length > 0 && keys.length <= 4 && new Set(keys).size === keys.length
    && keys.every((item) => typeof item === "string" && SNAPSHOT_IDENTIFIER.test(item))
    && Array.isArray(columns) && columns.length >= keys.length && columns.length <= 16 && new Set(columns).size === columns.length
    && columns.every((item) => typeof item === "string" && SNAPSHOT_IDENTIFIER.test(item))
    && keys.every((key) => columns.includes(key));
}

function dimensionCellHash(table: string, keys: string[], values: string[], column: string, value: string): string {
  return createHash("sha256").update(JSON.stringify(["dimension_snapshot_cell_v1", table, keys, values, column, value])).digest("hex");
}

function dimensionSnapshotHash(table: string, keys: string[], columns: string[], cells: string[]): string {
  return createHash("sha256").update(JSON.stringify(["dimension_snapshot_v1", table, keys, columns, cells])).digest("hex");
}

/** Validate the complete observation before its MySQL batch can be
 * published. A failed/empty probe must not retain an older success hash. */
export function dimensionSnapshotStatusValid(
  observation: FreshnessPublication["tables"][string] | undefined,
  table: string,
  expected?: { key_columns: string[]; snapshot_columns: string[] },
): observation is DimensionSnapshotFreshness {
  if (!observation || !("kind" in observation) || observation.kind !== "dimension_snapshot" || observation.engine !== "clickhouse-local" || !SNAPSHOT_IDENTIFIER.test(table)) return false;
  const keys = observation.key_columns; const columns = observation.snapshot_columns; const cells = observation.snapshot_cell_hashes;
  if (!validSnapshotColumns(keys, columns) || !Array.isArray(columns) || !Array.isArray(cells) || typeof observation.probed_at !== "string" || !Number.isFinite(Date.parse(observation.probed_at)) || !Number.isSafeInteger(observation.observed_rows) || observation.observed_rows < 0 || observation.observed_rows > SNAPSHOT_MAX_ROWS || cells.some((cell) => typeof cell !== "string" || !/^[a-f0-9]{64}$/u.test(cell)) || new Set(cells).size !== cells.length || JSON.stringify([...cells].sort()) !== JSON.stringify(cells)) return false;
  if (expected && (JSON.stringify(keys) !== JSON.stringify(expected.key_columns) || JSON.stringify(columns) !== JSON.stringify(expected.snapshot_columns))) return false;
  if (observation.status === "missing" || observation.status === "probe_failed") return observation.as_of === null && observation.observed_rows === 0 && observation.snapshot_hash === null && cells.length === 0 && typeof observation.failure_reason === "string" && observation.failure_reason.length > 0;
  return observation.status === "fresh" && observation.observed_rows > 0 && observation.as_of === observation.probed_at && observation.failure_reason === null && cells.length === observation.observed_rows * columns.length && observation.snapshot_hash === dimensionSnapshotHash(table, keys, columns, cells);
}

/** Checks one actual JOIN observation against the current authoritative
 * publication. Hashes bind individual values to the full declared key; they
 * do not constitute a signature or prove a cross-database snapshot. */
export function dimensionSnapshotMatches(
  observation: FreshnessPublication["tables"][string] | undefined,
  table: string,
  key: Record<string, string>,
  column: string,
  value: string,
): boolean {
  if (!dimensionSnapshotStatusValid(observation, table) || observation.status !== "fresh") return false;
  const keys = observation.key_columns; const columns = observation.snapshot_columns; const cells = observation.snapshot_cell_hashes;
  if (!columns.includes(column) || typeof value !== "string" || !key || typeof key !== "object" || Array.isArray(key) || JSON.stringify(Object.keys(key).sort()) !== JSON.stringify([...keys].sort()) || keys.some((name) => typeof key[name] !== "string")) return false;
  return cells.includes(dimensionCellHash(table, keys, keys.map((name) => key[name]!), column, value));
}

async function probeDimensionSnapshot(
  query: (sql: string) => Promise<Array<{ event_date: string }>>,
  target: ProbeTarget,
  probedAt: string,
): Promise<DimensionSnapshotFreshness> {
  const keys = target.key_columns ?? []; const columns = target.snapshot_columns ?? [];
  const base: DimensionSnapshotFreshness = { kind: "dimension_snapshot", status: "probe_failed", as_of: null, engine: "clickhouse-local", probed_at: probedAt, key_columns: keys, snapshot_columns: columns, observed_rows: 0, snapshot_cell_hashes: [], snapshot_hash: null, failure_reason: null };
  if (target.engine !== "clickhouse-local" || !SNAPSHOT_IDENTIFIER.test(target.table) || !validSnapshotColumns(keys, columns)) return { ...base, failure_reason: "dimension_target_invalid" };
  let rows: Array<{ event_date: string }>;
  try {
    const encoded = `toJSONString(tuple(${columns.map((name) => `toString(${name})`).join(", ")}))`;
    // Never silently treat an oversized value as absent: return an invalid
    // sentinel that causes this entire dimension publication to fail closed.
    rows = await query(`SELECT if(length(${encoded}) <= 4096, ${encoded}, '') AS event_date FROM ${target.table} ORDER BY ${keys.join(", ")} LIMIT ${SNAPSHOT_MAX_ROWS + 1}`);
  } catch { return { ...base, failure_reason: "probe_query_failed" }; }
  if (!Array.isArray(rows) || rows.length > SNAPSHOT_MAX_ROWS) return { ...base, failure_reason: "dimension_snapshot_row_limit" };
  if (!rows.length) return { ...base, status: "missing", failure_reason: "dimension_snapshot_empty" };
  let bytes = 0; const seenKeys = new Set<string>(); const cells: string[] = [];
  for (const row of rows) {
    if (!row || typeof row.event_date !== "string") return { ...base, failure_reason: "dimension_snapshot_row_invalid" };
    bytes += Buffer.byteLength(row.event_date);
    if (bytes > SNAPSHOT_MAX_BYTES) return { ...base, failure_reason: "dimension_snapshot_byte_limit" };
    let tuple: unknown;
    try { tuple = JSON.parse(row.event_date) as unknown; } catch { return { ...base, failure_reason: "dimension_snapshot_row_invalid" }; }
    if (!Array.isArray(tuple) || tuple.length !== columns.length || tuple.some((value) => typeof value !== "string" || Buffer.byteLength(value) > 4096)) return { ...base, failure_reason: "dimension_snapshot_row_invalid" };
    const values = tuple as string[];
    const keyValues = keys.map((name) => values[columns.indexOf(name)]!);
    if (keyValues.some((value) => !value) || seenKeys.has(JSON.stringify(keyValues))) return { ...base, failure_reason: "dimension_key_not_unique" };
    seenKeys.add(JSON.stringify(keyValues));
    for (const [index, column] of columns.entries()) cells.push(dimensionCellHash(target.table, keys, keyValues, column, values[index]!));
  }
  cells.sort();
  return { ...base, status: "fresh", as_of: probedAt, observed_rows: rows.length, snapshot_cell_hashes: cells, snapshot_hash: dimensionSnapshotHash(target.table, keys, columns, cells) };
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
