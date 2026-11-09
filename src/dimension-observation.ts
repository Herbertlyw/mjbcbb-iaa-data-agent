// Verify saved dimension labels against the current published key/value snapshot.
import { parse } from "@clickhouse/parser";
import { joinIntegerType, joinIntegerValue } from "./join-integer.js";
import {
  dimensionCellHash,
  dimensionSnapshotStatusValid,
  type FreshnessPublication,
} from "./freshness.js";
import type { DataContract, QueryResource } from "./types.js";

export interface DimensionSnapshotReceipt {
  table: string;
  snapshot_hash: string;
  observed_at: string;
  publication_id: string;
  version: number;
}

export interface VerifiedDimensionObservation {
  resource_id: string;
  execution_id: string;
  table: string;
  row: number;
  key: Record<string, string>;
  values: Array<{ column: string; description: string; value: string | null }>;
  snapshot: DimensionSnapshotReceipt;
}

export type DimensionVerification =
  | { ok: true; observations: VerifiedDimensionObservation[] }
  | {
      ok: false;
      code: "dimension_projection_unsupported" | "dimension_snapshot_mismatch";
    };

/** Prove individual keyed labels, never a complete domain or a business-date range.
 * The caller checks current task ownership, contract permissions and source hashes. */
export function verifyDimensionObservations(
  source: QueryResource,
  contract: DataContract,
  publication: FreshnessPublication,
): DimensionVerification {
  const projection = directDimensionProjection(source.sql, contract);
  if (
    !projection ||
    source.truncated ||
    source.rows.length > 1000 ||
    !source.rows.length
  )
    return { ok: false, code: "dimension_projection_unsupported" };
  const snapshot = publication.tables[contract.table];
  const receipt = source.dimension_snapshot;
  if (
    contract.series ||
    contract.must_filter.length ||
    !contract.grain?.length ||
    source.engine !== "clickhouse-local" ||
    source.result_semantics_version !== 2 ||
    source.tables.length !== 1 ||
    source.tables[0] !== contract.table ||
    source.executed_sql !== source.sql ||
    !source.execution_id ||
    source.returned_rows !== source.rows.length ||
    source.total_rows !== source.rows.length ||
    source.total_rows_exact !== true ||
    source.review_plan?.scope?.kind !== "dimension_snapshot" ||
    source.time_range.start !== contract.valid_from ||
    source.time_range.end !== contract.valid_until ||
    !dimensionSnapshotStatusValid(snapshot, contract.table) ||
    snapshot.status !== "fresh" ||
    JSON.stringify([...snapshot.key_columns].sort()) !==
      JSON.stringify([...contract.grain].sort()) ||
    !receipt ||
    receipt.table !== contract.table ||
    receipt.snapshot_hash !== snapshot.snapshot_hash ||
    receipt.observed_at !== snapshot.probed_at ||
    receipt.publication_id !== publication.publication_id ||
    receipt.version !== publication.version ||
    source.freshness_receipts.length !== 1 ||
    !source.freshness_receipts.some(
      (item) =>
        item.table === contract.table &&
        item.status === "fresh" &&
        item.publication_id === publication.publication_id &&
        item.version === publication.version,
    )
  )
    return { ok: false, code: "dimension_snapshot_mismatch" };
  const hashes = new Set(snapshot.snapshot_cell_hashes);
  const seen = new Set<string>();
  const observations: VerifiedDimensionObservation[] = [];
  for (const [index, row] of source.rows.entries()) {
    const key: Record<string, string> = {};
    for (const column of snapshot.key_columns) {
      const output = projection.find((item) => item.column === column)?.output;
      if (!output)
        return { ok: false, code: "dimension_projection_unsupported" };
      const value = row[output];
      if (
        typeof value !== "string" ||
        !value ||
        Buffer.byteLength(value) > 4096
      )
        return { ok: false, code: "dimension_snapshot_mismatch" };
      key[column] = value;
    }
    const keyValues = snapshot.key_columns.map((column) => key[column]!);
    const identity = JSON.stringify(keyValues);
    if (seen.has(identity))
      return { ok: false, code: "dimension_snapshot_mismatch" };
    seen.add(identity);
    const values: VerifiedDimensionObservation["values"] = [];
    for (const item of projection) {
      const declared = contract.columns.find(
        (column) => column.name === item.column,
      )!;
      const raw = row[item.output];
      const physical = source.column_types?.[item.output]?.replace(/\s/gu, "").toLowerCase();
      const expectedType = declared.type.replace(/\s/gu, "").toLowerCase();
      const integer = joinIntegerType(declared.type);
      // Snapshot publication stringifies typed values before hashing. The
      // query transport returns small ClickHouse integers as JS numbers;
      // canonicalize only physically matched, range-checked integers.
      const value = raw === null ? null : integer ? joinIntegerValue(raw, integer) : typeof raw === "string" ? raw : undefined;
      if (
        !Object.hasOwn(row, item.output) ||
        value === undefined || (value === null && (raw !== null || !/^nullable\(/u.test(expectedType))) ||
        (typeof value === "string" && Buffer.byteLength(value) > 4096) ||
        physical !== expectedType ||
        !snapshot.snapshot_columns.includes(item.column) ||
        !hashes.has(
          dimensionCellHash(
            contract.table,
            snapshot.key_columns,
            keyValues,
            item.column,
            value,
          ),
        )
      )
        return { ok: false, code: "dimension_snapshot_mismatch" };
      values.push({
        column: item.column,
        description: declared.description,
        value,
      });
    }
    observations.push({
      resource_id: source.resource_id,
      execution_id: source.execution_id,
      table: contract.table,
      row: index,
      key,
      values,
      snapshot: receipt,
    });
  }
  return { ok: true, observations };
}

function directDimensionProjection(
  sql: string,
  contract: DataContract,
): Array<{ column: string; output: string }> | null {
  // SQL and persisted resource bytes cross a trust boundary; do not infer
  // physical labels from arbitrary expressions or model-chosen aliases.
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  let statements: unknown;
  try {
    statements = parse(sql, { locations: false });
  } catch {
    return null;
  }
  if (!Array.isArray(statements) || statements.length !== 1) return null;
  const root = object(statements[0]);
  if (
    root?.type !== "SelectWithUnionQuery" ||
    !Array.isArray(root.selects) ||
    root.selects.length !== 1
  )
    return null;
  const select = object(root.selects[0]);
  if (
    !select ||
    select.type !== "SelectQuery" ||
    select.distinct ||
    select.group_by ||
    select.having ||
    (Array.isArray(select.with) && select.with.length)
  )
    return null;
  const from = object(select.from);
  if (!Array.isArray(from?.children) || from.children.length !== 1) return null;
  const element = object(from.children[0]);
  const expression = object(element?.table_expression);
  const table = object(expression?.database_and_table_name);
  if (
    !table ||
    table.name !== contract.table ||
    table.database ||
    expression?.subquery ||
    expression?.table_function ||
    element?.table_join ||
    element?.array_join ||
    !Array.isArray(select.select)
  )
    return null;
  const result: Array<{ column: string; output: string }> = [];
  for (const raw of select.select) {
    const item = object(raw);
    if (item?.type !== "Identifier") return null;
    const parts = Array.isArray(item.name_parts)
      ? item.name_parts
      : [item.name];
    if (
      parts.length < 1 ||
      parts.length > 2 ||
      parts.some((part) => typeof part !== "string") ||
      (parts.length === 2 &&
        parts[0] !== table.alias &&
        parts[0] !== contract.table)
    )
      return null;
    const column = String(parts.at(-1));
    const output = typeof item.alias === "string" ? item.alias : column;
    if (
      !/^[a-z_][a-z0-9_]*$/iu.test(output) ||
      ["__proto__", "constructor", "prototype"].includes(
        output.toLowerCase(),
      ) ||
      !contract.columns.some((field) => field.name === column) ||
      contract.sensitive_columns.includes(column) ||
      result.some((entry) => entry.output === output || entry.column === column)
    )
      return null;
    result.push({ column, output });
  }
  return result.length ? result : null;
}
