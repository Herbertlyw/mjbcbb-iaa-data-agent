// Render saved analysis as escaped HTML. Model prose is never treated as markup.
export const labels = {
  queued: "排队中",
  running: "运行中",
  completed: "执行结束",
  needs_clarification: "需要澄清",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
  timed_out: "已超时",
};

export function coverageText(source) {
  if (source.dimension_snapshot) {
    const snapshot = source.dimension_snapshot;
    return `维表键值快照 · 观测 ${snapshot.observed_at} · 发布 v${snapshot.version}。仅核验所列键值，不表示业务日期覆盖或未返回对象不存在。`;
  }
  const report = source.coverage;
  const receipts = (source.freshness_receipts || [])
    .map((item) => `${item.table} 发布 v${item.version}`)
    .join(", ");
  const reports = report?.per_table?.length ? report.per_table : [report];
  const lines = reports.map((item) => {
    if (!item || item.status === "unknown")
      return `${item?.table || source.tables.join(",")} 覆盖情况未知。${item?.reason || "没有覆盖回执。"}`;
    const groups = (item.groups || [])
      .filter(
        (group) =>
          group.absent_dates.length ||
          group.null_dates.length ||
          group.predicted_dates.length,
      )
      .map(
        (group) =>
          `${group.dimension}=${group.value} 无记录 ${group.absent_dates.length} 天`,
      );
    return `${item.table || source.tables.join(",")} 预期 ${item.expected_days} 天 · 无记录 ${item.absent_dates.length} · NULL ${item.null_dates.length} · 数值为零 ${item.zero_dates.length} · 预测标记 ${item.predicted_dates.length} · 实际标记 ${item.actual_dates.length} · 状态未声明 ${(item.unknown_prediction_dates || []).length}${groups.length ? " · " + groups.join("；") : ""}`;
  });
  return `${lines.join("；")} · ${receipts || "没有新鲜度回执"}`;
}

export function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
}

export function displayCell(value) {
  return value === null
    ? "NULL（空值）"
    : value === "NULL"
      ? '"NULL"（字符串）'
      : value;
}

/** Update the visible count only after rows have actually been appended. */
export function updatePaginationCount(table, button) {
  const progress = button.parentElement?.querySelector(".pagination-count");
  if (!progress) return;
  const shown = table.querySelectorAll("tbody tr").length;
  const total = progress.dataset.total;
  progress.textContent =
    progress.dataset.kind === "source"
      ? `已保存 ${total} 行，当前显示前 ${shown} 行。`
      : `显示 ${shown}/${total} 行。`;
}

