// Render proven values and limitations without trusting model prose.
import { type AggregateComparison } from "./aggregate-comparison.js";
import { type VerifiedAggregate } from "./aggregate-evidence.js";
import { type VerifiedGroupRollup } from "./aggregate-rollup.js";
import { type VerifiedConditionalAggregate } from "./conditional-aggregate-evidence.js";
import { type VerifiedDecimalCell } from "./decimal-cell-evidence.js";
import { type VerifiedComparison } from "./evidence-comparison.js";
import {
  verifyCell,
  type CellOperation,
  type VerifiedCell,
} from "./evidence.js";
import { type ArithmeticValue } from "./exact-arithmetic.js";
import { type VerifiedJoinValue } from "./join-evidence.js";
import { type AlignedRow } from "./result-alignment.js";
import type { VerifiedQueryObservation } from "./query-observation.js";
import type { VerifiedDimensionObservation } from "./dimension-observation.js";
import {
  transformResult,
  type ResultColumn,
  type ResultTable,
  type ResultValue,
} from "./result-transform.js";
import type {
  AlignmentResource,
  AnalysisRecord,
  AnalysisStatus,
  CalculationResource,
  KnowledgeBase,
  QueryResource,
  SessionResource,
  TransformResource,
} from "./types.js";

export function renderVerifiedJoin(
  item: VerifiedJoinValue,
  resourceId: string,
): string {
  const fields = (value: Record<string, string | null>) =>
    Object.entries(value)
      .map(
        ([key, part]) =>
          `${key}=${part === null ? "NULL（维表未匹配）" : part}`,
      )
      .join("，") || "无";
  const metric = item.operation === "count_rows" ? `${item.fact}（${item.description}）` : `${item.fact}.${item.column}（${item.description}）`;
  const operations = { sum: "求和", count_null: "NULL 计数", count_nonnull: "非 NULL 计数", count_zero: "零值计数", count_rows: "观测行计数" };
  return `${metric}：已核验 JOIN ${operations[item.operation]} ${item.value}；单位 ${item.unit}；分组 ${fields(item.group)}；事实筛选 ${fields(item.factFilters)}；维表筛选 ${fields(item.dimensionFilters)}；${item.range.start} 到 ${item.range.end}（${item.range.timezone}）；来源 ${resourceId}。${item.unmatched_rows ? `未匹配维表 ${item.unmatched_rows} 行，维表字段保留 NULL。` : ""}结果与维表匹配证明来自同次查询，非跨表原子快照。`;
}

export function renderComparison(comparison: VerifiedComparison): string {
  const { left, right, difference, change_percent } = comparison;
  const scope = (cell: VerifiedCell) =>
    `${Object.entries(cell.filters)
      .map(([key, value]) => `${key}=${value}`)
      .join(
        "，",
      )}；${cell.range.start} 到 ${cell.range.end}（${cell.range.timezone}）；来源 ${cell.sourceResourceId}`;
  return `${left.source.table}.${left.source.column} 比较：${left.source.value}（${scope(left.source)}）减 ${right.source.value}（${scope(right.source)}）= ${difference} ${left.source.unit}；${change_percent === null ? "基准为零，变化率不可计算" : `相对基准变化 ${change_percent}%（四舍五入到小数点后两位）`}；${left.source.prediction}。`;
}

export function renderAggregate(item: VerifiedAggregate): string {
  const filters =
    Object.entries(item.filters)
      .map(([key, value]) => `${key}=${value}`)
      .join("，") || "无";
  const group = Object.entries(item.group)
    .map(([key, value]) => `${key}=${value}`)
    .join("，");
  const metric =
    item.operation === "count_rows"
      ? `${item.table}（查询观测行）`
      : `${item.table}.${item.column}（${item.description}）`;
  return `${metric}：数据库${item.operation === "sum" ? "求和" : item.operation === "count_rows" ? "观测行计数" : "非 NULL 计数"} ${item.value}；单位 ${item.unit}；实际（契约声明仅观察值）；筛选 ${filters}${group ? `；分组 ${group}` : ""}；${item.range.start} 到 ${item.range.end}（${item.range.timezone}）；来源 ${item.source_resource_id}。${item.coverage_incomplete ? "本次结果的请求分组或日期组合不完整，不能代表完整总体。" : ""}`;
}

