// Revalidate a dependency graph without persisting new resources.
import { createHash } from "node:crypto";
import { permitsAggregation } from "./aggregation-policy.js";
import { groupedTransformObservation } from "./grouped-transform-evidence.js";
import { verifyDatabaseAggregates, type VerifiedAggregate } from "./aggregate-evidence.js";
import { verifyGroupRollup } from "./aggregate-rollup.js";
import { currentCalendarDate, isCalendarDate } from "./config.js";
import { coverageHasGap, provenCoverageFilters } from "./coverage.js";
import { verifyDecimalCell } from "./decimal-cell-evidence.js";
import { normalizeDecimal } from "./decimal-kernel.js";
import { queryEvidenceShape } from "./evidence-shape.js";
import { verifyCell } from "./evidence.js";
import {
  arithmeticUnit,
  fromAggregate,
  sumDecimalStrings,
  type ArithmeticValue,
} from "./exact-arithmetic.js";
import { type FreshnessPublication } from "./freshness.js";
import { joinCoverage, verifyJoinResource, type JoinQueryResource } from "./join-resource-proof.js";
import { joinResultTable } from "./join-result-table.js";
import { canQueryTable, contractValidity, tableGrain } from "./knowledge.js";
import { queryCellInput } from "./query-cell-input.js";
import { queryRowsMatchScope, verifyQueryObservation } from "./query-observation.js";
import { readResultResource } from "./resource-reader.js";
import { aggregateTable, alignmentTable, rawResultTable, stableHashes } from "./result-adapters.js";
import {
  alignAggregates,
  alignCompleteTables,
  type AlignedRow,
  type AlignmentSpec,
  type CompleteKeyedInput,
} from "./result-alignment.js";
import { calculateResultCells } from "./result-cells.js";
import {
  evaluationContext,
  type EvaluatedResult,
  type EvaluatedValue,
  type EvaluationContext,
} from "./result-evaluation-context.js";
import { ResultPolicy } from "./result-policy.js";
import {
  RESULT_CALCULATION_MAX_ROWS,
  type ResultColumn,
  type ResultTable,
  type ResultValue,
} from "./result-transform.js";
import { type SessionRecord } from "./session.js";
import { ToolAccess } from "./tool-access.js";
import { type ToolContext } from "./tool-context.js";
import { typedObservation } from "./typed-observation.js";
import {
  aggregateObservationInput,
  aggregateObservationValue,
} from "./aggregate-observation.js";
import type { ArithmeticRef, DataContract, QueryResource } from "./types.js";
export class ResultEvaluator {
  private readonly ctx: ToolContext;
  private readonly access: ToolAccess;
  private readonly policy: ResultPolicy;
  constructor(ctx: ToolContext, access: ToolAccess) {
    this.ctx = ctx;
    this.access = access;
    this.policy = new ResultPolicy(ctx.knowledge);
  }

  /** Observed arithmetic needs one currently authorized physical query;
   * JOIN evidence must also retain both contracts and the published snapshot. */
  async canUseObservedTransform(session: SessionRecord, jobId: string, leaves: string[], publication: FreshnessPublication): Promise<boolean> {
    if (leaves.length !== 1) return false;
    const found = await this.ctx.sessions.lookupResourceAsync(session.session_id, leaves[0]!);
    if (!found.ok || found.resource.kind !== "query_result" || found.resource.job_id !== jobId) return false;
    if (found.resource.tables.length === 2) {
      if (!(await this.access.resourceReadable(session.session_id, found.resource))) return false;
      const joined = verifyJoinResource(found.resource as JoinQueryResource, session, this.ctx.knowledge, this.ctx.config, publication);
      const fact = joined && this.ctx.knowledge.contract_by_table.get(joined.plan.fact)?.contract;
      const dimension = joined && this.ctx.knowledge.contract_by_table.get(joined.plan.dimension)?.contract;
      return Boolean(joined && fact && dimension && joinResultTable(joined.plan, joined.values, fact, dimension));
    }
    const contract = this.arithmeticContract(session, found.resource, publication);
    const evidence = contract && this.access.evidenceSource(session, found.resource);
    return Boolean(contract && evidence && (rawResultTable(evidence, contract) || aggregateObservationInput(evidence, contract)));
  }

  async resolveAlignment(
    session: SessionRecord,
    jobId: string,
    spec: AlignmentSpec,
    publication: FreshnessPublication,
    path: Set<string> = new Set(),
    evaluation: EvaluationContext = evaluationContext(),
  ): Promise<{
    rows: AlignedRow[];
    hashes: Record<string, string>;
    leaves: string[];
    partial: boolean;
  } | null> {
    if (
      !spec ||
      !spec.left ||
      !spec.right ||
      typeof spec.left.resource_id !== "string" ||
      typeof spec.right.resource_id !== "string" ||
      typeof spec.left.cell !== "string" ||
      typeof spec.right.cell !== "string"
    )
      return null;
    const inputs: Array<{
      source: QueryResource;
      contract: DataContract;
      aggregates: VerifiedAggregate[] | null;
    }> = [];
    for (const ref of [spec.left, spec.right]) {
      const found = await this.ctx.sessions.lookupResourceAsync(session.session_id, ref.resource_id);
      if (!found.ok || found.resource.job_id !== jobId) return null;
      if (found.resource.kind !== "query_result")
        return this.resolveDerivedAlignment(session, jobId, spec, publication, path, evaluation);
      const source = found.resource;
      const contract = this.arithmeticContract(session, source, publication);
      const evidence = contract && this.access.evidenceSource(session, source);
      if (!contract || !evidence) return null;
      if (
        !(await this.evaluateVerifiedResult(
          session,
          jobId,
          source.resource_id,
          publication,
          path,
          evaluation,
        ))
      )
        return null;
      const aggregates =
        verifyDatabaseAggregates(evidence, contract)?.filter(
          (item) => item.output_column === ref.cell,
        ) ?? null;
      inputs.push({ source, contract, aggregates });
    }
    if (!inputs[0]!.aggregates?.length || !inputs[1]!.aggregates?.length)
      return this.resolveCompleteRawAlignment(session, jobId, spec, publication, inputs, evaluation);
    const first = inputs[0]!.aggregates[0]!;
    const second = inputs[1]!.aggregates[0]!;
    if (stableHashes(first.filters) !== stableHashes(second.filters)) return null;
    const aScope = fromAggregate(first);
    const bScope = fromAggregate(second);
    aScope.scopes[0]!.filters = { ...first.filters };
    bScope.scopes[0]!.filters = { ...second.filters };
    if (!this.policy.computeProvenArithmetic(spec.op, aScope, bScope)) return null;
    const rows = alignAggregates(
      inputs[0]!.aggregates,
      inputs[1]!.aggregates,
      spec.keys,
      spec.op,
      (op, a, b) => this.policy.computeProvenArithmetic(op, a, b),
    );
    if (!rows) return null;
    const hashes = Object.fromEntries(
      inputs.map(({ source }) => [
        source.resource_id,
        createHash("sha256").update(JSON.stringify(source)).digest("hex"),
      ]),
    );
    return {
      rows,
      hashes,
      leaves: [...new Set(inputs.map(({ source }) => source.resource_id))],
      partial: inputs.some((item) =>
        item.aggregates?.some((aggregate) => aggregate.coverage_incomplete),
      ),
    };
  }

