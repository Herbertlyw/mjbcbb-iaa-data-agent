import { fauxAssistantMessage, fauxToolCall, type AssistantMessage, type JsonObject, type TranscriptContext } from "@earendil-works/pi-ai";
import { resolveTurn } from "./turn.js";
import type { Slots, TurnResolution } from "./types.js";

interface ToolFact {
  name: string;
  isError: boolean;
  payload: Record<string, unknown>;
}

export function planFromTranscript(context: TranscriptContext, knowledgeDir?: string): AssistantMessage {
  try {
    const turn = readTrustedTurn(lastUserText(context.messages)) ?? (knowledgeDir ? foldTurns(context.messages, knowledgeDir) : undefined);
    const facts = factsAfterLastUser(context.messages);
    return plan(turn, facts);
  } catch (error) {
    return fauxAssistantMessage(`规划失败：${error instanceof Error ? error.message : "未知错误"}`, { stopReason: "stop" });
  }
}

function plan(turn: TurnResolution | undefined, facts: ToolFact[]): AssistantMessage {
  const updated = facts.find((fact) => fact.name === "update_analysis" && !fact.isError);
  if (updated) return fauxAssistantMessage(String(updated.payload.answer ?? "分析已由服务端记录。"), { stopReason: "stop" });
  if (facts.length > 18) return fauxAssistantMessage("工具步骤超过上限，停止继续调用。", { stopReason: "stop" });
  if (!turn) {
    return call("update_analysis", {
      suggested_status: "needs_clarification",
      draft_answer: "没有服务端问题解析。",
      resource_ids: [],
      clarification_question: "请换一种说法重新提问。",
      limitations: ["服务端没有给出可执行的问题范围。"],
    });
  }
  if (turn.intent === "unsupported" || turn.intent === "retention_missing" || turn.missing_slots.length > 0) {
    return call("update_analysis", {
      suggested_status: "needs_clarification",
      draft_answer: "当前问题还不能查询。",
      resource_ids: [],
      clarification_question: turn.clarification_question ?? "请补充平台、国家和日期范围。",
      limitations: ["问题范围不足以形成只读查询。"],
    });
  }
  if (!facts.some((fact) => fact.name === "search_assets")) {
    return call("search_assets", { query: turn.search_query });
  }
  if (turn.intent === "unauthorized") return denyUnauthorized(turn, facts);
  if (turn.intent === "sensitive") return denySensitive(turn, facts);
  return answerPerformance(turn, facts);
}

function denyUnauthorized(turn: TurnResolution, facts: ToolFact[]): AssistantMessage {
  const assetId = turn.contract_asset_ids[0] ?? "contract.finance_ledger";
  const read = facts.find((fact) => fact.name === "read_data_contract_view" && fact.payload.asset_id === assetId);
  if (!read) return call("read_data_contract_view", { asset_id: assetId });
  const query = facts.find((fact) => fact.name === "query");
  if (!query) {
    return call("query", {
      sql: boundedSelect("amount_usd", "finance_ledger", turn),
      purpose: "unauthorized",
    });
  }
  return call("update_analysis", {
    suggested_status: "failed",
    draft_answer: "财务表没有查询许可。",
    resource_ids: [],
    limitations: ["未授权的表不能因为被搜索到就查询。"],
  });
}

function denySensitive(turn: TurnResolution, facts: ToolFact[]): AssistantMessage {
  const assetId = turn.contract_asset_ids[0] ?? "contract.player_device_map";
  const read = facts.find((fact) => fact.name === "read_data_contract_view" && fact.payload.asset_id === assetId);
  if (!read) return call("read_data_contract_view", { asset_id: assetId });
  const query = facts.find((fact) => fact.name === "query");
  if (!query) {
    return call("query", {
      sql: boundedSelect("device_id, player_id", "player_device_map", turn),
      purpose: "sensitive",
    });
  }
  return call("update_analysis", {
    suggested_status: "failed",
    draft_answer: "敏感字段被拒绝。",
    resource_ids: [],
    limitations: ["设备标识和玩家标识不能出现在查询里。"],
  });
}

