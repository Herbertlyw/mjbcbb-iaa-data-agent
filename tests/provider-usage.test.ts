import assert from "node:assert/strict";
import test from "node:test";
import { observeProviderUsage, waitForProviderUsage } from "../src/provider-usage.js";

test("SSE 流式用量分别保留实际输入、输出、缓存命中与缺失字段", async () => {
  const encoder = new TextEncoder();
  const text = 'data: {"choices":[{"delta":{"content":"合成"}}]}\n\ndata: {"usage":{"prompt_tokens":42,"completion_tokens":7,"prompt_cache_hit_tokens":0}}\n\ndata: [DONE]\n\n';
  const bytes = encoder.encode(text);
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 37)); controller.enqueue(bytes.slice(37, 79)); controller.enqueue(bytes.slice(79)); controller.close(); } }));
  const observation = observeProviderUsage(response);
  const original = response.text();
  assert.deepEqual(await waitForProviderUsage(observation), { inputTokens: 42, outputTokens: 7, cacheHitTokens: 0, cacheMissTokens: null });
  assert.equal(await original, text, "旁路观察不能消耗或改变提供给 SDK 的流");
});

test("用量缺失、错误响应、格式错误与未结束的流不伪造成零", async () => {
  for (const input of ['data: {"usage":null}\n\ndata: [DONE]\n\n', 'data: {broken}\n\n', '{"error":"fictional"}']) {
    const response = new Response(input);
    const observation = observeProviderUsage(response);
    assert.equal(await waitForProviderUsage(observation), null);
  }
  const pending = new Response(new ReadableStream({ start() {} }));
  const observation = observeProviderUsage(pending);
  assert.equal(await waitForProviderUsage(observation, 20), null);
  void pending.body?.cancel();
});

test("缓存详细字段只接受供应商明示的非负整数", async () => {
  const response = new Response('data: {"usage":{"prompt_tokens":12,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":5},"prompt_cache_miss_tokens":7}}\n\n');
  assert.deepEqual(await waitForProviderUsage(observeProviderUsage(response)), { inputTokens: 12, outputTokens: 3, cacheHitTokens: 5, cacheMissTokens: 7 });
});
