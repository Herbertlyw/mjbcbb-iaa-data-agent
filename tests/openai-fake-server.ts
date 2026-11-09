import { createServer, type ServerResponse } from "node:http";
import { shiftSyntheticDates } from "../src/synthetic-clock.js";
import { REAL_F_FACT_SQL, REAL_F_JOIN_SQL } from "./real-model-f-sql.js";
import { REAL_A_PAYMENT_SQL, REAL_A_SPEND_SQL } from "./real-model-a-sql.js";
import { GROUPED_A_PAYMENT_SQL, GROUPED_A_SPEND_SQL, GROUPED_A_PAYMENT_OPERATIONS, GROUPED_A_SPEND_OPERATIONS } from "./grouped-a-fixture.js";

export interface ProtocolObservation {
  script: string;
  sawUserText: boolean;
  sawKnowledgeBody: boolean;
  sawSystemPrompt: boolean;
  sawToolDefinition: boolean;
  reasoningEffort: string | null;
  thinkingType: string | null;
  assistantReasoning: string[];
  authorizationPresent: boolean;
  authorizationMatched: boolean;
  userMessages: string[];
  currentTurnRoles: string[];
  historySummaryCount: number;
  historySummaryBytes: number;
  requestBytes: number;
  toolMessageBytes: number;
}

export async function startFakeOpenAI(token: string, options: { recordObservations?: boolean; syntheticDateShiftDays?: number; deepseekThinking?: boolean; cacheHitTokens?: number } = {}): Promise<{ url: string; observations: ProtocolObservation[]; close: () => Promise<void> }> {
  const dateShift = options.syntheticDateShiftDays ?? 0;
  if (!Number.isSafeInteger(dateShift) || Math.abs(dateShift) > 70_000) throw new Error("invalid_synthetic_clock");
  const observations: ProtocolObservation[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const header = request.headers.authorization ?? "";
      const matched = header === `Bearer ${token}`;
      const script = typeof request.headers["x-script"] === "string" ? request.headers["x-script"] : "happy";
      let reasoningEffort: string | null = null;
      let thinkingType: string | null = null;
      let messages: ProtocolMessage[] = [];
      try {
        const parsed = JSON.parse(body) as { reasoning_effort?: unknown; thinking?: { type?: unknown }; messages?: ProtocolMessage[] };
        messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        reasoningEffort = typeof parsed.reasoning_effort === "string" ? parsed.reasoning_effort : null;
        thinkingType = typeof parsed.thinking?.type === "string" ? parsed.thinking.type : null;
      } catch {
        reasoningEffort = null;
      }
      if (options.recordObservations !== false) observations.push({
        script,
        sawUserText: body.includes("纸灯 在 2026-10-06 到 2026-10-12（美国、iOS、雾帆）的新增用户是多少？"),
        sawKnowledgeBody: body.includes("NULL 不计入，0 是真实零"),
        sawSystemPrompt: body.includes("先搜索已发布资产"),
        sawToolDefinition: body.includes("\"name\":\"search_assets\"") || body.includes("\"name\": \"search_assets\""),
        reasoningEffort,
        thinkingType,
        assistantReasoning: messages.filter((message) => message.role === "assistant" && typeof message.reasoning_content === "string").map((message) => message.reasoning_content!),
        authorizationPresent: header.length > 0,
        authorizationMatched: matched,
        userMessages: messages.filter((message) => message.role === "user" && !historySummary(message)).map(messageText),
        currentTurnRoles: currentTurn(messages).map((message) => message.role),
        historySummaryCount: messages.filter(historySummary).length,
        historySummaryBytes: messages.filter(historySummary).reduce((sum, message) => sum + Buffer.byteLength(messageText(message)), 0),
        requestBytes: Buffer.byteLength(body),
        toolMessageBytes: messages.filter((message) => message.role === "tool").reduce((sum, message) => sum + Buffer.byteLength(JSON.stringify(message)), 0),
      });
      if (!matched) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "unauthorized" } }));
        return;
      }
      if (script === "error") {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "scripted failure" } }));
        return;
      }
      if (script === "rate-limit") {
        response.writeHead(429, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "fictional rate limit" } }));
        return;
      }
      if (["status-400", "status-401", "status-402", "status-403", "status-429"].includes(script)) {
        response.writeHead(Number(script.slice(7)), { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "fictional private error text and sk-fictional-do-not-store" } }));
        return;
      }
      if (script === "hold") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        return;
      }
      if (script === "connection-reset") {
        request.socket.destroy();
        return;
      }
      if (script === "disconnect") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify(chunkFrame(toolDelta("call_partial", "search_assets", "")))}\n\n`);
        response.destroy();
        return;
      }
      if (script === "no-usage") {
        writeTextStream(response);
        return;
      }
      if (script === "no-candidate") {
        writeTextStream(response, true, options.cacheHitTokens, "这只是没有结果来源的探索。 ");
        return;
      }
      const plainBody = body.replaceAll("\\", "");
      const holdTurn = plainBody.slice(Math.max(0, plainBody.lastIndexOf("请停住")));
      if (plainBody.includes("请停住") && !holdTurn.includes('"role":"tool"')) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        return;
      }
      const tail = plainBody.slice(-900);
      if (tail.includes("The messages above are") || tail.includes("Create a concise checkpoint")) {
        writeTextStream(response, true, options.cacheHitTokens);
        return;
      }
      // Only the explicitly scripted fake maps its fixture dates. The actual
      // Pi session and persisted user message always keep the original text.
      const fixtureMessages = dateShift ? JSON.parse(shiftSyntheticDates(JSON.stringify(messages), -dateShift)) as ProtocolMessage[] : messages;
      const turnTools = currentTurn(fixtureMessages).filter((message) => message.role === "tool");
      if (script === "clarify-retry") {
        writeTextStream(response, true, options.cacheHitTokens, JSON.stringify(fixtureMessages).includes("宿主反馈") ? "[[clarify]] 请说明分析范围？" : "[[result:res_invalid]]");
        return;
      }
      if (script === "clarify-trailing-request") {
        writeTextStream(response, true, options.cacheHitTokens, "[[clarify]] 目前我还没有生成任何本次查询结果，也不会编造数字。你想看的是交易或支付金额，还是广告变现？另外请一并说明时间范围，以及想按哪个维度看。");
        return;
      }
      if (messageText(currentTurn(fixtureMessages)[0] ?? { role: "user" }).includes("合成并发契约") && turnTools.length === 0) {
        const names = ["contract.fact_fox_daily_install", "contract.fact_fox_daily_payment", "contract.dim_fox_channel"];
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify(chunkFrame({ role: "assistant", tool_calls: names.map((asset_id, index) => ({ index, id: `batch_contract_${index}`, type: "function", function: { name: "read_data_contract_view", arguments: JSON.stringify({ asset_id }) } })) }))}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 } })}\n\n`);
        response.end("data: [DONE]\n\n");
        return;
      }
      const call = script === "minimal-clarification" && turnTools.length === 0
        ? { id: "call_clarify_minimal", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "needs_clarification", clarification_question: "请补充产品和日期范围。" }) }
        : script === "clarification" && turnTools.length === 0
        ? { id: "call_clarify", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "needs_clarification", draft_answer: "", resource_ids: [], clarification_question: "请说明分析范围。" }) }
        : script === "bad-args" ? badCall(body) : happyCall(fixtureMessages);
      if (!call) {
        const hasRecord = turnTools.some((message) => messageText(message).includes('"analysis_record"'));
        const user = messageText(currentTurn(fixtureMessages)[0] ?? { role: "user" });
        if (hasRecord || user.includes("不调用记录") || turnTools.length > 0) {
          const last = turnTools.flatMap((message) => { try { const payload = JSON.parse(messageText(message)) as Record<string, unknown>; return typeof payload.resource_id === "string" ? [payload.resource_id] : []; } catch { return []; } }).at(-1);
          if (last) { writeTextStream(response, true, options.cacheHitTokens, `[[result:${last}]]`); return; }
        }
        writeTextStream(response, true, options.cacheHitTokens);
        return;
      }
      if (call.name === "update_analysis") {
        const value = JSON.parse(call.arguments) as Record<string, unknown>;
        if (typeof value.scope === "string" && typeof value.grain === "string") {
          writeToolStream(response, call, true, options.deepseekThinking === true, options.cacheHitTokens);
          return;
        }
        if (value.declaration && typeof value.declaration === "object") {
          writeToolStream(response, { ...call, arguments: JSON.stringify(value.declaration) }, true, options.deepseekThinking === true, options.cacheHitTokens);
          return;
        }
        const question = typeof value.clarification_question === "string" ? value.clarification_question : "请补充分析范围？";
        const ids = Array.isArray(value.resource_ids) ? value.resource_ids.filter((id): id is string => typeof id === "string") : [];
        const comparisons = Array.isArray(value.comparisons) ? value.comparisons.flatMap((item) => item?.left?.resource_id && item?.left?.cell && item?.right?.resource_id && item?.right?.cell ? [`[[compare:${item.left.resource_id}.${item.left.cell},${item.right.resource_id}.${item.right.cell}]]`] : []) : [];
        const answer = value.suggested_status === "needs_clarification" ? `[[clarify]] ${/[?？]$/.test(question) ? question : `${question.replace(/[。！]$/, "")}？`}` : ids.length ? [...ids.map((id) => `[[result:${id}]]`), ...comparisons].join(" ") : "[[failed]]";
        writeTextStream(response, true, options.cacheHitTokens, answer);
        return;
      }
      const turnNumber = messages.filter((message) => message.role === "user").length;
      const adapted = call.name === "calculate_session_cells" ? adaptScriptedCalculation(call.arguments, currentTurn(fixtureMessages)) : call.arguments;
      writeToolStream(response, { ...call, id: `${call.id}_turn${turnNumber}`, arguments: shiftSyntheticDates(adapted, dateShift) }, true, options.deepseekThinking === true, options.cacheHitTokens);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    observations,
    close: () => new Promise((resolve, reject) => { server.closeAllConnections(); server.close((error) => (error ? reject(error) : resolve())); }),
  };
}

interface ProtocolMessage { role: string; content?: unknown; reasoning_content?: string; tool_calls?: Array<{ function?: { name?: string } }> }

function historySummary(message: ProtocolMessage): boolean {
  if (message.role !== "tool" && message.role !== "user") return false;
  try { return (JSON.parse(messageText(message)) as { history_summary?: boolean }).history_summary === true; } catch { return false; }
}

/** Upgrade only the test server's existing scripted fixtures. Model-facing
 * production code receives just the discriminated calculation protocol. */