function answerPerformance(turn: TurnResolution, facts: ToolFact[]): AssistantMessage {
  if (turn.read_asset_ids.length && !facts.some((fact) => fact.name === "read_assets")) {
    return call("read_assets", { asset_ids: turn.read_asset_ids });
  }
  for (const assetId of turn.contract_asset_ids) {
    const read = facts.find((fact) => fact.name === "read_data_contract_view" && fact.payload.asset_id === assetId);
    if (!read) return call("read_data_contract_view", { asset_id: assetId });
    if (read.isError || read.payload.queryable !== true) {
      return call("update_analysis", {
        suggested_status: "failed",
        draft_answer: "契约不能用于查询。",
        resource_ids: [],
        limitations: [String(read.payload.reason ?? read.payload.message ?? "契约不可查询")],
      });
    }
  }
  const queries = plannedQueries(turn);
  for (const item of queries) {
    const done = facts.find((fact) => fact.name === "query" && fact.payload.purpose === item.purpose);
    if (!done) {
      const knowledgeBodyVisible = facts.some((fact) => knowledgeBody(fact));
      return call("query", { sql: item.sql, purpose: item.purpose, ...(knowledgeBodyVisible ? { knowledge_body_visible: true } : {}) });
    }
    if (done.isError) {
      const successful = facts.filter((fact) => fact.name === "query" && !fact.isError && fact.payload.resource_id);
      if (successful.length === 0) {
        return call("update_analysis", {
          suggested_status: "failed",
          draft_answer: "查询被拒绝。",
          resource_ids: [],
          limitations: [String(done.payload.message ?? done.payload.code ?? "查询失败")],
        });
      }
      return call("update_analysis", {
        suggested_status: "partial",
        draft_answer: "部分来源查询失败，只提交已经成功的资源。",
        resource_ids: successful.map((fact) => String(fact.payload.resource_id)),
        limitations: [String(done.payload.message ?? done.payload.code ?? "有来源查询失败")],
      });
    }
  }
  for (const item of queries) {
    const query = facts.find((fact) => fact.name === "query" && fact.payload.purpose === item.purpose);
    const resourceId = String(query?.payload.resource_id ?? "");
    const calc = facts.find((fact) => fact.name === "calculate_session_cells" && fact.payload.source_resource_id === resourceId);
    if (!calc) {
      return call("calculate_session_cells", {
        operation: "cells",
        input: { resource_id: resourceId, execution_id: String(query?.payload.execution_id ?? "") },
        operations: item.operations,
      });
    }
  }
  const calcIds = facts.filter((fact) => fact.name === "calculate_session_cells" && !fact.isError).map((fact) => String(fact.payload.resource_id));
  if (!facts.some((fact) => fact.name === "read_session_resource")) {
    return call("read_session_resource", { resource_id: calcIds[0] ?? "" });
  }
  const queryIds = facts.filter((fact) => fact.name === "query" && !fact.isError).map((fact) => String(fact.payload.resource_id));
  return call("update_analysis", {
    suggested_status: "completed",
    draft_answer: "模型建议把这次分析标成完成。",
    resource_ids: [...queryIds, ...calcIds],
    limitations: [],
  });
}

function plannedQueries(turn: TurnResolution): Array<{ purpose: string; sql: string; operations: JsonObject[] }> {
  const queries: Array<{ purpose: string; sql: string; operations: JsonObject[] }> = [];
  const joined = turn.raw_text.includes("连表") && turn.slots.metrics.includes("new_users") && turn.slots.metrics.includes("ad_revenue");
  if (joined) {
    queries.push({
      purpose: "joined_installs_revenue",
      sql: joinSql(turn),
      operations: [...installOperations("new_users_sum", "new_users_missing", "new_users_zero"), ...revenueOperations()],
    });
  }
  if (!joined && turn.slots.metrics.includes("new_users")) {
    queries.push({ purpose: "installs", sql: installsSql(turn), operations: installOperations("new_users_sum", "new_users_missing", "new_users_zero") });
    if (turn.slots.compare === "previous_period" && turn.slots.previous_start && turn.slots.previous_end) {
      queries.push({
        purpose: "installs_previous",
        sql: installsSql(turn, { start: turn.slots.previous_start, end: turn.slots.previous_end }),
        operations: installOperations("new_users_sum_previous", "new_users_missing_previous", "new_users_zero_previous"),
      });
    }
  }
  if (!joined && turn.slots.metrics.includes("ad_revenue")) {
    queries.push({ purpose: "revenue", sql: revenueSql(turn), operations: revenueOperations() });
  }
  if (turn.slots.metrics.some((metric) => metric === "spend" || metric === "actual_payback" || metric === "predicted_payback" || metric === "roi")) {
    queries.push({ purpose: "economics", sql: economicsSql(turn), operations: economicsOperations(turn) });
  }
  return queries;
}