export function renderConditionalAggregate(
  item: VerifiedConditionalAggregate,
): string {
  const filters =
    Object.entries(item.filters)
      .map(([key, value]) => `${key}=${value}`)
      .join("，") || "无";
  const group = Object.entries(item.group)
    .map(([key, value]) => `${key}=${value}`)
    .join("，");
  const condition =
    item.operation === "count_null"
      ? "为 NULL"
      : item.operation === "count_nonnull"
        ? "非 NULL"
        : item.operation === "count_zero"
          ? "等于零"
          : `${item.comparison!.operator} ${item.comparison!.threshold}（NULL 不满足条件）`;
  return `${item.table}.${item.column}：数据库条件计数（${condition}）${item.value}；单位 行；实际（契约声明仅观察值）；筛选 ${filters}${group ? `；分组 ${group}` : ""}；${item.range.start} 到 ${item.range.end}（${item.range.timezone}）；来源 ${item.source_resource_id}。${item.coverage_incomplete ? "覆盖不完整，此计数仅描述已观测行；NULL 和未出现的行没有补零。" : "此计数描述查询中已观测的行，未出现的分组没有补零。"}`;
}

export function renderAggregateComparison(item: AggregateComparison): string {
  const scope = (value: VerifiedAggregate) =>
    `${Object.entries({ ...value.filters, ...value.group })
      .map(([key, part]) => `${key}=${part}`)
      .join(
        "，",
      )}；${value.range.start} 到 ${value.range.end}（${value.range.timezone}）；来源 ${value.source_resource_id}`;
  return `${item.left.table}.${item.left.column} 精确十进制比较：${item.left.value}（${scope(item.left)}）减 ${item.right.value}（${scope(item.right)}）= ${item.difference} ${item.left.unit}；${item.ratio === null ? "基准为零，比例和变化率不可计算" : `比例 ${item.ratio}，变化率 ${item.change_percent}%（四舍五入，半数远离零）`}；实际（契约声明仅观察值）。`;
}

export function renderArithmetic(
  item: NonNullable<AnalysisRecord["arithmetic_results"]>[number],
): string {
  const value =
    item.result.value === null
      ? item.result.undefined_reason === "null_input"
        ? "输入为空或 NULL，结果未知"
        : "除数为零，结果不可计算"
      : `${item.result.value} ${item.result.unit}`;
  if (item.result.interpretation === "mathematical_only")
    return `${item.result.formula ?? "所选结果单元"} 可复核数学运算 ${item.operation}：${value}；输入 ${item.left.resource_id}、${item.right.resource_id}；计算资源 ${item.resource_id}。仅认证计算与来源，不认证业务指标名称、用户意图或完整范围。${item.result.approximate ? "输入含浮点观测，结果为近似值。" : ""}${item.result.partial ? "输入有缺失或覆盖不完整。" : ""}`;
  const scope = item.result.scopes
    .map(
      (entry) =>
        `${Object.entries(entry.filters)
          .map(([key, part]) => `${key}=${part}`)
          .join("，")}；${entry.start} 到 ${entry.end}`,
    )
    .join(" / ");
  return `${item.result.formula ?? `${item.result.basis.table}.${item.result.basis.column}`} 可复核四则运算 ${item.operation}：${value}；范围 ${scope}（${item.result.basis.timezone}）；输入 ${item.left.resource_id}、${item.right.resource_id}；计算资源 ${item.resource_id}。除法保留 18 位，半数远离零。${item.result.scope_unverified ? "仅基于该分组的已观察数据，未证明完整业务总体或不存在其他分组。" : ""}`;
}

