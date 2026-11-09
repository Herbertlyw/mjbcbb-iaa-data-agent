// Discover and read versioned knowledge under persistent read budgets.
import { createHash, randomUUID } from "node:crypto";
import { currentCalendarDate } from "./config.js";
import {
  canQueryTable,
  canRead,
  contractValidity,
  tableGrain,
  validateKnowledgeSources,
} from "./knowledge.js";
import { fail, type ToolContext, type ToolResult } from "./tool-context.js";
import type { ContractBinding, ToolFailure } from "./types.js";

import { ToolAccess } from "./tool-access.js";

export class KnowledgeTools {
  private readonly ctx: ToolContext;
  private readonly access: ToolAccess;

  constructor(ctx: ToolContext, access: ToolAccess) {
    this.ctx = ctx;
    this.access = access;
  }
  async searchAssets(
    sessionId: string,
    input: {
      query?: string;
      kinds?: string[];
      offset?: number;
      limit?: number;
      expected_search_hash?: string;
    },
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const cancelled = await this.access.gate(sessionId, signal);
    if (cancelled) return cancelled;
    const session = await this.ctx.sessions.requireAsync(sessionId);
    if (
      !(await validateKnowledgeSources(
        this.ctx.knowledge,
        this.ctx.knowledge.assets
          .filter(
            (asset) =>
              asset.status === "published" &&
              asset.discoverable &&
              canRead(this.ctx.knowledge, session.role, asset.asset_id),
          )
          .map((asset) => asset.asset_id),
      ))
    )
      return fail("knowledge_source_changed", "知识目录或可读资产已变化，请重新加载后再检索。");
    const query = (input.query ?? "").trim().toLowerCase();
    const kinds = new Set(input.kinds ?? []);
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 50;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
      return fail("invalid_search_page", "搜索偏移须为非负整数，每页限 1 到 100 项。");
    const assets = this.ctx.knowledge.assets
      .filter((asset) => asset.discoverable && asset.status === "published")
      .filter((asset) => kinds.size === 0 || kinds.has(asset.kind))
      .filter((asset) => {
        if (!query) return true;
        // Body and contract definitions may contain searchable metric names,
        // aliases and dimensions. Do not expose a match on a body the caller
        // could not read: search itself must not become a content oracle.
        const body = canRead(this.ctx.knowledge, session.role, asset.asset_id) ? asset.body : "";
        const haystack = [asset.asset_id, asset.kind, asset.title, asset.summary, asset.table ?? "", body]
          .join("\n")
          .toLowerCase();
        if (haystack.includes(query)) return true;
        return query
          .split(/\s+/u)
          .filter((part) => part.length >= 2)
          .some((part) => haystack.includes(part));
      })
      .sort((a, b) => (a.asset_id < b.asset_id ? -1 : a.asset_id > b.asset_id ? 1 : 0));
    const searchHash = createHash("sha256")
      .update(
        JSON.stringify({
          role: session.role,
          query,
          kinds: [...kinds].sort(),
          registry: this.ctx.knowledge.registry_revision,
          results: assets.map((asset) => [asset.asset_id, asset.content_hash]),
        }),
      )
      .digest("hex");
    if (
      (offset > 0 && !input.expected_search_hash) ||
      (input.expected_search_hash && input.expected_search_hash !== searchHash)
    )
      return fail("search_version_changed", "续页须使用首页 search_hash；查询、权限或结果变化后请从头搜索。");
    if (offset > assets.length) return fail("invalid_search_page", "搜索偏移超出结果长度。");
    const hits = assets.slice(offset, offset + limit).map((asset) => {
      const readable = canRead(this.ctx.knowledge, session.role, asset.asset_id);
      const term = (input.query ?? "").trim();
      const match = readable && term ? asset.body.indexOf(term) : -1;
      const codePointOffset = match < 0 ? -1 : Array.from(asset.body.slice(0, match)).length;
      const excerptStart = Math.max(0, codePointOffset - 30);
      const excerpt =
        codePointOffset < 0
          ? null
          : Array.from(asset.body)
              .slice(excerptStart, excerptStart + 120)
              .join("");
      return {
        asset_id: asset.asset_id,
        kind: asset.kind,
        title: asset.title,
        summary: asset.summary,
        revision: asset.revision,
        content_hash: asset.content_hash,
        path: asset.path,
        status: asset.status,
        ...(excerpt === null
          ? {}
          : {
              match_excerpt: excerpt,
              excerpt_offset: excerptStart,
              excerpt_offset_unit: "unicode_code_points",
            }),
        ...(asset.table ? { table: asset.table } : {}),
      };
    });
    // Search excerpts are also knowledge body. Count the exact bytes before
    // returning them so repeated searches cannot bypass the read budget.
    const excerptBytes = hits.reduce(
      (sum, hit) => sum + (typeof hit.match_excerpt === "string" ? Buffer.byteLength(hit.match_excerpt) : 0),
      0,
    );
    if (excerptBytes) {
      const excerptSources = hits
        .filter((hit) => typeof hit.match_excerpt === "string")
        .map((hit) => ({
          id: hit.asset_id,
          hash: hit.content_hash,
          body: this.ctx.knowledge.by_id.get(hit.asset_id)?.body,
        }));
      const reserved = await this.ctx.sessions.reserveAssetRead(
        sessionId,
        excerptBytes,
        this.ctx.config.maxAssetReadBytes,
      );
      if (reserved === "lost")
        return fail(
          "asset_read_budget_outcome_unknown",
          "知识正文预算或当前任务租约无法确认，搜索片段未返回；不会自动重试。",
        );
      if (reserved === "budget_exhausted")
        return fail("asset_read_budget_exceeded", "本次会话的知识正文读取超过上限，搜索片段没有返回。");
      if (signal?.aborted) return fail("tool_cancelled", "工具已取消");
      const current = await this.ctx.sessions.requireAsync(sessionId);
      if (
        current.role !== session.role ||
        current.actor_id !== session.actor_id ||
        excerptSources.some((source) => {
          const asset = this.ctx.knowledge.by_id.get(source.id);
          return !asset || asset.content_hash !== source.hash || asset.body !== source.body;
        }) ||
        !(await validateKnowledgeSources(
          this.ctx.knowledge,
          excerptSources.map((source) => source.id),
        ))
      )
        return fail("knowledge_source_changed", "知识来源或读取权限已变化，请重新加载后搜索。");
      if (signal?.aborted) return fail("tool_cancelled", "工具已取消");
    }
    return {
      ok: true,
      hits,
      role: session.role,
      search_hash: searchHash,
      total: assets.length,
      offset,
      has_more: offset + hits.length < assets.length,
      next_offset: offset + hits.length < assets.length ? offset + hits.length : null,
      notice: "搜索只用于发现资产，不授予读取正文或查询数据的权限。",
    };
  }

