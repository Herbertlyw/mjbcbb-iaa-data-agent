import { isCalendarDate } from "./config.js";
import { assertJoinKeys, parseReadonlySql, rewritePreaggregatedDimensionJoin } from "./sql.js";
import type { DataContract, JoinConstraint } from "./types.js";

/** Narrow one-fact/one-dimension JOIN whose aggregate can be recomputed from
 * the rows captured by the *same* ClickHouse SELECT. This is not an immutable
 * database version or a cross-table transaction snapshot. */
export interface JoinEvidencePlan {
  originalSql: string;
  executionSql: string;
  fact: string;
  dimension: string;
  joinType: "inner" | "left";
  joinKeys: string[];
  range: { start: string; end: string; timezone: string };
  factFilters: Record<string, string>;
  dimensionFilters: Record<string, string>;
  groups: Array<{ table: "fact" | "dimension"; column: string; output: string }>;
  metrics: Array<{ column: string; output: string; operation: "sum" | "count_nonnull"; unit: string; description: string }>;
  proofFields: Array<{ table: "fact" | "dimension"; column: string }>;
  expectedDates: string[];
}

export interface VerifiedJoinValue {
  fact: string;
  dimension: string;
  column: string;
  operation: "sum" | "count_nonnull";
  value: string;
  unit: string;
  description: string;
  group: Record<string, string | null>;
  /** Count of captured fact rows lacking a dimension match in this group. */
  unmatched_rows: number;
  factFilters: Record<string, string>;
  dimensionFilters: Record<string, string>;
  range: JoinEvidencePlan["range"];
}

export interface JoinDimensionObservation {
  keys: Record<string, string>;
  column: string;
  value: string;
}

const IDENT = /^[a-z_][a-z0-9_]*$/u;
const LITERAL = /^[\p{L}\p{N}_ .-]{1,100}$/u;
const PROOF = "__da_join_proof";
const DIMENSION_COUNT = "__da_dimension_key_count";
const object = (item: unknown): Record<string, unknown> | null => item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null;
const quote = (value: string) => `'${value}'`;

/** Returns null when any SQL feature, contract or relationship is outside
 * this proof's strictly enumerated subset. Call the normal authorization and
 * freshness checks as well; this function does not grant access. */