function joinSql(turn: TurnResolution): string {
  return `SELECT a.event_date, a.product_id, a.platform, a.country_code, a.channel, a.new_users, b.revenue_usd, b.is_predicted
FROM daily_installs AS a
JOIN daily_ad_revenue AS b
  ON a.event_date = b.event_date AND a.product_id = b.product_id AND a.platform = b.platform AND a.country_code = b.country_code
WHERE ${scopedFilters("a", turn)} AND ${scopedFilters("b", turn)}`;
}

function scopedFilters(alias: string, turn: TurnResolution): string {
  const parts = [
    `${alias}.event_date >= '${turn.slots.start}'`,
    `${alias}.event_date <= '${turn.slots.end}'`,
    `${alias}.product_id = '${turn.slots.game}'`,
  ];
  if (turn.slots.platform) parts.push(`${alias}.platform = '${turn.slots.platform}'`);
  if (turn.slots.country) parts.push(`${alias}.country_code = '${turn.slots.country}'`);
  if (alias === "a" && turn.slots.channel && turn.slots.group_by !== "channel") parts.push(`${alias}.channel = '${turn.slots.channel}'`);
  return parts.join(" AND ");
}

function installsSql(turn: TurnResolution, range?: { start?: string; end?: string }): string {
  const window = range?.start && range.end ? range : { start: turn.slots.start, end: turn.slots.end };
  const spec = turn.warehouse?.new_users;
  if (spec) return `SELECT ${spec.select_columns.join(", ")} FROM ${spec.table} WHERE ${warehouseFilters(turn, spec, window.start ?? "", window.end ?? "")}`;
  return `SELECT event_date, product_id, platform, country_code, channel, new_users FROM daily_installs WHERE ${filters(turn, window.start ?? "", window.end ?? "")}`;
}

function revenueSql(turn: TurnResolution): string {
  const spec = turn.warehouse?.ad_revenue;
  if (spec) return `SELECT ${spec.select_columns.join(", ")} FROM ${spec.table} WHERE ${warehouseFilters(turn, spec, turn.slots.start ?? "", turn.slots.end ?? "")}`;
  return `SELECT event_date, product_id, platform, country_code, placement, revenue_usd, is_predicted FROM daily_ad_revenue WHERE ${filters(turn, turn.slots.start ?? "", turn.slots.end ?? "")}`;
}

function economicsSql(turn: TurnResolution): string {
  const spec = turn.warehouse?.spend ?? turn.warehouse?.roi;
  if (spec) return `SELECT ${spec.select_columns.join(", ")} FROM ${spec.table} WHERE ${warehouseFilters(turn, spec, turn.slots.start ?? "", turn.slots.end ?? "")}`;
  return `SELECT event_date, product_id, platform, country_code, channel, spend_usd, payback_usd, is_predicted FROM daily_unit_economics WHERE ${filters(turn, turn.slots.start ?? "", turn.slots.end ?? "")}`;
}

function warehouseFilters(turn: TurnResolution, spec: NonNullable<TurnResolution["warehouse"]>[keyof NonNullable<TurnResolution["warehouse"]>], start: string, end: string): string {
  if (!spec) return filters(turn, start, end);
  const parts = [`${spec.date_column} >= '${start}' AND ${spec.date_column} <= '${end}'`, `${spec.title_column} = '${turn.slots.game}'`];
  if (turn.slots.platform) parts.push(`${spec.platform_column} = '${turn.slots.platform}'`);
  if (turn.slots.country) parts.push(`${spec.country_column} = '${turn.slots.country}'`);
  if (spec.channel_column && turn.slots.channel && turn.slots.group_by !== "channel") parts.push(`${spec.channel_column} = '${turn.slots.channel}'`);
  return parts.join(" AND ");
}

function filters(turn: TurnResolution, start: string, end: string): string {
  const parts = [`event_date >= '${start}' AND event_date <= '${end}'`, `product_id = '${turn.slots.game}'`];
  if (turn.slots.platform) parts.push(`platform = '${turn.slots.platform}'`);
  if (turn.slots.country) parts.push(`country_code = '${turn.slots.country}'`);
  if (turn.slots.channel && turn.slots.group_by !== "channel") parts.push(`channel = '${turn.slots.channel}'`);
  return parts.join(" AND ");
}

