// Read bounded, hash-bound pages without granting new evidence authority.
import { createHash } from "node:crypto";
import { type JoinQueryResource } from "./join-resource-proof.js";
import { savedResultView } from "./result-view.js";
import { ToolAccess } from "./tool-access.js";
import { fail, type ToolContext, type ToolResult } from "./tool-context.js";
import { coveragePreview, previewRows } from "./tool-preview.js";
export async function readResultResource(
  ctx: ToolContext,
  access: ToolAccess,
  sessionId: string,
  input: {
    resource_id?: string;
    row_offset?: number;
    row_limit?: number;
    columns?: string[];
    expected_resource_hash?: string;
    format?: "result_view";
  },
  signal?: AbortSignal,
): Promise<ToolResult> {
  const cancelled = await access.gate(sessionId, signal);
  if (cancelled) return cancelled;
  const found = await ctx.sessions.lookupResourceAsync(sessionId, input.resource_id ?? "");
  if (!found.ok) return fail(found.code, found.message);
  if (!(await access.resourceReadable(sessionId, found.resource)))
    return fail("resource_authorization_changed", "资源引用的授权、契约或来源发生变化，不能继续读取。");
  const hash = createHash("sha256").update(JSON.stringify(found.resource)).digest("hex");
  const offset = input.row_offset ?? 0;
  const limit = input.row_limit ?? 50;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
    return fail("invalid_resource_page", "行偏移须为非负整数，每页限 1 到 100 行。");
  if (
    (offset > 0 && !input.expected_resource_hash) ||
    (input.expected_resource_hash && input.expected_resource_hash !== hash)
  )
    return fail("resource_version_changed", "续读须携带首页的资源哈希，资源变化后请从头读取。");
  if (input.format !== undefined && input.format !== "result_view")
    return fail("invalid_resource_page", "不支持的结果格式。");
  if (input.format === "result_view") {
    const view = savedResultView(found.resource);
    if (!view)
      return fail("resource_execution_identity_missing", "旧资源缺少可验证的执行身份，请重新查询或计算。");
    const available = view.columns.map((column) => column.name);
    const selected = input.columns ?? available;
    if (
      offset > view.saved_rows ||
      !Array.isArray(selected) ||
      new Set(selected).size !== selected.length ||
      selected.some((name) => typeof name !== "string" || !available.includes(name))
    )
      return fail("invalid_resource_page", "行偏移或列选择不合法。");
    const rows = previewRows(
      view.rows
        .slice(offset, offset + limit)
        .map((row) => Object.fromEntries(selected.map((name) => [name, row[name]]))),
      limit,
    );
    if (!rows.length && offset < view.saved_rows)
      return fail("resource_page_byte_limit", "单行超过页面字节上限，请选择较少字段。");
    const next = offset + rows.length;
    return {
      ok: true,
      result_view: {
        ...view,
        columns: view.columns.filter((column) => selected.includes(column.name)),
        rows,
      },
      resource_hash: hash,
      row_offset: offset,
      has_more: next < view.saved_rows,
      next_row_offset: next < view.saved_rows ? next : null,
      resource_truncated: view.source_truncated,
      notice: "已保存的结果视图；本次读取检查权限，正式交付仍须递归重算并复核新鲜度。",
    };
  }
  if (found.resource.kind === "transform") {
    const resource = found.resource;
    const available = resource.result.columns.map((column) => column.name);
    const selected = input.columns ?? available;
    if (
      offset > resource.result.rows.length ||
      !Array.isArray(selected) ||
      selected.some((name) => typeof name !== "string" || !available.includes(name)) ||
      new Set(selected).size !== selected.length
    )
      return fail("invalid_resource_page", "行偏移或列选择不合法。");
    const rows = previewRows(
      resource.result.rows
        .slice(offset, offset + limit)
        .map((row) => Object.fromEntries(selected.map((name) => [name, row[name]]))),
      limit,
    );
    if (!rows.length && offset < resource.result.rows.length)
      return fail("resource_page_byte_limit", "单行超过页面字节上限，请选择较少字段。");
    const next = offset + rows.length;
    return {
      ok: true,
      resource: {
        ...resource,
        result: {
          columns: resource.result.columns.filter((column) => selected.includes(column.name)),
          rows,
        },
      },
      resource_hash: hash,
      has_more: next < resource.result.rows.length,
      next_row_offset: next < resource.result.rows.length ? next : null,
      resource_truncated: false,
    };
  }
  if (found.resource.kind === "alignment") {
    const resource = found.resource;
    if (input.columns || offset > resource.rows.length)
      return fail("invalid_resource_page", "对齐结果仅支持行分页。");
    const rows = previewRows(resource.rows.slice(offset, offset + limit), limit);
    const next = offset + rows.length;
    if (!rows.length && offset < resource.rows.length)
      return fail("resource_page_byte_limit", "单行超过页面字节上限。");
    return {
      ok: true,
      resource: { ...resource, rows },
      resource_hash: hash,
      has_more: next < resource.rows.length,
      next_row_offset: next < resource.rows.length ? next : null,
      resource_truncated: false,
    };
  }
  if (found.resource.kind !== "query_result") {
    if (offset !== 0 || input.columns) return fail("invalid_resource_page", "计算资源没有可分页的表格行。");
    return {
      ok: true,
      resource: found.resource,
      resource_hash: hash,
      has_more: false,
      resource_truncated: found.resource.input_truncated,
    };
  }
  const source = found.resource as JoinQueryResource;
  if (offset > source.rows.length) return fail("invalid_resource_page", "行偏移超出已保存的结果。");
  const columns = input.columns ?? source.columns;
  if (
    !Array.isArray(columns) ||
    columns.some((column) => typeof column !== "string" || !source.columns.includes(column)) ||
    new Set(columns).size !== columns.length
  )
    return fail("invalid_resource_columns", "只能选择资源中已有且不重复的列。");
  const rows = previewRows(
    source.rows
      .slice(offset, offset + limit)
      .map((row) => Object.fromEntries(columns.map((column) => [column, row[column]]))),
    limit,
  );
  if (!rows.length && offset < source.rows.length)
    return fail("resource_page_byte_limit", "单行超过页面字节上限，请选择较少字段。");
  const next = offset + rows.length;
  const { join_proof: _privateProof, wide_aggregate_proof: _wideProof, ...publicSource } = source;
  return {
    ok: true,
    resource: { ...publicSource, columns, rows, coverage: coveragePreview(publicSource.coverage) },
    resource_hash: hash,
    row_offset: offset,
    row_limit: limit,
    has_more: next < source.rows.length,
    next_row_offset: next < source.rows.length ? next : null,
    resource_truncated: source.truncated || source.sql_limited === true,
    sql_limited: source.sql_limited === true,
    notice:
      "has_more 仅表示已保存资源还有页面；resource_truncated 表示源查询结果不完整。历史资源可回读，但不能当作当前任务的证据。",
  };
}