function adaptScriptedCalculation(args: string, turn: ProtocolMessage[]): string {
  const ids = new Map<string, string>();
  for (const message of turn.filter((item) => item.role === "tool")) {
    try { const value = JSON.parse(messageText(message)) as Record<string, unknown>; if (typeof value.resource_id === "string" && typeof value.execution_id === "string") ids.set(value.resource_id, value.execution_id); } catch { /* malformed fixture is exercised as-is */ }
  }
  try {
    const value = JSON.parse(args) as Record<string, any>;
    const identity = (id: string) => ({ resource_id: id, execution_id: ids.get(id) ?? "" });
    const ref = (item: Record<string, any>) => ({ ...identity(item.resource_id), column: item.cell, ...(item.aggregate ? { aggregate: item.aggregate } : { row: item.row ?? 0 }) });
    const source = (item: Record<string, any>) => ({ ...identity(item.resource_id), column: item.cell });
    if (value.operation === "cells" && value.input?.resource_id) return JSON.stringify({ ...value, input: identity(value.input.resource_id) });
    if (["add", "subtract", "multiply", "divide"].includes(value.operation) && value.left?.resource_id && value.right?.resource_id) return JSON.stringify({ ...value, left: { ...value.left, ...identity(value.left.resource_id) }, right: { ...value.right, ...identity(value.right.resource_id) } });
    if (value.operations) return JSON.stringify({ operation: "cells", input: identity(value.resource_id), operations: value.operations });
    if (value.transform) return JSON.stringify({ operation: "transform", input: identity(value.transform.resource_id), steps: value.transform.steps });
    if (value.align) return JSON.stringify({ operation: "align", align_op: value.align.op, keys: value.align.keys, left: source(value.align.left), right: source(value.align.right) });
    if (value.arithmetic) return JSON.stringify(value.arithmetic.op === "divide" ? { operation: "divide", numerator: ref(value.arithmetic.left), denominator: ref(value.arithmetic.right) } : { operation: value.arithmetic.op, left: ref(value.arithmetic.left), right: ref(value.arithmetic.right) });
  } catch { /* malformed fixture is exercised as-is */ }
  return args;
}

function messageText(message: ProtocolMessage): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return message.content.map((part) => typeof part?.text === "string" ? part.text : "").join("");
  return "";
}

function currentTurn(messages: ProtocolMessage[]): ProtocolMessage[] {
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  return lastUser < 0 ? [] : messages.slice(lastUser);
}

function happyCall(messages: ProtocolMessage[]): { id: string; name: string; arguments: string } | null {
  const turn = currentTurn(messages);
  const latest = turn[0] ? messageText(turn[0]) : "";
  const earlierUsers = messages.slice(0, messages.length - turn.length).filter((message) => message.role === "user").map(messageText);
  if (latest.includes("合成工作记录后继续")) {
    const results = turn.filter((message) => message.role === "tool");
    if (!results.length) return { id: "working_note", name: "update_analysis", arguments: JSON.stringify({ scope: "合成纸灯美国范围", grain: "日", expected_group_keys: [], unresolved_questions: [], assumptions: ["模型笔记不代表授权"] }) };
    const resultText = results.map(messageText).join("\n");
    const ids = [...resultText.matchAll(/resource_id[=:]"?(res_[0-9a-f-]{36})/g)].map((match) => match[1] ?? "");
    return defaultSteps(ids)[results.length - 1] ?? null;
  }
  const hasBase = earlierUsers.some((text) => text.includes("纸灯") && text.includes("美国") && text.includes("iOS") && text.includes("雾帆") && text.includes("2026-10-06") && text.includes("2026-10-12"));
  if (latest.includes("合成真实F计数组合关联")) return scriptedRealF(turn, "join");
  if (latest.includes("合成真实F分查并引用名称")) return scriptedRealF(turn, "separate");
  if (latest.includes("合成补读支付契约恢复")) return scriptedContractRecovery(turn);
  if (latest.includes("合成独立维表名称")) return scripted(turn, independentDimensionSteps);
  if (latest.includes("合成真实聚合维表轨迹")) return scripted(turn, acceptanceJoinSteps);
  if (latest.includes("合成真实A单值日期IN")) return scripted(turn, ids => missingSpendComparisonSteps(ids, [REAL_A_PAYMENT_SQL, REAL_A_SPEND_SQL]));
  if (latest.includes("合成真实A分组聚合")) return scripted(turn, ids => groupedSpendComparisonSteps(ids,"query"));
  if (latest.includes("合成真实A聚合计算后差额")) return scripted(turn, ids => groupedSpendComparisonSteps(ids,"calculation"));
  if (latest.includes("支付流水和投放成本") && latest.includes("2026-10-08")) return scripted(turn, missingSpendComparisonSteps);
  if (latest.includes("合成错误摘录修正")) return scriptedExcerptRecovery(turn);
  if (latest.includes("合成纠正查询错误")) return scriptedAllowError(turn, false);
  if (latest.includes("合成第二项未完成")) return scriptedAllowError(turn, true);
  if (latest.includes("合成无别名空值标记")) return scripted(turn, (ids) => nullMarkerSteps(ids).map((step) => ({ ...step, arguments: step.arguments.replace(" AS is_null", "") })));
  if (latest.includes("合成空值标记投影")) return scripted(turn, nullMarkerSteps);
  if (latest.includes("合成条件阈值")) return scripted(turn, conditionalThresholdSteps);
  if (latest.includes("合成单资源比较")) return scripted(turn, sameResourceComparisonSteps);
  if (latest.includes("合成维表关联后再汇总")) return scripted(turn, joinTransformSteps);
  if (latest.includes("合成变换结果对齐")) return scripted(turn, derivedAlignmentSteps);
  if (latest.includes("合成单明细比较")) return scripted(turn, rawSingleComparisonSteps);
  if (latest.includes("合成不同明细来源")) return scripted(turn, rawDifferentResourceSteps);
  if (latest.includes("不调用记录")) return scripted(turn, noRecordSteps);
  if (latest.includes("合成收入成本比")) return scripted(turn, ratioSteps);
  if (latest.includes("合成多渠道收入成本比")) return scripted(turn, groupedRatioSteps);
  if (latest.includes("合成分组对齐")) return scripted(turn, alignmentSteps);
  if (latest.includes("合成两地区 IN")) return scripted(turn, inCountrySteps);
  if (latest.includes("合成多日双渠道跨事实")) return scripted(turn, dailyCrossFactSteps);
  if (latest.includes("合成变换后跨事实对齐")) return scripted(turn, derivedCrossFactSteps);
  if (latest.includes("合成跨资源收入减成本")) return scripted(turn, crossResourceDifferenceSteps);
  if (latest.includes("合成未声明反向比率")) return scripted(turn, (ids) => coarseChannelRatioSteps(ids, true));
  if (latest.includes("合成多层过滤产品")) return scripted(turn, layeredFilterSteps);
  if (latest.includes("合成日期函数查询")) return scripted(turn, dateFunctionSteps);
  if (latest.includes("合成十万行渠道日期")) return scripted(turn, largeJoinSteps);
  if (latest.includes("合成渠道关联比率")) return scripted(turn, coarseChannelRatioSteps);
  if (latest.includes("合成粗粒度渠道关联")) return scripted(turn, coarseChannelJoinSteps);
  if (latest.includes("合成粗粒度金额关联")) return scripted(turn, coarsePaymentJoinSteps);
  if (latest.includes("合成混合聚合明细")) return scripted(turn, mixedFactSteps);
  if (latest.includes("合成可空地区对齐")) return scripted(turn, nullableCountrySteps);
  if (latest.includes("合成部分空值跨事实")) return scripted(turn, (ids) => rawNullCrossFactSteps(ids, true));
  if (latest.includes("合成空值跨事实")) return scripted(turn, rawNullCrossFactSteps);
  if (latest.includes("合成明细跨事实")) return scripted(turn, rawCrossFactSteps);
  if (latest.includes("合成 CTE 左关联未匹配")) return scripted(turn, (ids) => preaggregatedTitleSteps(ids, true));
  if (latest.includes("合成 CTE 预聚合关联")) return scripted(turn, (ids) => preaggregatedTitleSteps(ids, false));
  if (latest.includes("合成 CTE 查询")) return scripted(turn, cteSteps);
  if (latest.includes("合成多层恒等投影")) return scripted(turn, nestedCteSteps);
  if (latest.includes("合成多层重命名投影")) return scripted(turn, renamedCteSteps);
  if (latest.includes("合成底层重命名投影")) return scripted(turn, baseRenamedCteSteps);
  if (latest.includes("合成多层预聚合")) return scripted(turn, layeredPreaggregateSteps);
  if (latest.includes("合成聚合 CTE 观察")) return scripted(turn, scopedAggregateObservationSteps);
  if (latest.includes("合成聚合 CTE 证明")) return scripted(turn, scopedAggregateProofSteps);
  if (latest.includes("合成实际范围变换")) return scripted(turn, observedOnlyTransformSteps);
  if (latest.includes("合成常量日期查询")) return scripted(turn, constantDateSteps);
  if (latest.includes("合成外层维度筛选")) return scripted(turn, outerFilterSteps);
  if (latest.includes("合成条件求和表达式")) return scripted(turn, (ids) => expressionSteps(ids, "sumif"));
  if (latest.includes("合成安全除法表达式")) return scripted(turn, (ids) => expressionSteps(ids, "nullif"));
  if (latest.includes("合成显式空值替换")) return scripted(turn, (ids) => expressionSteps(ids, "ifnull"));
  if (latest.includes("合成未知覆盖筛选")) return scripted(turn, (ids) => expressionSteps(ids, "filtered"));
  if (latest.includes("合成左关联产品")) return scripted(turn, leftTitleSteps);
  if (latest.includes("合成跨事实比率")) return scripted(turn, crossFactRatioSteps);
  if (latest.includes("合成三千六百行")) return scripted(turn, largerTransformSteps);
  if (latest.includes("合成千行完整计算")) return scripted(turn, thousandTransformSteps);
  if (latest.includes("合成完整分页")) return scripted(turn, largeTransformSteps);
  if (latest.includes("合成产品维表关联")) return scripted(turn, validJoinSteps);
  if (latest.includes("合成渠道维表关联")) return scripted(turn, validChannelJoinSteps);
  if (latest.includes("合成精确金额")) return scripted(turn, decimalSteps);
  if (latest.includes("玻璃鲦") && latest.includes("德国")) return scripted(turn, glassSteps);
  if (latest.includes("只说看看收入") || (latest.includes("日本") && !hasBase && !latest.includes("纸灯"))) return scripted(turn, clarifySteps);
  if (latest.includes("日期改成") && hasBase && earlierUsers.some((text) => text.includes("日本"))) return scripted(turn, shortJapanSteps);
  if (latest.includes("日本") && (hasBase || latest.includes("雾帆"))) return scripted(turn, japanSteps);
  if (latest.includes("连表")) return scripted(turn, unsafeJoinSteps);
  return scripted(turn, defaultSteps);
}

function conditionalThresholdSteps(ids: string[]) {
  return [
    { id: "threshold_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "threshold_query", name: "query", arguments: JSON.stringify({ sql: "SELECT countIf(new_users > 50) AS above_fifty, countIf(new_users <= 100) AS at_most_hundred, countIf(new_users != 0) AS nonzero FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-08' AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'US' AND channel_id = 'mist_ads'" }) },
    { id: "threshold_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", resource_ids: ids }) },
  ];
}

function sameResourceComparisonSteps(ids: string[]) {
  const id = ids[0] ?? "";
  return [
    { id: "same_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_payment" }) },
    { id: "same_query", name: "query", arguments: JSON.stringify({ sql: "SELECT SUM(amount_usd) AS amount_sum, SUM(cost_usd) AS cost_sum, COUNT() AS row_cnt FROM fact_fox_daily_payment WHERE event_date = toDate('2026-10-08') AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'US' AND channel_id = 'mist_ads'" }) },
    { id: "same_calculate", name: "calculate_session_cells", arguments: JSON.stringify({ resource_id: id, arithmetic: { op: "subtract", left: { resource_id: id, cell: "amount_sum", row: 0 }, right: { resource_id: id, cell: "cost_sum", row: 0 } } }) },
    { id: "same_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", resource_ids: ids }) },
  ];
}