function boundedSelect(columns: string, table: string, turn: TurnResolution): string {
  return `SELECT ${columns} FROM ${table} WHERE ${bounds(turn)}`;
}

function bounds(turn: TurnResolution): string {
  return `event_date >= '${turn.slots.start}' AND event_date <= '${turn.slots.end}'`;
}

function installOperations(sumAs: string, missingAs: string, zeroAs: string): JsonObject[] {
  return [
    { op: "sum", column: "new_users", predicted: "any", as: sumAs },
    { op: "count_null", column: "new_users", predicted: "any", as: missingAs },
    { op: "count_zero", column: "new_users", predicted: "any", as: zeroAs },
  ];
}

function revenueOperations(): JsonObject[] {
  return [
    { op: "sum", column: "revenue_usd", predicted: "actual_only", as: "revenue_actual" },
    { op: "sum", column: "revenue_usd", predicted: "predicted_only", as: "revenue_predicted" },
    { op: "count_null", column: "revenue_usd", predicted: "actual_only", as: "revenue_missing" },
    { op: "count_zero", column: "revenue_usd", predicted: "actual_only", as: "revenue_zero" },
  ];
}

function economicsOperations(turn: TurnResolution): JsonObject[] {
  const metrics = turn.slots.metrics;
  const wantsSpend = metrics.includes("spend") || metrics.includes("roi");
  const wantsActual = metrics.includes("actual_payback") || metrics.includes("roi");
  const wantsPredicted = metrics.includes("predicted_payback") || metrics.includes("roi");
  const operations: JsonObject[] = [];
  if (wantsSpend) {
    operations.push(
      { op: "sum", column: "spend_usd", predicted: "actual_only", as: "actual_spend" },
      { op: "count_null", column: "spend_usd", predicted: "actual_only", as: "spend_missing" },
      { op: "count_zero", column: "spend_usd", predicted: "actual_only", as: "spend_zero" },
    );
  }
  if (wantsActual) operations.push({ op: "sum", column: "payback_usd", predicted: "actual_only", as: "actual_payback" });
  if (wantsPredicted) operations.push({ op: "sum", column: "payback_usd", predicted: "predicted_only", as: "predicted_payback" });
  return operations;
}

function knowledgeBody(fact: ToolFact): boolean {
  if (typeof fact.payload.body === "string" && fact.payload.body.length > 0) return true;
  const assets = fact.payload.assets ?? fact.payload.results;
  return Array.isArray(assets) && assets.some((asset) => asset && typeof asset === "object" && typeof (asset as { body?: unknown }).body === "string" && (asset as { body: string }).body.length > 0);
}

function call(name: string, args: JsonObject): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

function lastUserText(messages: TranscriptContext["messages"]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === "user") return textOf(message.content);
  }
  return "";
}

function foldTurns(messages: TranscriptContext["messages"], knowledgeDir: string): TurnResolution | undefined {
  let slots: Slots | null = null;
  let turn: TurnResolution | undefined;
  for (const message of messages) {
    if (!message || message.role !== "user") continue;
    const text = textOf(message.content);
    if (text.startsWith("The messages above are")) continue;
    const trusted = readTrustedTurn(text);
    turn = trusted ?? resolveTurn(slots, text, knowledgeDir);
    slots = turn.slots;
  }
  return turn;
}

function readTrustedTurn(userText: string): TurnResolution | undefined {
  const match = userText.match(/<trusted_turn>([\s\S]*?)<\/trusted_turn>/u);
  if (!match?.[1]) return undefined;
  return JSON.parse(match[1]) as TurnResolution;
}

function factsAfterLastUser(messages: TranscriptContext["messages"]): ToolFact[] {
  let start = 0;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === "user") start = index + 1;
  }
  const facts: ToolFact[] = [];
  for (const message of messages.slice(start)) {
    if (!message || message.role !== "toolResult") continue;
    facts.push({
      name: message.toolName,
      isError: message.isError === true,
      payload: parsePayload(textOf(message.content)),
    });
  }
  return facts;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block && typeof block === "object" && "text" in block) return String((block as { text: unknown }).text);
      return "";
    })
    .join("\n");
}

function parsePayload(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
  return { raw: text };
}