export function renderQueryObservation(item: VerifiedQueryObservation): string {
  const value =
    item.value === null
      ? `NULL（缺失，未知） ${item.unit}`
      : `${item.approximate ? "约 " : ""}${item.value} ${item.unit}`;
  const prediction = {
    actual: "实际标记已核对",
    predicted: "预测值，不能当作实际",
    unknown: "实际/预测状态未知",
  }[item.prediction];
  const filters =
    Object.entries(item.filters)
      .map(([key, part]) => `${key}=${part}`)
      .join("，") || "未限定维度";
  const scope = item.aggregation === "sum"
    ? "这是数据库返回的分组求和结果；未出现的分组没有补零，不自动代表完整总体。"
    : "仅证明这条保存记录，不自动代表完整总体。";
  return `${item.table}.${item.column}（${item.description}）：${value}；${prediction}；筛选 ${filters}；${item.range.start} 到 ${item.range.end}（${item.range.timezone}）；来源 ${item.resource_id}，执行 ${item.execution_id}，保存结果第 ${item.row} 行。${scope}`;
}

/** Render host-verified physical dimension fields without model alias labels. */
export function renderDimensionObservation(
  item: VerifiedDimensionObservation,
): string {
  const key = Object.entries(item.key)
    .map(([column, value]) => `${column}=${JSON.stringify(value)}`)
    .join("，");
  const values = item.values
    .map(
      (value) =>
        `${item.table}.${value.column}（${value.description}）=${value.value === null ? "NULL（空值）" : JSON.stringify(value.value)}`,
    )
    .join("；");
  return `维表键值 ${key}：${values}；快照观测 ${item.snapshot.observed_at}，发布 v${item.snapshot.version}；来源 ${item.resource_id}，执行 ${item.execution_id}。仅证明所列键值，不代表业务日期覆盖。`;
}

export function renderCalculatedCell(
  resource: CalculationResource,
  column: ResultColumn,
  value: ResultValue,
  operation: CellOperation | undefined,
): string {
  const prediction =
    operation?.predicted === "actual_only"
      ? "仅实际记录"
      : operation?.predicted === "predicted_only"
        ? "仅预测记录"
        : "未筛选实际/预测";
  return `已复核结果的数学计算 ${column.label}：${value === null ? "NULL（未知，空集或全 NULL 未补零）" : String(value)}；单位 ${column.unit || "未认证"}；${prediction}；来源 ${resource.source_resource_id}；计算资源 ${resource.resource_id}。该计算不单独证明业务总体完整。`;
}

export function renderTransform(
  resource: TransformResource,
  input: ResultTable,
  result: ResultTable,
): string[] {
  const descriptions: string[] = [];
  let current = input;
  const label = (name: string) =>
    current.columns.find((column) => column.name === name)?.label ?? "未知字段";
  for (const step of resource.steps) {
    if (step.op === "filter")
      descriptions.push(
        `筛选 ${label(step.column)} ${step.comparison}${"other_column" in step && step.other_column ? ` ${label(step.other_column)}` : "value" in step ? ` ${JSON.stringify(step.value)}` : ""}`,
      );
    else if (step.op === "compare")
      descriptions.push(
        `比较 ${label(step.left)} ${step.comparison} ${label(step.right)}`,
      );
    else if (
      step.op === "add" ||
      step.op === "subtract" ||
      step.op === "multiply" ||
      step.op === "divide"
    )
      descriptions.push(
        `计算 ${label(step.left)} ${{ add: "+", subtract: "−", multiply: "×", divide: "/" }[step.op]} ${label(step.right)}（${step.op === "divide" ? "除法保留 18 位，半数远离零；" : ""}NULL 或零分母结果未知）`,
      );
    else if (step.op === "sort")
      descriptions.push(
        `排序 ${step.keys.map((key) => `${label(key.column)} ${key.direction}（NULL ${key.nulls}）`).join("、")}`,
      );
    else if (step.op === "group")
      descriptions.push(
        `按 ${step.by.map(label).join("、") || "全部结果"} 分组；${step.aggregates.map((item) => (item.op === "count_all" ? "输入结果行数" : `${label(item.column!)} ${item.op}`)).join("、")}`,
      );
    const next = transformResult(current, [step], () => true);
    if (next) current = next;
  }
  const lines = [
    `结果变换：${descriptions.join(" → ")}；输入 ${resource.source_resource_id}；计算资源 ${resource.resource_id}。计数指输入结果行，不自动代表业务明细行；聚合忽略 NULL，未知值没有补零。`,
  ];
  if (!result.rows.length) lines.push("变换后无结果行；不补零。");
  let shown = 0;
  let bytes = 0;
  for (const row of result.rows.slice(0, 100)) {
    const line =
      result.columns
        .map((column) => {
          const value = row[column.name];
          return `${column.label}=${value === null ? "NULL（空值）" : value === "NULL" ? '"NULL"（字符串）' : String(value)}（${column.unit}）`;
        })
        .join("；") + "。";
    const size = Buffer.byteLength(line);
    if (bytes + size > 32_000) break;
    lines.push(line);
    bytes += size;
    shown += 1;
  }
  if (result.rows.length > shown)
    lines.push(
      `已验证结果共 ${result.rows.length} 行，此处展示 ${shown} 行；可按资源分页回读其余行。`,
    );
  return lines;
}

