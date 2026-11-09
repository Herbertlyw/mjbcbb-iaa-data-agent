// Prove the physical meaning of bounded database aggregate result cells.
import { completeObservedGroups } from "./aggregate-group-coverage.js";
import { permitsAggregation } from "./aggregation-policy.js";
import { verifyWideAggregateProof } from "./wide-aggregate-proof.js";
import { isCalendarDate } from "./config.js";
import { coverageHasGap, provenCoverageScope } from "./coverage.js";
import { queryEvidenceShape } from "./evidence-shape.js";
import type { VerifiedQueryObservation } from "./query-observation.js";
import type { ResultColumn, ResultTable } from "./result-transform.js";
import { typedObservation } from "./typed-observation.js";
import type { DataContract, QueryResource } from "./types.js";
import type { ArithmeticValue } from "./exact-arithmetic.js";

export interface AggregateObservationInput {
  table: ResultTable;
  observations: VerifiedQueryObservation[];
  incomplete: boolean;
}

/** Expand only a selected, already verified query. A calculation selects the
 * metrics it actually uses; a standalone query can show its observed cells. */
export function selectedAggregateReferences(
  input: AggregateObservationInput | null,
  references: Array<{ row: number; column: string }>,
  directQueryOnly: boolean,
): Array<{ row: number; column: string }> {
  if (!input?.incomplete || (!references.length && !directQueryOnly)) return [];
  const columns = references.length ? new Set(references.map((ref) => ref.column)) : null;
  return input.observations
    .filter((item) => !columns || columns.has(item.output_column))
    .map((item) => ({ row: item.row, column: item.output_column }));
}

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const typeName = (value: string) => value.replace(/\s/gu, "").toLowerCase();
const baseType = (value: string) =>
  typeName(value).replace(/^nullable\((.*)\)$/u, "$1");
const namePattern = /^[a-z_][a-z0-9_]{0,63}$/u;

/** Authority belongs to the caller. This proof checks a complete saved single
 * table SUM/COUNT result, its contract, physical types, group scope and flags.
 * It never turns a missing input or an opaque expression into a business zero. */