  /** Keyed mathematical alignment of verified derived results. Physical key
   * lineage and compatible contracts establish key equivalence; display
   * labels do not establish a new business metric. */
  private async resolveDerivedAlignment(
    session: SessionRecord,
    jobId: string,
    spec: AlignmentSpec,
    publication: FreshnessPublication,
    path: Set<string>,
    evaluation: EvaluationContext,
  ): Promise<{
    rows: AlignedRow[];
    hashes: Record<string, string>;
    leaves: string[];
    partial: boolean;
  } | null> {
    if (
      !Array.isArray(spec.keys) ||
      !spec.keys.length ||
      spec.keys.length > 3 ||
      new Set(spec.keys).size !== spec.keys.length
    )
      return null;
    // Evaluate sequentially so shared dependencies use the completed cache;
    // never cache an in-flight promise that could wait on its own cycle.
    const checked = [
      await this.evaluateVerifiedResult(
        session,
        jobId,
        spec.left.resource_id,
        publication,
        new Set(path),
        evaluation,
      ),
      await this.evaluateVerifiedResult(
        session,
        jobId,
        spec.right.resource_id,
        publication,
        new Set(path),
        evaluation,
      ),
    ];
    if (!checked[0] || !checked[1] || checked.some((item) => !item || !item.leaves.length)) return null;
    const groups: QueryResource[][] = [];
    for (const evaluated of checked) {
      const sources: QueryResource[] = [];
      for (const id of evaluated!.leaves) {
        const found = await this.ctx.sessions.lookupResourceAsync(session.session_id, id);
        if (
          !found.ok ||
          found.resource.kind !== "query_result" ||
          found.resource.job_id !== jobId ||
          found.resource.tables.length !== 1
        )
          return null;
        sources.push(found.resource);
      }
      groups.push(sources);
    }
    const leftSource = groups[0]![0]!;
    const rightSource = groups[1]![0]!;
    if (
      groups
        .flat()
        .some(
          (source) =>
            source.time_range.start !== leftSource.time_range.start ||
            source.time_range.end !== leftSource.time_range.end ||
            source.time_range.timezone !== leftSource.time_range.timezone,
        )
    )
      return null;
    const contract = this.arithmeticContract(session, leftSource, publication);
    const other = this.arithmeticContract(session, rightSource, publication);
    if (
      !contract?.series ||
      !other?.series ||
      contract.series.predicted_column ||
      other.series.predicted_column ||
      contract.series.prediction_mode !== "observed_only" ||
      other.series.prediction_mode !== "observed_only" ||
      contract.series.date_column !== other.series.date_column ||
      JSON.stringify([...contract.series.dimensions].sort()) !==
        JSON.stringify([...other.series.dimensions].sort()) ||
      JSON.stringify([...tableGrain(this.ctx.knowledge, contract.table)].sort()) !==
        JSON.stringify([...tableGrain(this.ctx.knowledge, other.table)].sort())
    )
      return null;
    const leftEvidence = this.access.evidenceSource(session, leftSource);
    const rightEvidence = this.access.evidenceSource(session, rightSource);
    const leftFilters =
      leftEvidence && provenCoverageFilters(leftEvidence.sql, contract, leftSource.time_range);
    const rightFilters =
      rightEvidence && provenCoverageFilters(rightEvidence.sql, other, rightSource.time_range);
    if (
      !leftFilters ||
      !rightFilters ||
      stableHashes(leftFilters) !== stableHashes(rightFilters) ||
      spec.keys.some(
        (key) =>
          (key !== contract.series!.date_column && !contract.series!.dimensions.includes(key)) ||
          Object.hasOwn(leftFilters, key),
      ) ||
      !contract.series.dimensions.every(
        (key) => spec.keys.includes(key) || Object.hasOwn(leftFilters, key),
      )
    )
      return null;
    for (let index = 0; index < checked.length; index++)
      for (const key of spec.keys) {
        const column = checked[index]!.table.columns.find((candidate) => candidate.name === key);
        const lineages = column?.key_lineages ?? (column?.key_lineage ? [column.key_lineage] : []);
        if (!column || column.type !== "text" || !lineages.length) return null;
        for (const source of groups[index]!) {
          const current = this.arithmeticContract(session, source, publication);
          const series = current?.series;
          const evidence = current && this.access.evidenceSource(session, source);
          const filters =
            evidence && current && provenCoverageFilters(evidence.sql, current, source.time_range);
          const expected = current?.columns
            .find((item) => item.name === key)
            ?.type.replace(/\s/gu, "")
            .toLowerCase();
          const firstType = contract.columns
            .find((item) => item.name === key)
            ?.type.replace(/\s/gu, "")
            .toLowerCase();
          if (
            !current ||
            !series ||
            series.predicted_column ||
            series.prediction_mode !== "observed_only" ||
            series.date_column !== contract.series.date_column ||
            JSON.stringify([...series.dimensions].sort()) !==
              JSON.stringify([...contract.series.dimensions].sort()) ||
            JSON.stringify([...tableGrain(this.ctx.knowledge, current.table)].sort()) !==
              JSON.stringify([...tableGrain(this.ctx.knowledge, contract.table)].sort()) ||
            !filters ||
            stableHashes(filters) !== stableHashes(leftFilters) ||
            !expected ||
            expected !== firstType ||
            !lineages.some(
              (item) =>
                item.table === current.table && item.column === key && item.physical_type === expected,
            )
          )
            return null;
        }
      }
    const multipleLeaves = groups.some((sources) => sources.length > 1);
    // A derived table can carry several independently revalidated leaves.
    // The key lineage, contracts, ranges and filters for every leaf have all
    // been checked above. Its value is still mathematical-only, not a newly
    // certified business metric. Preserve the stricter declared-metric rule
    // for directly aligning distinct single-source metrics.
    if (
      !multipleLeaves &&
      contract.table !== other.table &&
      spec.left.resource_id !== spec.right.resource_id
    ) {
      const leftMetric = checked[0]!.table.columns.find((column) => column.name === spec.left.cell);
      const rightMetric = checked[1]!.table.columns.find((column) => column.name === spec.right.cell);
      const a = leftMetric?.value_lineage;
      const b = rightMetric?.value_lineage;
      const expectedUnit =
        leftMetric && rightMetric && arithmeticUnit(spec.op, leftMetric.unit, rightMetric.unit);
      const declared = [...(contract.derived_metrics ?? []), ...(other.derived_metrics ?? [])].some(
        (item) =>
          item.operation === spec.op &&
          item.prediction === "actual_only" &&
          item.unit === expectedUnit &&
          item.numerator === `${a?.table}.${a?.column}` &&
          item.denominator === `${b?.table}.${b?.column}`,
      );
      if (
        !a ||
        !b ||
        a.table !== contract.table ||
        b.table !== other.table ||
        !expectedUnit ||
        !declared
      )
        return null;
    }
    const inputs: CompleteKeyedInput[] = [];
    const makers: Array<(value: string | null) => ArithmeticValue> = [];
    for (let index = 0; index < 2; index++) {
      const ref = index ? spec.right : spec.left;
      const table = checked[index]!.table;
      const metric = table.columns.find((column) => column.name === ref.cell);
      if (!metric || metric.type !== "decimal" || !Number.isInteger(metric.scale)) return null;
      const make = (value: string | null): ArithmeticValue => ({
        value,
        scale: metric.scale!,
        unit: metric.unit || "未认证",
        basis: {
          table: "结果资源",
          column: `${ref.resource_id}.${ref.cell}`,
          operation: "result_cell",
          unit: metric.unit || "未认证",
          prediction: "未认证",
          timezone: "未认证",
        },
        scopes: [],
        interpretation: "mathematical_only",
        ...(metric.approximate ? { approximate: true } : {}),
        formula: `${ref.resource_id}.${ref.cell}`,
      });
      makers.push(make);
      const normalized = {
        ...table,
        columns: table.columns.map((column) =>
          spec.keys.includes(column.name) ? { ...column, unit: `维度 ${column.name}` } : column,
        ),
      };
      inputs.push({
        table: normalized,
        valueColumn: ref.cell,
        keyColumns: spec.keys,
        valueForGroup: make,
      });
    }
    const aligned = alignCompleteTables(inputs[0]!, inputs[1]!, spec.op, (op, left, right) =>
      this.policy.computeProvenArithmetic(op, left, right),
    );
    if (!aligned) return null;
    const rows: AlignedRow[] = aligned.map((row) => ({
      group: row.group as Record<string, string | null>,
      status: row.status,
      left: row.left ? makers[0]!(row.left.value) : null,
      right: row.right ? makers[1]!(row.right.value) : null,
      result: row.result,
      ...(row.left ? { left_count: row.left.count, left_null_count: row.left.null_count } : {}),
      ...(row.right ? { right_count: row.right.count, right_null_count: row.right.null_count } : {}),
    }));
    const hashes: Record<string, string> = {};
    for (const item of checked)
      for (const [id, digest] of Object.entries(item!.hashes)) {
        if (hashes[id] && hashes[id] !== digest) return null;
        hashes[id] = digest;
      }
    return {
      rows,
      hashes,
      leaves: [...new Set(checked.flatMap((item) => item!.leaves))],
      partial: checked.some((item) => item!.partial),
    };
  }