export function renderAlignment(
  resource: AlignmentResource,
  rows: AlignedRow[],
): string[] {
  const lines = [
    `按分组键全集对齐并执行 ${resource.spec.op}；输入 ${resource.spec.left.resource_id}、${resource.spec.right.resource_id}；计算资源 ${resource.resource_id}。未出现的组不补零。`,
  ];
  if (rows.some((row) => row.result?.interpretation === "mathematical_only"))
    lines.push(
      "这是按已核验结果键值进行的数学对齐；不认证模型自选的业务名称或自然语言意图。",
    );
  if (resource.coverage_incomplete)
    lines.push(
      "来源覆盖不完整或未知；以下各组计算仅基于已观察记录，不能代表完整周期。",
    );
  if (
    rows.some((row) => Object.values(row.group).some((value) => value === null))
  )
    lines.push(
      "NULL 键作为独立分组保留；当前覆盖回执不证明 NULL 键的周期完整性，因此只能部分交付。",
    );
  for (const row of rows.slice(0, 100)) {
    const group = Object.entries(row.group)
      .map(
        ([key, value]) =>
          `${key}=${value === null ? "NULL（空键）" : value === "NULL" ? '"NULL"（字符串）' : value}`,
      )
      .join("，");
    const show = (
      value: ArithmeticValue | null,
      count?: number,
      nullCount?: number,
    ) =>
      value
        ? `${value.basis.table}.${value.basis.column} ${value.value === null ? "全 NULL" : value.value} ${value.unit}${count === undefined ? "" : `（${count} 行，${nullCount} 行 NULL）`}`
        : "该查询结果未出现此组";
    const result =
      row.status === "zero_divisor"
        ? "除数为零，结果不可计算"
        : row.status === "null_input"
          ? "至少一侧全 NULL，结果未知"
          : row.status === "empty_inputs"
            ? "两侧无输入，结果未知"
            : row.result
              ? `${row.result.value} ${row.result.unit}${row.status === "partial_nulls" ? "（仅非 NULL 部分，不能代表完整分组）" : ""}`
              : "缺少一侧分组，结果未知";
    lines.push(
      `${group}：左侧 ${show(row.left, row.left_count, row.left_null_count)}；右侧 ${show(row.right, row.right_count, row.right_null_count)}；结果 ${result}${row.result && resource.coverage_incomplete ? "（来源覆盖不完整，仅为已观察记录的计算）" : ""}。`,
    );
  }
  if (rows.length > 100)
    lines.push(
      `已验证对齐结果共 ${rows.length} 行，此处展示 100 行；可按资源分页回读其余行。`,
    );
  return lines;
}