export function renderCalculationTables(analysis) {
  const more = (id, count, shown, hash) =>
    count > shown && hash
      ? `<p class="muted pagination-count" data-kind="calculation" data-total="${escapeHtml(count)}">显示 ${shown}/${escapeHtml(count)} 行。</p><button class="secondary calculation-next" data-resource="${escapeHtml(id)}" data-hash="${escapeHtml(hash)}" data-offset="${shown}">加载更多计算行</button>`
      : "";
  const transforms = (analysis.transform_results || [])
    .map((item) => {
      const columns = item.result.columns;
      const rows = item.result.rows.slice(0, 20);
      return `<div class="source calculation" data-kind="transform"><strong>已核验的结果变换</strong><p class="muted">计算资源 ${escapeHtml(item.resource_id)} · 输入 ${escapeHtml(item.source_resource_id)}</p><table><thead><tr>${columns.map((column) => `<th>${escapeHtml(column.label)}（${escapeHtml(column.unit)}）</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(displayCell(row[column.name]))}</td>`).join("")}</tr>`).join("")}</tbody></table>${more(item.resource_id, item.total_rows ?? rows.length, rows.length, analysis.resource_hashes?.[item.resource_id])}</div>`;
    })
    .join("");
  const alignments = (analysis.alignment_results || [])
    .map((item) => {
      const rows = item.rows.slice(0, 20);
      return `<div class="source calculation" data-kind="alignment" data-coverage-incomplete="${item.coverage_incomplete ? "true" : "false"}"><strong>已核验的分组对齐</strong><p class="muted">计算资源 ${escapeHtml(item.resource_id)} · ${escapeHtml(item.spec.left.resource_id)} / ${escapeHtml(item.spec.right.resource_id)} · 运算 ${escapeHtml(item.spec.op)}。缺侧、NULL 和零分母不会补零。${item.coverage_incomplete ? "来源覆盖不完整，所有分组仅基于已观察记录。" : ""}</p><table><thead><tr><th>分组</th><th>左侧</th><th>右侧</th><th>结果</th><th>状态</th></tr></thead><tbody>${rows.map((row) => alignmentRowHtml(row, item.coverage_incomplete)).join("")}</tbody></table>${more(item.resource_id, item.total_rows ?? rows.length, rows.length, analysis.resource_hashes?.[item.resource_id])}</div>`;
    })
    .join("");
  return transforms + alignments;
}

export function alignmentRowHtml(row, incomplete) {
  const names = {
    matched: "已匹配",
    missing_left: "缺少左侧",
    missing_right: "缺少右侧",
    null_input: "全 NULL",
    partial_nulls: "部分 NULL",
    zero_divisor: "除数为零",
    empty_inputs: "无输入",
  };
  const value = (item) =>
    item ? `${displayCell(item.value)} ${item.unit || ""}` : "—";
  const group =
    Object.entries(row.group)
      .map(
        ([key, part]) =>
          `${key}=${part === null ? "NULL（空键）" : part === "NULL" ? '"NULL"（字符串）' : part}`,
      )
      .join("，") || "总体";
  const counts = (side) =>
    Number.isSafeInteger(row[`${side}_count`])
      ? `（${row[`${side}_count`]} 行，${row[`${side}_null_count`] ?? "?"} 行 NULL）`
      : "";
  return `<tr><td>${escapeHtml(group)}</td><td>${escapeHtml(value(row.left) + counts("left"))}</td><td>${escapeHtml(value(row.right) + counts("right"))}</td><td>${escapeHtml(value(row.result))}</td><td>${escapeHtml((names[row.status] || "不可验证") + (incomplete ? "（来源覆盖不完整）" : ""))}</td></tr>`;
}

export function usageSummary(job) {
  const usage = job.usage;
  if (!usage || !Number.isSafeInteger(usage.model_attempts)) return "";
  return `<p class="muted">模型尝试至少 ${escapeHtml(usage.model_attempts)} · 可能已派发上限 ${escapeHtml(usage.model_calls)} · 明确未派发 ${escapeHtml(usage.provider_not_dispatched)} · 成功结算 ${escapeHtml(usage.provider_completed)} · 结果或用量未知 ${escapeHtml(usage.provider_outcome_unknown)}。输入 token：${escapeHtml(usage.input_tokens ?? "未知")}；输出 token：${escapeHtml(usage.output_tokens ?? "未知")}；缓存命中：${escapeHtml(usage.cache_hit_tokens ?? "未知")}；缓存未命中：${escapeHtml(usage.cache_miss_tokens ?? "未知")}；来源：${escapeHtml(usage.usage_source || "未知")}。</p>`;
}

export function renderJob(job) {
  const status = Object.hasOwn(labels, job.status) ? job.status : "failed";
  const statusLabel = status === "completed" && job.analysis?.server_reasons?.includes("request_coverage_unverified")
    ? "结果已生成 · 请求覆盖待核对" : labels[status];
  const heading = `<div class="result-heading"><h3>${escapeHtml(job.user_text)}</h3><span class="status ${status}">${escapeHtml(statusLabel)}</span></div>`;
  const diagnostics = `<details class="diagnostics"><summary>模型与用量</summary><p>模型 ${escapeHtml(job.model_id || "未记录")} · 档位 ${escapeHtml(job.reasoning || "未记录")}</p>${usageSummary(job)}</details>`;
  const analysis = job.analysis;
  if (!analysis) {
    const pending = status === "queued" || status === "running";
    const note =
      status === "cancelled"
        ? "服务端终态：已取消。没有提交分析。"
        : job.error?.message ||
          (pending
            ? "正在检索和分析。完成后，结果与数据来源会显示在这里。"
            : `服务端终态：${labels[status]}。没有提交分析。`);
    return `${heading}<p class="task-message ${pending ? "pending" : ""}">${escapeHtml(note)}</p>${["failed", "cancelled", "timed_out"].includes(status) ? '<button id="retry" class="secondary">重新提问</button>' : ""}${diagnostics}`;
  }
  const sourceCount = analysis.sources.length;
  const limitations = analysis.limitations.length
    ? `<details class="limitations" ${status === "partial" ? "open" : ""}><summary>结果范围与限制 <span class="count">${analysis.limitations.length}</span></summary><ul>${analysis.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></details>`
    : "";
  const record = analysis.analysis_declaration;
  const workRecord = record
    ? `<details class="diagnostics"><summary>模型工作记录 · 自报内容</summary>
    <p>范围：${escapeHtml(record.declaration.scope || "未声明")} · 粒度：${escapeHtml(record.declaration.grain || "未声明")}</p>
    <p>预期分组：${escapeHtml((record.declaration.expected_group_keys || []).join("、") || "未声明")}</p>
    <p>待解决问题：${escapeHtml((record.declaration.unresolved_questions || []).join("；") || "无")}</p>
    <p>假设：${escapeHtml((record.declaration.assumptions || []).join("；") || "无")}</p>
    ${(record.declaration.source_excerpts || []).map((item) => `<blockquote>当前可读知识的逐字摘录，不证明适用性：${escapeHtml(item.quote)}<br>${escapeHtml(item.asset_id)}</blockquote>`).join("")}</details>`
    : "";
  const verifiedRows = (record?.verified_cells || [])
    .map((item) => {
      const source = analysis.sources.find(
        (entry) =>
          entry.resource_id === item.resource_id && entry.evidence_eligible,
      );
      if (!source) return "";
      const observation = item.observation;
      const observedScope = observation
        ? ` · 筛选 ${escapeHtml(Object.entries(observation.filters || {}).map(([key, value]) => `${key}=${value}`).join("，") || "无")} · ${escapeHtml(observation.prediction === "actual" ? "实际" : observation.prediction === "predicted" ? "预测" : "实际/预测未知")} · ${observation.scope_complete && !observation.coverage_incomplete ? "已核验所列范围" : "仅观察到的分组，不代表完整总体"}`
        : "";
      return `<li>${escapeHtml(item.field)} = ${escapeHtml(displayCell(item.value))} ${escapeHtml(item.unit)}${observedScope} · 保存结果第 ${escapeHtml(item.row)} 行 · ${escapeHtml(source.time_range.start)} 至 ${escapeHtml(source.time_range.end)}（${escapeHtml(source.time_range.timezone)}） · 来源 ${escapeHtml(item.resource_id)} · 执行 ${escapeHtml(item.execution_id)}</li>`;
    })
    .join("");
  return `${heading}
    ${job.error ? `<p class="inline-error">${escapeHtml(job.error.message)}</p>` : ""}
    ${analysis.model_answer ? `<section class="model-answer"><h4>模型分析 · 未逐句核验</h4><p class="prose">${escapeHtml(analysis.model_answer)}</p><p class="muted">请结合下方已核验结果和来源判断；正文中的推断和数字未获得独立认证。</p></section>` : ""}
    <div class="answer">${renderVerifiedSummary(analysis) || escapeHtml(analysis.answer)}</div>
    ${verifiedRows ? `<section class="verified-results"><h4>经核验的查询单元</h4><p class="muted">仅代表所列保存结果行，不自动代表总计或模型对问题的理解。</p><ul>${verifiedRows}</ul></section>` : ""}
    ${analysis.clarification_question ? `<div class="clarification"><strong>请补充</strong><p>${escapeHtml(analysis.clarification_question)}</p><p class="muted">在下方问题框补充条件，将继续当前会话。</p></div>` : ""}
    ${renderCalculationTables(analysis)}${limitations}
    ${
      sourceCount
        ? `<div class="evidence-heading"><h4>数据来源</h4><span>${sourceCount} 个查询 · 点击查看明细与 SQL</span></div><div class="sources">${analysis.sources
            .map((source) =>
              renderSource(
                source,
                analysis.resource_hashes,
                analysis.join_results?.find(
                  (item) =>
                    item.resource_id === source.resource_id &&
                    item.execution_id === source.execution_id &&
                    source.evidence_eligible,
                ),
              ),
            )
            .join("")}</div>`
        : ""
    }
    ${analysis.model_draft && analysis.sources.some((source) => source.evidence_eligible) ? `<details class="diagnostics"><summary>模型解释 · 未逐句核验</summary><p class="prose">${escapeHtml(analysis.model_draft.replace(/\[\[(?:result|compare):[^\]]+\]\]|\[\[partial\]\]|\[\[review:\{[^\n]*\}\]\]/g, ""))}</p><p class="muted">解释中的业务判断、范围和数字没有逐句认证；请以核验结果及来源为准。</p></details>` : ""}
    ${workRecord}${diagnostics}
    <details class="diagnostics"><summary>结果核验记录</summary><p>服务端判定：${escapeHtml(labels[analysis.status] || analysis.status)}。模型建议：${escapeHtml(analysis.model_suggested_status)}。</p><ul>${(analysis.server_reasons || []).map((reason) => `<li><code>${escapeHtml(reason)}</code></li>`).join("")}</ul></details>`;
}

function renderVerifiedSummary(analysis) {
  const cells = (analysis.calculations || []).flatMap(
    (calculation) => calculation.verified_cells || [],
  );
  const observations = (analysis.query_observations || []).filter((item) =>
    analysis.sources.some(
      (source) =>
        source.resource_id === item.resource_id &&
        source.execution_id === item.execution_id &&
        source.evidence_eligible,
    ),
  );
  const arithmetic = analysis.arithmetic_results || [];
  const dimensions = (analysis.dimension_observations || []).filter((item) =>
    analysis.sources.some(
      (source) =>
        source.resource_id === item.resource_id &&
        source.execution_id === item.execution_id &&
        source.evidence_eligible,
    ),
  );
  const evaluated = (analysis.calculations || []).filter(
    (item) => item.verified_result,
  );
  const rollups = (analysis.calculations || []).flatMap((calculation) =>
    (calculation.verified_group_rollups || [])
      .filter(
        (item) =>
          item.source_resource_id === calculation.source_resource_id &&
          analysis.sources.some(
            (source) =>
              source.resource_id === item.source_resource_id &&
              source.evidence_eligible,
          ),
      )
      .map((item) => ({ item, calculation })),
  );
  const joins = (analysis.join_results || []).filter((item) =>
    analysis.sources.some(
      (source) =>
        source.resource_id === item.resource_id &&
        source.execution_id === item.execution_id &&
        source.evidence_eligible,
    ),
  );
  if (
    !cells.length &&
    !observations.length &&
    !arithmetic.length &&
    !dimensions.length &&
    !evaluated.length &&
    !rollups.length &&
    !joins.length
  )
    return "";
  const groups = new Map();
  for (const cell of cells) {
    const key = JSON.stringify([
      cell.sourceResourceId,
      cell.table,
      cell.column,
      cell.range,
      cell.filters,
    ]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(cell);
  }
  const operations = {
    sum: "非 NULL 合计",
    count_null: "NULL 行数",
    count_zero: "零值行数",
    count_rows: "记录行数",
  };
  const blocks = [...groups.values()]
    .map((values) => {
      const first = values[0];
      const filters = Object.entries(first.filters)
        .map(([key, value]) => `${key}=${value}`)
        .join(" · ");
      return `<section class="metric-block"><h4>${escapeHtml(first.description || first.column || "记录数量")}</h4>
      <p class="metric-scope">${escapeHtml(first.range.start)} 至 ${escapeHtml(first.range.end)} · ${escapeHtml(first.range.timezone)}<br>${escapeHtml(filters)}</p>
      <div class="table-scroll" tabindex="0" role="region" aria-label="已核验计算结果"><table><thead><tr><th scope="col">计算</th><th scope="col">数值</th><th scope="col">单位</th><th scope="col">数据状态</th></tr></thead><tbody>${values.map((cell) => `<tr><td>${escapeHtml(operations[cell.operation] || cell.operation)}</td><td class="metric-value">${cell.precision === "floating_point_approximate" ? "约 " : ""}${escapeHtml(cell.value)}</td><td>${escapeHtml(cell.unit)}</td><td>${escapeHtml(cell.prediction)}${cell.operation === "sum" && cell.excludedNulls > 0 ? `；不含 ${escapeHtml(cell.excludedNulls)} 行 NULL` : ""}</td></tr>`).join("")}</tbody></table></div></section>`;
    })
    .join("");
  const observed = observations
    .map((item) => {
      const prediction =
        { actual: "实际", predicted: "预测，非实际", unknown: "实际/预测未知" }[
          item.prediction
        ] || "状态未知";
      const filters = Object.entries(item.filters)
        .map(([key, value]) => `${key}=${value}`)
        .join(" · ");
      return `<section class="metric-block"><h4>${escapeHtml(item.table)}.${escapeHtml(item.column)}</h4>
      <p class="metric-scope">${escapeHtml(item.description)}<br>${escapeHtml(item.range.start)} 至 ${escapeHtml(item.range.end)} · ${escapeHtml(item.range.timezone)}<br>${escapeHtml(filters)}</p>
      <div class="table-scroll" tabindex="0" role="region" aria-label="已核验查询单元"><table><thead><tr><th scope="col">数值</th><th scope="col">单位</th><th scope="col">数据状态</th></tr></thead><tbody><tr><td class="metric-value">${item.value === null ? "未知（NULL）" : (item.approximate ? "约 " : "") + escapeHtml(item.value)}</td><td>${escapeHtml(item.unit)}</td><td>${escapeHtml(prediction)}${item.value === null ? "；金额缺失" : ""}</td></tr></tbody></table></div>
      <p class="muted">保存结果第 ${escapeHtml(item.row)} 行，${item.aggregation === "sum" ? "数据库分组求和；未出现的分组没有补零" : "仅证明该记录"}；不自动代表总体。${item.coverage_incomplete ? "来源覆盖不完整。" : ""}<br>来源 ${escapeHtml(item.resource_id)} · 执行 ${escapeHtml(item.execution_id)}</p></section>`;
    })
    .join("");
  const computed = arithmetic
    .map((item) => {
      const value = item.result;
      const group = Object.entries(item.verified_group || {}).map(([key, part]) => `${key}=${part === null ? "NULL" : JSON.stringify(part)}`).join(" · ");
      const shown =
        value.value === null
          ? value.undefined_reason === "null_input"
            ? "未知（输入缺失）"
            : "不可计算（除数为零）"
          : `${value.approximate ? "约 " : ""}${value.value}`;
      return `<section class="metric-block"><h4>已核验运算 · ${escapeHtml({ add: "相加", subtract: "相减", multiply: "相乘", divide: "相除" }[item.operation] || item.operation)}</h4>
      ${group ? `<p class="metric-scope">同次查询分组：${escapeHtml(group)}</p>` : ""}
      <div class="table-scroll" tabindex="0" role="region" aria-label="已核验运算结果"><table><thead><tr><th scope="col">结果</th><th scope="col">单位</th></tr></thead><tbody><tr><td class="metric-value">${escapeHtml(shown)}</td><td>${escapeHtml(value.unit)}</td></tr></tbody></table></div>
      <p class="muted">${value.interpretation === "mathematical_only" ? "核验数学运算与来源，不认证模型给出的业务名称。" : ""}${value.partial ? "输入有缺失或覆盖不完整。" : ""}</p>
      <details class="diagnostics"><summary>计算公式与来源</summary><p class="metric-scope">${escapeHtml(value.formula || `${value.basis?.table || "结果资源"}.${value.basis?.column || "结果"}`)}</p><p class="muted">计算资源 ${escapeHtml(item.resource_id)}</p></details></section>`;
    })
    .join("");
  const named = dimensions
    .map(
      (
        item,
      ) => `<section class="metric-block"><h4>已核验维表 · ${escapeHtml(item.table)}</h4>
    <p class="metric-scope">${escapeHtml(
      Object.entries(item.key)
        .map(([key, value]) => `${key}=${value}`)
        .join(" · "),
    )}<br>快照观测 ${escapeHtml(item.snapshot.observed_at)} · 发布 v${escapeHtml(item.snapshot.version)}</p>
    <div class="table-scroll" tabindex="0" role="region" aria-label="已核验维表键值"><table><thead><tr><th scope="col">契约字段</th><th scope="col">观测值</th></tr></thead><tbody>${item.values.map((value) => `<tr><td>${escapeHtml(value.column)} · ${escapeHtml(value.description)}</td><td>${escapeHtml(displayCell(value.value))}</td></tr>`).join("")}</tbody></table></div>
    <p class="muted">仅证明所列键值；与业务指标的对应关系须依据相同键，未自动证明关联或统计周期。<br>来源 ${escapeHtml(item.resource_id)} · 执行 ${escapeHtml(item.execution_id)}</p></section>`,
    )
    .join("");
  const evaluatedCells = evaluated
    .map((item) => {
      const { columns, rows } = item.verified_result;
      return `<section class="metric-block"><h4>已核验的结果计算</h4>
      <p class="metric-scope">按保存资源递归复算，指标及单位来自服务端核验；完整性请查看范围与限制。</p>
      <div class="table-scroll" tabindex="0" role="region" aria-label="已核验的结果计算"><table><thead><tr>${columns.map((column) => `<th scope="col">${escapeHtml(column.label)}（${escapeHtml(column.unit)}）</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td class="metric-value">${escapeHtml(displayCell(row[column.name]))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
      <p class="muted">来源 ${escapeHtml(item.source_resource_id)} · 计算资源 ${escapeHtml(item.resource_id)}</p></section>`;
    })
    .join("");
  const groupedRollups = rollups
    .map(({ item, calculation }) => {
      const inputs = { sum: "求和", count_nonnull: "非 NULL 计数", count_rows: "观测行计数" };
      const actions = {
        sum: `分组${inputs[item.input_operation] || "聚合"}结果再求和`,
        count_rows: "查询返回的结果分组数",
        count_null: "聚合输出为 NULL 的分组数",
        count_zero: "聚合输出为零的分组数",
      };
      const filters = [
        ...Object.entries(item.filters || {}).map(([key, value]) => `${key}=${value}`),
        ...Object.entries(item.in_sets || {}).map(([key, values]) => `${key} IN (${values.join("、")})`),
      ].join(" · ") || "未限定维度";
      return `<section class="metric-block"><h4>已核验的分组计算 · ${escapeHtml(item.table)}.${escapeHtml(item.column)}</h4>
      <p class="metric-scope">${escapeHtml(item.description)}<br>${escapeHtml(item.range.start)} 至 ${escapeHtml(item.range.end)} · ${escapeHtml(item.range.timezone)}<br>${escapeHtml(filters)}<br>原查询按 ${escapeHtml((item.grouped_by || []).join("、"))} 分组</p>
      <div class="table-scroll" tabindex="0" role="region" aria-label="已核验的分组计算"><table><thead><tr><th scope="col">计算</th><th scope="col">数值</th><th scope="col">单位</th><th scope="col">数据状态</th></tr></thead><tbody><tr><td>${escapeHtml(actions[item.operation] || "分组计算")}</td><td class="metric-value">${escapeHtml(item.value)}</td><td>${escapeHtml(item.unit)}</td><td>实际（契约声明仅观察值）</td></tr></tbody></table></div>
      <p class="muted">${item.operation === "sum" ? "仅汇总查询已返回的分组，未出现的组合没有补零。" : "这是结果分组的计数，不是底层业务明细的计数。"}<br>来源 ${escapeHtml(item.source_resource_id)} · 计算资源 ${escapeHtml(calculation.resource_id)}</p></section>`;
    })
    .join("");
  const joined = joins
    .map((item) => {
      const operation = {
        sum: "合计",
        count_nonnull: "非 NULL 计数",
        count_null: "NULL 计数",
        count_zero: "零值计数",
        count_rows: "记录行数",
      };
      return `<section class="metric-block"><h4>已核验的关联结果</h4>
      <p class="metric-scope">由同次 JOIN 捕获的数据核验分组与指标；不表示跨读取原子快照。</p>
      <div class="table-scroll" tabindex="0" role="region" aria-label="已核验的关联结果"><table><thead><tr><th scope="col">分组</th><th scope="col">指标</th><th scope="col">运算</th><th scope="col">数值</th><th scope="col">单位</th></tr></thead><tbody>${item.values
        .map(
          (value) =>
            `<tr><td>${escapeHtml(
              Object.entries(value.group)
                .map(([key, part]) => `${key}=${displayCell(part)}`)
                .join(" · ") || "总体",
            )}</td><td>${escapeHtml(value.description)}</td><td>${escapeHtml(operation[value.operation] || value.operation)}</td><td class="metric-value">${escapeHtml(value.value)}</td><td>${escapeHtml(value.unit)}</td></tr>`,
        )
        .join("")}</tbody></table></div>
      <p class="muted">来源 ${escapeHtml(item.resource_id)} · 执行 ${escapeHtml(item.execution_id)}。完整筛选及范围请查看来源。</p></section>`;
    })
    .join("");
  return `<div class="verified-summary"><p class="summary-caption">本次核验的单元结果${analysis.status === "partial" ? " · 仅完成部分分析，请查看范围与限制" : ""}</p>${named}${observed}${blocks}${joined}${evaluatedCells}${groupedRollups}${computed}<details class="diagnostics"><summary>完整分析结论与引用</summary><div class="prose">${escapeHtml(analysis.answer)}</div></details></div>`;
}