  /** Each side is a complete direct projection or a verified database SUM;
   * both are re-authorized and hash-bound on calculation and delivery. */
  private async resolveCompleteRawAlignment(
    session: SessionRecord,
    jobId: string,
    spec: AlignmentSpec,
    publication: FreshnessPublication,
    inputs: Array<{
      source: QueryResource;
      contract: DataContract;
      aggregates: VerifiedAggregate[] | null;
    }>,
    evaluation: EvaluationContext,
  ): Promise<{
    rows: AlignedRow[];
    hashes: Record<string, string>;
    leaves: string[];
    partial: boolean;
  } | null> {
    const keys = spec.keys;
    if (
      !Array.isArray(keys) ||
      !keys.length ||
      keys.length > 3 ||
      new Set(keys).size !== keys.length ||
      keys.some((key) => !/^[a-z_][a-z0-9_]{0,63}$/u.test(key))
    )
      return null;
    const prepared: Array<{
      input: CompleteKeyedInput;
      make: (value: string | null, values: ReadonlyArray<ResultValue>) => ArithmeticValue | null;
      filters: Record<string, string>;
      source: QueryResource;
      partial: boolean;
    }> = [];
    for (let i = 0; i < inputs.length; i++) {
      const { source, contract, aggregates } = inputs[i]!;
      const ref = i === 0 ? spec.left : spec.right;
      const evidence = this.access.evidenceSource(session, source);
      const series = contract.series;
      if (
        !evidence ||
        !series ||
        series.prediction_mode !== "observed_only" ||
        series.predicted_column ||
        source.coverage.unknown_prediction_dates.length ||
        source.coverage.predicted_dates.length
      )
        return null;
      if (aggregates?.length) {
        const first = aggregates[0]!;
        const orderedKeys = [...keys].sort();
        if (
          first.operation !== "sum" ||
          !series.metrics.includes(first.column) ||
          JSON.stringify(Object.keys(first.group).sort()) !== JSON.stringify(orderedKeys) ||
          !series.dimensions.every((key) => keys.includes(key) || Object.hasOwn(first.filters, key)) ||
          keys.some((key) => !series.dimensions.includes(key) || Object.hasOwn(first.filters, key)) ||
          aggregates.some(
            (item) =>
              item.operation !== "sum" ||
              item.table !== first.table ||
              item.column !== first.column ||
              item.output_column !== first.output_column ||
              item.unit !== first.unit ||
              item.scale !== first.scale ||
              stableHashes(item.filters) !== stableHashes(first.filters) ||
              JSON.stringify(Object.keys(item.group).sort()) !== JSON.stringify(orderedKeys),
          )
        )
          return null;
        const table = aggregateTable(
          aggregates,
          source.key_lineage_version === 1 ? contract : undefined,
        );
        if (!table) return null;
        const normalized: ResultTable = {
          ...table,
          columns: table.columns.map((column) =>
            keys.includes(column.name) ? { ...column, unit: `维度 ${column.name}` } : column,
          ),
        };
        const make = (
          value: string | null,
          values: ReadonlyArray<ResultValue>,
        ): ArithmeticValue | null => {
          if (values.some((v) => typeof v !== "string")) return null;
          const filters: Record<string, string | null> = { ...first.filters };
          keys.forEach((key, index) => {
            filters[key] = values[index] as string;
          });
          return {
            value,
            scale: first.scale,
            unit: first.unit,
            basis: {
              table: first.table,
              column: first.column,
              operation: "sum",
              unit: first.unit,
              prediction: first.prediction,
              timezone: first.range.timezone,
            },
            scopes: [{ filters, start: first.range.start, end: first.range.end }],
          };
        };
        prepared.push({
          input: { table: normalized, valueColumn: ref.cell, keyColumns: keys, valueForGroup: make },
          make,
          filters: first.filters,
          source,
          partial: Boolean(first.coverage_incomplete),
        });
        continue;
      }
      const shape = verifyCell(
        evidence,
        contract,
        { op: "count_rows", as: "shape" },
        source.rows.length,
      );
      const projections = queryEvidenceShape(evidence, contract)?.columns;
      if (!shape || !Array.isArray(projections)) return null;
      const fields = new Map<string, string>();
      for (const entry of projections as Array<{
        as?: string | null;
        expr?: { type?: string; column?: string };
      }>)
        if (entry.expr?.type === "column_ref" && entry.expr.column)
          fields.set(entry.as ?? entry.expr.column, entry.expr.column);
      const field = fields.get(ref.cell);
      const declared = contract.columns.find((item) => item.name === field);
      if (
        !field ||
        !declared?.unit ||
        !series.metrics.includes(field) ||
        !permitsAggregation(contract, field, shape.filters, keys, source.time_range) ||
        keys.some(
          (key) =>
            fields.get(key) !== key ||
            (key !== series.date_column && !series.dimensions.includes(key)) ||
            Object.hasOwn(shape.filters, key),
        ) ||
        !series.dimensions.every((key) => keys.includes(key) || Object.hasOwn(shape.filters, key))
      )
        return null;
      const checked = await this.evaluateVerifiedResult(
        session,
        jobId,
        source.resource_id,
        publication,
        new Set(),
        evaluation,
      );
      const table = checked?.table;
      const metric = table?.columns.find((column) => column.name === ref.cell);
      if (
        !table ||
        !metric ||
        metric.type !== "decimal" ||
        metric.scale === undefined ||
        keys.some((key) => table.columns.find((column) => column.name === key)?.type !== "text") ||
        table.rows.some((row) =>
          keys.some((key) =>
            key === series.date_column
              ? typeof row[key] !== "string" ||
                !isCalendarDate(row[key]) ||
                row[key] < source.time_range.start ||
                row[key] > source.time_range.end
              : row[key] !== null && typeof row[key] !== "string",
          ),
        )
      )
        return null;
      // Normalize only after physical key names and contract types have been
      // checked; a model-provided alias never establishes key equivalence.
      const normalized: ResultTable = {
        ...table,
        columns: table.columns.map((column) =>
          keys.includes(column.name) ? { ...column, unit: `维度 ${column.name}` } : column,
        ),
      };
      const make = (
        value: string | null,
        values: ReadonlyArray<ResultValue>,
      ): ArithmeticValue | null => {
        if (values.some((v) => v !== null && typeof v !== "string")) return null;
        const filters: Record<string, string | null> = { ...shape.filters };
        for (let n = 0; n < keys.length; n++) filters[keys[n]!] = values[n] as string | null;
        return {
          value,
          scale: metric.scale!,
          unit: declared.unit!,
          basis: {
            table: contract.table,
            column: field,
            operation: "sum",
            unit: declared.unit!,
            prediction: "actual_observed_only",
            timezone: source.time_range.timezone,
          },
          scopes: [{ filters, start: source.time_range.start, end: source.time_range.end }],
        };
      };
      prepared.push({
        input: { table: normalized, valueColumn: ref.cell, keyColumns: keys, valueForGroup: make },
        make,
        filters: shape.filters,
        source,
        partial: checked!.partial,
      });
    }
    if (
      prepared.length !== 2 ||
      stableHashes(prepared[0]!.filters) !== stableHashes(prepared[1]!.filters)
    )
      return null;
    const a = prepared[0]!,
      b = prepared[1]!;
    const fakeKeys = keys.map(() => "scope");
    const sampleA = a.make(
      `1${a.input.table.columns.find((c) => c.name === a.input.valueColumn)!.scale ? "." + "0".repeat(a.input.table.columns.find((c) => c.name === a.input.valueColumn)!.scale!) : ""}`,
      fakeKeys,
    );
    const sampleB = b.make(
      `1${b.input.table.columns.find((c) => c.name === b.input.valueColumn)!.scale ? "." + "0".repeat(b.input.table.columns.find((c) => c.name === b.input.valueColumn)!.scale!) : ""}`,
      fakeKeys,
    );
    if (!sampleA || !sampleB || !this.policy.computeProvenArithmetic(spec.op, sampleA, sampleB))
      return null;
    const aligned = alignCompleteTables(a.input, b.input, spec.op, (op, x, y) =>
      this.policy.computeProvenArithmetic(op, x, y),
    );
    if (!aligned) return null;
    const rows: AlignedRow[] = [];
    for (const row of aligned) {
      const values = keys.map((key) => row.group[key]!);
      if (values.some((value) => value !== null && typeof value !== "string")) return null;
      rows.push({
        group: row.group as Record<string, string | null>,
        status: row.status,
        left: row.left ? a.make(row.left.value, values) : null,
        right: row.right ? b.make(row.right.value, values) : null,
        result: row.result,
        ...(row.left ? { left_count: row.left.count, left_null_count: row.left.null_count } : {}),
        ...(row.right ? { right_count: row.right.count, right_null_count: row.right.null_count } : {}),
      });
    }
    const hashes = Object.fromEntries(
      inputs.map(({ source }) => [
        source.resource_id,
        createHash("sha256").update(JSON.stringify(source)).digest("hex"),
      ]),
    );
    return {
      rows,
      hashes,
      leaves: [...new Set(inputs.map(({ source }) => source.resource_id))],
      partial: prepared.some((item) => item.partial),
    };
  }

