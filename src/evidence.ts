import { parseReadonlySql } from "./sql.js";
import type { DataContract, QueryResource } from "./types.js";

export interface CellOperation {
  op: "sum" | "count_null" | "count_zero" | "count_rows";
  column?: string;
  predicted?: "actual_only" | "predicted_only" | "any";
  as: string;
}

export interface VerifiedCell {
  value: number;
  precision: "exact_integer" | "floating_point_approximate";
  table: string;
  column: string | null;
  outputColumn: string | null;
  description: string;
  unit: string;
  operation: CellOperation["op"];
  prediction: string;
  predictionFilter: "actual_only" | "predicted_only" | "any";
  filters: Record<string, string>;
  range: QueryResource["time_range"];
  sourceResourceId: string;
  excludedNulls: number;
}

/** Only direct projections from one contracted table and conjunctive, literal filters
 * are currently eligible for authoritative calculation statements. This is
 * independent of SQL admission: admitted SQL can still have unknown lineage. */
export function verifyCell(source: QueryResource, contract: DataContract, operation: CellOperation, storedValue: number): VerifiedCell | null {
  if (source.truncated || !source.complete_population || source.tables.length !== 1 || source.tables[0] !== contract.table || !contract.series) return null;
  let ast: Record<string, unknown>;
  try { ast = parseReadonlySql(source.sql).ast; } catch { return null; }
  if (ast.with || ast.distinct || ast.groupby || ast.having || ast.limit || ast._next || ast.options) return null;
  const from = Array.isArray(ast.from) ? ast.from : [];
  if (from.length !== 1) return null;
  const relation = record(from[0]);
  if (!relation || relation.table !== contract.table || relation.db || relation.join || relation.expr) return null;
  const qualifier = typeof relation.as === "string" ? relation.as : contract.table;
  const projections = Array.isArray(ast.columns) ? ast.columns : [];
  const projectedToField = new Map<string, string>();
  const fieldToProjected = new Map<string, string>();
  const contractNames = new Set(contract.columns.map((column) => column.name));
  for (const projection of projections) {
    const item = record(projection); const expr = record(item?.expr);
    if (!item || !expr || expr.type !== "column_ref" || typeof expr.column !== "string" || (expr.table && expr.table !== qualifier)) return null;
    const field = expr.column;
    const output = item.as === null || item.as === undefined ? field : item.as;
    if (typeof output !== "string" || !/^[a-z_][a-z0-9_]*$/u.test(output) || !contractNames.has(field) || projectedToField.has(output) || fieldToProjected.has(field) || (output !== field && contractNames.has(output))) return null;
    projectedToField.set(output, field);
    fieldToProjected.set(field, output);
  }
  const dateColumn = contract.series.date_column;
  const dimensions = new Set([...contract.series.dimensions, ...(contract.grain ?? []).filter((x) => x !== dateColumn && !contract.series!.metrics.includes(x))]);
  const filters: Record<string, string> = {};
  let start = ""; let end = "";
  function visit(value: unknown): boolean {
    const expression = record(value);
    if (!expression || expression.type !== "binary_expr") return false;
    if (expression.operator === "AND") return visit(expression.left) && visit(expression.right);
    const left = record(expression.left); const right = record(expression.right);
    if (!left || left.type !== "column_ref" || typeof left.column !== "string" || (left.table && left.table !== qualifier) || !right || !["single_quote_string", "number"].includes(String(right.type))) return false;
    const valueString = String(right.value);
    if (left.column === dateColumn) {
      if (right.type !== "single_quote_string" || !/^\d{4}-\d{2}-\d{2}$/u.test(valueString)) return false;
      if (expression.operator === ">=" && !start) start = valueString;
      else if (expression.operator === "<=" && !end) end = valueString;
      else return false;
      return true;
    }
    if (expression.operator !== "=" || !dimensions.has(left.column) || Object.hasOwn(filters, left.column)) return false;
    filters[left.column] = valueString;
    return true;
  }
  if (!visit(ast.where) || !start || !end || start !== source.time_range.start || end !== source.time_range.end) return null;
  for (const [key, value] of Object.entries(filters)) {
    const output = fieldToProjected.get(key);
    if (output && source.rows.some((row) => String(row[output]) !== value)) return null;
  }
  const op = operation.op;
  if (!["sum", "count_null", "count_zero", "count_rows"].includes(op)) return null;
  const outputColumn = op === "count_rows" ? null : operation.column ?? "";
  const column = outputColumn ? projectedToField.get(outputColumn) ?? "" : null;
  const declared = column ? contract.columns.find((item) => item.name === column) : undefined;
  if (op !== "count_rows" && (!column || !outputColumn || !contract.series.metrics.includes(column) || !declared)) return null;
  if (outputColumn && source.rows.some((row) => !Object.hasOwn(row, outputColumn))) return null;
  const predColumn = contract.series.predicted_column;
  if (predColumn && contract.series.prediction_mode || !predColumn && contract.series.prediction_values) return null;
  let rows = source.rows;
  let prediction = "契约未声明预测标记，实际/预测状态未验证";
  if (predColumn) {
    const mapping = contract.series.prediction_values;
    const predOutput = fieldToProjected.get(predColumn);
    if (!mapping || !Number.isFinite(mapping.actual) || !Number.isFinite(mapping.predicted) || mapping.actual === mapping.predicted) return null;
    if (!predOutput || rows.some((row) => !Object.hasOwn(row, predOutput) || (typeof row[predOutput] !== "number" && (typeof row[predOutput] !== "string" || !/^-?\d+(?:\.\d+)?$/u.test(row[predOutput] as string))) || ![mapping.actual, mapping.predicted].includes(Number(row[predOutput])))) return null;
    const wanted = operation.predicted ?? "any";
    if (wanted === "actual_only") { rows = rows.filter((row) => Number(row[predOutput]) === mapping.actual); prediction = `实际（${predColumn}=${mapping.actual}）`; }
    else if (wanted === "predicted_only") { rows = rows.filter((row) => Number(row[predOutput]) === mapping.predicted); prediction = `预测（${predColumn}=${mapping.predicted}）`; }
    else {
      const flags = new Set(rows.map((row) => Number(row[predOutput])));
      if (flags.size > 1 && op !== "count_rows") return null;
      prediction = flags.size > 1 ? "包含实际和预测（未分开）" : flags.has(mapping.predicted) ? `预测（${predColumn}=${mapping.predicted}）` : flags.has(mapping.actual) ? `实际（${predColumn}=${mapping.actual}）` : "无符合预测筛选的行";
    }
  } else if (contract.series.prediction_mode === "observed_only") {
    if ((operation.predicted ?? "any") === "predicted_only") return null;
    prediction = "实际（契约声明仅观察值）";
  } else if ((operation.predicted ?? "any") !== "any") return null;
  if (op !== "count_rows" && rows.length === 0) return null;
  let actual: number;
  let precision: VerifiedCell["precision"] = "exact_integer";
  let excludedNulls = 0;
  if (op === "count_rows") actual = rows.length;
  else {
    const values = rows.map((row) => row[outputColumn!]);
    excludedNulls = values.filter((value) => value === null).length;
    if (values.some((value) => value !== null && (typeof value !== "number" || !Number.isFinite(value)))) return null;
    if (op === "count_null") actual = excludedNulls;
    else if (op === "count_zero") actual = values.filter((value) => value === 0).length;
    else {
      const numeric = values.filter((value): value is number => typeof value === "number");
      if (!numeric.length) return null;
      const integerType = declared && /^(?:nullable\()?\s*(?:u?int\d*|integer)\s*\)?$/iu.test(declared.type);
      if (integerType) {
        let magnitude = 0n;
        for (const value of numeric) {
          if (!Number.isSafeInteger(value)) return null;
          const n = BigInt(value);
          magnitude += n < 0n ? -n : n;
          if (magnitude > BigInt(Number.MAX_SAFE_INTEGER)) return null;
        }
      } else precision = "floating_point_approximate";
      actual = numeric.reduce((a, b) => a + b, 0);
    }
  }
  if (!Number.isFinite(storedValue) || Math.abs(actual - storedValue) > 1e-9) return null;
  return {
    value: actual, precision, table: contract.table, column, outputColumn, description: declared?.description ?? "查询结果行数",
    unit: op === "sum" ? (declared?.unit || "契约未声明") : "行",
    operation: op, prediction, predictionFilter: operation.predicted ?? "any", filters, range: source.time_range, sourceResourceId: source.resource_id, excludedNulls,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