export function renderDecimalCell(item: VerifiedDecimalCell): string {
  const filters =
    Object.entries(item.filters)
      .map(([key, value]) => `${key}=${value}`)
      .join("，") || "无";
  return `${item.table}.${item.column}（${item.description}）：完整资源精确十进制合计 ${item.value}；单位 ${item.unit}；实际（契约声明仅观察值）；筛选 ${filters}；${item.range.start} 到 ${item.range.end}（${item.range.timezone}）；来源 ${item.source_resource_id}。`;
}

export function renderGroupRollup(item: VerifiedGroupRollup): string {
  const restrictions =
    [
      ...Object.entries(item.filters).map(([key, value]) => `${key}=${value}`),
      ...Object.entries(item.in_sets).map(
        ([key, values]) => `${key} IN (${values.join("、")})`,
      ),
    ].join("，") || "未限定维度";
  const metric =
    item.input_operation === "count_rows"
      ? `${item.table}（查询观测行）`
      : `${item.table}.${item.column}（${item.description}）`;
  const input =
    item.input_operation === "sum"
      ? "求和"
      : item.input_operation === "count_rows"
        ? "观测行计数"
        : "非 NULL 计数";
  const action =
    item.operation === "sum"
      ? `分组${input}结果再求和`
      : item.operation === "count_rows"
        ? "查询返回的结果分组数"
        : item.operation === "count_null"
          ? "分组聚合输出为 NULL 的分组数"
          : "分组聚合输出为零的分组数";
  return `${metric}：${action} ${item.value}；单位 ${item.unit}；实际（契约声明仅观察值）；筛选 ${restrictions}；原查询按 ${item.grouped_by.join("、")} 分组；${item.range.start} 到 ${item.range.end}（${item.range.timezone}）；来源 ${item.source_resource_id}。${item.operation === "sum" ? "仅汇总查询已返回的分组，未出现的组合没有补零。" : "这是结果分组的计数，不是底层业务明细的计数。"}`;
}

export function renderAnswer(
  status: AnalysisStatus,
  cells: VerifiedCell[],
  sources: AnalysisRecord["sources"],
  clarification: string | undefined,
  derivedLines: string[],
): string {
  const lines: string[] = [];
  if (status === "partial") lines.push("这个回答不完整。");
  if (status === "completed")
    lines.push("以下数字由当前任务的已授权查询和计算生成。");
  if (status === "needs_clarification")
    lines.push(
      `需要澄清（以下为模型提出的问题，其中的假设尚未核验）：${clarification || "还需要补充问题范围。"}`,
    );
  if (status === "failed")
    lines.push(clarification || "这次没有取得可引用的查询结果。");
  const operations: Record<VerifiedCell["operation"], string> = {
    sum: "非 NULL 值合计",
    count_null: "值为 NULL 的行数",
    count_zero: "数值为零的行数",
    count_rows: "查询结果行数",
  };
  for (const cell of cells) {
    const filters =
      Object.entries(cell.filters)
        .map(([key, value]) => `${key}=${value}`)
        .join("，") || "未限定维度";
    const metric = cell.column
      ? `${cell.table}.${cell.column}（${cell.description}）`
      : `${cell.table} 查询行`;
    lines.push(
      `${metric}：${operations[cell.operation]}${cell.precision === "floating_point_approximate" ? "（浮点近似，非精确十进制）" : ""} ${formatNumber(cell.value)}；单位 ${cell.unit}；${cell.prediction}；筛选 ${filters}；${cell.range.start} 到 ${cell.range.end}（${cell.range.timezone}）；来源 ${cell.sourceResourceId}。${cell.operation === "sum" && cell.excludedNulls ? `排除了 ${cell.excludedNulls} 行 NULL；无记录没有补成零。` : ""}`,
    );
  }
  lines.push(...derivedLines);
  for (const source of sources) {
    if (source.evidence_eligible) appendCoverage(lines, source);
    else
      lines.push(
        `${source.tables.join(",")} 的证据当前不可验证，未展示其数值。`,
      );
  }
  if (!cells.length && !derivedLines.length && sources.length)
    lines.push("没有可证明血缘的计算数值。");
  return lines.join("\n");
}

