import assert from "node:assert/strict";
import test from "node:test";
import { cacheUsageFromMetadata } from "../src/provider-usage-metadata.mjs";

test("缓存用量只来自与已结算输入输出一致的元数据", () => {
  const step = { status: "completed", settlement: "settled", usage_source: "reported", input_tokens: 21, output_tokens: 9 };
  const receipt = { format: "metadata-only", failed: false, usage_source: "reported", input_tokens: 21, output_tokens: 9, cache_hit_tokens: 0, cache_miss_tokens: 21 };
  const check = (data: unknown, source = step) => cacheUsageFromMetadata(typeof data === "string" ? data : JSON.stringify(data), source);
  assert.deepEqual(check(receipt), { cache_hit_tokens: 0, cache_miss_tokens: 21 });
  assert.deepEqual(check({ ...receipt, cache_miss_tokens: null }), { cache_hit_tokens: 0, cache_miss_tokens: null });
  for (const bad of ["not-json", { ...receipt, input_tokens: 20 }, { ...receipt, cache_hit_tokens: 22 }, { ...receipt, cache_hit_tokens: 1 }, { ...receipt, failed: true }]) {
    assert.deepEqual(check(bad), { cache_hit_tokens: null, cache_miss_tokens: null });
  }
  assert.deepEqual(check(receipt, { ...step, settlement: "held_unknown" }), { cache_hit_tokens: null, cache_miss_tokens: null });
  assert.deepEqual(check(receipt, { ...step, usage_source: "simulated" }), { cache_hit_tokens: null, cache_miss_tokens: null });
});
