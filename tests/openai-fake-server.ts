import { createServer, type ServerResponse } from "node:http";

export interface ProtocolObservation {
  script: string;
  sawUserText: boolean;
  sawKnowledgeBody: boolean;
  sawSystemPrompt: boolean;
  sawToolDefinition: boolean;
  reasoningEffort: string | null;
  authorizationPresent: boolean;
  authorizationMatched: boolean;
  userMessages: string[];
  currentTurnRoles: string[];
}

export async function startFakeOpenAI(token: string, options: { recordObservations?: boolean } = {}): Promise<{ url: string; observations: ProtocolObservation[]; close: () => Promise<void> }> {
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
      let messages: ProtocolMessage[] = [];
      try {
        const parsed = JSON.parse(body) as { reasoning_effort?: unknown; messages?: ProtocolMessage[] };
        messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        reasoningEffort = typeof parsed.reasoning_effort === "string" ? parsed.reasoning_effort : null;
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
        authorizationPresent: header.length > 0,
        authorizationMatched: matched,
        userMessages: messages.filter((message) => message.role === "user").map(messageText),
        currentTurnRoles: currentTurn(messages).map((message) => message.role),
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
      if (script === "hold") {
        response.writeHead(200, { "content-type": "text/event-stream" });
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
      const plainBody = body.replaceAll("\\", "");
      const holdTurn = plainBody.slice(Math.max(0, plainBody.lastIndexOf("请停住")));
      if (plainBody.includes("请停住") && !holdTurn.includes('"role":"tool"')) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        return;
      }
      const tail = plainBody.slice(-900);
      if (tail.includes("The messages above are") || tail.includes("Create a concise checkpoint")) {
        writeTextStream(response, true);
        return;
      }
      const call = script === "bad-args" ? badCall(body) : happyCall(messages);
      if (!call) {
        writeTextStream(response, true);
        return;
      }
      const turnNumber = messages.filter((message) => message.role === "user").length;
      writeToolStream(response, { ...call, id: `${call.id}_turn${turnNumber}` }, true);
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

interface ProtocolMessage { role: string; content?: unknown; tool_calls?: Array<{ function?: { name?: string } }> }

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
  const hasBase = earlierUsers.some((text) => text.includes("纸灯") && text.includes("美国") && text.includes("iOS") && text.includes("雾帆") && text.includes("2026-10-06") && text.includes("2026-10-12"));
  if (latest.includes("不调用记录")) return scripted(turn, noRecordSteps);
  if (latest.includes("合成收入成本比")) return scripted(turn, ratioSteps);
  if (latest.includes("合成多渠道收入成本比")) return scripted(turn, groupedRatioSteps);
  if (latest.includes("合成分组对齐")) return scripted(turn, alignmentSteps);
  if (latest.includes("合成产品维表关联")) return scripted(turn, validJoinSteps);
  if (latest.includes("合成精确金额")) return scripted(turn, decimalSteps);
  if (latest.includes("玻璃鲦") && latest.includes("德国")) return scripted(turn, glassSteps);
  if (latest.includes("只说看看收入") || (latest.includes("日本") && !hasBase && !latest.includes("纸灯"))) return scripted(turn, clarifySteps);
  if (latest.includes("日期改成") && hasBase && earlierUsers.some((text) => text.includes("日本"))) return scripted(turn, shortJapanSteps);
  if (latest.includes("日本") && (hasBase || latest.includes("雾帆"))) return scripted(turn, japanSteps);
  if (latest.includes("连表")) return scripted(turn, unsafeJoinSteps);
  return scripted(turn, defaultSteps);
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
    { id: "join_query", name: "query", arguments: JSON.stringify({ sql: "SELECT d.title_name AS label, SUM(f.new_users) AS total FROM fact_fox_daily_install f JOIN dim_fox_title d ON f.title_id = d.title_id WHERE f.event_date >= '2026-10-06' AND f.event_date <= '2026-10-12' AND f.title_id = 'paper_lantern' AND f.platform = 'ios' AND f.country_code = 'JP' AND f.channel_id = 'mist_ads' GROUP BY d.title_name ORDER BY d.title_name" }) },
    { id: "join_record", name: "update_analysis", arguments: JSON.stringify({ suggested_status: "completed", draft_answer: "", resource_ids: ids }) },
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

function writeTextStream(response: ServerResponse, includeUsage = false): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify(chunkFrame({ role: "assistant", content: "没有" }))}\n\n`);
  response.write(`data: ${JSON.stringify(chunkFrame({ content: "用量。" }))}\n\n`);
  const done: Record<string, unknown> = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
  if (includeUsage) done.usage = { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 };
  response.write(`data: ${JSON.stringify(done)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function writeToolStream(response: ServerResponse, call: { id: string; name: string; arguments: string }, includeUsage: boolean): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const midpoint = Math.max(1, Math.floor(call.arguments.length / 2));
  const frames = [
    chunkFrame({ role: "assistant", content: "" }),
    chunkFrame(toolDelta(call.id, call.name, "")),
    chunkFrame(toolDelta(call.id, undefined, call.arguments.slice(0, midpoint))),
    chunkFrame(toolDelta(call.id, undefined, call.arguments.slice(midpoint))),
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], ...(includeUsage ? { usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 } } : {}) },
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
