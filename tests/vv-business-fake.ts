// Explicit local protocol fixture: follows published recipes and never receives gold.
import { createServer } from "node:http";
import { businessCalculations, businessPreparations, type BusinessInput } from "./vv-business-calculations.js";

export interface BusinessScript {
  id: string;
  text: string;
  recipe: string;
  queries: Array<{ sql: string; table: string; join_dimension?: string }>;
}

/** Replay current-turn recipes through HTTP; this is not language understanding. */
export async function startBusinessFake(cases: BusinessScript[]) {
  const calls: Array<{ scenario: string; tool: string | null }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        if (request.headers.authorization !== "Bearer fictional-vv-protocol") {
          response.writeHead(401).end();
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages: Array<{ role: string; content?: unknown }>;
        };
        const text = (message: { content?: unknown }): string => typeof message.content === "string"
          ? message.content : Array.isArray(message.content)
            ? message.content.map(part => typeof part?.text === "string" ? part.text : "").join("") : "";
        const index = body.messages.findLastIndex(message => message.role === "user");
        const turn = body.messages.slice(index);
        const user = text(turn[0] ?? {});
        const scenario = cases.find(item => user.includes(item.text));
        const replies = turn.filter(message => message.role === "tool").map(message => JSON.parse(text(message)) as Record<string, unknown>);
        const tables = scenario ? [...new Set(scenario.queries.flatMap(query => [query.table, ...(query.join_dimension ? [query.join_dimension] : [])]))] : [];
        const steps = [
          ...tables.map(table => ({ name: "read_data_contract_view", arguments: { asset_id: `contract.${table}` } })),
          ...(scenario?.queries ?? []).map(query => ({ name: "query", arguments: { sql: query.sql, preview_limit: 100 } })),
        ];
        if (replies.some(reply => reply.ok === false)) throw new Error("business_fixture_tool_failed");
        const step = steps[replies.length];
        const inputs = replies.slice(tables.length, steps.length) as unknown as BusinessInput[];
        const preparations = scenario && replies.length >= steps.length ? businessPreparations(scenario.recipe, inputs) : [];
        const prepared = replies.slice(steps.length, steps.length + preparations.length) as unknown as BusinessInput[];
        const calculation = scenario && replies.length >= steps.length + preparations.length
          ? businessCalculations(scenario.recipe, inputs, prepared) : [];
        const pending = preparations.length && replies.length === steps.length
          ? preparations : replies.length === steps.length + preparations.length ? calculation.map(item => item.params) : [];
        calls.push({ scenario: scenario?.id ?? "unmatched", tool: pending.length ? "calculate_session_cells" : step?.name ?? null });
        response.writeHead(200, { "content-type": "text/event-stream" });
        const delta = pending.length ? { role: "assistant", tool_calls: pending.map((params, index) => ({ index,
          id: `vv_${scenario!.id}_math_${replies.length}_${index}`, type: "function", function: { name: "calculate_session_cells", arguments: JSON.stringify(params) } })) }
          : step ? { role: "assistant", tool_calls: [{ index: 0,
          id: `vv_${scenario!.id}_${replies.length}`, type: "function",
          function: { name: step.name, arguments: JSON.stringify(step.arguments) } }] }
          : { role: "assistant", content: scenario?.queries.length
            ? replies.flatMap(reply => typeof reply.resource_id === "string" ? [`[[result:${reply.resource_id}]]`] : []).join(" ")
            : "[[clarify]] 请补充游戏或包体、统计日期及收入来源？" };
        response.write(`data: ${JSON.stringify({ id: "vv-script", object: "chat.completion.chunk", created: 1,
          model: "vv-script", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: step || pending.length ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`);
        response.end("data: [DONE]\n\n");
      } catch {
        if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "scripted VV fixture failed" } }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("vv_fixture_listen_failed");
  return { url: `http://127.0.0.1:${address.port}/v1`, calls,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close(error => error ? reject(error) : resolve());
    }) };
}