export function prepareJoinEvidence(sql: string, fact: DataContract, dimension: DataContract, joins: JoinConstraint[]): JoinEvidencePlan | null {
  try {
    const series = fact.series;
    if (!series || series.prediction_mode !== "observed_only" || series.predicted_column || dimension.series || fact.timezone !== dimension.timezone || !fact.grain || [...fact.grain].sort().join("|") !== [series.date_column, ...series.dimensions].sort().join("|")) return null;
    const parsed = parseReadonlySql(sql);
    const ast = parsed.ast;
    const preaggregated = rewritePreaggregatedDimensionJoin(ast);
    if (preaggregated) {
      if (preaggregated.fact !== fact.table || JSON.stringify([...preaggregated.grain].sort()) !== JSON.stringify([...fact.grain].sort())) return null;
      const proof = prepareJoinEvidence(preaggregated.sql, fact, dimension, joins);
      return proof ? { ...proof, originalSql: parsed.sql } : null;
    }
    if (ast.with || ast._next || ast.having || ast.limit || ast.distinct || ast.options || ast.for_update || ast.window || !Array.isArray(ast.from) || ast.from.length !== 2) return null;
    const left = object(ast.from[0]); const right = object(ast.from[1]);
    if (!left || !right || left.table !== fact.table || right.table !== dimension.table || left.db || right.db || left.expr || right.expr || !["INNER JOIN", "LEFT JOIN"].includes(String(right.join))) return null;
    const joinType = right.join === "LEFT JOIN" ? "left" : "inner";
    const fa = String(left.as || fact.table); const da = String(right.as || dimension.table);
    if (!IDENT.test(fa) || !IDENT.test(da) || fa === da || !IDENT.test(fact.table) || !IDENT.test(dimension.table)) return null;
    const relation = joins.find((item) => item.tables.length === 2 && item.tables.includes(fact.table) && item.tables.includes(dimension.table));
    if (!relation || !relation.keys.length || !dimension.grain || [...relation.keys].sort().join("|") !== [...dimension.grain].sort().join("|") || relation.keys.some((key) => !series.dimensions.includes(key))) return null;
    assertJoinKeys(sql, joins, new Map([[fact.table, [series.date_column, ...series.dimensions]], [dimension.table, dimension.grain]]), { leftJoinDimensions: new Set([dimension.table]) });
    const factColumns = new Set(fact.columns.map((col) => col.name)); const dimColumns = new Set(dimension.columns.map((col) => col.name));
    // Proof tuples introduce reads beyond SELECT projections. They must be
    // independently authorized even if outer SQL checks already inspected
    // filters and join predicates. A private proof is not an exemption.
    if ([series.date_column, ...series.dimensions, ...relation.keys].some((name) => !IDENT.test(name) || !factColumns.has(name) || fact.sensitive_columns.includes(name)) || relation.keys.some((name) => !IDENT.test(name) || !dimColumns.has(name) || dimension.sensitive_columns.includes(name))) return null;
    const field = (value: unknown): { table: "fact" | "dimension"; column: string } | null => {
      const col = object(value);
      if (col?.type !== "column_ref" || col.collate || typeof col.column !== "string" || !IDENT.test(col.column)) return null;
      if (col.table === fa && factColumns.has(col.column) && !fact.sensitive_columns.includes(col.column)) return { table: "fact", column: col.column };
      if (col.table === da && dimColumns.has(col.column) && !dimension.sensitive_columns.includes(col.column)) return { table: "dimension", column: col.column };
      return null;
    };
    const factFilters: Record<string, string> = {}; const dimensionFilters: Record<string, string> = {};
    let start = ""; let end = "";
    const conditions: string[] = [];
    const where = (node: unknown): boolean => {
      const item = object(node);
      if (item?.type !== "binary_expr" || typeof item.operator !== "string") return false;
      const op = item.operator.toUpperCase();
      if (op === "AND") return where(item.left) && where(item.right);
      const col = field(item.left); const value = object(item.right);
      if (!col || value?.type !== "single_quote_string" || typeof value.value !== "string" || !LITERAL.test(value.value)) return false;
      if (col.table === "fact" && col.column === series.date_column) {
        if (!isCalendarDate(value.value)) return false;
        if (op === ">=" && !start) start = value.value;
        else if (op === "<=" && !end) end = value.value;
        else return false;
      } else {
        if (op !== "=" || (col.table === "fact" && !series.dimensions.includes(col.column))) return false;
        const filters = col.table === "fact" ? factFilters : dimensionFilters;
        if (Object.hasOwn(filters, col.column)) return false;
        filters[col.column] = value.value;
      }
      conditions.push(`${col.table === "fact" ? fa : da}.${col.column} ${op} ${quote(value.value)}`);
      return true;
    };
    if (!where(ast.where) || !start || !end || start > end || (joinType === "left" && Object.keys(dimensionFilters).length)) return null;
    const dates: string[] = [];
    for (let current = Date.parse(`${start}T00:00:00Z`), last = Date.parse(`${end}T00:00:00Z`); current <= last; current += 86_400_000) {
      if (dates.length >= 366) return null;
      dates.push(new Date(current).toISOString().slice(0, 10));
    }
    const groupNode = object(ast.groupby); const groupList = groupNode && Array.isArray(groupNode.columns) ? groupNode.columns : [];
    if (groupList.length > 4) return null;
    const groupFields = groupList.map(field);
    if (groupFields.some((item) => !item || item.table === "fact" && !series.dimensions.includes(item.column))) return null;
    if (new Set(groupFields.map((item) => `${item?.table}.${item?.column}`)).size !== groupFields.length) return null;
    if (!series.dimensions.every((item) => Object.hasOwn(factFilters, item) || groupFields.some((group) => group?.table === "fact" && group.column === item))) return null;
    const groups: JoinEvidencePlan["groups"] = []; const metrics: JoinEvidencePlan["metrics"] = []; const selections: string[] = []; const outputs = new Set<string>();
    for (const raw of Array.isArray(ast.columns) ? ast.columns : []) {
      const item = object(raw); const expr = object(item?.expr); if (!item || !expr) return null;
      const col = field(expr);
      if (col) {
        if (!groupFields.some((group) => group?.table === col.table && group.column === col.column)) return null;
        const output = item.as ?? col.column;
        if (typeof output !== "string" || !IDENT.test(output) || outputs.has(output) || output === PROOF) return null;
        outputs.add(output); groups.push({ ...col, output }); selections.push(`${col.table === "fact" ? fa : da}.${col.column} AS ${output}`); continue;
      }
      const fn = typeof expr.name === "string" ? expr.name.toLowerCase() : ""; const args = object(expr.args); const metric = field(args?.expr);
      if (expr.type !== "aggr_func" || expr.over || !["sum", "count"].includes(fn) || !args || args.distinct || !metric || metric.table !== "fact" || !series.metrics.includes(metric.column) || typeof item.as !== "string" || !IDENT.test(item.as) || outputs.has(item.as) || item.as === PROOF) return null;
      const declared = fact.columns.find((column) => column.name === metric.column);
      if (!declared?.unit || !/^(?:nullable\()?\s*u?int(?:8|16|32)\s*\)?$/iu.test(declared.type)) return null;
      outputs.add(item.as); metrics.push({ column: metric.column, output: item.as, operation: fn === "sum" ? "sum" : "count_nonnull", unit: fn === "sum" ? declared.unit : "行", description: declared.description });
      selections.push(`${fn.toUpperCase()}(${fa}.${metric.column}) AS ${item.as}`);
    }
    if (!metrics.length || groups.length !== groupFields.length || new Set(groups.map((item) => `${item.table}.${item.column}`)).size !== groupFields.length || !groupFields.every((field) => groups.some((item) => item.table === field?.table && item.column === field.column)) || !Array.isArray(ast.columns)) return null;
    const fields = new Map<string, JoinEvidencePlan["proofFields"][number]>();
    for (const name of series.dimensions) fields.set(`fact.${name}`, { table: "fact", column: name });
    for (const name of relation.keys) fields.set(`dimension.${name}`, { table: "dimension", column: name });
    for (const group of groups) fields.set(`${group.table}.${group.column}`, { table: group.table, column: group.column });
    for (const name of Object.keys(dimensionFilters)) fields.set(`dimension.${name}`, { table: "dimension", column: name });
    const proofFields = [...fields.values()]; const metricFields = [...new Set(metrics.map((metric) => metric.column))];
    const filteredDimension = Object.keys(dimensionFilters).length > 0;
    if (filteredDimension && dimColumns.has(DIMENSION_COUNT)) return null;
    // Keep physical types inside the tuple so the response metadata can be
    // checked against contracts for the actual execution, not just an earlier
    // DESCRIBE that may race a schema change.
    const proof = [`${fa}.${series.date_column}`, ...metricFields.map((name) => `${fa}.${name}`), ...proofFields.map((col) => `${col.table === "fact" ? fa : da}.${col.column}`)];
    // A WHERE predicate on the joined dimension would otherwise hide a second
    // physical row having the same key but a different label. Count each key's
    // unfiltered rows inside the dimension subquery before the outer WHERE.
    // A window preserves every row, so even when proof fails the returned
    // query rows retain the original JOIN's multiplicity and SQL semantics.
    if (filteredDimension) proof.push(`${da}.${DIMENSION_COUNT}`);
    selections.push(`groupArray(367)(tuple(${proof.join(", ")})) AS ${PROOF}`);
    const on = relation.keys.map((key) => `${fa}.${key} = ${da}.${key}`).join(" AND ");
    const dimensionFrom = filteredDimension
      ? `(SELECT ${[...relation.keys, ...proofFields.filter((field) => field.table === "dimension" && !relation.keys.includes(field.column)).map((field) => field.column), `count() OVER (PARTITION BY ${relation.keys.join(", ")}) AS ${DIMENSION_COUNT}`].join(", ")} FROM ${dimension.table})`
      : dimension.table;
    const groupSql = groupFields.length ? ` GROUP BY ${groupFields.map((col) => `${col!.table === "fact" ? fa : da}.${col!.column}`).join(", ")}` : "";
    let orderSql = "";
    if (ast.orderby) {
      if (!Array.isArray(ast.orderby)) return null;
      const order: string[] = [];
      for (const raw of ast.orderby) {
        const entry = object(raw); const col = field(entry?.expr); const expr = object(entry?.expr); const direction = String(entry?.type || "ASC").toUpperCase();
        if (!entry || entry.nulls || !["ASC", "DESC"].includes(direction)) return null;
        if (col && groupFields.some((g) => g?.table === col.table && g.column === col.column)) order.push(`${col.table === "fact" ? fa : da}.${col.column} ${direction}`);
        else if (expr?.type === "column_ref" && !expr.table && typeof expr.column === "string" && outputs.has(expr.column)) order.push(`${expr.column} ${direction}`);
        else return null;
      }
      orderSql = ` ORDER BY ${order.join(", ")}`;
    }
    return { originalSql: parsed.sql, executionSql: `SELECT ${selections.join(", ")} FROM ${fact.table} AS ${fa} ${joinType === "left" ? "LEFT JOIN" : "INNER JOIN"} ${dimensionFrom} AS ${da} ON ${on} WHERE ${conditions.join(" AND ")}${groupSql}${orderSql}`, fact: fact.table, dimension: dimension.table, joinType, joinKeys: [...relation.keys], range: { start, end, timezone: fact.timezone }, factFilters, dimensionFilters, groups, metrics, proofFields, expectedDates: dates };
  } catch { return null; }
}