function rawSingleComparisonSteps(ids: string[]) {
  const id = ids[0] ?? "";
  return [
    { id: "raw_same_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_payment" }) },
    { id: "raw_same_query", name: "query", arguments: JSON.stringify({ sql: "SELECT event_date, title_id, platform, country_code, channel_id, amount_usd, cost_usd FROM fact_fox_daily_payment WHERE event_date = toDate('2026-10-08') AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'US' AND channel_id = 'mist_ads'" }) },
    { id: "raw_same_calculate", name: "calculate_session_cells", arguments: JSON.stringify({ resource_id: id, arithmetic: { op: "subtract", left: { resource_id: id, cell: "amount_usd", row: 0 }, right: { resource_id: id, cell: "cost_usd", row: 0 } } }) },
    { id: "raw_same_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", resource_ids: ids }) },
  ];
}

function rawDifferentResourceSteps(ids: string[]) {
  const sql = "SELECT event_date, title_id, platform, country_code, channel_id, amount_usd, cost_usd FROM fact_fox_daily_payment WHERE event_date = toDate('2026-10-08') AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'US' AND channel_id = 'mist_ads'";
  return [
    { id: "raw_diff_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_payment" }) },
    { id: "raw_diff_query_a", name: "query", arguments: JSON.stringify({ sql }) },
    { id: "raw_diff_query_b", name: "query", arguments: JSON.stringify({ sql }) },
    { id: "raw_diff_calculate", name: "calculate_session_cells", arguments: JSON.stringify({ arithmetic: { op: "subtract", left: { resource_id: ids[0] ?? "", cell: "amount_usd", row: 0 }, right: { resource_id: ids[1] ?? "", cell: "cost_usd", row: 0 } } }) },
  ];
}

function nullMarkerSteps(ids: string[]) {
  return [
    { id: "null_marker_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "null_marker_query", name: "query", arguments: JSON.stringify({ sql: "SELECT event_date, new_users, isNull(new_users) AS is_null FROM fact_fox_daily_install WHERE event_date >= toDate('2026-10-06') AND event_date <= toDate('2026-10-08') AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'US' AND channel_id = 'mist_ads' ORDER BY event_date" }) },
    { id: "null_marker_calculate", name: "calculate_session_cells", arguments: JSON.stringify({ resource_id: ids[0] ?? "", operations: [{ op: "sum", column: "new_users", predicted: "actual_only", as: "total" }, { op: "count_zero", column: "new_users", as: "zero" }] }) },
    { id: "null_marker_update", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "不可信草稿 99999", resource_ids: ids }) },
  ];
}

function inCountrySteps(ids: string[]) {
  const sql = "SELECT country_code, SUM(new_users) AS total FROM fact_fox_daily_install WHERE event_date = '2026-10-08' AND title_id = 'paper_lantern' AND platform = 'ios' AND channel_id = 'mist_ads' AND country_code IN ('US', 'JP') GROUP BY country_code ORDER BY country_code";
  return [
    { id: "in_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "in_query", name: "query", arguments: JSON.stringify({ sql }) },
    { id: "in_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "", resource_ids: ids }) },
  ];
}

function crossResourceDifferenceSteps(ids: string[]) {
  const where = "event_date = '2026-10-08' AND title_id = 'paper_lantern' AND platform = 'ios'";
  return [
    { id: "difference_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_payment" }) },
    { id: "difference_revenue", name: "query", arguments: JSON.stringify({ sql: `SELECT country_code, channel_id, SUM(amount_usd) AS total FROM fact_fox_daily_payment WHERE ${where} GROUP BY country_code, channel_id` }) },
    { id: "difference_cost", name: "query", arguments: JSON.stringify({ sql: `SELECT country_code, channel_id, SUM(cost_usd) AS total FROM fact_fox_daily_payment WHERE ${where} GROUP BY country_code, channel_id` }) },
    { id: "difference_align", name: "calculate_session_cells", arguments: JSON.stringify({ align: { op: "subtract", keys: ["country_code", "channel_id"], left: { resource_id: ids[0] ?? "", cell: "total" }, right: { resource_id: ids[1] ?? "", cell: "total" } } }) },
    { id: "difference_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "", resource_ids: ids }) },
  ];
}

function dateFunctionSteps(ids: string[]) {
  const where = "event_date >= toDate('2026-10-06') AND event_date <= toDate('2026-10-08') AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'JP' AND channel_id = 'mist_ads'";
  return [
    { id: "date_function_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "date_function_detail", name: "query", arguments: JSON.stringify({ sql: `SELECT event_date,title_id,platform,country_code,channel_id,new_users FROM fact_fox_daily_install WHERE ${where}` }) },
    { id: "date_function_aggregate", name: "query", arguments: JSON.stringify({ sql: `SELECT SUM(new_users) AS total FROM fact_fox_daily_install WHERE ${where}` }) },
    { id: "date_function_calc", name: "calculate_session_cells", arguments: JSON.stringify({ resource_id: ids[0] ?? "", operations: [{ op: "sum", column: "new_users", as: "total" }] }) },
    { id: "date_function_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "", resource_ids: ids }) },
  ];
}

function layeredFilterSteps(ids: string[]) {
  const sql = "WITH a AS (SELECT f.title_id AS id, f.channel_id AS ch, SUM(f.amount_usd) AS amount, SUM(f.cost_usd) AS cost FROM fact_fox_daily_payment f WHERE f.event_date >= '2026-10-06' AND f.event_date <= '2026-10-08' AND f.platform = 'ios' AND f.country_code = 'US' GROUP BY f.title_id, f.channel_id), b AS (SELECT id AS item, ch AS chn, amount AS price, cost AS c FROM a WHERE id = 'paper_lantern'), c AS (SELECT item AS product, chn AS chan, price AS revenue, c AS cost2 FROM b WHERE chn = 'mist_ads') SELECT p.product, p.chan, d.title_name AS label, SUM(p.revenue) AS total, SUM(p.cost2) AS expense FROM c p LEFT JOIN dim_fox_title d ON p.product = d.title_id GROUP BY p.product, p.chan, d.title_name ORDER BY p.product";
  return [
    { id: "layered_filter_fact_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_payment" }) },
    { id: "layered_filter_dimension_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.dim_fox_title" }) },
    { id: "layered_filter_query", name: "query", arguments: JSON.stringify({ sql }) },
    { id: "layered_filter_transform", name: "calculate_session_cells", arguments: JSON.stringify({ transform: { resource_id: ids[0] ?? "", steps: [{ op: "group", by: [], aggregates: [{ op: "sum", column: "total", as: "all_total" }] }] } }) },
    { id: "layered_filter_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "", resource_ids: ids }) },
  ];
}

function coarseChannelRatioSteps(ids: string[], reverse = false) {
  const steps = coarseChannelJoinSteps(ids);
  steps[3] = { id: "coarse_channel_ratio", name: "calculate_session_cells", arguments: JSON.stringify({ transform: { resource_id: ids[0] ?? "", steps: [
    { op: "divide", left: reverse ? "cost_total" : "revenue_total", right: reverse ? "revenue_total" : "cost_total", as: "ratio" },
    { op: "sort", keys: [{ column: "ratio", direction: "asc", nulls: "last" }] },
  ] } }) };
  return steps;
}

function coarseChannelJoinSteps(ids: string[]) {
  const sql = "WITH p AS (SELECT f.channel_id AS channel, SUM(f.amount_usd) AS revenue, SUM(f.cost_usd) AS cost FROM fact_fox_daily_payment f WHERE f.event_date >= '2026-10-08' AND f.event_date <= '2026-10-08' AND f.title_id = 'paper_lantern' AND f.platform = 'ios' AND f.country_code = 'US' GROUP BY f.channel_id) SELECT p.channel AS channel, d.channel_name AS label, SUM(p.revenue) AS revenue_total, SUM(p.cost) AS cost_total FROM p INNER JOIN dim_fox_channel d ON p.channel = d.channel_id GROUP BY p.channel, d.channel_name ORDER BY p.channel";
  return [
    { id: "coarse_channel_payment_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_payment" }) },
    { id: "coarse_channel_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.dim_fox_channel" }) },
    { id: "coarse_channel_query", name: "query", arguments: JSON.stringify({ sql }) },
    { id: "coarse_channel_transform", name: "calculate_session_cells", arguments: JSON.stringify({ transform: { resource_id: ids[0] ?? "", steps: [{ op: "sort", keys: [{ column: "revenue_total", direction: "desc", nulls: "last" }] }, { op: "group", by: [], aggregates: [{ op: "sum", column: "revenue_total", as: "revenue_sum" }, { op: "sum", column: "cost_total", as: "cost_sum" }] }] } }) },
    { id: "coarse_channel_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "", resource_ids: ids }) },
  ];
}