  /** One request-local entry for typed results. Only completed evaluations are
   * cached; neither authority decisions nor in-flight promises cross calls. */
  async evaluateVerifiedResult(
    session: SessionRecord,
    jobId: string,
    resourceId: string,
    publication: FreshnessPublication,
    path: Set<string>,
    evaluation: EvaluationContext = evaluationContext(),
  ): Promise<EvaluatedResult | null> {
    if (typeof resourceId !== "string" || path.has(resourceId) || path.size >= 8) return null;
    const prior = evaluation.completed.get(resourceId);
    if (prior) return prior;
    evaluation.seen.add(resourceId);
    if (evaluation.seen.size > 128) return null;
    const result = await this.evaluateResultNode(
      session,
      jobId,
      resourceId,
      publication,
      path,
      evaluation,
    );
    if (!result) return null;
    const bytes = Buffer.byteLength(JSON.stringify(result.table));
    if (evaluation.rows + result.table.rows.length > 100_000 || evaluation.bytes + bytes > 16_000_000)
      return null;
    evaluation.rows += result.table.rows.length;
    evaluation.bytes += bytes;
    evaluation.completed.set(resourceId, result);
    return result;
  }

  private async evaluateResultNode(
    session: SessionRecord,
    jobId: string,
    resourceId: string,
    publication: FreshnessPublication,
    path: Set<string>,
    evaluation: EvaluationContext,
  ): Promise<EvaluatedResult | null> {
    const found = await this.ctx.sessions.lookupResourceAsync(session.session_id, resourceId);
    if (!found.ok || found.resource.job_id !== jobId) return null;
    const resource = found.resource;
    const ownHash = createHash("sha256").update(JSON.stringify(resource)).digest("hex");
    if (resource.kind === "query_result") {
      // JOIN rows are accepted only after revalidating their private proof,
      // both contracts, authorization and the current publication. Build
      // semantic column labels from the contracts rather than SQL aliases.
      if (resource.tables.length === 2) {
        const joined = verifyJoinResource(
          resource as JoinQueryResource,
          session,
          this.ctx.knowledge,
          this.ctx.config,
          publication,
        );
        const fact = joined && this.ctx.knowledge.contract_by_table.get(joined.plan.fact)?.contract;
        const dimension =
          joined && this.ctx.knowledge.contract_by_table.get(joined.plan.dimension)?.contract;
        const table =
          joined && fact && dimension && joinResultTable(joined.plan, joined.values, fact, dimension);
        const classified =
          table &&
          resource.result_semantics_version === 2 &&
          fact?.series?.prediction_mode === "observed_only" &&
          !fact.series.predicted_column
            ? { ...table, prediction_scope: "observed_only" as const }
            : table;
        return classified
          ? {
              table: classified,
              hashes: { [resource.resource_id]: ownHash },
              leaves: [resource.resource_id],
              partial: false,
            }
          : null;
      }
      const contract = this.arithmeticContract(session, resource, publication);
      const evidence = this.access.evidenceSource(session, resource);
      if (contract && evidence && !queryRowsMatchScope(evidence, contract)) return null;
      const aggregates = contract && evidence && verifyDatabaseAggregates(evidence, contract);
      let table =
        aggregates &&
        aggregateTable(aggregates, resource.key_lineage_version === 1 ? contract! : undefined);
      const aggregateInput =
        !table && contract && evidence
          ? aggregateObservationInput(evidence, contract)
          : null;
      if (aggregateInput) table = aggregateInput.table;
      if (!table && contract && evidence) {
        // Read the stored result through the same bounded, hash-bound pages
        // exposed to agents. A mutation between pages invalidates the input.
        const rows: Array<Record<string, unknown>> = [];
        let offset = 0;
        do {
          const page = await readResultResource(this.ctx, this.access, session.session_id, {
            resource_id: resourceId,
            row_offset: offset,
            row_limit: 100,
            expected_resource_hash: ownHash,
          });
          if (
            !page.ok ||
            page.resource_hash !== ownHash ||
            page.resource_truncated ||
            !page.resource ||
            typeof page.resource !== "object"
          )
            return null;
          const result = page.resource as QueryResource;
          if (result.job_id !== jobId || !Array.isArray(result.rows) || result.rows.length > 100)
            return null;
          rows.push(...result.rows);
          if (rows.length > RESULT_CALCULATION_MAX_ROWS) return null;
          const next = page.next_row_offset;
          if (!page.has_more) break;
          if (
            !Number.isInteger(next) ||
            (next as number) !== offset + result.rows.length ||
            !result.rows.length
          )
            return null;
          offset = next as number;
        } while (true);
        if (
          rows.length !== resource.returned_rows ||
          rows.length !== resource.total_rows ||
          resource.total_rows_exact !== true
        )
          return null;
        const complete = { ...evidence, rows };
        table = rawResultTable(complete, contract);
        if (!table && verifyCell(complete, contract, { op: "count_rows", as: "shape" }, rows.length))
          table = queryCellInput(complete, contract);
      }
      let expressionOnly = false;
      if (!table && contract && evidence) {
        table = typedObservation(resource);
        expressionOnly = Boolean(table);
      }
      if (
        table &&
        resource.result_semantics_version === 2 &&
        contract?.series?.prediction_mode === "observed_only" &&
        !contract.series.predicted_column
      )
        table = { ...table, prediction_scope: "observed_only" };
      const partial =
        coverageHasGap(resource.coverage) ||
        resource.coverage.unknown_prediction_dates.length > 0 ||
        resource.coverage.status !== "known" ||
        !resource.rows.length ||
        Boolean(aggregateInput?.incomplete) ||
        Boolean(aggregates?.some((item) => item.coverage_incomplete));
      return table
        ? {
            table,
            hashes: { [resource.resource_id]: ownHash },
            leaves: [resource.resource_id],
            partial,
            ...(expressionOnly ? { expression_only: true } : {}),
            ...(aggregateInput ? { aggregate_input: true } : {}),
            ...(partial ? { partial_reason: "transform_coverage_incomplete" as const } : {}),
          }
        : null;
    }
    if (resource.kind === "alignment") {
      const next = new Set(path);
      next.add(resourceId);
      const checked = await this.resolveAlignment(
        session,
        jobId,
        resource.spec,
        publication,
        next,
        evaluation,
      );
      if (
        !checked ||
        Boolean(resource.coverage_incomplete) !== checked.partial ||
        stableHashes(checked.hashes) !== stableHashes(resource.input_hashes) ||
        JSON.stringify(checked.rows) !== JSON.stringify(resource.rows)
      )
        return null;
      const keySources: Record<string, NonNullable<ResultColumn["key_lineages"]>> = {};
      let observedOnly = false;
      if (resource.key_lineage_version === 1) {
        const a = await this.evaluateVerifiedResult(
          session,
          jobId,
          resource.spec.left.resource_id,
          publication,
          next,
          evaluation,
        );
        const b = await this.evaluateVerifiedResult(
          session,
          jobId,
          resource.spec.right.resource_id,
          publication,
          next,
          evaluation,
        );
        observedOnly =
          a?.table.prediction_scope === "observed_only" && b?.table.prediction_scope === "observed_only";
        if (a && b)
          for (const key of resource.spec.keys) {
            const columns = [a, b].map((item) =>
              item.table.columns.find((column) => column.name === key),
            );
            const lineages = columns.flatMap(
              (column) => column?.key_lineages ?? (column?.key_lineage ? [column.key_lineage] : []),
            );
            if (columns.every((column) => column && (column.key_lineage || column.key_lineages?.length)))
              keySources[key] = [
                ...new Map(lineages.map((item) => [JSON.stringify(item), item])).values(),
              ];
          }
      }
      const table = alignmentTable(resource.spec, checked.rows, keySources);
      const partial =
        checked.partial ||
        checked.rows.some(
          (row) => row.status !== "matched" || Object.values(row.group).some((value) => value === null),
        );
      return table
        ? {
            table: observedOnly ? { ...table, prediction_scope: "observed_only" } : table,
            hashes: { ...checked.hashes, [resource.resource_id]: ownHash },
            leaves: checked.leaves,
            partial,
            ...(partial ? { partial_reason: "alignment_incomplete" as const } : {}),
          }
        : null;
    }
    if (resource.kind === "calculation" && resource.evaluated_table_v1) {
      if (!resource.execution_id || !resource.operations || !resource.source_resource_hash) return null;
      const next = new Set(path);
      next.add(resourceId);
      const parent = await this.evaluateVerifiedResult(
        session,
        jobId,
        resource.source_resource_id,
        publication,
        next,
        evaluation,
      );
      if (
        !parent ||
        parent.hashes[resource.source_resource_id] !== resource.source_resource_hash ||
        stableHashes(parent.hashes) !== stableHashes(resource.evaluated_table_v1.input_hashes)
      )
        return null;
      const result = calculateResultCells(parent.table, Object.values(resource.operations));
      if (
        !result ||
        result.incomplete !== resource.evaluated_table_v1.incomplete ||
        JSON.stringify(result.table) !== JSON.stringify(resource.evaluated_table_v1.table) ||
        Object.entries(resource.cells).some(([key, value]) => {
          const expected = result.table.rows[0]?.[key];
          return typeof value === "number"
            ? typeof expected !== "string" ||
                normalizeDecimal(String(value)) !== normalizeDecimal(expected)
            : value !== expected;
        }) ||
        Object.keys(resource.cells).length !== result.table.columns.length
      )
        return null;
      const partial = parent.partial || result.incomplete;
      return {
        table: result.table,
        hashes: { ...parent.hashes, [resourceId]: ownHash },
        leaves: parent.leaves,
        partial,
        ...(partial
          ? { partial_reason: parent.partial_reason ?? ("transform_coverage_incomplete" as const) }
          : {}),
        ...(parent.partial_reasons ? { partial_reasons: parent.partial_reasons } : {}),
      };
    }
    if (resource.kind === "calculation" || resource.kind === "arithmetic") {
      if (!resource.execution_id) return null;
      const names = resource.kind === "calculation" ? Object.keys(resource.cells) : ["result"];
      if (!names.length || names.length > 40) return null;
      const columns: ResultColumn[] = [];
      const row: Record<string, string | null> = {};
      const hashes: Record<string, string> = {};
      const leaves = new Set<string>();
      let partial = false;
      for (const name of names) {
        const checked = await this.resolveArithmetic(
          session,
          jobId,
          { resource_id: resourceId, execution_id: resource.execution_id, cell: name },
          publication,
          path,
          evaluation,
          true,
        );
        if (
          !checked ||
          !Number.isInteger(checked.value.scale) ||
          checked.value.scale < 0 ||
          checked.value.scale > 38
        )
          return null;
        columns.push({
          name,
          type: "decimal",
          scale: checked.value.scale,
          unit: checked.value.unit || "未认证",
          label: `已复核计算单元 ${name}`,
          ...(checked.value.approximate ? { approximate: true } : {}),
        });
        row[name] = checked.value.value;
        for (const [id, digest] of Object.entries(checked.hashes)) {
          if (hashes[id] && hashes[id] !== digest) return null;
          hashes[id] = digest;
        }
        checked.leaves.forEach((id) => leaves.add(id));
        partial ||= checked.value.partial === true || checked.value.value === null;
      }
      let observedOnly = leaves.size > 0;
      // Check every intermediate recipe, not only the outer resource. An
      // arithmetic wrapper must never turn a forecast-only calculation into
      // an observation merely because its physical leaf is observed-only.
      for (const id of Object.keys(hashes)) {
        const found = await this.ctx.sessions.lookupResourceAsync(session.session_id, id);
        if (
          !found.ok ||
          (found.resource.kind === "calculation" &&
            Object.values(found.resource.operations ?? {}).some(
              (operation) => operation.predicted === "predicted_only",
            ))
        )
          observedOnly = false;
      }
      for (const id of leaves) {
        const found = await this.ctx.sessions.lookupResourceAsync(session.session_id, id);
        const query = found.ok && found.resource.kind === "query_result" ? found.resource : null;
        const facts =
          query?.tables
            .map((table) => this.ctx.knowledge.contract_by_table.get(table)?.contract)
            .filter((contract) => contract?.series) ?? [];
        if (
          !query ||
          query.result_semantics_version !== 2 ||
          facts.length !== 1 ||
          facts[0]?.series?.prediction_mode !== "observed_only" ||
          facts[0].series.predicted_column
        )
          observedOnly = false;
      }
      return {
        table: {
          columns,
          rows: [row],
          ...(observedOnly ? { prediction_scope: "observed_only" as const } : {}),
        },
        hashes,
        leaves: [...leaves],
        partial,
        ...(partial ? { partial_reason: "transform_undefined_division" as const } : {}),
      };
    }
    if (resource.kind !== "transform") return null;
    const next = new Set(path);
    next.add(resourceId);
    const source = await this.evaluateVerifiedResult(
      session,
      jobId,
      resource.source_resource_id,
      publication,
      next,
      evaluation,
    );
    if (!source || stableHashes(source.hashes) !== stableHashes(resource.input_hashes)) return null;
    const allowObservedPartial = await this.canUseObservedTransform(session, jobId, source.leaves, publication);
    const transformed = this.policy.applyProvenTransform(source.table, resource.steps, allowObservedPartial);
    if (!transformed || JSON.stringify(transformed.table) !== JSON.stringify(resource.result))
      return null;
    const partial = source.partial || transformed.undefinedArithmetic || transformed.observedPartialArithmetic;
    const partialReasons: NonNullable<EvaluatedResult["partial_reasons"]> = [...new Set([
      ...(source.partial_reasons ?? (source.partial_reason ? [source.partial_reason] : [])),
      ...(transformed.undefinedArithmetic ? ["transform_undefined_division" as const] : []),
      ...(transformed.observedPartialArithmetic ? ["transform_coverage_incomplete" as const] : []),
    ])];
    return {
      table: transformed.table,
      hashes: { ...source.hashes, [resource.resource_id]: ownHash },
      leaves: source.leaves,
      partial,
      ...(partialReasons.length ? { partial_reason: partialReasons[0], partial_reasons: partialReasons } : {}),
    };
  }