/** Name checks alone are insufficient: a changed physical number or date
 * type invalidates the contract even when its column name still matches. */
export function verifyJoinPhysicalSchema(plan: JoinEvidencePlan, fact: DataContract, dimension: DataContract, actualFact: Record<string, string>, actualDimension: Record<string, string>): boolean {
  if (fact.table !== plan.fact || dimension.table !== plan.dimension || !fact.series) return false;
  const factFields = new Set([fact.series.date_column, ...plan.joinKeys, ...plan.metrics.map((item) => item.column), ...plan.proofFields.filter((item) => item.table === "fact").map((item) => item.column)]);
  const dimensionFields = new Set([...plan.joinKeys, ...plan.proofFields.filter((item) => item.table === "dimension").map((item) => item.column)]);
  const normalize = (value: string) => value.replace(/\s/gu, "").toLowerCase();
  const matches = (contract: DataContract, actual: Record<string, string>, fields: Set<string>) => [...fields].every((name) => {
    const declared = contract.columns.find((column) => column.name === name)?.type;
    return Boolean(declared && actual[name] && normalize(declared) === normalize(actual[name]!));
  });
  return matches(fact, actualFact, factFields) && matches(dimension, actualDimension, dimensionFields);
}

/** The tuple's ClickHouse result type is produced by the actual SELECT. This
 * catches schema changes between DESCRIBE and execution. ClickHouse removes
 * LowCardinality wrappers inside aggregate tuples; nullability is retained. */