function coarsePaymentJoinSteps(ids: string[]) {
  const sql = "WITH p AS (SELECT f.title_id AS product_id, SUM(f.amount_usd) AS revenue, SUM(f.cost_usd) AS cost FROM fact_fox_daily_payment f WHERE f.event_date >= '2026-10-06' AND f.event_date <= '2026-10-08' AND f.title_id = 'paper_lantern' AND f.platform = 'ios' AND f.country_code = 'US' AND f.channel_id = 'mist_ads' GROUP BY f.title_id) SELECT p.product_id AS product, d.title_name AS label, SUM(p.revenue) AS revenue_total, SUM(p.cost) AS cost_total FROM p LEFT JOIN dim_fox_title d ON p.product_id = d.title_id GROUP BY p.product_id, d.title_name ORDER BY p.product_id";
  return [
    { id: "coarse_payment_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_payment" }) },
    { id: "coarse_title_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.dim_fox_title" }) },
    { id: "coarse_payment_query", name: "query", arguments: JSON.stringify({ sql }) },
    { id: "coarse_payment_transform", name: "calculate_session_cells", arguments: JSON.stringify({ transform: { resource_id: ids[0] ?? "", steps: [{ op: "sort", keys: [{ column: "revenue_total", direction: "desc", nulls: "last" }] }, { op: "group", by: [], aggregates: [{ op: "sum", column: "revenue_total", as: "revenue_sum" }, { op: "sum", column: "cost_total", as: "cost_sum" }] }] } }) },
    { id: "coarse_payment_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "", resource_ids: ids }) },
  ];
}

function mixedFactSteps(ids: string[]) {
  const where = "event_date = '2026-10-08' AND title_id = 'paper_lantern' AND platform = 'ios'";
  return [
    { id: "mixed_payment_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_payment" }) },
    { id: "mixed_install_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "mixed_amount", name: "query", arguments: JSON.stringify({ sql: `SELECT country_code, channel_id, SUM(amount_usd) AS total FROM fact_fox_daily_payment WHERE ${where} GROUP BY country_code, channel_id` }) },
    { id: "mixed_users", name: "query", arguments: JSON.stringify({ sql: `SELECT event_date, title_id, platform, country_code, channel_id, new_users FROM fact_fox_daily_install WHERE ${where}` }) },
    { id: "mixed_align", name: "calculate_session_cells", arguments: JSON.stringify({ align: { op: "divide", keys: ["country_code", "channel_id"], left: { resource_id: ids[0] ?? "", cell: "total" }, right: { resource_id: ids[1] ?? "", cell: "new_users" } } }) },
    { id: "mixed_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "", resource_ids: ids }) },
  ];
}

/** The contract and rows for this case exist only in the isolated integration
 * test. Its script exercises Pi's HTTP/tool protocol, not model reasoning. */