function renderSource(source, hashes = {}, verifiedJoin) {
  const columns = source.rows[0] ? Object.keys(source.rows[0]) : [];
  const shown = source.rows.slice(0, 20);
  const table = columns.length
    ? `<div class="table-scroll" tabindex="0" role="region" aria-label="查询结果明细"><table><thead><tr>${columns.map((key) => `<th scope="col">${escapeHtml(key)}</th>`).join("")}</tr></thead><tbody>${shown.map((row) => `<tr>${columns.map((key) => `<td>${escapeHtml(displayCell(row[key]))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
    : verifiedJoin
      ? '<p class="muted">已核验的关联结果显示在上方。展开下方可查看 SQL 与来源。</p>'
      : source.dimension_snapshot && source.evidence_eligible
        ? '<p class="muted">已核验的维表键值显示在上方正式结果中；完整查询记录保存在当前资源，未将模型列别名作为业务名称。</p>'
        : '<p class="muted">没有可展示的明细行。空结果不等于零。</p>';
  const more =
    source.evidence_eligible &&
    columns.length &&
    source.returned_rows > shown.length &&
    hashes[source.resource_id]
      ? `<p class="muted pagination-count" data-kind="source" data-total="${escapeHtml(source.returned_rows)}">已保存 ${escapeHtml(source.returned_rows)} 行，当前显示前 ${shown.length} 行。</p><button class="secondary resource-next" data-resource="${escapeHtml(source.resource_id)}" data-hash="${escapeHtml(hashes[source.resource_id])}" data-offset="${shown.length}">加载更多结果行</button>`
      : "";
  return `<details class="source"><summary><span>${escapeHtml(source.tables.join(", "))}</span><span class="source-engine">${escapeHtml(source.engine || "本地合成库")}</span></summary><div class="source-body">
    <p>${source.evidence_eligible ? "当前证据" : "证据不可验证，未展示结果行"} · ${source.dimension_snapshot ? `维表快照观测 ${escapeHtml(source.dimension_snapshot.observed_at)}` : source.time_range.selected_dates?.length ? `仅所选日期：${escapeHtml(source.time_range.selected_dates.join("、"))} · ${escapeHtml(source.time_range.timezone)}` : `${escapeHtml(source.time_range.start)} 至 ${escapeHtml(source.time_range.end)} · ${escapeHtml(source.time_range.timezone)}`}</p>
    <p class="coverage">${escapeHtml(source.evidence_eligible ? coverageText(source) : "覆盖与新鲜度未作为当前有效证据使用。")}</p>
    ${table}${more}
    <details class="diagnostics"><summary>查询与执行依据</summary><p>提交的 SQL</p><pre><code>${escapeHtml(source.sql)}</code></pre>
    ${source.executed_sql && source.executed_sql !== source.sql ? `<p>实际执行的 SQL</p><pre><code>${escapeHtml(source.executed_sql)}</code></pre>` : ""}
    <dl class="metadata"><dt>资源</dt><dd>${escapeHtml(source.resource_id)}</dd><dt>执行 ID</dt><dd>${escapeHtml(source.execution_id || "未记录")}</dd>
    <dt>保存时间</dt><dd>${escapeHtml(source.observed_at || "未记录")}</dd><dt>契约</dt><dd>${Object.entries(
      source.contract_revisions || {},
    )
      .map(
        ([table, revision]) => `${escapeHtml(table)}@${escapeHtml(revision)}`,
      )
      .join(", ")}</dd>
    <dt>结果范围</dt><dd>${source.complete_population ? "源结果未截断；不单独证明业务总体完整" : "源结果受限制，不是完整总体"}</dd>
    ${source.data_capture_hash ? `<dt>捕获指纹</dt><dd>${escapeHtml(source.data_capture_hash)}（内容标识，不是不可变版本或签名）</dd>` : ""}
    ${source.execution_settings ? `<dt>执行设置</dt><dd>${escapeHtml(JSON.stringify(source.execution_settings))}</dd>` : ""}</dl></details></div></details>`;
}
