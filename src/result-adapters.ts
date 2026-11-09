// Convert proven query and alignment resources to typed result tables.
import { type VerifiedAggregate } from "./aggregate-evidence.js";
import { requiredAggregationDimensions } from "./aggregation-policy.js";
import { joinIntegerType, joinIntegerValue } from "./join-integer.js";
import { clickHouseCoverageScope } from "./clickhouse-coverage-scope.js";
import { normalizeDecimal } from "./decimal-kernel.js";
import { queryEvidenceShape } from "./evidence-shape.js";
import { verifyCell, type CellOperation } from "./evidence.js";
import { computeArithmetic, sumDecimalStrings, type ArithmeticValue } from "./exact-arithmetic.js";
import { type AlignedRow, type AlignmentSpec } from "./result-alignment.js";
import {
  fitsResultCalculationBytes,
  RESULT_CALCULATION_MAX_ROWS,
  type ResultColumn,
  type ResultTable,
  type ResultValue,
} from "./result-transform.js";
import type { DataContract, QueryResource, SessionResource } from "./types.js";

export function stableHashes(value: Record<string, string>): string {
  return JSON.stringify(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Typed observations from a saved sparse-date projection remain partial:
 * exact membership is verified, but missing groups/dates are not certified. */
function sparseDirectProjection(source: QueryResource, contract: DataContract): boolean {
  if (source.engine !== "clickhouse-local" || source.sql_review_engine !== "clickhouse_ast_direct" || source.coverage.status !== "unknown" || !source.rows.length || !contract.series) return false;
  const scope = clickHouseCoverageScope(source.sql, contract, source.time_range);
  if (!scope?.selectedDates || Object.keys(scope.inSets).length || JSON.stringify(scope.selectedDates) !== JSON.stringify(source.time_range.selected_dates)) return false;
  const ast = queryEvidenceShape(source, contract);
  if (!ast || ast.groupby || !Array.isArray(ast.columns)) return false;
  const fields = new Map<string, string>();
  for (const raw of ast.columns) {
    const item = raw as { as?: unknown; expr?: { type?: unknown; column?: unknown } };
    if (item?.expr?.type !== "column_ref" || typeof item.expr.column !== "string") return false;
    const output = item.as ?? item.expr.column;
    if (typeof output !== "string" || fields.has(item.expr.column)) return false;
    fields.set(item.expr.column, output);
  }
  const dateOutput = fields.get(contract.series.date_column);
  if (!dateOutput) return false;
  return source.rows.every((row) => typeof row[dateOutput] === "string" && scope.selectedDates!.includes(row[dateOutput] as string) &&
    Object.entries(scope.equalities).every(([field, value]) => !fields.has(field) || row[fields.get(field)!] === value));
}

/** Reconstruct rows solely from verified aggregate outputs and contract labels,
 * never from model-chosen aliases as semantic descriptions. */
/** Convert only a complete direct projection of an observed-only contract.
 * SQL admission alone is insufficient evidence of column lineage or exactness. */
export function rawResultTable(source: QueryResource, contract: DataContract): ResultTable | null {
  if (
    !contract.series ||
    contract.series.prediction_mode !== "observed_only" ||
    contract.series.predicted_column ||
    source.truncated ||
    source.sql_limited ||
    !source.complete_population ||
    source.total_rows_exact !== true ||
    source.rows.length > RESULT_CALCULATION_MAX_ROWS ||
    source.rows.length !== source.returned_rows ||
    source.rows.length !== source.total_rows ||
    (source.engine === "clickhouse-local" && !source.execution_id)
  )
    return null;
  if (!verifyCell(source, contract, { op: "count_rows", as: "shape" }, source.rows.length) && !sparseDirectProjection(source, contract)) return null;
  const projections = queryEvidenceShape(source, contract)?.columns;
  if (!Array.isArray(projections) || projections.length !== source.columns.length || projections.length > 40)
    return null;
  const fields: Array<{
    column: ResultColumn;
    field: string;
    declared: DataContract["columns"][number];
    kind: "integer" | "decimal" | "text";
  }> = [];
  for (const projection of projections) {
    if (!projection || typeof projection !== "object") return null;
    const item = projection as { as?: string | null; expr?: { type?: string; column?: string } };
    const field = item.expr?.column,
      name = item.as ?? field;
    if (
      item.expr?.type !== "column_ref" ||
      !field ||
      !name ||
      !source.columns.includes(name) ||
      !/^[a-z_][a-z0-9_]{0,63}$/u.test(name) ||
      ["__proto__", "constructor", "prototype"].includes(name)
    )
      return null;
    const declared = contract.columns.find((candidate) => candidate.name === field);
    if (!declared || contract.sensitive_columns.includes(field)) return null;
    const type = declared.type.replace(/\s/gu, "").toLowerCase();
    const decimal = /^(?:nullable\()?decimal\((\d+),(\d+)\)\)?$/u.exec(type);
    const integer = /^(?:nullable\()?(?:u?int\d*|integer)\)?$/u.test(type);
    const text =
      /^(?:nullable\()?(?:lowcardinality\()?string\)?\)?$/u.test(type) ||
      /^(?:nullable\()?date\)?$/u.test(type);
    if (!decimal && !integer && !text) return null;
    const kind = decimal ? "decimal" : integer ? "integer" : "text";
    const isMetric = contract.series.metrics.includes(field);
    const required = isMetric ? requiredAggregationDimensions(contract, field) : [];
    if (!required || (required.length > 0 && source.key_lineage_version !== 1)) return null;
    if (isMetric && (!declared.unit || kind === "text")) return null;
    if (
      decimal &&
      (Number(decimal[1]) > 28 ||
        Number(decimal[2]) > 28 ||
        source.engine !== "clickhouse-local" ||
        source.decimal_types?.[`${contract.table}.${field}`]?.replace(/\s/gu, "").toLowerCase() !== type ||
        source.column_types?.[name]?.replace(/\s/gu, "").toLowerCase() !== type)
    )
      return null;
    if (
      source.engine === "clickhouse-local" &&
      integer &&
      source.column_types?.[name]?.replace(/\s/gu, "").toLowerCase() !== type
    )
      return null;
    const column: ResultColumn = {
      name,
      type: kind === "text" ? "text" : "decimal",
      unit: isMetric ? declared.unit! : `维度 ${contract.table}.${field}`,
      label: `${contract.table}.${field}${isMetric ? "（实际观察）" : ""}`,
      ...(kind === "text" ? {} : { scale: decimal ? Number(decimal[2]) : 0 }),
      ...(source.key_lineage_version === 1 &&
      (contract.series.date_column === field || contract.series.dimensions.includes(field))
        ? { key_lineage: { table: contract.table, column: field, physical_type: type } }
        : {}),
      ...(source.key_lineage_version === 1 && isMetric
        ? { value_lineage: { table: contract.table, column: field } }
        : {}),
    };
    fields.push({ column, field, declared, kind });
  }
  const rows: Array<Record<string, ResultValue>> = [];
  for (const row of source.rows) {
    if (
      Object.keys(row).length !== fields.length ||
      fields.some(({ column }) => !Object.hasOwn(row, column.name))
    )
      return null;
    const result: Record<string, ResultValue> = Object.create(null) as Record<string, ResultValue>;
    for (const { column, declared, kind } of fields) {
      const value = row[column.name];
      if (value === null) {
        if (!declared.nullable && !declared.type.toLowerCase().startsWith("nullable(")) return null;
        result[column.name] = null;
        continue;
      }
      if (kind === "text") {
        if (typeof value !== "string" || value.length > 256) return null;
        result[column.name] = value;
        continue;
      }
      if (kind === "integer") {
        const physical = source.engine === "clickhouse-local" ? joinIntegerType(declared.type) : null;
        if (physical) {
          const exact = joinIntegerValue(value, physical);
          if (exact === null) return null;
          result[column.name] = exact;
        } else if (typeof value === "number" && Number.isSafeInteger(value)) result[column.name] = String(value);
        else if (typeof value === "string" && /^-?\d{1,76}$/u.test(value)) result[column.name] = value;
        else return null;
      } else {
        const exact = sumDecimalStrings([value], column.scale!);
        if (exact === null) return null;
        const physicalDecimal = /^(?:nullable\()?decimal\((\d+),(\d+)\)\)?$/u.exec(declared.type.replace(/\s/gu, "").toLowerCase());
        if (source.engine === "clickhouse-local" && (!physicalDecimal || exact.replace(/^-?/u, "").replace(".", "").replace(/^0+/u, "").length > Number(physicalDecimal[1]))) return null;
        result[column.name] = exact;
      }
    }
    rows.push(result);
  }
  const result = { columns: fields.map(({ column }) => column), rows };
  return fitsResultCalculationBytes(result) ? result : null;
}

export function aggregateTable(items: VerifiedAggregate[], contract?: DataContract): ResultTable | null {
  if (!items.length) return null;
  const first = items[0]!;
  const groupKeys = Object.keys(first.group).sort();
  const columns: ResultColumn[] = groupKeys.map((name) => ({
    name,
    type: "text",
    unit: `维度 ${first.table}.${name}`,
    label: `${first.table}.${name}`,
    ...(contract?.columns.find((column) => column.name === name)
      ? {
          key_lineage: {
            table: first.table,
            column: name,
            physical_type: contract.columns
              .find((column) => column.name === name)!
              .type.replace(/\s/gu, "")
              .toLowerCase(),
          },
        }
      : {}),
  }));
  const grouped = new Map<string, Record<string, ResultValue>>();
  const metrics = new Map<string, ResultColumn>();
  for (const item of items) {
    if (
      item.table !== first.table ||
      item.source_resource_id !== first.source_resource_id ||
      JSON.stringify(Object.keys(item.group).sort()) !== JSON.stringify(groupKeys)
    )
      return null;
    const metric: ResultColumn = {
      name: item.output_column,
      type: "decimal",
      unit: item.unit,
      label:
        item.operation === "count_rows"
          ? `${item.table} 查询观测行数`
          : `${item.table}.${item.column} ${item.operation === "sum" ? "合计" : "非 NULL 计数"}`,
      scale: item.scale,
      ...(contract && item.operation === "sum"
        ? { value_lineage: { table: item.table, column: item.column } }
        : {}),
    };
    const previous = metrics.get(metric.name);
    if (previous && JSON.stringify(previous) !== JSON.stringify(metric)) return null;
    if (groupKeys.includes(metric.name)) return null;
    metrics.set(metric.name, metric);
    const key = JSON.stringify(groupKeys.map((name) => item.group[name]));
    let row = grouped.get(key);
    if (!row) {
      row = Object.create(null) as Record<string, ResultValue>;
      for (const name of groupKeys) row[name] = item.group[name]!;
      grouped.set(key, row);
    }
    if (Object.hasOwn(row, metric.name)) return null;
    row[metric.name] = item.value;
  }
  columns.push(...metrics.values());
  const rows = [...grouped.values()];
  if (rows.some((row) => Object.keys(row).length !== columns.length)) return null;
  return { columns, rows };
}

export function alignmentTable(
  spec: AlignmentSpec,
  rows: AlignedRow[],
  keySources: Record<string, NonNullable<ResultColumn["key_lineages"]>> = {},
): ResultTable | null {
  const left = rows.find((row) => row.left)?.left;
  const right = rows.find((row) => row.right)?.right;
  const sample = (item: ArithmeticValue) => ({
    ...item,
    value: item.scale ? `1.${"0".repeat(item.scale)}` : "1",
  });
  const output =
    rows.find((row) => row.result)?.result ??
    (left && right
      ? computeArithmetic(spec.op, sample(left), { ...sample(right), scopes: left.scopes }, true)
      : null);
  const reserved = ["left_value", "right_value", "result_value", "alignment_status"];
  if (!left || !right || !output || spec.keys.some((key) => reserved.includes(key))) return null;
  const leftLabel = `${left.basis.table}.${left.basis.column}`;
  const rightLabel = `${right.basis.table}.${right.basis.column}`;
  const columns: ResultColumn[] = [
    ...[...spec.keys].sort().map((name) => ({
      name,
      type: "text" as const,
      unit: `维度 ${name}`,
      label: name,
      ...(keySources[name]?.length ? { key_lineages: keySources[name] } : {}),
    })),
    {
      name: "left_value",
      type: "decimal",
      unit: left.unit,
      label: `左侧 ${leftLabel}`,
      scale: left.scale,
      ...(left.approximate ? { approximate: true } : {}),
    },
    {
      name: "right_value",
      type: "decimal",
      unit: right.unit,
      label: `右侧 ${rightLabel}`,
      scale: right.scale,
      ...(right.approximate ? { approximate: true } : {}),
    },
    {
      name: "result_value",
      type: "decimal",
      unit: output.unit,
      label: `${leftLabel} ${spec.op} ${rightLabel}`,
      scale: output.scale,
      ...(output.approximate ? { approximate: true } : {}),
    },
    { name: "alignment_status", type: "text", unit: "状态", label: "对齐状态" },
  ];
  for (const row of rows) {
    if (
      row.left &&
      (row.left.unit !== left.unit ||
        row.left.scale !== left.scale ||
        row.left.basis.table !== left.basis.table ||
        row.left.basis.column !== left.basis.column)
    )
      return null;
    if (
      row.right &&
      (row.right.unit !== right.unit ||
        row.right.scale !== right.scale ||
        row.right.basis.table !== right.basis.table ||
        row.right.basis.column !== right.basis.column)
    )
      return null;
    if (row.result && (row.result.unit !== output.unit || row.result.scale !== output.scale)) return null;
  }
  return {
    columns,
    rows: rows.map((row) => ({
      ...row.group,
      left_value: row.left?.value ?? null,
      right_value: row.right?.value ?? null,
      result_value: row.result?.value ?? null,
      alignment_status: row.status,
    })),
  };
}

/** Preserve the existing JSON number representation only when it is lossless.
 * Numeric execution itself always happens in the shared fixed-point engine. */
export function persistedCells(
  source: SessionResource,
  result: ResultTable,
  operations: CellOperation[],
): Record<string, number | string | null> {
  const cells: Record<string, number | string | null> = {};
  for (const operation of operations) {
    const value = result.rows[0]![operation.as] as string | null;
    const type = source.kind === "query_result" ? (source.column_types?.[operation.column ?? ""] ?? "") : "";
    const textual = /(?:Decimal|(?:U?Int)(?:64|128|256))/iu.test(type);
    const number = value === null ? null : Number(value);
    const numberInput =
      source.kind === "query_result" &&
      (operation.op !== "sum" ||
        (!textual && source.rows.every(
          (row) => row[operation.column!] === null || typeof row[operation.column!] === "number",
        )));
    const lossless =
      value !== null &&
      number !== null &&
      Number.isFinite(number) &&
      normalizeDecimal(String(number)) === normalizeDecimal(value);
    cells[operation.as] =
      numberInput &&
      lossless &&
      (Number.isSafeInteger(number) ||
        result.columns.find((column) => column.name === operation.as)?.approximate)
        ? number
        : value;
  }
  return cells;
}