function largeJoinSteps(ids: string[]) {
  const sql = "WITH p AS (SELECT f.event_date AS day, f.channel_id AS channel, SUM(f.new_users) AS subtotal FROM fact_fox_daily_install f WHERE f.event_date >= '2026-10-06' AND f.event_date <= '2026-10-09' AND f.title_id = 'big_demo' AND f.platform = 'android' GROUP BY f.event_date, f.channel_id) SELECT p.day AS day, p.channel AS channel, d.channel_name AS label, SUM(p.subtotal) AS total FROM p INNER JOIN dim_fox_channel d ON p.channel = d.channel_id GROUP BY p.day, p.channel, d.channel_name ORDER BY p.day, p.channel";
  return [
    { id: "large_join_fact_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "large_join_dim_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.dim_fox_channel" }) },
    { id: "large_join_query", name: "query", arguments: JSON.stringify({ sql }) },
    { id: "large_join_transform", name: "calculate_session_cells", arguments: JSON.stringify({ transform: { resource_id: ids[0] ?? "", steps: [{ op: "group", by: [], aggregates: [{ op: "sum", column: "total", as: "all_total" }] }] } }) },
    { id: "large_join_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "", resource_ids: ids }) },
  ];
}

function nullableCountrySteps(ids: string[]) {
  const where = "event_date = '2026-10-08' AND title_id = 'null_demo' AND platform = 'android' AND channel_id = 'mist_ads'";
  return [
    { id: "nullable_payment_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_payment" }) },
    { id: "nullable_install_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "nullable_amount", name: "query", arguments: JSON.stringify({ sql: `SELECT event_date,title_id,platform,country_code,channel_id,amount_usd FROM fact_fox_daily_payment WHERE ${where}` }) },
    { id: "nullable_users", name: "query", arguments: JSON.stringify({ sql: `SELECT event_date,title_id,platform,country_code,channel_id,new_users FROM fact_fox_daily_install WHERE ${where}` }) },
    { id: "nullable_align", name: "calculate_session_cells", arguments: JSON.stringify({ align: { op: "divide", keys: ["country_code"], left: { resource_id: ids[0] ?? "", cell: "amount_usd" }, right: { resource_id: ids[1] ?? "", cell: "new_users" } } }) },
    { id: "nullable_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "", resource_ids: ids }) },
  ];
}

function preaggregatedTitleSteps(ids: string[], unmatched: boolean) {
  const filter = unmatched ? "f.platform = 'android' AND f.country_code = 'ZZ' AND f.channel_id = 'mist_ads'" : "f.platform = 'ios' AND f.country_code = 'JP' AND f.channel_id = 'mist_ads'";
  const inner = `SELECT f.event_date, f.title_id, f.platform, f.country_code, f.channel_id, SUM(f.new_users) AS subtotal FROM fact_fox_daily_install f WHERE f.event_date >= '2026-10-06' AND f.event_date <= '2026-10-12' AND ${filter} GROUP BY f.event_date, f.title_id, f.platform, f.country_code, f.channel_id`;
  const sql = `WITH p AS (${inner}) SELECT p.title_id, d.title_name AS label, SUM(p.subtotal) AS total FROM p LEFT JOIN dim_fox_title d ON p.title_id = d.title_id GROUP BY p.title_id, d.title_name ORDER BY p.title_id`;
  return [
    { id: "preaggregate_fact_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "preaggregate_title_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.dim_fox_title" }) },
    { id: "preaggregate_query", name: "query", arguments: JSON.stringify({ sql }) },
    ...(unmatched ? [{ id: "preaggregate_transform", name: "calculate_session_cells", arguments: JSON.stringify({ transform: { resource_id: ids[0] ?? "", steps: [{ op: "filter", column: "label", comparison: "is_null" }, { op: "group", by: [], aggregates: [{ op: "sum", column: "total", as: "missing_total" }] }] } }) }] : []),
    { id: "preaggregate_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "", resource_ids: ids }) },
  ];
}

function layeredPreaggregateSteps(ids: string[]) {
  const base = preaggregatedTitleSteps(ids, false);
  const sql = "WITH a AS (SELECT f.event_date, f.title_id, f.platform, f.country_code, f.channel_id, SUM(f.new_users) AS subtotal FROM fact_fox_daily_install f WHERE f.event_date >= '2026-10-06' AND f.event_date <= '2026-10-12' AND f.platform = 'ios' AND f.country_code = 'JP' AND f.channel_id = 'mist_ads' GROUP BY f.event_date, f.title_id, f.platform, f.country_code, f.channel_id), b AS (SELECT event_date, title_id AS item, platform, country_code, channel_id, subtotal AS value FROM a), c AS (SELECT event_date, item AS product, platform, country_code, channel_id, value AS total_value FROM b) SELECT p.product, d.title_name AS label, SUM(p.total_value) AS total FROM c p LEFT JOIN dim_fox_title d ON p.product = d.title_id GROUP BY p.product, d.title_name ORDER BY p.product";
  base[2] = { ...base[2]!, arguments: JSON.stringify({ sql }) };
  return base;
}

function cteSteps(ids: string[]) {
  const inner = "SELECT event_date, title_id, platform, country_code, channel_id, new_users FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-12' AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'JP' AND channel_id = 'mist_ads'";
  return [
    { id: "cte_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "cte_query", name: "query", arguments: JSON.stringify({ sql: `WITH scoped AS (${inner}) SELECT event_date, new_users FROM scoped` }) },
    { id: "cte_calculate", name: "calculate_session_cells", arguments: JSON.stringify({ resource_id: ids[0] ?? "", operations: [{ op: "sum", column: "new_users", as: "total" }] }) },
    { id: "cte_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "", resource_ids: ids }) },
  ];
}

function constantDateSteps(ids: string[]) {
  const steps = cteSteps(ids);
  const original = JSON.parse(steps[1]!.arguments) as { sql: string };
  steps[1] = { ...steps[1]!, arguments: JSON.stringify({ sql: original.sql.replaceAll("'2026-10-06'", "toDate('2026-10-06')").replaceAll("'2026-10-12'", "toDate('2026-10-12')") }) };
  return steps;
}

function outerFilterSteps(ids: string[]) {
  const steps = cteSteps(ids);
  const original = JSON.parse(steps[1]!.arguments) as { sql: string };
  const inner = original.sql.replace(" AND country_code = 'JP'", "");
  if (inner === original.sql) throw new Error("invalid_cte_fixture");
  steps[1] = { ...steps[1]!, arguments: JSON.stringify({ sql: `${inner} WHERE country_code = 'JP'` }) };
  return steps;
}

function expressionSteps(ids: string[], kind: "sumif" | "nullif" | "ifnull" | "filtered") {
  const end = kind === "ifnull" ? "2026-10-12" : "2026-10-08";
  const where = `event_date >= '2026-10-06' AND event_date <= '${end}' AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'US' AND channel_id = 'mist_ads'`;
  const select = kind === "sumif" ? "sumIf(new_users, new_users > 0) AS observed" : kind === "nullif" ? "SUM(new_users) / nullIf(COUNT(), 0) AS observed" : kind === "filtered" ? "SUM(new_users) AS observed" : "event_date, ifNull(new_users, 0) AS observed";
  const compute = kind === "ifnull" ? { resource_id: ids[0] ?? "", operations: [{ op: "sum", column: "observed", as: "result" }] } : { arithmetic: { op: "add", left: { resource_id: ids[0] ?? "", cell: "observed", row: 0 }, right: { resource_id: ids[0] ?? "", cell: "observed", row: 0 } } };
  return [
    { id: "expr_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "expr_query", name: "query", arguments: JSON.stringify({ sql: `SELECT ${select} FROM fact_fox_daily_install WHERE ${where}${kind === "filtered" ? " AND new_users > 0" : ""}` }) },
    { id: "expr_calculate", name: "calculate_session_cells", arguments: JSON.stringify(compute) },
  ];
}

function scopedAggregateObservationSteps(ids: string[]) {
  return [
    { id: "scoped_observation_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "scoped_observation_query", name: "query", arguments: JSON.stringify({ sql: "WITH a AS (SELECT country_code, SUM(new_users) AS total FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-08' AND title_id = 'paper_lantern' AND platform = 'ios' AND channel_id = 'mist_ads' GROUP BY country_code), b AS (SELECT country_code, total FROM a) SELECT country_code, total FROM b WHERE country_code = 'US'" }) },
    { id: "scoped_observation_calculate", name: "calculate_session_cells", arguments: JSON.stringify({ resource_id: ids[0] ?? "", operations: [{ op: "sum", column: "total", as: "observed" }] }) },
  ];
}

function scopedAggregateProofSteps(ids: string[]) {
  return [
    { id: "scoped_proof_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "scoped_proof_query", name: "query", arguments: JSON.stringify({ sql: "WITH a AS (SELECT country_code, SUM(new_users) AS total FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-08' AND title_id = 'paper_lantern' AND platform = 'ios' AND channel_id = 'mist_ads' AND country_code IN ('US', 'JP') GROUP BY country_code), b AS (SELECT country_code, total FROM a) SELECT country_code, total FROM b" }) },
    { id: "scoped_proof_calculate", name: "calculate_session_cells", arguments: JSON.stringify({ resource_id: ids[0] ?? "", operations: [{ op: "sum", column: "total", as: "result" }] }) },
  ];
}

function observedOnlyTransformSteps(ids: string[]) {
  return [
    { id: "observed_scope_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "observed_scope_query", name: "query", arguments: JSON.stringify({ sql: "SELECT event_date, new_users FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-08' AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'US' AND channel_id = 'mist_ads'" }) },
    { id: "observed_scope_sort", name: "calculate_session_cells", arguments: JSON.stringify({ transform: { resource_id: ids[0] ?? "", steps: [{ op: "sort", keys: [{ column: "event_date", direction: "desc", nulls: "last" }] }] } }) },
    { id: "observed_scope_total", name: "calculate_session_cells", arguments: JSON.stringify({ resource_id: ids[1] ?? "", operations: [{ op: "sum", column: "new_users", predicted: "actual_only", as: "observed_total" }] }) },
  ];
}

function nestedCteSteps(ids: string[]) {
  const steps = cteSteps(ids);
  const original = JSON.parse(steps[1]!.arguments) as { sql: string };
  const prefix = "WITH scoped AS ("; const suffix = ") SELECT event_date, new_users FROM scoped";
  if (!original.sql.startsWith(prefix) || !original.sql.endsWith(suffix)) throw new Error("invalid_cte_fixture");
  const inner = original.sql.slice(prefix.length, -suffix.length);
  steps[1] = { ...steps[1]!, arguments: JSON.stringify({ sql: `WITH scoped AS (SELECT event_date, new_users FROM (${inner})) SELECT event_date, new_users FROM scoped` }) };
  return steps;
}

function renamedCteSteps(ids: string[]) {
  const steps = cteSteps(ids);
  const original = JSON.parse(steps[1]!.arguments) as { sql: string };
  const prefix = "WITH scoped AS ("; const suffix = ") SELECT event_date, new_users FROM scoped";
  if (!original.sql.startsWith(prefix) || !original.sql.endsWith(suffix)) throw new Error("invalid_cte_fixture");
  const inner = original.sql.slice(prefix.length, -suffix.length);
  steps[1] = { ...steps[1]!, arguments: JSON.stringify({ sql: `WITH scoped AS (SELECT event_date, new_users AS measure FROM (${inner})) SELECT event_date, measure AS new_users FROM scoped` }) };
  return steps;
}

function baseRenamedCteSteps(ids: string[]) {
  const steps = cteSteps(ids);
  const original = JSON.parse(steps[1]!.arguments) as { sql: string };
  const sql = original.sql.replace("channel_id, new_users FROM fact_fox_daily_install", "channel_id, new_users AS measure FROM fact_fox_daily_install").replace(") SELECT event_date, new_users FROM scoped", ") SELECT event_date, measure AS new_users FROM scoped");
  if (sql === original.sql || !sql.includes("new_users AS measure") || !sql.includes("measure AS new_users")) throw new Error("invalid_cte_fixture");
  steps[1] = { ...steps[1]!, arguments: JSON.stringify({ sql }) };
  return steps;
}

function leftTitleSteps(ids: string[]) {
  const sql = "SELECT f.title_id, d.title_name AS label, SUM(f.new_users) AS total FROM fact_fox_daily_install f LEFT JOIN dim_fox_title d ON f.title_id = d.title_id WHERE f.event_date >= '2026-10-06' AND f.event_date <= '2026-10-12' AND f.platform = 'android' AND f.country_code = 'ZZ' AND f.channel_id = 'mist_ads' GROUP BY f.title_id, d.title_name ORDER BY f.title_id";
  return [
    { id: "left_fact_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "left_title_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.dim_fox_title" }) },
    { id: "left_query", name: "query", arguments: JSON.stringify({ sql }) },
    { id: "left_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "", resource_ids: ids }) },
  ];
}

function rawCrossFactSteps(ids: string[]) {
  const where = "event_date = '2026-10-08' AND title_id = 'paper_lantern' AND platform = 'ios'";
  return [
    { id: "raw_payment_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_payment" }) },
    { id: "raw_install_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "raw_amount", name: "query", arguments: JSON.stringify({ sql: `SELECT event_date, title_id, platform, country_code, channel_id, amount_usd FROM fact_fox_daily_payment WHERE ${where}` }) },
    { id: "raw_users", name: "query", arguments: JSON.stringify({ sql: `SELECT event_date, title_id, platform, country_code, channel_id, new_users FROM fact_fox_daily_install WHERE ${where}` }) },
    { id: "raw_align", name: "calculate_session_cells", arguments: JSON.stringify({ align: { op: "divide", keys: ["country_code", "channel_id"], left: { resource_id: ids[0] ?? "", cell: "amount_usd" }, right: { resource_id: ids[1] ?? "", cell: "new_users" } } }) },
    { id: "raw_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "", resource_ids: ids }) },
  ];
}

/** Fixed local protocol replay of the two SQL statements observed in the
 * real-model task. IDs and execution IDs come from the current tool replies. */
function missingSpendComparisonSteps(ids: string[], queries?: readonly [string, string]) {
  const where = "event_date = toDate('2026-10-08') AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'US' AND channel_id = 'mist_ads'";
  return [
    { id: "missing_payment_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_payment" }) },
    { id: "missing_spend_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_spend" }) },
    { id: "missing_payment_query", name: "query", arguments: JSON.stringify({ sql: queries?.[0] ?? `SELECT event_date, title_id, platform, country_code, channel_id, amount_usd, cost_usd FROM fact_fox_daily_payment WHERE ${where}` }) },
    { id: "missing_spend_query", name: "query", arguments: JSON.stringify({ sql: queries?.[1] ?? `SELECT event_date, title_id, platform, country_code, channel_id, is_predicted, spend_usd, payback_usd FROM fact_fox_daily_spend WHERE ${where}` }) },
    { id: "missing_difference", name: "calculate_session_cells", arguments: JSON.stringify({ arithmetic: { op: "subtract", left: { resource_id: ids[0] ?? "", cell: "amount_usd", row: 0 }, right: { resource_id: ids[1] ?? "", cell: "spend_usd", row: 0 } } }) },
    { id: "missing_result", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", resource_ids: [ids[2] ?? ""] }) },
  ];
}

/** Replay the real grouped A shape; all IDs and execution IDs are current. */
function groupedSpendComparisonSteps(
  ids: string[],
  right: "query" | "calculation",
) {
  return [
    {
      id: "grouped_payment_contract",
      name: "read_data_contract_view",
      arguments: JSON.stringify({
        asset_id: "contract.fact_fox_daily_payment",
      }),
    },
    {
      id: "grouped_spend_contract",
      name: "read_data_contract_view",
      arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_spend" }),
    },
    {
      id: "grouped_payment_query",
      name: "query",
      arguments: JSON.stringify({ sql: GROUPED_A_PAYMENT_SQL }),
    },
    {
      id: "grouped_spend_query",
      name: "query",
      arguments: JSON.stringify({ sql: GROUPED_A_SPEND_SQL }),
    },
    {
      id: "grouped_spend_cells",
      name: "calculate_session_cells",
      arguments: JSON.stringify({
        operation: "cells",
        input: { resource_id: ids[1] ?? "" },
        operations: GROUPED_A_SPEND_OPERATIONS,
      }),
    },
    {
      id: "grouped_payment_cells",
      name: "calculate_session_cells",
      arguments: JSON.stringify({
        operation: "cells",
        input: { resource_id: ids[0] ?? "" },
        operations: GROUPED_A_PAYMENT_OPERATIONS,
      }),
    },
    {
      id: "grouped_difference",
      name: "calculate_session_cells",
      arguments: JSON.stringify({
        operation: "subtract",
        left: {
          resource_id: ids[3] ?? "",
          column: "payment_amount_sum",
          row: 0,
        },
        right:
          right === "query"
            ? { resource_id: ids[1] ?? "", column: "spend_usd_sum", row: 0 }
            : { resource_id: ids[2] ?? "", column: "spend_actual_sum", row: 0 },
      }),
    },
    {
      id: "grouped_record",
      name: "update_analysis",
      arguments: JSON.stringify({
        suggested_status: "completed",
        resource_ids: [ids[3] ?? "", ids[1] ?? "", ids[4] ?? "", ids[2] ?? ""],
      }),
    },
  ];
}

function rawNullCrossFactSteps(ids: string[], partial = false) {
  const where = `${partial ? "event_date >= '2026-10-08' AND event_date <= '2026-10-09'" : "event_date = '2026-10-09'"} AND title_id = 'paper_lantern' AND platform = 'ios'`;
  return [
    { id: "null_payment_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_payment" }) },
    { id: "null_install_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "null_amount", name: "query", arguments: JSON.stringify({ sql: `SELECT event_date, title_id, platform, country_code, channel_id, amount_usd FROM fact_fox_daily_payment WHERE ${where}` }) },
    { id: "null_users", name: "query", arguments: JSON.stringify({ sql: `SELECT event_date, title_id, platform, country_code, channel_id, new_users FROM fact_fox_daily_install WHERE ${where}` }) },
    { id: "null_align", name: "calculate_session_cells", arguments: JSON.stringify({ align: { op: "divide", keys: ["country_code", "channel_id"], left: { resource_id: ids[0] ?? "", cell: "amount_usd" }, right: { resource_id: ids[1] ?? "", cell: "new_users" } } }) },
    { id: "null_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "", resource_ids: ids }) },
  ];
}

function thousandTransformSteps(ids: string[]) {
  return [
    { id: "thousand_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "thousand_query", name: "query", arguments: JSON.stringify({ sql: "SELECT event_date, title_id, platform, country_code, channel_id, new_users FROM fact_fox_daily_install WHERE event_date = '2026-10-08' AND title_id = 'glass_minnow' AND platform = 'android' AND channel_id = 'pebble_net' ORDER BY country_code", preview_limit: 20 }) },
    { id: "thousand_transform", name: "calculate_session_cells", arguments: JSON.stringify({ transform: { resource_id: ids[0] ?? "", steps: [
      { op: "filter", column: "new_users", comparison: "gt", value: "0" },
      { op: "sort", keys: [{ column: "country_code", direction: "desc", nulls: "last" }] },
      { op: "group", by: [], aggregates: [{ op: "sum", column: "new_users", as: "total" }, { op: "count_all", as: "count" }] },
    ] } }) },
    { id: "thousand_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "", resource_ids: ids }) },
  ];
}

function largerTransformSteps(ids: string[]) {
  return [
    { id: "larger_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "larger_query", name: "query", arguments: JSON.stringify({ sql: "SELECT event_date, title_id, platform, country_code, channel_id, new_users FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-08' AND title_id = 'glass_minnow' AND platform = 'android' AND channel_id = 'pebble_net' ORDER BY country_code, event_date", preview_limit: 20 }) },
    { id: "larger_transform", name: "calculate_session_cells", arguments: JSON.stringify({ transform: { resource_id: ids[0] ?? "", steps: [
      { op: "filter", column: "new_users", comparison: "gt", value: "0" },
      { op: "group", by: [], aggregates: [{ op: "sum", column: "new_users", as: "total" }, { op: "count_all", as: "count" }] },
    ] } }) },
    { id: "larger_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "", resource_ids: ids }) },
  ];
}

function crossFactRatioSteps(ids: string[]) {
  const where = "event_date = '2026-10-08' AND title_id = 'paper_lantern' AND platform = 'ios'";
  return [
    { id: "cross_fact_payment_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_payment" }) },
    { id: "cross_fact_install_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "cross_fact_amount", name: "query", arguments: JSON.stringify({ sql: `SELECT country_code, channel_id, SUM(amount_usd) AS total FROM fact_fox_daily_payment WHERE ${where} GROUP BY country_code, channel_id` }) },
    { id: "cross_fact_users", name: "query", arguments: JSON.stringify({ sql: `SELECT country_code, channel_id, SUM(new_users) AS total FROM fact_fox_daily_install WHERE ${where} GROUP BY country_code, channel_id` }) },
    { id: "cross_fact_align", name: "calculate_session_cells", arguments: JSON.stringify({ align: { op: "divide", keys: ["country_code", "channel_id"], left: { resource_id: ids[0] ?? "", cell: "total" }, right: { resource_id: ids[1] ?? "", cell: "total" } } }) },
    { id: "cross_fact_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "", resource_ids: ids }) },
  ];
}

/** Scripted protocol fixture, not an autonomous model plan. */
function dailyCrossFactSteps(ids: string[]) {
  const where = "event_date >= '2026-10-06' AND event_date <= '2026-10-07' AND title_id = 'date_demo' AND platform = 'android' AND country_code = 'DATEZZ'";
  return [
    { id: "daily_cross_payment_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_payment" }) },
    { id: "daily_cross_install_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "daily_cross_amount", name: "query", arguments: JSON.stringify({ sql: `SELECT event_date, channel_id, SUM(amount_usd) AS total FROM fact_fox_daily_payment WHERE ${where} GROUP BY event_date, channel_id ORDER BY event_date, channel_id`, preview_limit: 0 }) },
    { id: "daily_cross_users", name: "query", arguments: JSON.stringify({ sql: `SELECT event_date, channel_id, SUM(new_users) AS total FROM fact_fox_daily_install WHERE ${where} GROUP BY event_date, channel_id ORDER BY event_date, channel_id`, preview_limit: 0 }) },
    { id: "daily_cross_align", name: "calculate_session_cells", arguments: JSON.stringify({ align: { op: "divide", keys: ["event_date", "channel_id"], left: { resource_id: ids[0] ?? "", cell: "total" }, right: { resource_id: ids[1] ?? "", cell: "total" } } }) },
    { id: "daily_cross_transform", name: "calculate_session_cells", arguments: JSON.stringify({ transform: { resource_id: ids[2] ?? "", steps: [
      { op: "filter", column: "result_value", comparison: "gt", value: "0" },
      { op: "sort", keys: [{ column: "result_value", direction: "desc", nulls: "last" }] },
    ] } }) },
  ];
}

function derivedCrossFactSteps(ids: string[]) {
  const base = crossFactRatioSteps(ids).slice(0, 4);
  const sort = [{ op: "sort", keys: [{ column: "country_code", direction: "asc", nulls: "last" }] }];
  return [...base,
    { id: "cross_sort_payment", name: "calculate_session_cells", arguments: JSON.stringify({ transform: { resource_id: ids[0] ?? "", steps: sort } }) },
    { id: "cross_sort_installs", name: "calculate_session_cells", arguments: JSON.stringify({ transform: { resource_id: ids[1] ?? "", steps: sort } }) },
    { id: "cross_align_derived", name: "calculate_session_cells", arguments: JSON.stringify({ align: { op: "divide", keys: ["country_code", "channel_id"], left: { resource_id: ids[2] ?? "", cell: "total" }, right: { resource_id: ids[3] ?? "", cell: "total" } } }) },
    { id: "cross_sort_aligned", name: "calculate_session_cells", arguments: JSON.stringify({ transform: { resource_id: ids[4] ?? "", steps: sort } }) },
    { id: "cross_sort_aligned_copy", name: "calculate_session_cells", arguments: JSON.stringify({ transform: { resource_id: ids[4] ?? "", steps: sort } }) },
    { id: "cross_align_again", name: "calculate_session_cells", arguments: JSON.stringify({ align: { op: "add", keys: ["country_code", "channel_id"], left: { resource_id: ids[5] ?? "", cell: "result_value" }, right: { resource_id: ids[6] ?? "", cell: "result_value" } } }) },
    { id: "cross_sort_again", name: "calculate_session_cells", arguments: JSON.stringify({ transform: { resource_id: ids[7] ?? "", steps: sort } }) },
    { id: "cross_sum_aligned", name: "calculate_session_cells", arguments: JSON.stringify({ resource_id: ids[8] ?? "", operations: [{ op: "sum", column: "result_value", as: "total_ratio" }] }) },
    { id: "cross_add_aligned", name: "calculate_session_cells", arguments: JSON.stringify({ arithmetic: { op: "add", left: { resource_id: ids[9] ?? "", cell: "total_ratio" }, right: { resource_id: ids[9] ?? "", cell: "total_ratio" } } }) },
  ];
}

function largeTransformSteps(ids: string[]) {
  return [
    { id: "large_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "large_query", name: "query", arguments: JSON.stringify({ sql: "SELECT event_date, title_id, platform, country_code, channel_id, new_users FROM fact_fox_daily_install WHERE event_date = '2026-10-06' AND title_id = 'paper_lantern' AND platform = 'android' AND channel_id = 'mist_ads' ORDER BY country_code", preview_limit: 20 }) },
    { id: "large_transform", name: "calculate_session_cells", arguments: JSON.stringify({ transform: { resource_id: ids[0] ?? "", steps: [
      { op: "filter", column: "new_users", comparison: "gt", value: "0" },
      { op: "sort", keys: [{ column: "country_code", direction: "asc", nulls: "last" }] },
      { op: "group", by: [], aggregates: [{ op: "sum", column: "new_users", as: "total" }, { op: "count_all", as: "count" }] },
    ] } }) },
    { id: "large_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "", resource_ids: ids, declaration: { scope: "纸灯 Android 雾帆的虚构地区", grain: "业务日和地区", expected_group_keys: ["country_code"], unresolved_questions: [], assumptions: ["这些地区代码仅为合成示例"] } }) },
  ];
}

function ratioSteps(ids: string[]) {
  const where = "event_date >= '2026-10-08' AND event_date <= '2026-10-08' AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'US' AND channel_id = 'mist_ads'";
  return [
    { id: "ratio_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_payment" }) },
    { id: "ratio_revenue", name: "query", arguments: JSON.stringify({ sql: `SELECT SUM(amount_usd) AS total FROM fact_fox_daily_payment WHERE ${where}` }) },
    { id: "ratio_cost", name: "query", arguments: JSON.stringify({ sql: `SELECT SUM(cost_usd) AS total FROM fact_fox_daily_payment WHERE ${where}` }) },
    { id: "ratio_calculate", name: "calculate_session_cells", arguments: JSON.stringify({ arithmetic: { op: "divide", left: { resource_id: ids[0] ?? "", cell: "total" }, right: { resource_id: ids[1] ?? "", cell: "total" } } }) },
    { id: "ratio_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "", resource_ids: ids }) },
  ];
}

function groupedRatioSteps(ids: string[]) {
  const where = "event_date >= '2026-10-08' AND event_date <= '2026-10-08' AND title_id = 'paper_lantern' AND platform = 'ios'";
  return [
    { id: "grouped_ratio_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_payment" }) },
    { id: "grouped_ratio_revenue", name: "query", arguments: JSON.stringify({ sql: `SELECT country_code, channel_id, SUM(amount_usd) AS total FROM fact_fox_daily_payment WHERE ${where} GROUP BY country_code, channel_id` }) },
    { id: "grouped_ratio_cost", name: "query", arguments: JSON.stringify({ sql: `SELECT country_code, channel_id, SUM(cost_usd) AS total FROM fact_fox_daily_payment WHERE ${where} GROUP BY country_code, channel_id` }) },
    { id: "grouped_ratio_align", name: "calculate_session_cells", arguments: JSON.stringify({ align: { op: "divide", keys: ["country_code", "channel_id"], left: { resource_id: ids[0] ?? "", cell: "total" }, right: { resource_id: ids[1] ?? "", cell: "total" } } }) },
    { id: "grouped_ratio_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "", resource_ids: ids }) },
  ];
}

function alignmentSteps(ids: string[]) {
  const query = (date: string) => `SELECT country_code, SUM(new_users) AS total FROM fact_fox_daily_install WHERE event_date >= '${date}' AND event_date <= '${date}' AND title_id = 'paper_lantern' AND platform = 'ios' AND channel_id = 'mist_ads' GROUP BY country_code`;
  return [
    { id: "align_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "align_first", name: "query", arguments: JSON.stringify({ sql: query("2026-10-06") }) },
    { id: "align_second", name: "query", arguments: JSON.stringify({ sql: query("2026-10-08") }) },
    { id: "align_calculate", name: "calculate_session_cells", arguments: JSON.stringify({ align: { op: "subtract", keys: ["country_code"], left: { resource_id: ids[0] ?? "", cell: "total" }, right: { resource_id: ids[1] ?? "", cell: "total" } } }) },
    { id: "align_transform", name: "calculate_session_cells", arguments: JSON.stringify({ transform: { resource_id: ids[2] ?? "", steps: [
      { op: "filter", column: "result_value", comparison: "lt", value: "0" },
      { op: "sort", keys: [{ column: "result_value", direction: "asc", nulls: "last" }] },
      { op: "group", by: [], aggregates: [{ op: "sum", column: "result_value", as: "negative_total" }] },
    ] } }) },
    { id: "align_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "", resource_ids: ids }) },
  ];
}

function noRecordSteps() {
  return [
    { id: "no_record_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "no_record_query", name: "query", arguments: JSON.stringify({ sql: "SELECT SUM(new_users) AS total FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-12' AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'JP' AND channel_id = 'mist_ads'" }) },
  ];
}

function validJoinSteps(ids: string[]) {
  return [
    { id: "join_fact", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "join_dim", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.dim_fox_title" }) },
    { id: "join_query", name: "query", arguments: JSON.stringify({ sql: "SELECT d.title_name AS label, SUM(f.new_users) AS total FROM fact_fox_daily_install f JOIN dim_fox_title d ON f.title_id = d.title_id WHERE f.event_date >= '2026-10-06' AND f.event_date <= '2026-10-12' AND f.title_id = 'paper_lantern' AND f.platform = 'ios' AND f.country_code = 'JP' AND f.channel_id = 'mist_ads' AND d.title_name = '纸灯' GROUP BY d.title_name ORDER BY d.title_name" }) },
    { id: "join_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "", resource_ids: ids }) },
  ];
}

function joinTransformSteps(ids: string[]) {
  return [
    ...validJoinSteps(ids).slice(0, 3),
    { id: "join_transform", name: "calculate_session_cells", arguments: JSON.stringify({ transform: { resource_id: ids[0] ?? "", steps: [{ op: "group", by: [], aggregates: [{ op: "sum", column: "total", as: "joined_total" }] }] } }) },
    { id: "join_twice", name: "calculate_session_cells", arguments: JSON.stringify({ arithmetic: { op: "add", left: { resource_id: ids[1] ?? "", cell: "joined_total", row: 0 }, right: { resource_id: ids[1] ?? "", cell: "joined_total", row: 0 } } }) },
    { id: "join_final", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", resource_ids: [ids[2] ?? ""] }) },
  ];
}

function derivedAlignmentSteps(ids: string[]) {
  const steps = [{ id: "derived_align_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "derived_align_query", name: "query", arguments: JSON.stringify({ sql: "SELECT country_code, SUM(new_users) AS total FROM fact_fox_daily_install WHERE event_date = '2026-10-06' AND title_id = 'paper_lantern' AND platform = 'ios' AND channel_id = 'mist_ads' GROUP BY country_code" }) }];
  for (const direction of ["asc", "desc"]) steps.push({ id: `derived_sort_${direction}`, name: "calculate_session_cells", arguments: JSON.stringify({ transform: { resource_id: ids[0] ?? "", steps: [{ op: "sort", keys: [{ column: "country_code", direction, nulls: "last" }] }] } }) });
  steps.push({ id: "derived_align", name: "calculate_session_cells", arguments: JSON.stringify({ align: { op: "divide", keys: ["country_code"], left: { resource_id: ids[1] ?? "", cell: "total" }, right: { resource_id: ids[2] ?? "", cell: "total" } } }) });
  steps.push({ id: "derived_align_final", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", resource_ids: [ids[3] ?? ""] }) });
  return steps;
}

function validChannelJoinSteps(ids: string[]) {
  return [
    { id: "join_channel_fact", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "join_channel_dim", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.dim_fox_channel" }) },
    { id: "join_channel_query", name: "query", arguments: JSON.stringify({ sql: "SELECT d.channel_name AS label, SUM(f.new_users) AS total FROM fact_fox_daily_install f JOIN dim_fox_channel d ON f.channel_id = d.channel_id WHERE f.event_date >= '2026-10-06' AND f.event_date <= '2026-10-12' AND f.title_id = 'paper_lantern' AND f.platform = 'ios' AND f.country_code = 'JP' AND f.channel_id = 'mist_ads' AND d.channel_name = '雾帆' GROUP BY d.channel_name ORDER BY d.channel_name" }) },
    { id: "join_channel_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "", resource_ids: ids }) },
  ];
}

function decimalSteps(ids: string[]) {
  const query = (day: string) => `SELECT SUM(amount_usd) AS total FROM fact_fox_daily_payment WHERE event_date >= '${day}' AND event_date <= '${day}' AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'US' AND channel_id = 'mist_ads'`;
  return [
    { id: "decimal_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_payment" }) },
    { id: "decimal_first", name: "query", arguments: JSON.stringify({ sql: query("2026-10-06") }) },
    { id: "decimal_second", name: "query", arguments: JSON.stringify({ sql: query("2026-10-08") }) },
    { id: "decimal_subtract", name: "calculate_session_cells", arguments: JSON.stringify({ arithmetic: { op: "subtract", left: { resource_id: ids[0] ?? "", cell: "total" }, right: { resource_id: ids[1] ?? "", cell: "total" } } }) },
    { id: "decimal_divide", name: "calculate_session_cells", arguments: JSON.stringify({ arithmetic: { op: "divide", left: { resource_id: ids[2] ?? "", cell: "result" }, right: { resource_id: ids[1] ?? "", cell: "total" } } }) },
    { id: "decimal_analysis", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "", resource_ids: ids, comparisons: [{ left: { resource_id: ids[0] ?? "", cell: "total" }, right: { resource_id: ids[1] ?? "", cell: "total" } }] }) },
  ];
}

function scripted(turn: ProtocolMessage[], steps: (ids: string[]) => Array<{ id: string; name: string; arguments: string }>): { id: string; name: string; arguments: string } | null {
  if (turn.some((message) => message.role === "assistant" && message.tool_calls?.some((call) => call.function?.name === "update_analysis"))) return null;
  const results = turn.filter((message) => message.role === "tool");
  const resultText = results.map(messageText).join("\n");
  if (resultText.includes('"ok":false')) {
    return { id: "call_stop", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "failed", draft_answer: "查询没有成功，草稿里的 99999 不能采用。", resource_ids: [] }) };
  }
  const ids = [...resultText.matchAll(/resource_id[=:]"?(res_[0-9a-f-]{36})/g)].map((match) => match[1] ?? "");
  const planned = steps(ids);
  return planned[results.length] ?? null;
}

function scriptedAllowError(turn: ProtocolMessage[], unresolved: boolean): { id: string; name: string; arguments: string } | null {
  const results = turn.filter((message) => message.role === "tool");
  const resultText = results.map(messageText).join("\n");
  const ids = [...resultText.matchAll(/resource_id[=:]"?(res_[0-9a-f-]{36})/g)].map((match) => match[1] ?? "");
  const contract = { id: "retry_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) };
  const invalid = { id: "retry_invalid", name: "query", arguments: JSON.stringify({ sql: "SELECT (" }) };
  const valid = { id: "retry_valid", name: "query", arguments: JSON.stringify({ sql: "SELECT event_date, new_users FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-08' AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'US' AND channel_id = 'mist_ads'" }) };
  const calculate = { id: "retry_calculate", name: "calculate_session_cells", arguments: JSON.stringify({ resource_id: ids[0] ?? "", operations: [{ op: "sum", column: "new_users", as: "total" }] }) };
  return (unresolved ? [contract, valid, invalid] : [contract, invalid, valid, calculate])[results.length] ?? null;
}

/** Replay C exactly: the identical query fails before a contract read, then succeeds. */
function scriptedContractRecovery(turn: ProtocolMessage[]): { id: string; name: string; arguments: string } | null {
  const results = turn.filter(message => message.role === "tool");
  const ids = [...results.map(messageText).join("\n").matchAll(/resource_id[=:]"?(res_[0-9a-f-]{36})/g)].map(match => match[1] ?? "");
  const steps = rawSingleComparisonSteps(ids);
  const query = steps[1]!;
  return [{ ...query, id: "missing_contract_query" }, steps[0]!, query, ...steps.slice(2)][results.length] ?? null;
}

/** Fixed protocol replay of the actual F SQL; it does not simulate autonomous planning. */
function scriptedRealF(turn: ProtocolMessage[], mode: "join" | "separate"): { id: string; name: string; arguments: string } | null {
  const results = turn.filter(message => message.role === "tool");
  const ids: string[] = [];
  for (const message of results) {
    try {
      const value = JSON.parse(messageText(message)) as Record<string, unknown>;
      if (value.ok === false) return { id: "f_failed", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "failed", resource_ids: [] }) };
      if (typeof value.resource_id === "string") ids.push(value.resource_id);
    } catch { throw new Error("invalid_real_f_protocol_fixture"); }
  }
  const steps = [
    { id: "f_fact_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "f_dimension_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.dim_fox_title" }) },
    { id: "f_query", name: "query", arguments: JSON.stringify({ sql: mode === "join" ? REAL_F_JOIN_SQL : REAL_F_FACT_SQL }) },
    ...(mode === "separate" ? [{ id: "f_name_query", name: "query", arguments: JSON.stringify({ sql: "SELECT title_id, title_name FROM dim_fox_title WHERE title_id = 'paper_lantern'" }) }] : []),
    { id: "f_calculate", name: "calculate_session_cells", arguments: JSON.stringify({ resource_id: ids[0] ?? "", operations: [{ op: "sum", column: "new_users_sum", as: "total_users" }] }) },
    { id: "f_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", resource_ids: mode === "join" ? [ids[1] ?? ""] : [ids[2] ?? "", ids[1] ?? ""] }) },
  ];
  return steps[results.length] ?? null;
}

function independentDimensionSteps(ids: string[]) {
  return [
    { id: "dimension_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.dim_fox_title" }) },
    { id: "dimension_query", name: "query", arguments: JSON.stringify({ sql: "SELECT title_id, title_name FROM dim_fox_title ORDER BY title_id" }) },
    { id: "dimension_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", resource_ids: [ids[0] ?? ""] }) },
  ];
}

function acceptanceJoinSteps(ids: string[]) {
  return [
    { id: "acceptance_fact_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "acceptance_dimension_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.dim_fox_title" }) },
    { id: "acceptance_join_query", name: "query", arguments: JSON.stringify({ sql: "SELECT t.title_id AS title_id, t.title_name AS title_name, SUM(f.new_users) AS new_users_sum, COUNT(f.new_users) AS rows_non_null, countIf(f.new_users IS NULL) AS rows_null FROM fact_fox_daily_install AS f JOIN dim_fox_title AS t ON f.title_id = t.title_id WHERE f.event_date >= toDate('2026-10-06') AND f.event_date <= toDate('2026-10-12') AND f.country_code = 'JP' AND f.platform = 'ios' AND f.channel_id = 'mist_ads' AND t.title_id = 'paper_lantern' GROUP BY t.title_id, t.title_name" }) },
    { id: "acceptance_join_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", resource_ids: [ids[0] ?? ""] }) },
  ];
}

/** Replay the observed failure shape: a correct contract hash accompanied by
 * a paraphrase falsely presented as an exact quote, then an explicit repair. */
function scriptedExcerptRecovery(turn: ProtocolMessage[]): { id: string; name: string; arguments: string } | null {
  const results = turn.filter((message) => message.role === "tool");
  const resultText = results.map(messageText).join("\n");
  const ids = [...resultText.matchAll(/resource_id[=:]"?(res_[0-9a-f-]{36})/g)].map((match) => match[1] ?? "");
  let hash = "";
  try { hash = String((JSON.parse(messageText(results[0]!)) as { content_hash?: string }).content_hash ?? ""); } catch { /* malformed fixture fails closed */ }
  let calc: { resource_id?: string; execution_id?: string } = {};
  try { calc = JSON.parse(messageText(results[4]!)) as typeof calc; } catch { /* malformed fixture fails closed */ }
  const note = { scope: "合成纸灯单日收入与成本", grain: "日", expected_group_keys: [], unresolved_questions: [] };
  const steps = [
    sameResourceComparisonSteps(ids)[0]!,
    { id: "bad_excerpt", name: "update_analysis", arguments: JSON.stringify({ ...note, source_excerpts: [{ asset_id: "contract.fact_fox_daily_payment", content_hash: hash, quote: "并非原文的伪造合成摘录" }] }) },
    { id: "corrected_excerpt", name: "update_analysis", arguments: JSON.stringify({ ...note, source_excerpts: [] }) },
    ...sameResourceComparisonSteps(ids).slice(1, 3),
    { id: "bad_cell", name: "update_analysis", arguments: JSON.stringify({ ...note, result_cells: [{ resource_id: calc.resource_id, execution_id: calc.execution_id, row: 0, column: "difference" }] }) },
    { id: "corrected_cell", name: "update_analysis", arguments: JSON.stringify({ ...note, result_cells: [] }) },
  ];
  return steps[results.length] ?? null;
}

function defaultSteps(ids: string[]) {
  const steps = [
    { id: "call_search", name: "search_assets", arguments: JSON.stringify({ query: "新增用户" }) },
    { id: "call_read", name: "read_assets", arguments: JSON.stringify({ asset_ids: ["metric.new_users"] }) },
    { id: "call_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    {
      id: "call_query",
      name: "query",
      arguments: JSON.stringify({
        sql: "SELECT event_date, title_id, platform, country_code, channel_id, new_users FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-12' AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'US' AND channel_id = 'mist_ads'",
        purpose: "installs",
      }),
    },
    {
      id: "call_calc",
      name: "calculate_session_cells",
      arguments: JSON.stringify({
        resource_id: ids[0] ?? "",
        operations: [
          { op: "sum", column: "new_users", predicted: "actual_only", as: "new_users_sum" },
          { op: "count_null", column: "new_users", predicted: "actual_only", as: "new_users_missing" },
          { op: "count_zero", column: "new_users", predicted: "actual_only", as: "new_users_zero" },
        ],
      }),
    },
    {
      id: "call_update",
      name: "update_analysis",
      arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "模型草稿不是答案。", resource_ids: ids }),
    },
  ];
  return steps;
}

function glassSteps(ids: string[]) {
  return [
    { id: "call_search", name: "search_assets", arguments: JSON.stringify({ query: "新增用户" }) },
    { id: "call_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "call_query", name: "query", arguments: JSON.stringify({ sql: "SELECT event_date, title_id, platform, country_code, channel_id, new_users FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-12' AND title_id = 'glass_minnow' AND platform = 'ios' AND country_code = 'DE' AND channel_id = 'mist_ads'", purpose: "glass" }) },
    { id: "call_calc", name: "calculate_session_cells", arguments: JSON.stringify({ resource_id: ids[0] ?? "", operations: [{ op: "sum", column: "new_users", as: "glass_de_new_users" }, { op: "count_zero", column: "new_users", as: "glass_de_zeros" }] }) },
    { id: "call_update", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "草稿写成 99999。", resource_ids: ids, findings: [{ label: "玻璃鲦德国新增", value: 48, kind: "actual", resource_id: ids[1] ?? "", cell: "glass_de_new_users", group: { title_id: "glass_minnow", country_code: "DE" }, time_range: { start: "2026-10-06", end: "2026-10-12" } }] }) },
  ];
}

function japanSteps(ids: string[]) {
  return [
    { id: "call_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "call_query", name: "query", arguments: JSON.stringify({ sql: "SELECT event_date, title_id, platform, country_code, channel_id, new_users FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-12' AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'JP' AND channel_id = 'mist_ads'", purpose: "japan" }) },
    { id: "call_calc", name: "calculate_session_cells", arguments: JSON.stringify({ resource_id: ids[0] ?? "", operations: [{ op: "sum", column: "new_users", as: "jp_new_users" }] }) },
    { id: "call_update", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "日本雾帆。", resource_ids: ids, findings: [{ label: "日本雾帆新增", value: 70, kind: "actual", resource_id: ids[1] ?? "", cell: "jp_new_users", group: { country_code: "JP" }, time_range: { start: "2026-10-06", end: "2026-10-12" } }] }) },
  ];
}

function shortJapanSteps(ids: string[]) {
  return [
    { id: "call_contract", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "call_query", name: "query", arguments: JSON.stringify({ sql: "SELECT event_date, title_id, platform, country_code, channel_id, new_users FROM fact_fox_daily_install WHERE event_date >= '2026-10-06' AND event_date <= '2026-10-08' AND title_id = 'paper_lantern' AND platform = 'ios' AND country_code = 'JP' AND channel_id = 'mist_ads'", purpose: "japan-short" }) },
    { id: "call_calc", name: "calculate_session_cells", arguments: JSON.stringify({ resource_id: ids[0] ?? "", operations: [{ op: "sum", column: "new_users", as: "jp_short_new_users" }] }) },
    { id: "call_update", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "日本雾帆短日期。", resource_ids: ids, findings: [{ label: "日本雾帆新增", value: 30, kind: "actual", resource_id: ids[1] ?? "", cell: "jp_short_new_users", group: { country_code: "JP" }, time_range: { start: "2026-10-06", end: "2026-10-08" } }] }) },
  ];
}

function unsafeJoinSteps(): Array<{ id: string; name: string; arguments: string }> {
  return [
    { id: "call_contract_i", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_daily_install" }) },
    { id: "call_contract_r", name: "read_data_contract_view", arguments: JSON.stringify({ asset_id: "contract.fact_fox_ad_receipt" }) },
    { id: "call_query", name: "query", arguments: JSON.stringify({ sql: "SELECT i.event_date, i.new_users, r.revenue_usd, r.is_predicted FROM fact_fox_daily_install AS i JOIN fact_fox_ad_receipt AS r ON i.event_date = r.event_date AND i.title_id = r.title_id AND i.platform = r.platform AND i.country_code = r.country_code WHERE i.event_date >= '2026-10-06' AND i.event_date <= '2026-10-12' AND r.event_date >= '2026-10-06' AND r.event_date <= '2026-10-12' AND i.title_id = 'paper_lantern' AND i.platform = 'ios' AND i.country_code = 'US'", purpose: "unsafe-join" }) },
  ];
}

function clarifySteps(): Array<{ id: string; name: string; arguments: string }> {
  return [
    { id: "call_update", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "needs_clarification", draft_answer: "也许是 99999。", clarification_question: "请补充产品、地区、平台、渠道和封闭日期。", resource_ids: [] }) },
  ];
}

function badCall(body: string): { id: string; name: string; arguments: string } {
  if (body.includes('"role":"tool"')) {
    return { id: "call_bad_stop", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "failed", draft_answer: "参数不合法。", resource_ids: [] }) };
  }
  return { id: "call_bad", name: "query", arguments: JSON.stringify({ sql: "DROP TABLE fact_fox_daily_install", purpose: "bad" }) };
}

function writeTextStream(response: ServerResponse, includeUsage = false, cacheHitTokens = 0, text = "没有用量。"): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify(chunkFrame({ role: "assistant", content: text }))}\n\n`);
  const done: Record<string, unknown> = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
  if (includeUsage) done.usage = { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30, prompt_cache_hit_tokens: cacheHitTokens };
  response.write(`data: ${JSON.stringify(done)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function writeToolStream(response: ServerResponse, call: { id: string; name: string; arguments: string }, includeUsage: boolean, thinking = false, cacheHitTokens = 0): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const midpoint = Math.max(1, Math.floor(call.arguments.length / 2));
  const frames = [
    chunkFrame({ role: "assistant", content: "" }),
    ...(thinking ? [chunkFrame({ reasoning_content: "合成推理片段。" })] : []),
    chunkFrame(toolDelta(call.id, call.name, "")),
    chunkFrame(toolDelta(call.id, undefined, call.arguments.slice(0, midpoint))),
    chunkFrame(toolDelta(call.id, undefined, call.arguments.slice(midpoint))),
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], ...(includeUsage ? { usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30, prompt_cache_hit_tokens: cacheHitTokens } } : {}) },
  ];
  for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function toolDelta(id: string, name: string | undefined, args: string) {
  return {
    tool_calls: [
      {
        index: 0,
        id,
        type: "function",
        function: { ...(name ? { name } : {}), arguments: args },
      },
    ],
  };
}

function chunkFrame(delta: Record<string, unknown>) {
  return { id: "chatcmpl-local", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] };
}