  async readAsset(
    sessionId: string,
    input: { asset_id?: string; body_offset?: number; body_limit?: number; expected_content_hash?: string },
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const cancelled = await this.access.gate(sessionId, signal);
    if (cancelled) return cancelled;
    const decision = await this.access.authorizeRead(sessionId, input.asset_id ?? "");
    if (!decision.ok) return decision;
    const offset = input.body_offset ?? 0;
    const limit = input.body_limit ?? 4000;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 4000) {
      return fail("invalid_asset_page", "正文偏移必须是非负整数，每页限 1 到 4000 个 Unicode 码点。");
    }
    if (
      (offset > 0 && !input.expected_content_hash) ||
      (input.expected_content_hash && input.expected_content_hash !== decision.asset.content_hash)
    ) {
      return fail("asset_version_changed", "续读必须携带第一页的内容哈希；版本不一致时请从头读取。");
    }
    const originalHash = decision.asset.content_hash;
    const originalBody = decision.asset.body;
    const characters = Array.from(originalBody);
    if (offset > characters.length) return fail("invalid_asset_page", "正文偏移超出资产长度。");
    const body = characters.slice(offset, offset + limit).join("");
    const next = offset + Array.from(body).length;
    const bodyBytes = Buffer.byteLength(body);
    const reservation = await this.ctx.sessions.reserveAssetRead(
      sessionId,
      bodyBytes,
      this.ctx.config.maxAssetReadBytes,
    );
    if (reservation === "lost")
      return fail(
        "asset_read_budget_outcome_unknown",
        "知识正文预算或当前任务租约无法确认，正文未返回；不会自动重试。",
        { asset_id: decision.asset.asset_id },
      );
    if (reservation === "budget_exhausted") {
      return fail(
        "asset_read_budget_exceeded",
        "本次会话的知识正文读取超过上限。正文不会返回，也不能据此形成正式结论。",
        { asset_id: decision.asset.asset_id },
      );
    }
    // A cancellation during the asynchronous reservation must not release
    // the committed budget or deliver the page to the abandoned model call.
    if (signal?.aborted) return fail("tool_cancelled", "工具已取消");
    const confirmed = await this.access.authorizeRead(sessionId, decision.asset.asset_id);
    if (!confirmed.ok) return confirmed;
    if (confirmed.asset.content_hash !== originalHash || confirmed.asset.body !== originalBody)
      return fail("asset_version_changed", "正文读取期间资产发生变化，请从头读取。", {
        asset_id: decision.asset.asset_id,
      });
    if (signal?.aborted) return fail("tool_cancelled", "工具已取消");
    return {
      ok: true,
      asset_id: decision.asset.asset_id,
      kind: decision.asset.kind,
      revision: decision.asset.revision,
      content_hash: decision.asset.content_hash,
      title: decision.asset.title,
      body,
      body_offset: offset,
      body_limit: limit,
      body_offset_unit: "unicode_code_points",
      total_body_length: characters.length,
      has_more: next < characters.length,
      next_body_offset: next < characters.length ? next : null,
      notice: "读到正文不等于可以查询数据。",
    };
  }

  async readAssets(
    sessionId: string,
    input: {
      asset_ids?: string[];
      requests?: Array<{
        asset_id: string;
        body_offset?: number;
        body_limit?: number;
        expected_content_hash?: string;
      }>;
      offset?: number;
      limit?: number;
    },
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const cancelled = await this.access.gate(sessionId, signal);
    if (cancelled) return cancelled;
    if (input.asset_ids && input.requests)
      return fail("invalid_asset_page", "asset_ids 和 requests 只能提供一个；资产列表分页使用 offset/limit，单个正文分页使用 requests 中的 body_offset/body_limit。不要混用两种偏移。");
    if (
      input.asset_ids !== undefined &&
      (!Array.isArray(input.asset_ids) || input.asset_ids.some((id) => typeof id !== "string"))
    )
      return fail("invalid_asset_page", "资产 ID 列表必须由字符串组成。");
    const requests = input.requests ?? (input.asset_ids ?? []).map((asset_id) => ({ asset_id }));
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 50;
    if (
      !Array.isArray(requests) ||
      requests.length > 100 ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > requests.length ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      return fail("invalid_asset_page", "批量读取最多 100 项；offset 是资产列表起点，须在 0 到列表长度之间，limit 是每页资产数（1–100），不是正文长度。单个正文请使用 body_offset/body_limit。");
    const page = requests.slice(offset, offset + limit);
    const results = [];
    for (const request of page) {
      if (!request || typeof request.asset_id !== "string") {
        results.push(fail("invalid_asset_page", "资产读取请求无效。"));
        continue;
      }
      const result = await this.readAsset(sessionId, request, signal);
      results.push({ ...result, asset_id: request.asset_id });
    }
    const anyOk = results.some((item) => item.ok);
    if (results.length && !anyOk) {
      const failures = results.filter((item): item is typeof item & ToolFailure => !item.ok);
      const sameCode =
        failures.length === results.length && failures.every((item) => item.code === failures[0]?.code);
      return {
        ok: false,
        code: sameCode ? failures[0]!.code : "asset_batch_failed",
        message: sameCode ? failures[0]!.message : "批量读取没有成功项；请查看每项的错误原因。",
        results,
        offset,
        limit,
        total: requests.length,
        has_more: offset + page.length < requests.length,
        next_offset: offset + page.length < requests.length ? offset + page.length : null,
        notice: "批量读取逐个授权。成功读取不会创建查询绑定。",
      };
    }
    return {
      ok: true,
      results,
      offset,
      limit,
      total: requests.length,
      has_more: offset + page.length < requests.length,
      next_offset: offset + page.length < requests.length ? offset + page.length : null,
      notice:
        "批量读取逐项授权；正文偏移按 Unicode 码点，续读须带该资产的内容哈希。成功读取不会创建查询绑定。",
    };
  }

  async readDataContractView(
    sessionId: string,
    input: {
      asset_id?: string;
      columns_offset?: number;
      columns_limit?: number;
      expected_content_hash?: string;
    },
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const cancelled = await this.access.gate(sessionId, signal);
    if (cancelled) return cancelled;
    const decision = await this.access.authorizeRead(sessionId, input.asset_id ?? "");
    if (!decision.ok) return { ...decision, asset_id: input.asset_id ?? "" };
    const asset = decision.asset;
    if (asset.kind !== "data_contract" || !asset.contract) {
      return fail("missing_data_contract", "这个资产没有数据契约", { asset_id: asset.asset_id });
    }
    const contract = asset.contract;
    const offset = input.columns_offset ?? 0;
    const limit = input.columns_limit ?? 100;
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > contract.columns.length ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      return fail("invalid_contract_page", "字段偏移或页大小无效。");
    if (
      (offset > 0 && !input.expected_content_hash) ||
      (input.expected_content_hash && input.expected_content_hash !== asset.content_hash)
    )
      return fail("asset_version_changed", "续页须带首页的内容哈希，版本变化后请重新读取。");
    const session = await this.ctx.sessions.requireAsync(sessionId);
    const validity = contractValidity(contract, currentCalendarDate(this.ctx.config, contract.timezone));
    const allowed = canQueryTable(this.ctx.knowledge, session.role, contract.table);
    const queryable = !validity && allowed;
    const denyReason =
      validity === "expired"
        ? "expired_contract"
        : validity === "not_yet_valid"
          ? "contract_not_yet_valid"
          : validity === "invalid"
            ? "invalid_contract_period"
            : !allowed
              ? "table_not_authorized"
              : undefined;
    // Expose calculation and relationship metadata only when every referenced
    // contract is published and visible/queryable to this principal. These
    // hints do not create additional bindings or authorize a JOIN.
    const visibleContract = (table: string) => {
      const candidate = this.ctx.knowledge.contract_by_table.get(table);
      return candidate?.status === "published" &&
        candidate.contract &&
        canRead(this.ctx.knowledge, session.role, candidate.asset_id) &&
        canQueryTable(this.ctx.knowledge, session.role, table)
        ? candidate
        : undefined;
    };
    const visibleOperand = (name: string) => {
      if (typeof name !== "string" || name.length > 257) return undefined;
      const parts = name.split(".");
      if (parts.length < 1 || parts.length > 2) return undefined;
      const table = parts.length === 2 ? parts[0]! : contract.table;
      const field = parts.at(-1)!;
      const source = visibleContract(table);
      return source?.contract &&
        source.contract.series?.metrics.includes(field) &&
        !source.contract.sensitive_columns.includes(field) &&
        source.contract.columns.some((column) => column.name === field)
        ? source
        : undefined;
    };
    const derived = (contract.derived_metrics ?? []).flatMap((item) => {
      if (
        !item ||
        typeof item.id !== "string" ||
        item.id.length > 128 ||
        typeof item.label !== "string" ||
        item.label.length > 256 ||
        typeof item.unit !== "string" ||
        item.unit.length > 128 ||
        !["add", "subtract", "multiply", "divide"].includes(item.operation) ||
        item.prediction !== "actual_only"
      )
        return [];
      const left = visibleOperand(item.numerator);
      const right = visibleOperand(item.denominator);
      return left && right ? [{ item, assets: [left.asset_id, right.asset_id] }] : [];
    });
    const joinAsset = this.ctx.knowledge.by_id.get("join.rules");
    const relations =
      joinAsset?.status === "published" && canRead(this.ctx.knowledge, session.role, joinAsset.asset_id)
        ? this.ctx.knowledge.joins.flatMap((join) => {
            if (
              typeof join.join_id !== "string" ||
              join.join_id.length > 128 ||
              !Array.isArray(join.tables) ||
              !join.tables.includes(contract.table) ||
              join.tables.length !== 2 ||
              join.tables.some((table) => typeof table !== "string" || table.length > 128) ||
              !Array.isArray(join.keys) ||
              !join.keys.length ||
              join.keys.length > 16 ||
              join.keys.some((key) => typeof key !== "string" || key.length > 128)
            )
              return [];
            const sources = join.tables.map(visibleContract);
            if (
              sources.some(
                (source) =>
                  !source?.contract ||
                  join.keys.some(
                    (key) =>
                      !source.contract!.columns.some((column) => column.name === key) ||
                      source.contract!.sensitive_columns.includes(key),
                  ),
              )
            )
              return [];
            return [
              {
                item: { join_id: join.join_id, tables: join.tables, keys: join.keys },
                assets: sources.map((source) => source!.asset_id),
              },
            ];
          })
        : [];
    const extraAssets = [
      ...derived.flatMap((item) => item.assets),
      ...relations.flatMap((item) => item.assets),
      ...(relations.length && joinAsset ? [joinAsset.asset_id] : []),
    ];
    if (!(await validateKnowledgeSources(this.ctx.knowledge, extraAssets)))
      return fail("knowledge_source_changed", "契约或关联规则来源已变化，请重新加载后再读取。");
    if (signal?.aborted) return fail("tool_cancelled", "工具已取消");
    const binding: ContractBinding = {
      receipt_id: `rcpt_${randomUUID()}`,
      session_id: session.session_id,
      asset_id: asset.asset_id,
      table: contract.table,
      contract_revision: contract.revision,
      registry_revision: this.ctx.knowledge.registry_revision,
      content_hash: asset.content_hash,
      queryable,
      ...(denyReason ? { deny_reason: denyReason } : {}),
      allowed_columns: contract.columns
        .map((column) => column.name)
        .filter((name) => !contract.sensitive_columns.includes(name)),
      sensitive_columns: contract.sensitive_columns,
      must_filter: contract.must_filter,
      timezone: contract.timezone,
      freshness: contract.freshness,
      valid_until: contract.valid_until,
      read_at: new Date().toISOString(),
    };
    await this.ctx.sessions.upsertContractBinding(session, binding);
    const freshnessResult = await this.access.currentFreshness();
    const publication = freshnessResult.ok ? freshnessResult.publication : null;
    const publishedTable = publication?.tables[contract.table];
    return {
      ok: true,
      asset_id: asset.asset_id,
      receipt_id: binding.receipt_id,
      table: contract.table,
      contract_revision: contract.revision,
      registry_revision: binding.registry_revision,
      queryable,
      ...(denyReason ? { reason: denyReason } : {}),
      timezone: contract.timezone,
      must_filter: contract.must_filter,
      series: contract.series ?? null,
      content_hash: asset.content_hash,
      grain: tableGrain(this.ctx.knowledge, contract.table),
      derived_metrics: derived.slice(0, 20).map((item) => item.item),
      derived_metrics_has_more: derived.length > 20,
      registered_relationships: relations.slice(0, 20).map((item) => item.item),
      registered_relationships_has_more: relations.length > 20,
      columns: contract.columns.slice(offset, offset + limit).map((column) => ({
        name: column.name,
        type: column.type,
        unit: column.unit ?? null,
        description: column.description,
        sensitive: contract.sensitive_columns.includes(column.name),
        nullable: column.nullable === true,
        null_means: column.null_means ?? null,
        zero_means: column.zero_means ?? null,
      })),
      columns_offset: offset,
      columns_total: contract.columns.length,
      columns_has_more: offset + limit < contract.columns.length,
      columns_next_offset: offset + limit < contract.columns.length ? offset + limit : null,
      freshness: contract.freshness,
      published_freshness:
        publication && publishedTable
          ? {
              ...publishedTable,
              status:
                publication.valid_until < currentCalendarDate(this.ctx.config, this.ctx.knowledge.timezone)
                  ? "expired"
                  : publishedTable.status,
              publication_id: publication.publication_id,
              version: publication.version,
              valid_until: publication.valid_until,
            }
          : { status: freshnessResult.ok ? "not_published" : "unavailable" },
      valid_from: contract.valid_from,
      valid_until: contract.valid_until,
      simulated: true,
      notice: queryable
        ? `服务端已记录当前契约绑定。派生指标和登记关系仅说明口径，不授予其他表的读取或查询绑定；JOIN 还须核查键、粒度与证据，事实表之间可分别查询并对齐。${contract.series?.coverage_semantics === "sparse_observations" ? " 此表按实际事件稀疏记录；未出现的分组不证明为零或已完整覆盖，需要结合目标范围和独立覆盖依据。" : ""}`
        : "契约已读取，但不能用于查询。",
    };
  }
}