export function aggregateObservationInput(
  source: QueryResource,
  contract: DataContract,
): AggregateObservationInput | null {
  const series = contract.series;
  if (
    !series ||
    source.result_semantics_version !== 2 ||
    source.key_lineage_version !== 1 ||
    source.tables.length !== 1 ||
    source.tables[0] !== contract.table ||
    source.time_range.timezone !== contract.timezone ||
    !source.rows.length ||
    (source.coverage.status !== "known" && !source.time_range.selected_dates?.length) ||
    !Number.isSafeInteger(source.scan_limit) ||
    source.scan_limit! < 1 ||
    source.scan_limit! > 2_000_000_000
  )
    return null;
  const scope = provenCoverageScope(source.sql, contract, source.time_range);
  const shape = queryEvidenceShape(source, contract);
  const converted = typedObservation(source);
  if (
    !scope ||
    !shape ||
    !converted ||
    !Array.isArray(shape.columns) ||
    shape.columns.length !== source.columns.length
  )
    return null;
  const relation =
    Array.isArray(shape.from) && shape.from.length === 1
      ? object(shape.from[0])
      : null;
  if (
    !relation ||
    relation.table !== contract.table ||
    relation.db ||
    relation.expr ||
    relation.join
  )
    return null;
  const qualifier = String(relation.as ?? contract.table);
  const field = (value: unknown): string | null => {
    const node = object(value);
    return node?.type === "column_ref" &&
      typeof node.column === "string" &&
      (!node.table || node.table === qualifier)
      ? node.column
      : null;
  };
  const groupNode = object(shape.groupby);
  const groupExpressions =
    groupNode && Array.isArray(groupNode.columns) ? groupNode.columns : [];
  const grouped = groupExpressions.map(field);
  const sparse = Boolean(scope.selectedDates?.length);
  if (Boolean(source.time_range.selected_dates?.length) !== sparse) return null;
  if (sparse && (source.coverage.status !== "unknown" ||
      JSON.stringify(scope.selectedDates) !== JSON.stringify(source.time_range.selected_dates) ||
      !grouped.includes(series.date_column) || !verifyWideAggregateProof(source, contract))) return null;
  const groupable = [
    series.date_column,
    ...series.dimensions,
    ...(series.predicted_column ? [series.predicted_column] : []),
    ...contract.columns.filter((column) =>
      !column.nullable && !contract.sensitive_columns.includes(column.name) &&
      namePattern.test(column.name) && !["__proto__", "constructor", "prototype"].includes(column.name) &&
      /^(?:String|LowCardinality\(String\))$/iu.test(column.type.replace(/\s/gu, "")),
    ).map((column) => column.name),
  ];
  if (
    grouped.length > 8 ||
    grouped.some((name) => !name || !groupable.includes(name)) ||
    new Set(grouped).size !== grouped.length ||
    Object.keys(scope.inSets).some((name) => !grouped.includes(name))
  )
    return null;
  // Folding authorized dimensions yields an observed subtotal. It does not
  // prove an exhaustive population, even if the query itself returned rows.
  const foldedDimensions = series.dimensions.some(
    (name) => !grouped.includes(name) && !Object.hasOwn(scope.equalities, name),
  );
  const extraAttributes = grouped.filter((name): name is string => name !== null &&
    name !== series.date_column && name !== series.predicted_column && !series.dimensions.includes(name));
  if (
    series.predicted_column
      ? !grouped.includes(series.predicted_column) || !series.prediction_values
      : series.prediction_mode !== "observed_only"
  )
    return null;
  const columns: ResultColumn[] = [];
  const groupOutputs = new Map<string, string>();
  const metrics: Array<{
    field: string;
    output: string;
    column: ResultColumn;
    declared: DataContract["columns"][number];
  }> = [];
  const counts: Array<{ output: string; field: string | null }> = [];
  for (const [index, raw] of shape.columns.entries()) {
    const projection = object(raw);
    const expression = object(projection?.expr);
    const physical = field(expression);
    const output = projection?.as ?? physical;
    if (
      !projection ||
      !expression ||
      typeof output !== "string" ||
      output !== source.columns[index] ||
      !namePattern.test(output) ||
      ["__proto__", "constructor", "prototype"].includes(output) ||
      columns.some((column) => column.name === output)
    )
      return null;
    const column = converted.columns.find((item) => item.name === output);
    if (!column) return null;
    if (physical) {
      const declared = contract.columns.find((item) => item.name === physical);
      if (
        !declared ||
        !grouped.includes(physical) ||
        groupOutputs.has(physical) ||
        contract.sensitive_columns.includes(physical) ||
        typeName(source.column_types![output]!) !== typeName(declared.type)
      )
        return null;
      if (
        output !== physical &&
        contract.columns.some((item) => item.name === output)
      )
        return null;
      groupOutputs.set(physical, output);
      columns.push({
        ...column,
        unit:
          physical === series.predicted_column
            ? "实际/预测标记"
            : `维度 ${contract.table}.${physical}`,
        label: `${contract.table}.${physical}`,
        ...(physical !== series.predicted_column
          ? {
              key_lineage: {
                table: contract.table,
                column: physical,
                physical_type: typeName(declared.type),
              },
            }
          : {}),
      });
      continue;
    }
    // Auxiliary status extrema and conditional counts remain opaque. They may
    // accompany proven SUMs but never gain model-selected business labels.
    const functionName = object(expression.name)?.name;
    const conditionalName = Array.isArray(functionName) ? object(functionName[0])?.value : null;
    if (expression.type === "function" && conditionalName === "countif") {
      const values = object(expression.args)?.value;
      const condition = Array.isArray(values) && values.length === 1 ? object(values[0]) : null;
      const conditionFn = object(condition?.name)?.name;
      const conditionArgs = object(condition?.args)?.value;
      const conditionalField = condition?.type === "binary_expr" ? field(condition.left)
        : Array.isArray(conditionFn) && ["isnull", "isnotnull"].includes(String(object(conditionFn[0])?.value))
          ? field(Array.isArray(conditionArgs) ? conditionArgs[0] : null) : null;
      if (!conditionalField || !contract.columns.some((item) => item.name === conditionalField) || contract.sensitive_columns.includes(conditionalField) || typeName(source.column_types![output]!) !== "uint64" || contract.columns.some((item) => item.name === output)) return null;
      columns.push(column);
      continue;
    }
    const fn = String(expression.name).toLowerCase();
    const args = object(expression.args);
    if (
      expression.type !== "aggr_func" ||
      expression.over ||
      !args ||
      args.distinct ||
      args.orderby ||
      !["sum", "count", "min", "max"].includes(fn)
    )
      return null;
    const input = field(args.expr);
    if (fn === "min" || fn === "max") {
      const declared = contract.columns.find((item) => item.name === input);
      if (!input || !declared || contract.sensitive_columns.includes(input) || typeName(source.column_types![output]!) !== typeName(declared.type) || output !== input && contract.columns.some((item) => item.name === output)) return null;
      columns.push(column);
      continue;
    }
    if (fn === "count" && object(args.expr)?.type === "star") {
      if (typeName(source.column_types![output]!) !== "uint64") return null;
      counts.push({ output, field: null });
      columns.push({
        ...column,
        unit: "行",
        label: `${contract.table} 查询观测行数`,
      });
      continue;
    }
    const declared = contract.columns.find((item) => item.name === input);
    if (
      !input ||
      !declared?.unit ||
      !series.metrics.includes(input) ||
      contract.sensitive_columns.includes(input) ||
      (output !== input &&
        contract.columns.some((item) => item.name === output))
    )
      return null;
    if (fn === "count") {
      if (typeName(source.column_types![output]!) !== "uint64") return null;
      counts.push({ output, field: input });
      columns.push({
        ...column,
        unit: "行",
        label: `${contract.table}.${input} 非 NULL 计数`,
      });
      continue;
    }
    if (!permitsAggregation(contract, input, scope.equalities, grouped, source.time_range)) return null;
    const physicalType = baseType(declared.type);
    const wireType = baseType(source.column_types![output]!);
    const decimal = /^decimal\((\d+),(\d+)\)$/u.exec(physicalType);
    const integer = /^(u?)int(8|16|32|64)$/u.exec(physicalType);
    const floating = /^float(32|64)$/u.test(physicalType);
    if (decimal) {
      if (
        Number(decimal[1]) > 28 ||
        wireType !== `decimal(38,${decimal[2]})` ||
        typeName(source.decimal_types?.[`${contract.table}.${input}`] ?? "") !==
          typeName(declared.type)
      )
        return null;
    } else if (
      integer
        ? wireType !== (integer[1] ? "uint64" : "int64")
        : !floating || wireType !== "float64"
    )
      return null;
    if (integer?.[2] === "64" && !verifyWideAggregateProof(source, contract)?.has(output)) return null;
    // A non-NULL subtotal over known gaps needs richer per-metric evidence.
    // Retain the mathematical fallback rather than calling an all-NULL SUM 0.
    if (
      !sparse && coverageHasGap(source.coverage) &&
      converted.rows.some((row) => row[output] !== null)
    )
      return null;
    const semantic = {
      ...column,
      unit: declared.unit,
      label: `${contract.table}.${input}（${declared.description}）的数据库非 NULL 合计`,
      value_lineage: { table: contract.table, column: input },
    };
    columns.push(semantic);
    metrics.push({ field: input, output, column: semantic, declared });
  }
  if (
    !metrics.length ||
    groupOutputs.size !== grouped.length ||
    !grouped.every((name) => groupOutputs.has(name!))
  )
    return null;
  const prediction = series.predicted_column
    ? {
        column: groupOutputs.get(series.predicted_column)!,
        actual: String(series.prediction_values!.actual),
        predicted: String(series.prediction_values!.predicted),
      }
    : undefined;
  const groups: Array<Record<string, string>> = [];
  const seen = new Set<string>();
  const observations: VerifiedQueryObservation[] = [];
  for (const [rowIndex, row] of converted.rows.entries()) {
    const group: Record<string, string> = {};
    for (const [physical, output] of groupOutputs) {
      const value = row[output];
      if (
        typeof value !== "string" ||
        !value.length ||
        value.length > 256 ||
        (Object.hasOwn(scope.equalities, physical) &&
          value !== scope.equalities[physical]) ||
        (scope.inSets[physical] && !scope.inSets[physical]!.includes(value))
      )
        return null;
      if (
        physical === series.date_column &&
        (!isCalendarDate(value) ||
          value < source.time_range.start ||
          value > source.time_range.end ||
          (scope.selectedDates !== undefined && !scope.selectedDates.includes(value)))
      )
        return null;
      group[physical] = value;
    }
    const key = JSON.stringify(
      [...groupOutputs.keys()].map((name) => group[name]),
    );
    if (seen.has(key)) return null;
    seen.add(key);
    groups.push(group);
    const totalCounts: bigint[] = [];
    for (const count of counts) {
      const value = row[count.output];
      if (
        typeof value !== "string" ||
        !/^\d+$/u.test(value) ||
        BigInt(value) > BigInt(source.scan_limit!) ||
        (count.field === null && BigInt(value) === 0n)
      )
        return null;
      if (count.field === null) totalCounts.push(BigInt(value));
    }
    if (totalCounts.some((value) => value !== totalCounts[0])) return null;
    if (
      totalCounts.length &&
      counts.some(
        (count) => BigInt(row[count.output] as string) > totalCounts[0]!,
      )
    )
      return null;
    const flag = prediction ? row[prediction.column] : undefined;
    if (
      prediction &&
      flag !== prediction.actual &&
      flag !== prediction.predicted
    )
      return null;
    for (const metric of metrics) {
      const value = row[metric.output];
      if (
        (value !== null && typeof value !== "string") ||
        (value === null &&
          !metric.declared.nullable &&
          !typeName(metric.declared.type).startsWith("nullable("))
      )
        return null;
      // COUNT(metric) and SUM(metric) observe the same group. Contradictory
      // receipts cannot prove either a missing SUM or a numeric SUM.
      if (
        counts.some(
          (count) =>
            count.field === metric.field &&
            (row[count.output] === "0") !== (value === null),
        )
      )
        return null;
      const filters = {
        ...scope.equalities,
        ...Object.fromEntries(
          [...series.dimensions, ...extraAttributes]
            .filter((name) => Object.hasOwn(group, name))
            .map((name) => [name, group[name]!]),
        ),
      };
      const day = group[series.date_column];
      observations.push({
        resource_id: source.resource_id,
        execution_id: source.execution_id!,
        row: rowIndex,
        output_column: metric.output,
        table: contract.table,
        column: metric.field,
        description: `${metric.declared.description} 数据库分组求和；不将未出现的分组补零。`,
        value: value as string | null,
        unit: metric.column.unit,
        scale: metric.column.scale!,
        approximate: value !== null && metric.column.approximate === true,
        prediction:
          prediction && flag === prediction.predicted ? "predicted" : "actual",
        filters,
        range: day && sparse
          ? { start: day, end: day, timezone: source.time_range.timezone }
          : { ...source.time_range, ...(day ? { start: day, end: day } : {}) },
        scope_complete: series.dimensions.every((name) =>
          Object.hasOwn(filters, name),
        ),
        coverage_incomplete: coverageHasGap(source.coverage) || value === null,
        aggregation: "sum",
      });
    }
  }
  const semanticGroups = grouped.filter(
    (name): name is string => name !== null && name !== series.predicted_column,
  );
  const complete = completeObservedGroups(
    groups,
    semanticGroups,
    scope.inSets,
    series.date_column,
    source.time_range,
  );
  const incomplete =
    sparse || foldedDimensions || extraAttributes.length > 0 || !complete ||
    coverageHasGap(source.coverage) ||
    source.coverage.unknown_prediction_dates.length > 0 ||
    observations.some((item) => item.value === null);
  return {
    table: {
      columns,
      rows: converted.rows,
      ...(prediction
        ? { prediction }
        : { prediction_scope: "observed_only" as const }),
    },
    observations: observations.map((item) =>
      incomplete ? { ...item, coverage_incomplete: true } : item,
    ),
    incomplete,
  };
}

