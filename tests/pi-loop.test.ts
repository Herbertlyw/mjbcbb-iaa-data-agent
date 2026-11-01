import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createDeterministicStream, ensureAgent } from "../src/agent.js";
import { ask, analyst, withRuntime } from "./helpers.js";
import { DEMO_QUESTIONS } from "../src/demo.js";

test("演示模式经过 Pi SDK 的多轮工具调用，失败和取消会回到下一轮", async () => {
  const faux = fauxProvider({
    provider: "lumenfox-local",
    api: "faux",
    models: [{ id: "deterministic-analyst", name: "Deterministic local analyst", input: ["text"] }],
    tokenSize: { min: 100000, max: 100000 },
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const calls: string[] = [];
  const step: FauxResponseFactory = (context) => {
    faux.appendResponses([step]);
    calls.push("model");
    let start = 0;
    context.messages.forEach((message, index) => {
      if (message.role === "user") start = index + 1;
    });
    const user = [...context.messages].reverse().find((message) => message.role === "user");
    const rawContent = user && "content" in user ? user.content : "";
    const userText = typeof rawContent === "string"
      ? rawContent
      : Array.isArray(rawContent)
        ? rawContent.map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : "")).join("")
        : "";
    const toolMessages = context.messages.slice(start).filter((message) => message.role === "toolResult");
    if (userText.includes("取消")) {
      if (toolMessages.length === 0) return fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" });
      return fauxAssistantMessage("取消后的回答", { stopReason: "stop" });
    }
    if (toolMessages.length === 0) return fauxAssistantMessage([fauxToolCall("broken", { n: "bad" })], { stopReason: "toolUse" });
    const latest = toolMessages.at(-1);
    if (latest && "isError" in latest && latest.isError === true && latest.toolName === "broken") {
      return fauxAssistantMessage([fauxToolCall("failing", {})], { stopReason: "toolUse" });
    }
    if (latest && latest.toolName === "failing") return fauxAssistantMessage("工具失败已进入下一轮回答", { stopReason: "stop" });
    return fauxAssistantMessage("意外轮次", { stopReason: "stop" });
  };
  faux.setResponses([step]);
  let executed = 0;
  const agent = new Agent({
    initialState: {
      systemPrompt: "测试",
      model: faux.getModel(),
      tools: [
        {
          name: "broken",
          label: "坏参数",
          description: "只接受数字",
          parameters: Type.Object({ n: Type.Number() }),
          execute: async () => {
            executed += 1;
            return { content: [{ type: "text", text: "不应执行" }], details: {} };
          },
        },
        {
          name: "failing",
          label: "失败",
          description: "总是失败",
          parameters: Type.Object({}),
          execute: async () => ({ content: [{ type: "text", text: "失败" }], details: { code: "tool_failed" }, isError: true }),
        },
        {
          name: "slow",
          label: "慢",
          description: "等待取消",
          parameters: Type.Object({}),
          execute: async (_id, _params, signal) => {
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, 5000);
              signal?.addEventListener("abort", () => {
                clearTimeout(timer);
                resolve(undefined);
              });
            });
            return { content: [{ type: "text", text: signal?.aborted ? "已取消" : "完成" }], details: {}, isError: signal?.aborted === true };
          },
        },
      ],
    },
    streamFn: models.streamSimple.bind(models),
    toolExecution: "sequential",
  });
  const events: string[] = [];
  agent.subscribe((event) => {
    if (event.type === "tool_execution_start") events.push(`start:${event.toolName}`);
    if (event.type === "tool_execution_end") events.push(`end:${event.toolName}:${event.isError ? "error" : "ok"}`);
    if (event.type === "message_end" && event.message.role === "assistant") {
      const text = event.message.content.filter((block) => block.type === "text").map((block) => (block.type === "text" ? block.text : "")).join("");
      if (text) events.push(`assistant:${text}`);
    }
  });
  await agent.prompt("先失败再回答");
  assert.ok(faux.state.callCount >= 3);
  assert.deepEqual(calls.slice(0, 3), ["model", "model", "model"]);
  assert.equal(executed, 0);
  assert.deepEqual(events, ["start:broken", "end:broken:error", "start:failing", "end:failing:error", "assistant:工具失败已进入下一轮回答"]);

  const cancelEvents: string[] = [];
  agent.subscribe((event) => {
    if (event.type === "tool_execution_end" && event.toolName === "slow") cancelEvents.push(event.isError ? "cancelled" : "finished");
  });
  const pending = agent.prompt("请取消");
  setTimeout(() => agent.abort(), 30);
  await pending;
  assert.deepEqual(cancelEvents, ["cancelled"]);
});

test("生产演示走 faux，真实 Pi 模式没有密钥时不会访问外部模型", async () => {
  const stream = createDeterministicStream();
  assert.equal(stream.model.provider, "lumenfox-local");
  assert.equal(stream.model.id, "deterministic-analyst");
  await withRuntime({}, async (runtime) => {
    const session = analyst(runtime);
    const job = await ask(runtime, session.session_id, DEMO_QUESTIONS[2].text);
    const names = job.events.filter((event) => event.type === "tool_started").map((event) => event.payload.tool_name);
    assert.ok(names.indexOf("search_assets") < names.indexOf("query"));
    assert.ok(names.indexOf("query") < names.indexOf("update_analysis"));
    assert.equal(job.status, "completed");
    const bare = analyst(runtime);
    await assert.rejects(() => ensureAgent(bare, runtime.tools, { ...runtime.config, modelMode: "pi", piApiKey: "" }));
  });
});
