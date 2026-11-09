// Apply contract-declared metric relationships to exact arithmetic and transforms.
import {
  arithmeticUnit,
  computeArithmetic,
  isExactZero,
  type ArithmeticOp,
  type ArithmeticValue,
} from "./exact-arithmetic.js";
import { tableGrain } from "./knowledge.js";
import { requiredAggregationDimensions } from "./aggregation-policy.js";
import {
  transformResult,
  type ResultColumn,
  type ResultTable,
  type TransformStep,
} from "./result-transform.js";
import type { KnowledgeBase } from "./types.js";
export class ResultPolicy {
  private readonly knowledge: KnowledgeBase;
  constructor(knowledge: KnowledgeBase) {
    this.knowledge = knowledge;
  }

  computeProvenArithmetic(
    op: ArithmeticOp,
    left: ArithmeticValue,
    right: ArithmeticValue,
  ): ArithmeticValue | null {
    if (
      left.interpretation === "mathematical_only" ||
      right.interpretation === "mathematical_only"
    )
      return computeArithmetic(op, left, right, false, true);
    const a = left.basis;
    const b = right.basis;
    const aBases = left.bases ?? [a];
    const bBases = right.bases ?? [b];
    // Incomplete folded groups can gain business lineage only within the
    // same saved physical row. Other combinations stay mathematical-only.
    if (left.scope_unverified || right.scope_unverified) {
      const x = left.row_identity, y = right.row_identity;
      if (!left.scope_unverified || !right.scope_unverified || !x || !y || typeof x.resource_id !== "string" || !x.resource_id || typeof x.execution_id !== "string" || !x.execution_id || !Number.isSafeInteger(x.row) || x.row < 0 || x.resource_id !== y.resource_id || x.execution_id !== y.execution_id || x.row !== y.row) return computeArithmetic(op, left, right, false, true);
    }
    // Comparing two sources is useful, but adding non-additive source scopes
    // must not become an apparently certified business total.
    if (op === "add") {
      for (const basis of aBases) {
        if (!bBases.some((other) => other.table === basis.table && other.column === basis.column)) continue;
        const contract = this.knowledge.contract_by_table.get(basis.table)?.contract;
        if (!contract) return null;
        const required = requiredAggregationDimensions(contract, basis.column);
        if (!required) return null;
        for (const dimension of required) {
          const scopeValue = (scope: ArithmeticValue["scopes"][number]) =>
            dimension === contract.series?.date_column
              ? scope.start === scope.end ? scope.start : null
              : scope.filters[dimension] ?? null;
          const values = [...left.scopes, ...right.scopes].map(scopeValue);
          if (!values.length || values.some((value) => value === null || value !== values[0])) return null;
        }
      }
    }
    let declared = false;
    if (
      aBases.length === 1 &&
      bBases.length === 1 &&
      (a.table !== b.table || a.column !== b.column)
    ) {
      const leftContract = this.knowledge.contract_by_table.get(
        a.table,
      )?.contract;
      const rightContract = this.knowledge.contract_by_table.get(
        b.table,
      )?.contract;
      const aSeries = leftContract?.series;
      const bSeries = rightContract?.series;
      const keys = (items: string[]) => JSON.stringify([...items].sort());
      const equalGrain =
        leftContract &&
        rightContract &&
        aSeries &&
        bSeries &&
        aSeries.date_column === bSeries.date_column &&
        keys(aSeries.dimensions) === keys(bSeries.dimensions) &&
        keys(tableGrain(this.knowledge, a.table)) ===
          keys(tableGrain(this.knowledge, b.table)) &&
        [aSeries.date_column, ...aSeries.dimensions].every((name) => {
          const leftType = leftContract.columns
            .find((column) => column.name === name)
            ?.type.replace(/\s/gu, "")
            .toLowerCase();
          const rightType = rightContract.columns
            .find((column) => column.name === name)
            ?.type.replace(/\s/gu, "")
            .toLowerCase();
          return Boolean(leftType && leftType === rightType);
        });
      const metric = (table: string, field: string, name: string) =>
        name === `${table}.${field}` || (name === field && a.table === b.table);
      const definitions = [
        ...(leftContract?.derived_metrics ?? []),
        ...(a.table === b.table ? [] : (rightContract?.derived_metrics ?? [])),
      ];
      const expectedUnit = arithmeticUnit(op, a.unit, b.unit);
      const sameVerifiedRow =
        a.operation === "value" &&
        b.operation === "value" &&
        left.row_identity &&
        right.row_identity &&
        left.row_identity.resource_id === right.row_identity.resource_id &&
        left.row_identity.execution_id === right.row_identity.execution_id &&
        left.row_identity.row === right.row_identity.row;
      const compatibleOperation =
        (a.operation === "sum" && b.operation === "sum") || sameVerifiedRow;
      // Unknown arithmetic over observed rows or proven sums establishes no
      // new business metric. Grain, actual status and scope must still match;
      // an unrelated NULL is not a valid substitute.
      if (
        (left.value === null || right.value === null) &&
        equalGrain &&
        expectedUnit &&
        (a.operation === "sum" ||
          (a.operation === "value" && left.row_identity)) &&
        (b.operation === "sum" ||
          (b.operation === "value" && right.row_identity)) &&
        a.prediction === "actual_observed_only" &&
        b.prediction === a.prediction &&
        a.timezone === b.timezone &&
        left.scopes.length === 1 &&
        right.scopes.length === 1 &&
        left.scopes[0]!.start === right.scopes[0]!.start &&
        left.scopes[0]!.end === right.scopes[0]!.end &&
        JSON.stringify(Object.entries(left.scopes[0]!.filters).sort()) ===
          JSON.stringify(Object.entries(right.scopes[0]!.filters).sort())
      )
        return computeArithmetic(op, left, right, false, true);
      declared = Boolean(
        equalGrain &&
        expectedUnit &&
        compatibleOperation &&
        a.prediction === "actual_observed_only" &&
        b.prediction === a.prediction &&
        a.timezone === b.timezone &&
        definitions.some(
          (item) =>
            item.operation === op &&
            item.prediction === "actual_only" &&
            (!item.scope || item.scope === "observed_partial_only" && left.scope_unverified === true && right.scope_unverified === true) &&
            item.unit === expectedUnit &&
            metric(a.table, a.column, item.numerator) &&
            metric(b.table, b.column, item.denominator),
        ),
      );
    }
    const proven = computeArithmetic(op, left, right, declared);
    return proven ?? (left.scope_unverified || right.scope_unverified ? computeArithmetic(op, left, right, false, true) : null);
  }