export function verifyJoinExecutionSchema(plan: JoinEvidencePlan, fact: DataContract, dimension: DataContract, resultTypes: Record<string, string>): boolean {
  if (fact.table !== plan.fact || dimension.table !== plan.dimension || !fact.series) return false;
  const lookup = (contract: DataContract, column: string) => contract.columns.find((item) => item.name === column)?.type;
  const metricFields = [...new Set(plan.metrics.map((item) => item.column))];
  const nullable = (type: string | undefined) => {
    if (!type) return type;
    const unwrapped = type.replace(/^LowCardinality\((.*)\)$/iu, "$1");
    return /^Nullable\(/iu.test(unwrapped) ? unwrapped : `Nullable(${unwrapped})`;
  };
  const expected = [lookup(fact, fact.series.date_column), ...metricFields.map((name) => lookup(fact, name)), ...plan.proofFields.map((item) => item.table === "fact" ? lookup(fact, item.column) : plan.joinType === "left" ? nullable(lookup(dimension, item.column)) : lookup(dimension, item.column))];
  if (expected.some((item) => !item) || !resultTypes[PROOF]) return false;
  if (Object.keys(plan.dimensionFilters).length) expected.push("UInt64");
  const normalize = (value: string) => value.replace(/\s/gu, "").toLowerCase().replace(/lowcardinality\(([^()]*)\)/gu, "$1");
  return normalize(resultTypes[PROOF]!) === normalize(`Array(Tuple(${expected.join(",")}))`);
}

/** Recompute every aggregate and label from the saved proof tuples. A group is
 * valid only when each date has exactly one non-NULL fact row for its complete
 * fact grain. Repeated dimension keys and duplicate fact rows therefore fail
 * rather than inflating a sum. Empty/missing groups never become zeros. */
export function verifyJoinEvidence(plan: JoinEvidencePlan, rows: Array<Record<string, unknown>>): VerifiedJoinValue[] | null {
  if (!rows.length || !plan.expectedDates.length) return null;
  const metrics = [...new Set(plan.metrics.map((item) => item.column))];
  const verified: VerifiedJoinValue[] = []; const seen = new Set<string>();
  // A duplicate dimension key may map the same fact to *different* labels.
  // Per-group date checks alone would accept each label independently, so
  // enforce uniqueness of the complete fact grain across every result group.
  const seenFactGrains = new Set<string>();
  const factFieldIndexes = plan.proofFields.flatMap((field, index) => field.table === "fact" ? [index] : []);
  if (!factFieldIndexes.length) return null;
  for (const row of rows) {
    const tuples = row[PROOF];
    if (!Array.isArray(tuples) || tuples.length !== plan.expectedDates.length) return null;
    const group: Record<string, string | null> = {};
    for (const item of plan.groups) {
      const value = row[item.output];
      if (!(typeof value === "string" && Boolean(value) && value.length <= 200) && !(plan.joinType === "left" && item.table === "dimension" && value === null)) return null;
      group[`${item.table === "fact" ? plan.fact : plan.dimension}.${item.column}`] = value;
    }
    const key = JSON.stringify(group); if (seen.has(key)) return null; seen.add(key);
    const dates = new Set<string>(); const sums = new Map(metrics.map((metric) => [metric, 0n])); let unmatchedRows = 0;
    for (const tuple of tuples) {
      const filteredDimension = Object.keys(plan.dimensionFilters).length > 0;
      if (!Array.isArray(tuple) || tuple.length !== 1 + metrics.length + plan.proofFields.length + Number(filteredDimension) || typeof tuple[0] !== "string" || !plan.expectedDates.includes(tuple[0]) || dates.has(tuple[0])) return null;
      if (filteredDimension && tuple.at(-1) !== 1 && tuple.at(-1) !== "1") return null;
      dates.add(tuple[0]);
      const dimensionValues = plan.proofFields.flatMap((field, index) => field.table === "dimension" ? [tuple[1 + metrics.length + index]] : []);
      const unmatched = plan.joinType === "left" && dimensionValues.length > 0 && dimensionValues.every((value) => value === null);
      if (!unmatched && dimensionValues.some((value) => typeof value !== "string")) return null;
      if (unmatched) unmatchedRows += 1;
      for (const [index, metric] of metrics.entries()) {
        const value = tuple[1 + index];
        if (!(typeof value === "string" && /^-?\d{1,11}$/u.test(value) || typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= 4_294_967_295)) return null;
        sums.set(metric, sums.get(metric)! + BigInt(value as string | number));
      }
      for (const [index, field] of plan.proofFields.entries()) {
        const value = tuple[1 + metrics.length + index];
        if (typeof value !== "string" && !(unmatched && field.table === "dimension" && value === null)) return null;
        const filtered = (field.table === "fact" ? plan.factFilters : plan.dimensionFilters)[field.column];
        if (filtered !== undefined && value !== filtered) return null;
        const selected = plan.groups.find((item) => item.table === field.table && item.column === field.column);
        if (selected && row[selected.output] !== value) return null;
      }
      const factGrain = JSON.stringify([tuple[0], ...factFieldIndexes.map((index) => tuple[1 + metrics.length + index])]);
      if (seenFactGrains.has(factGrain)) return null;
      seenFactGrains.add(factGrain);
      for (const key of plan.joinKeys) {
        const factIndex = plan.proofFields.findIndex((field) => field.table === "fact" && field.column === key);
        const dimensionIndex = plan.proofFields.findIndex((field) => field.table === "dimension" && field.column === key);
        if (factIndex < 0 || dimensionIndex < 0 || (!unmatched && tuple[1 + metrics.length + factIndex] !== tuple[1 + metrics.length + dimensionIndex])) return null;
      }
    }
    for (const metric of plan.metrics) {
      const expected = metric.operation === "sum" ? sums.get(metric.column)!.toString() : String(tuples.length);
      const actual = row[metric.output];
      if (!(typeof actual === "string" && /^-?\d+$/u.test(actual) || typeof actual === "number" && Number.isSafeInteger(actual)) || BigInt(actual as string | number).toString() !== expected) return null;
      verified.push({ fact: plan.fact, dimension: plan.dimension, column: metric.column, operation: metric.operation, value: expected, unit: metric.unit, description: metric.description, group, unmatched_rows: unmatchedRows, factFilters: plan.factFilters, dimensionFilters: plan.dimensionFilters, range: plan.range });
    }
  }
  return verified;
}

/** Extract the dimension values actually captured by a valid proof, for
 * comparison with the authority's published dimension snapshot. This helper
 * does not itself grant access or declare those values fresh. */
export function joinDimensionObservations(plan: JoinEvidencePlan, rows: Array<Record<string, unknown>>): JoinDimensionObservation[] | null {
  if (!verifyJoinEvidence(plan, rows)) return null;
  const metricCount = new Set(plan.metrics.map((metric) => metric.column)).size;
  const dimensionFields = plan.proofFields.flatMap((field, index) => field.table === "dimension" ? [{ column: field.column, index }] : []);
  const keyFields = plan.joinKeys.map((key) => dimensionFields.find((field) => field.column === key));
  if (keyFields.some((field) => !field)) return null;
  const unique = new Map<string, JoinDimensionObservation>();
  for (const row of rows) for (const tuple of row[PROOF] as unknown[][]) {
    // No dimension row was captured for this fact key. Its absence must be
    // checked separately against the complete published dimension snapshot.
    if (keyFields.every((field) => tuple[1 + metricCount + field!.index] === null)) continue;
    const keys = Object.fromEntries(keyFields.map((field) => [field!.column, tuple[1 + metricCount + field!.index] as string]));
    for (const field of dimensionFields) {
      const value = tuple[1 + metricCount + field.index];
      if (typeof value !== "string") return null;
      const observation = { keys, column: field.column, value };
      unique.set(JSON.stringify([plan.joinKeys.map((key) => keys[key]), field.column, value]), observation);
    }
  }
  return [...unique.values()];
}

/** Fact keys whose LEFT JOIN did not match. The caller must prove each key is
 * absent from the current, valid complete dimension publication; null alone
 * cannot distinguish an unchanged dimension from a stale publication. */
export function joinMissingDimensionKeys(plan: JoinEvidencePlan, rows: Array<Record<string, unknown>>): Array<Record<string, string>> | null {
  if (!verifyJoinEvidence(plan, rows)) return null;
  if (plan.joinType !== "left") return [];
  const metricCount = new Set(plan.metrics.map((metric) => metric.column)).size;
  const indexOf = (table: "fact" | "dimension", key: string) => plan.proofFields.findIndex((field) => field.table === table && field.column === key);
  const missing = new Map<string, Record<string, string>>();
  for (const row of rows) for (const tuple of row[PROOF] as unknown[][]) {
    const keys: Record<string, string> = {};
    let unmatched = true;
    for (const key of plan.joinKeys) {
      const fi = indexOf("fact", key), di = indexOf("dimension", key);
      if (fi < 0 || di < 0 || typeof tuple[1 + metricCount + fi] !== "string") return null;
      keys[key] = tuple[1 + metricCount + fi] as string;
      if (tuple[1 + metricCount + di] !== null) unmatched = false;
    }
    if (unmatched) missing.set(JSON.stringify(plan.joinKeys.map((key) => keys[key])), keys);
  }
  return [...missing.values()];
}