/** Attach already proven aggregate scopes to a separately recomputed scalar.
 * This does not calculate it or authorize cross-metric arithmetic. */
export function aggregateObservationValue(
  observations: VerifiedQueryObservation[],
  value: string | null,
  scale: number,
  partial: boolean,
  allowIncompleteSingle = false,
  allowIncompleteDisjointGroups = false,
): ArithmeticValue | null {
  const first = observations[0];
  const observedGroups = Boolean(first && allowIncompleteDisjointGroups && partial && observations.length > 1 &&
    observations.every((item) => !item.scope_complete && item.coverage_incomplete && item.value !== null &&
      item.resource_id === first.resource_id && item.execution_id === first.execution_id) &&
    observations.every((left, index) => observations.slice(index + 1).every((right) =>
      left.range.end < right.range.start || right.range.end < left.range.start ||
      Object.keys(left.filters).some((key) => Object.hasOwn(right.filters, key) && left.filters[key] !== right.filters[key]),
    )));
  if (
    !first ||
    observations.length > 32 ||
    observations.some(
      (item) =>
        item.aggregation !== "sum" ||
        (!item.scope_complete && !observedGroups && (!allowIncompleteSingle || observations.length !== 1 || !partial || !item.coverage_incomplete)) ||
        item.prediction !== "actual" ||
        item.table !== first.table ||
        item.column !== first.column ||
        item.unit !== first.unit ||
        item.range.timezone !== first.range.timezone,
    )
  )
    return null;
  return {
    value,
    scale,
    unit: first.unit,
    basis: {
      table: first.table,
      column: first.column,
      operation: "sum",
      unit: first.unit,
      prediction: "actual_observed_only",
      timezone: first.range.timezone,
    },
    scopes: observations.map((item) => ({
      filters: item.filters,
      start: item.range.start,
      end: item.range.end,
    })),
    ...(!first.scope_complete ? { scope_unverified: true as const, ...(observations.length === 1 ? { row_identity: { resource_id: first.resource_id, execution_id: first.execution_id, row: first.row } } : {}) } : {}),
    ...(partial ||
    value === null ||
    observations.some((item) => item.coverage_incomplete)
      ? { partial: true }
      : {}),
    ...(observations.some((item) => item.approximate)
      ? { approximate: true }
      : {}),
    ...(value === null ? { undefined_reason: "null_input" as const } : {}),
  };
}