export function renderDerivedAndGroups(
  cells: VerifiedCell[],
  resources: SessionResource[],
  knowledge: KnowledgeBase,
): string[] {
  const lines: string[] = [];
  const sourceIds = [...new Set(cells.map((cell) => cell.sourceResourceId))];
  for (const id of sourceIds) {
    const source = resources.find(
      (item): item is QueryResource =>
        item.kind === "query_result" && item.resource_id === id,
    );
    const asset =
      source && knowledge.contract_by_table.get(source.tables[0] ?? "");
    const contract = asset?.contract;
    if (!source || !contract?.series) continue;
    const related = cells.filter(
      (cell) => cell.sourceResourceId === id && cell.operation === "sum",
    );
    for (const definition of contract.derived_metrics ?? []) {
      if (
        definition.operation !== "divide" ||
        definition.prediction !== "actual_only"
      )
        continue;
      const numerator = related.find(
        (cell) =>
          cell.column === definition.numerator &&
          cell.predictionFilter === "actual_only" &&
          cell.prediction.startsWith("实际（"),
      );
      const denominator = related.find(
        (cell) =>
          cell.column === definition.denominator &&
          cell.predictionFilter === "actual_only" &&
          cell.prediction.startsWith("实际（"),
      );
      if (
        !numerator ||
        !denominator ||
        numerator.unit !== denominator.unit ||
        numerator.unit === "契约未声明"
      )
        continue;
      const scope = `${
        Object.entries(numerator.filters)
          .map(([key, value]) => `${key}=${value}`)
          .join("，") || "未限定维度"
      }；${numerator.range.start} 到 ${numerator.range.end}（${numerator.range.timezone}）`;
      if (denominator.value === 0)
        lines.push(
          `${definition.label}：分母为零，不能计算。${scope}；来源 ${id}。`,
        );
      else
        lines.push(
          `${definition.label}：${formatNumber(numerator.value)} / ${formatNumber(denominator.value)} = ${formatNumber(numerator.value / denominator.value)}（${definition.unit}，浮点近似）。${scope}；来源 ${id}；只使用契约声明的实际值，预测行不进入结果。`,
        );
    }
    // Group only already-authorized raw rows on a declared and selected dimension.
    for (const cell of related) {
      const calc = resources.find(
        (item): item is CalculationResource =>
          item.kind === "calculation" &&
          item.source_resource_id === id &&
          Object.values(item.operations ?? {}).some(
            (op) =>
              op.op === "sum" &&
              op.column === cell.outputColumn &&
              (op.predicted ?? "any") === cell.predictionFilter,
          ),
      );
      const op =
        calc &&
        Object.values(calc.operations ?? {}).find(
          (item) =>
            item.op === "sum" &&
            item.column === cell.outputColumn &&
            (item.predicted ?? "any") === cell.predictionFilter,
        );
      if (!op || !cell.column) continue;
      for (const dimension of contract.series.dimensions) {
        if (
          Object.hasOwn(cell.filters, dimension) ||
          !source.columns.includes(dimension)
        )
          continue;
        if (source.rows.some((row) => typeof row[dimension] !== "string"))
          continue;
        const values = [
          ...new Set(source.rows.map((row) => row[dimension] as string)),
        ];
        if (values.length < 2) continue;
        const parts: string[] = [];
        for (const value of values.slice(0, 100)) {
          const subset = source.rows.filter((row) => row[dimension] === value);
          const mapping = contract.series.prediction_values;
          const flag = contract.series.predicted_column;
          const selected =
            flag && mapping && op.predicted === "actual_only"
              ? subset.filter((row) => Number(row[flag]) === mapping.actual)
              : flag && mapping && op.predicted === "predicted_only"
                ? subset.filter(
                    (row) => Number(row[flag]) === mapping.predicted,
                  )
                : subset;
          const numbers = selected
            .map((row) => row[cell.outputColumn!])
            .filter(
              (value): value is number =>
                typeof value === "number" && Number.isFinite(value),
            );
          if (!numbers.length) continue;
          const total = numbers.reduce((a, b) => a + b, 0);
          if (!verifyCell({ ...source, rows: subset }, contract, op, total))
            continue;
          parts.push(`${value}=${formatNumber(total)}`);
        }
        if (parts.length)
          lines.push(
            `${cell.table}.${cell.column} 按 ${dimension} 分组：${parts.join("，")}${values.length > 100 ? `（共 ${values.length} 组，此处展示前 100 组）` : ""}${cell.precision === "floating_point_approximate" ? "（浮点近似）" : ""}；单位 ${cell.unit}；${cell.prediction}；其他筛选 ${
              Object.entries(cell.filters)
                .map(([key, value]) => `${key}=${value}`)
                .join("，") || "无"
            }；${cell.range.start} 到 ${cell.range.end}（${cell.range.timezone}）；来源 ${id}。NULL 与无记录没有补零。`,
          );
      }
    }
  }
  return lines;
}