  /** Only host-reconstructed JOIN SUM provenance can establish a declared
   * same-row arithmetic. Labels and units supplied by the model confer no rights. */
  private authorizeTransformArithmetic(
    left: ResultColumn,
    right: ResultColumn,
    op: ArithmeticOp,
    allowObservedPartial = false,
  ): false | "full" | "partial" {
    const observed = allowObservedPartial && !left.metric && !right.metric && left.value_lineage && right.value_lineage;
    if (Boolean(left.metric) !== Boolean(right.metric)) return false;
    const a = left.metric ?? (observed ? { ...left.value_lineage!, operation: "sum" as const } : undefined);
    const b = right.metric ?? (observed ? { ...right.value_lineage!, operation: "sum" as const } : undefined);
    if (
      !a ||
      !b ||
      a.table !== b.table ||
      a.operation !== "sum" ||
      b.operation !== "sum"
    )
      return false;
    const contract = this.knowledge.contract_by_table.get(a.table)?.contract;
    if (
      !contract?.series ||
      contract.series.prediction_mode !== "observed_only" ||
      contract.series.predicted_column ||
      !contract.series.metrics.includes(a.column) ||
      !contract.series.metrics.includes(b.column)
    )
      return false;
    const leftColumn = contract.columns.find((item) => item.name === a.column);
    const rightColumn = contract.columns.find((item) => item.name === b.column);
    if (
      !leftColumn?.unit ||
      !rightColumn?.unit ||
      left.unit !== leftColumn.unit ||
      right.unit !== rightColumn.unit ||
      contract.sensitive_columns.includes(a.column) ||
      contract.sensitive_columns.includes(b.column)
    )
      return false;
    const unit = arithmeticUnit(op, left.unit, right.unit);
    if (!unit) return false;
    const matching = contract.derived_metrics?.filter((item) =>
      item.operation === op && item.prediction === "actual_only" &&
      item.numerator === a.column && item.denominator === b.column && item.unit === unit,
    ) ?? [];
    if (left.metric && right.metric && matching.some((item) => item.scope === undefined)) return "full";
    // JOIN metrics and direct observations may both support a ratio over the
    // returned groups; neither proves the requested population is complete.
    if (allowObservedPartial && (observed || left.metric && right.metric) && matching.some((item) => item.scope === "observed_partial_only")) return "partial";
    return false;
  }

  applyProvenTransform(
    input: ResultTable,
    steps: TransformStep[],
    allowObservedPartial = false,
  ): { table: ResultTable; undefinedArithmetic: boolean; observedPartialArithmetic: boolean } | null {
    if (!Array.isArray(steps) || !steps.length || steps.length > 10)
      return null;
    let table = input;
    let undefinedArithmetic = false;
    let observedPartialArithmetic = false;
    for (const step of steps) {
      if (step?.op === "group" && Array.isArray(step.aggregates) && Array.isArray(step.by)) {
        for (const aggregate of step.aggregates) {
          if (!aggregate || !["sum", "min", "max"].includes(aggregate.op)) continue;
          const column = table.columns.find((item) => item.name === aggregate.column);
          if (!column) return null;
          const dependencies = column.aggregation_lineage ?? (column.value_lineage ? [column.value_lineage] : column.metric ? [{ table: column.metric.table, column: column.metric.column }] : []);
          for (const dependency of dependencies) {
            const contract = this.knowledge.contract_by_table.get(dependency.table)?.contract;
            if (!contract) return null;
            const required = requiredAggregationDimensions(contract, dependency.column);
            if (!required || required.some((dimension) => !step.by.some((name) => {
              const key = table.columns.find((item) => item.name === name);
              return [key?.key_lineage, ...(key?.key_lineages ?? [])].some((lineage) => lineage?.table === dependency.table && lineage.column === dimension);
            }))) return null;
          }
        }
      }
      if (
        step &&
        (step.op === "add" ||
          step.op === "subtract" ||
          step.op === "multiply" ||
          step.op === "divide") &&
        table.rows.some(
          (row) =>
            row[step.left] === null ||
            row[step.right] === null ||
            (step.op === "divide" && isExactZero(row[step.right])),
        )
      )
        undefinedArithmetic = true;
      const next = transformResult(table, [step], (left, right, op) => {
        const authority = this.authorizeTransformArithmetic(left, right, op, allowObservedPartial);
        if (authority === "partial") observedPartialArithmetic = true;
        return authority !== false;
      });
      if (!next) return null;
      table = next;
    }
    return { table, undefinedArithmetic, observedPartialArithmetic };
  }
}