  async resolveArithmetic(
    session: SessionRecord,
    jobId: string,
    ref: ArithmeticRef,
    publication: FreshnessPublication,
    path: Set<string>,
    evaluation: EvaluationContext = evaluationContext(),
    evaluatingScalar = false,
  ): Promise<EvaluatedValue | null> {
    if (
      !ref ||
      typeof ref.resource_id !== "string" ||
      typeof ref.cell !== "string" ||
      path.has(ref.resource_id) ||
      path.size >= 8
    )
      return null;
    const cacheKey = JSON.stringify([
      ref.resource_id,
      ref.execution_id ?? null,
      ref.cell,
      ref.row ?? null,
      ref.aggregate ?? null,
      ref.group ?? null,
    ]);
    const cached = evaluation.values.get(cacheKey);
    if (cached) return cached;
    if (!evaluatingScalar) {
      const table = await this.evaluateVerifiedResult(
        session,
        jobId,
        ref.resource_id,
        publication,
        path,
        evaluation,
      );
      if (!table) return null;
      const fromEvaluation = evaluation.values.get(cacheKey);
      if (fromEvaluation) return fromEvaluation;
    }
    const result = await this.resolveArithmeticNode(session, jobId, ref, publication, path, evaluation);
    if (result) evaluation.values.set(cacheKey, result);
    return result;
  }