function appendCoverage(
  lines: string[],
  source: AnalysisRecord["sources"][number],
): void {
  if (source.dimension_snapshot) {
    lines.push(
      `${source.dimension_snapshot.table} 使用维表快照观测 ${source.dimension_snapshot.observed_at}、发布 v${source.dimension_snapshot.version}；契约有效期不是业务统计周期。`,
    );
    return;
  }
  const report = source.coverage;
  if (!report) {
    lines.push(`${source.tables.join(",")} 的覆盖情况未知。`);
    return;
  }
  const reports = report.per_table?.length ? report.per_table : [report];
  for (const item of reports)
    appendOneCoverage(lines, item.table ?? source.tables.join(","), item);
  const receipt = source.freshness_receipts[0];
  if (receipt)
    lines.push(
      `新鲜度发布 ${receipt.publication_id} 版本 ${receipt.version}。`,
    );
}

function appendOneCoverage(
  lines: string[],
  label: string,
  report: NonNullable<AnalysisRecord["sources"][number]["coverage"]>,
): void {
  if (report.status === "unknown") {
    lines.push(`${label} 的覆盖情况未知。${report.reason}`);
    return;
  }
  if (report.absent_dates.length)
    lines.push(
      `${label} 无记录 ${report.absent_dates.length} 天：${report.absent_dates.join("、")}。这些天没有补成 0。`,
    );
  if (report.null_dates.length)
    lines.push(
      `${label} 有记录但值为 NULL 的日期：${report.null_dates.join("、")}。依赖这些缺失值的计算结果未知，不能将 NULL 当成零。`,
    );
  if (report.zero_dates.length)
    lines.push(`${label} 数值为零的日期：${report.zero_dates.join("、")}。`);
  if (report.predicted_dates.length)
    lines.push(
      `${label} 含预测标记的日期：${report.predicted_dates.join("、")}，没有当成实际值。`,
    );
  if (report.unknown_prediction_dates?.length)
    lines.push(`${label} 的部分日期未声明实际/预测状态。`);
  for (const group of report.groups) {
    if (
      !group.absent_dates.length &&
      !group.null_dates.length &&
      !group.predicted_dates.length &&
      !group.zero_dates.length
    )
      continue;
    lines.push(
      `${group.dimension}=${group.value}：无记录 ${group.absent_dates.length} 天，NULL ${group.null_dates.length} 天，数值为零 ${group.zero_dates.length} 天，含预测标记 ${group.predicted_dates.length} 天。未出现的维度组合不算缺失。`,
    );
  }
}

function formatNumber(value: number): string {
  return String(value);
}