  private async resolveArithmeticNode(
    session: SessionRecord,
    jobId: string,
    ref: ArithmeticRef,
    publication: FreshnessPublication,
    path: Set<string>,
    evaluation: EvaluationContext,
  ): Promise<EvaluatedValue | null> {
    if (
      !ref ||
      typeof ref.resource_id !== "string" ||
      typeof ref.cell !== "string" ||
      path.has(ref.resource_id) ||
      path.size >= 8
    )
      return null;
    const found = await this.ctx.sessions.lookupResourceAsync(session.session_id, ref.resource_id);
    if (!found.ok || found.resource.job_id !== jobId) return null;
    const resource = found.resource;
    const ownHash = createHash("sha256").update(JSON.stringify(resource)).digest("hex");
    const next = new Set(path);
    next.add(resource.resource_id);
    if (resource.kind === "query_result") {
      if (resource.tables.length === 2) {
        if (ref.group || !ref.execution_id || ref.execution_id !== resource.execution_id ||
            (ref.row === undefined) === (ref.aggregate === undefined) ||
            (ref.row !== undefined && (!Number.isSafeInteger(ref.row) || ref.row < 0)) ||
            (ref.aggregate !== undefined && ref.aggregate !== "sum")) return null;
        const joined = verifyJoinResource(resource as JoinQueryResource, session, this.ctx.knowledge, this.ctx.config, publication);
        const checked = joined && await this.evaluateVerifiedResult(session, jobId, resource.resource_id, publication, path, evaluation);
        const fact = joined && this.ctx.knowledge.contract_by_table.get(joined.plan.fact)?.contract;
        if (!joined || !checked || !fact) return null;
        const coverage = joinCoverage(joined.plan, (resource as JoinQueryResource).join_proof!.rows, fact);
        // Arithmetic on a JOIN result is a mathematical observation. A
        // verified row does not assert an unobserved group or business metric.
        return this.selectTableArithmetic({ ...checked, partial: checked.partial || coverage.status !== "known" || coverageHasGap(coverage) }, ref);
      }
      const contract = this.arithmeticContract(session, resource, publication);
      const evidence = this.access.evidenceSource(session, resource);
      if (!contract || !evidence) return null;
      const evaluated = await this.evaluateVerifiedResult(
        session,
        jobId,
        resource.resource_id,
        publication,
        path,
        evaluation,
      );
      if (!evaluated) return null;
      if (evaluated.expression_only) {
        if (
          ref.group ||
          !resource.execution_id ||
          ref.execution_id !== resource.execution_id ||
          (ref.row === undefined) === (ref.aggregate === undefined) ||
          (ref.row !== undefined && (!Number.isSafeInteger(ref.row) || ref.row < 0)) ||
          (ref.aggregate !== undefined && ref.aggregate !== "sum")
        )
          return null;
        return this.selectTableArithmetic(evaluated, ref);
      }
      if (
        ref.row !== undefined &&
        !ref.group &&
        ref.aggregate === undefined &&
        Number.isSafeInteger(ref.row) &&
        ref.row >= 0 &&
        ref.execution_id === resource.execution_id
      ) {
        const observation = verifyQueryObservation(evidence, contract, ref.row, ref.cell);
        if (observation?.aggregation === "sum") {
          const value = aggregateObservationValue(
            [observation], observation.value, observation.scale, evaluated.partial, true,
          );
          if (value) return { value, hashes: evaluated.hashes, leaves: evaluated.leaves };
          // A folded subtotal can still be used as explicitly unverified
          // mathematics; it cannot acquire full business-scope authority.
          return !observation.scope_complete ? this.selectTableArithmetic({ ...evaluated, partial: true }, ref) : null;
        }
      }
      // An ungrouped, independently verified aggregate has exactly one row.
      // Its stored resource already binds the execution and content hash, so
      // row 0 can be resolved without trusting a model-supplied execution ID.
      if (
        ref.row === 0 &&
        (ref.execution_id === undefined || ref.execution_id === resource.execution_id) &&
        ref.aggregate === undefined &&
        !ref.group &&
        resource.execution_id &&
        resource.rows.length === 1
      ) {
        const matching =
          verifyDatabaseAggregates(evidence, contract)?.filter(
            (item) => item.output_column === ref.cell && Object.keys(item.group).length === 0,
          ) ?? [];
        if (matching.length === 1)
          return {
            value: fromAggregate(matching[0]!),
            hashes: { [resource.resource_id]: ownHash },
            leaves: [resource.resource_id],
          };
      }
      // A proven database grouping is already a typed, complete result. The
      // same column sum must not depend on inserting an identity sort first.
      if (
        ref.aggregate === "sum" &&
        ref.row === undefined &&
        !ref.group &&
        ref.execution_id &&
        ref.execution_id === resource.execution_id &&
        verifyDatabaseAggregates(evidence, contract)?.some(
          (item) => item.output_column === ref.cell && Object.keys(item.group).length > 0,
        )
      ) {
        const checked = await this.evaluateVerifiedResult(
          session,
          jobId,
          resource.resource_id,
          publication,
          path,
          evaluation,
        );
        return checked ? this.selectTableArithmetic(checked, ref) : null;
      }
      if (ref.row !== undefined || ref.aggregate !== undefined || ref.execution_id !== undefined) {
        // Only a one-row resource can unambiguously select row zero without
        // a model-supplied ID. Use the stored execution ID, never invent one;
        // explicit mismatches and all multi-row references still fail closed.
        const executionId =
          ref.execution_id ??
          (ref.row === 0 && resource.rows.length === 1 ? resource.execution_id : undefined);
        if (
          ref.group ||
          !executionId ||
          executionId !== resource.execution_id ||
          (ref.row === undefined) === (ref.aggregate === undefined) ||
          (ref.row !== undefined && (!Number.isSafeInteger(ref.row) || ref.row < 0)) ||
          (ref.aggregate !== undefined && ref.aggregate !== "sum")
        )
          return null;
        // A missing cell can have sound provenance despite incomplete metric
        // coverage. Admit only the proven unknown here, never a numeric total.
        const missing =
          ref.row !== undefined ? verifyQueryObservation(evidence, contract, ref.row, ref.cell) : null;
        if (missing?.value === null && missing.scope_complete && missing.prediction === "actual") {
          return {
            value: {
              value: null,
              scale: missing.scale,
              unit: missing.unit,
              basis: {
                table: missing.table,
                column: missing.column,
                operation: "value",
                unit: missing.unit,
                prediction: "actual_observed_only",
                timezone: missing.range.timezone,
              },
              row_identity: {
                resource_id: resource.resource_id,
                execution_id: executionId,
                row: missing.row,
              },
              scopes: [{ filters: missing.filters, start: missing.range.start, end: missing.range.end }],
              partial: true,
              undefined_reason: "null_input",
            },
            hashes: evaluated.hashes,
            leaves: evaluated.leaves,
          };
        }
        if (coverageHasGap(resource.coverage) || resource.coverage.unknown_prediction_dates.length)
          return null;
        const checked = await this.evaluateVerifiedResult(
          session,
          jobId,
          resource.resource_id,
          publication,
          path,
          evaluation,
        );
        const table = checked?.table;
        const column = table?.columns.find((candidate) => candidate.name === ref.cell);
        const shape = verifyCell(
          evidence,
          contract,
          { op: "count_rows", as: "shape" },
          resource.rows.length,
        );
        const projections = queryEvidenceShape(evidence, contract)?.columns;
        const projection = Array.isArray(projections)
          ? (projections.find(
              (item) =>
                item &&
                typeof item === "object" &&
                ((item as { as?: string | null; expr?: { column?: string } }).as ??
                  (item as { expr?: { column?: string } }).expr?.column) === ref.cell,
            ) as { expr?: { type?: string; column?: string } } | undefined)
          : undefined;
        const field = projection?.expr?.type === "column_ref" ? projection.expr.column : undefined;
        if (
          !checked ||
          !table ||
          !column ||
          column.type !== "decimal" ||
          !shape ||
          !field ||
          !contract.series?.metrics.includes(field) ||
          !contract.columns.find((candidate) => candidate.name === field)?.unit ||
          !rawResultTable(evidence, contract)
        )
          return null;
        const filters = { ...shape.filters };
        let start = resource.time_range.start;
        let end = resource.time_range.end;
        let value: string | null;
        if (ref.row !== undefined) {
          const row = table.rows[ref.row];
          if (!row || typeof row[ref.cell] !== "string") return null;
          value = row[ref.cell] as string;
          const outputs = new Map<string, string>();
          for (const item of projections as Array<{
            as?: string | null;
            expr?: { type?: string; column?: string };
          }>)
            if (item.expr?.type === "column_ref" && item.expr.column)
              outputs.set(item.expr.column, item.as ?? item.expr.column);
          for (const dimension of contract.series.dimensions) {
            if (Object.hasOwn(filters, dimension)) continue;
            const output = outputs.get(dimension);
            const selected = output && row[output];
            if (typeof selected !== "string") return null;
            filters[dimension] = selected;
          }
          const dateOutput = outputs.get(contract.series.date_column);
          const dateValue = dateOutput && row[dateOutput];
          if (
            typeof dateValue === "string" &&
            /^\d{4}-\d{2}-\d{2}$/u.test(dateValue) &&
            dateValue >= start &&
            dateValue <= end
          )
            start = end = dateValue;
          else if (start !== end) return null;
        } else {
          if (!permitsAggregation(contract, field, filters, [], resource.time_range)) return null;
          if (table.rows.some((row) => typeof row[ref.cell] !== "string")) return null;
          value = sumDecimalStrings(
            table.rows.map((row) => row[ref.cell]),
            column.scale!,
          );
          if (value === null) return null;
        }
        const exact: ArithmeticValue = {
          value,
          scale: column.scale!,
          unit: column.unit,
          basis: {
            table: contract.table,
            column: field,
            operation: ref.row === undefined ? "sum" : "value",
            unit: column.unit,
            prediction: "actual_observed_only",
            timezone: resource.time_range.timezone,
          },
          ...(ref.row === undefined
            ? {}
            : {
                row_identity: {
                  resource_id: resource.resource_id,
                  execution_id: executionId,
                  row: ref.row,
                },
              }),
          scopes: [{ filters, start, end }],
        };
        return { value: exact, hashes: checked.hashes, leaves: checked.leaves };
      }
      const canonical = (group: Record<string, string>) =>
        JSON.stringify(Object.entries(group).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
      const matching =
        verifyDatabaseAggregates(evidence, contract)?.filter(
          (item) =>
            item.output_column === ref.cell && canonical(item.group) === canonical(ref.group ?? {}),
        ) ?? [];
      if (matching.length !== 1) return null;
      return {
        value: fromAggregate(matching[0]!),
        hashes: { [resource.resource_id]: ownHash },
        leaves: [resource.resource_id],
      };
    }
    if (resource.kind === "transform" || resource.kind === "alignment") {
      // Derived executions have their own identity; never interpret row zero
      // from different resources as a matched business row.
      if (
        ref.group ||
        !resource.execution_id ||
        ref.execution_id !== resource.execution_id ||
        (ref.row === undefined) === (ref.aggregate === undefined) ||
        (ref.row !== undefined && (!Number.isSafeInteger(ref.row) || ref.row < 0)) ||
        (ref.aggregate !== undefined && ref.aggregate !== "sum")
      )
        return null;
      const checked = await this.evaluateVerifiedResult(
        session,
        jobId,
        resource.resource_id,
        publication,
        path,
        evaluation,
      );
      if (checked && resource.kind === "transform" && ref.row !== undefined) {
        const parent = await this.ctx.sessions.lookupResourceAsync(session.session_id, resource.source_resource_id);
        if (parent.ok && parent.resource.kind === "query_result" && parent.resource.job_id === jobId) {
          const contract = this.arithmeticContract(session, parent.resource, publication);
          const evidence = contract && this.access.evidenceSource(session, parent.resource);
          const observed = contract && evidence && groupedTransformObservation(evidence, contract, resource, checked.table, ref);
          if (observed) return { value: observed, hashes: checked.hashes, leaves: checked.leaves };
        }
      }
      return checked ? this.selectTableArithmetic(checked, ref) : null;
    }
    if (
      (ref.execution_id !== undefined && ref.execution_id !== resource.execution_id) ||
      ref.row !== undefined ||
      ref.aggregate !== undefined
    )
      return null;
    if (resource.kind === "calculation") {
      const directParent = await this.ctx.sessions.lookupResourceAsync(
        session.session_id,
        resource.source_resource_id,
      );
      if (!directParent.ok) return null;
      const parentEvaluation =
        resource.evaluated_table_v1 && directParent.resource.kind === "query_result"
          ? await this.evaluateVerifiedResult(
              session,
              jobId,
              directParent.resource.resource_id,
              publication,
              new Set([...path, resource.resource_id]),
              evaluation,
            )
          : null;
      if (
        parentEvaluation?.aggregate_input &&
        directParent.resource.kind === "query_result" &&
        resource.evaluated_table_v1 &&
        resource.operations?.[ref.cell]?.op === "sum"
      ) {
        const source = directParent.resource;
        const contract = this.arithmeticContract(session, source, publication);
        const evidence = contract && this.access.evidenceSource(session, source);
        const aggregate = contract && evidence && aggregateObservationInput(evidence, contract);
        const checked = await this.evaluateVerifiedResult(
          session, jobId, resource.resource_id, publication, path, evaluation,
        );
        const column = checked?.table.columns.find((item) => item.name === ref.cell);
        const stored = checked?.table.rows[0]?.[ref.cell];
        const operation = resource.operations[ref.cell]!;
        const observations = aggregate?.observations.filter(
          (item) => item.output_column === operation.column &&
            (operation.predicted === "actual_only"
              ? item.prediction === "actual"
              : operation.predicted === "predicted_only"
                ? item.prediction === "predicted"
                : true),
        ) ?? [];
        const value = checked && column && (stored === null || typeof stored === "string")
          ? aggregateObservationValue(observations, stored, column.scale!, checked.partial, false, true)
          : null;
        if (value) return { value, hashes: checked!.hashes, leaves: checked!.leaves };
      }
      if (
        resource.evaluated_table_v1 &&
        (directParent.resource.kind !== "query_result" ||
          parentEvaluation?.expression_only ||
          resource.cells[ref.cell] === null)
      ) {
        const checked = await this.evaluateVerifiedResult(
          session,
          jobId,
          resource.resource_id,
          publication,
          path,
          evaluation,
        );
        const column = checked?.table.columns.find((item) => item.name === ref.cell);
        const value = checked?.table.rows[0]?.[ref.cell];
        if (
          !checked ||
          !column ||
          column.type !== "decimal" ||
          !Number.isInteger(column.scale) ||
          (value !== null && typeof value !== "string")
        )
          return null;
        return {
          value: {
            value: value as string | null,
            scale: column.scale!,
            unit: column.unit || "未认证",
            basis: {
              table: "结果资源",
              column: ref.cell,
              operation: "result_cell",
              unit: column.unit || "未认证",
              prediction: "未认证",
              timezone: "未认证",
            },
            interpretation: "mathematical_only",
            ...(column.approximate ? { approximate: true } : {}),
            ...(checked.partial || value === null ? { partial: true } : {}),
            formula: `${resource.resource_id} 的列 ${ref.cell}`,
            scopes: [],
          },
          hashes: checked.hashes,
          leaves: checked.leaves,
        };
      }
      if (
        resource.evaluated_table_v1 &&
        !(await this.evaluateVerifiedResult(
          session,
          jobId,
          resource.resource_id,
          publication,
          path,
          evaluation,
        ))
      )
        return null;
      if (ref.group || !resource.operations || !Object.hasOwn(resource.operations, ref.cell))
        return null;
      const foundSource = directParent;
      if (
        !foundSource.ok ||
        foundSource.resource.kind !== "query_result" ||
        foundSource.resource.job_id !== jobId
      )
        return null;
      const source = foundSource.resource;
      const contract = this.arithmeticContract(session, source, publication);
      if (
        !resource.source_resource_hash ||
        resource.source_resource_hash !==
          createHash("sha256").update(JSON.stringify(source)).digest("hex")
      )
        return null;
      const evidence = this.access.evidenceSource(session, source);
      const operation = resource.operations[ref.cell];
      const stored = resource.cells[ref.cell];
      if (
        !contract ||
        !evidence ||
        !operation ||
        coverageHasGap(source.coverage) ||
        source.coverage.unknown_prediction_dates.length
      )
        return null;
      if (operation.op !== "sum") {
        if (typeof stored !== "number" || !Number.isSafeInteger(stored) || stored < 0) return null;
        const verified = verifyCell(evidence, contract, operation, stored);
        const grouped = !verified ? verifyGroupRollup(evidence, contract, operation, stored) : null;
        if (
          (verified &&
            (verified.precision !== "exact_integer" || !verified.prediction.startsWith("实际（"))) ||
          (grouped && Object.keys(grouped.in_sets).length) ||
          (!verified && !grouped)
        )
          return null;
        const value = verified ?? grouped!;
        const result: ArithmeticValue = {
          value: String(stored),
          scale: 0,
          unit: value.unit,
          basis: {
            table: value.table,
            column: value.column ?? "结果行",
            operation: operation.op,
            unit: value.unit,
            prediction: "actual_observed_only",
            timezone: value.range.timezone,
          },
          scopes: [{ filters: value.filters, start: value.range.start, end: value.range.end }],
        };
        return {
          value: result,
          hashes: {
            [source.resource_id]: createHash("sha256").update(JSON.stringify(source)).digest("hex"),
            [resource.resource_id]: ownHash,
          },
          leaves: [source.resource_id],
        };
      }
      const decimal =
        typeof stored === "string" ? verifyDecimalCell(evidence, contract, operation, stored) : null;
      const integer =
        typeof stored === "number" ? verifyCell(evidence, contract, operation, stored) : null;
      const grouped =
        !decimal && !integer && (typeof stored === "string" || typeof stored === "number")
          ? verifyGroupRollup(evidence, contract, operation, stored)
          : null;
      // ArithmeticValue currently represents equality filters, not IN sets.
      // Do not silently drop an IN restriction when converting a rollup.
      if (grouped && (grouped.input_operation !== "sum" || Object.keys(grouped.in_sets).length))
        return null;
      if (
        !decimal &&
        !grouped &&
        (!integer ||
          integer.precision !== "exact_integer" ||
          !integer.column ||
          integer.unit === "契约未声明" ||
          !integer.prediction.startsWith("实际（") ||
          integer.excludedNulls)
      )
        return null;
      const base = decimal ?? grouped ?? integer!;
      const column = base.column!;
      const value = String(base.value);
      const scale = decimal || grouped ? (value.split(".")[1]?.length ?? 0) : 0;
      const aggregate: VerifiedAggregate = {
        source_resource_id: source.resource_id,
        table: base.table,
        column,
        output_column: operation.column ?? "",
        operation: "sum",
        value,
        scale,
        unit: base.unit,
        description: base.description,
        filters: base.filters,
        group: {},
        range: base.range,
        prediction: "actual_observed_only",
      };
      return {
        value: fromAggregate(aggregate),
        hashes: {
          [source.resource_id]: createHash("sha256").update(JSON.stringify(source)).digest("hex"),
          [resource.resource_id]: ownHash,
        },
        leaves: [source.resource_id],
      };
    }
    if (resource.kind !== "arithmetic" || ref.cell !== "result" || ref.group) return null;
    const left = await this.resolveArithmetic(
      session,
      jobId,
      resource.left,
      publication,
      next,
      evaluation,
    );
    const right = await this.resolveArithmetic(
      session,
      jobId,
      resource.right,
      publication,
      next,
      evaluation,
    );
    if (!left || !right) return null;
    const hashes = { ...left.hashes, ...right.hashes };
    const stable = (value: Record<string, string>) =>
      JSON.stringify(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    if (stable(hashes) !== stable(resource.input_hashes)) return null;
    const value = this.policy.computeProvenArithmetic(resource.operation, left.value, right.value);
    if (!value || JSON.stringify(value) !== JSON.stringify(resource.result)) return null;
    return {
      value,
      hashes: { ...hashes, [resource.resource_id]: ownHash },
      leaves: [...new Set([...left.leaves, ...right.leaves])],
    };
  }

  private selectTableArithmetic(
    checked: { table: ResultTable; hashes: Record<string, string>; leaves: string[]; partial: boolean },
    ref: ArithmeticRef,
  ): { value: ArithmeticValue; hashes: Record<string, string>; leaves: string[] } | null {
    const column = checked.table.columns.find((item) => item.name === ref.cell);
    if (
      !column ||
      column.type !== "decimal" ||
      !Number.isInteger(column.scale) ||
      column.scale! < 0 ||
      column.scale! > 38
    )
      return null;
    let values: Array<string | null>;
    if (ref.row !== undefined) {
      const row = checked.table.rows[ref.row];
      if (!row || !Object.hasOwn(row, ref.cell)) return null;
      const value = row[ref.cell];
      if (value !== null && typeof value !== "string") return null;
      values = [value as string | null];
    } else {
      values = [];
      for (const row of checked.table.rows) {
        const value = row[ref.cell];
        if (value !== null && typeof value !== "string") return null;
        values.push(value as string | null);
      }
    }
    const nonNull = values.filter((value): value is string => value !== null);
    const value = nonNull.length ? sumDecimalStrings(nonNull, column.scale!) : null;
    if (nonNull.length && value === null) return null;
    const partial = checked.partial || !values.length || nonNull.length !== values.length;
    const selection = ref.row !== undefined ? `第 ${ref.row} 行` : "整列非 NULL 合计";
    const result: ArithmeticValue = {
      value,
      scale: column.scale!,
      unit: column.unit || "未认证",
      basis: {
        table: "结果资源",
        column: ref.cell,
        operation: "result_cell",
        unit: column.unit || "未认证",
        prediction: "未认证",
        timezone: "未认证",
      },
      interpretation: "mathematical_only",
      ...(column.approximate ? { approximate: true } : {}),
      ...(partial ? { partial: true } : {}),
      formula: `${ref.resource_id} 的列 ${ref.cell}（${selection}）`,
      scopes: [],
    };
    return { value: result, hashes: checked.hashes, leaves: checked.leaves };
  }

  private arithmeticContract(
    session: SessionRecord,
    resource: QueryResource,
    publication: FreshnessPublication,
  ): DataContract | null {
    if (resource.tables.length !== 1 || resource.truncated || !resource.complete_population) return null;
    const asset = this.ctx.knowledge.contract_by_table.get(resource.tables[0]!);
    const contract = asset?.contract;
    if (
      !asset ||
      !contract ||
      resource.registry_revision !== this.ctx.knowledge.registry_revision ||
      resource.contract_revisions[contract.table] !== contract.revision ||
      resource.asset_hashes[asset.asset_id] !== asset.content_hash ||
      !canQueryTable(this.ctx.knowledge, session.role, contract.table) ||
      contractValidity(contract, currentCalendarDate(this.ctx.config, contract.timezone))
    )
      return null;
    if (
      publication.valid_until < currentCalendarDate(this.ctx.config, this.ctx.knowledge.timezone) ||
      resource.freshness_receipts.length !== 1 ||
      resource.freshness_receipts[0]?.table !== contract.table ||
      resource.freshness_receipts[0]?.publication_id !== publication.publication_id ||
      resource.freshness_receipts[0]?.version !== publication.version ||
      publication.tables[contract.table]?.status !== "fresh"
    )
      return null;
    return contract;
  }
}
