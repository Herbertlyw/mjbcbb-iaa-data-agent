/** Return only cache counts belonging to the same settled usage receipt. */
export function cacheUsageFromMetadata(body, step) {
  const missing = { cache_hit_tokens: null, cache_miss_tokens: null };
  if (typeof body !== "string" || step.status !== "completed" || step.settlement !== "settled") return missing;
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value) || value.format !== "metadata-only" || value.failed !== false || !["reported", "simulated"].includes(step.usage_source) || value.usage_source !== step.usage_source || step.input_tokens == null || step.output_tokens == null || value.input_tokens !== Number(step.input_tokens) || value.output_tokens !== Number(step.output_tokens)) return missing;
    const count = (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
    const hit = count(value.cache_hit_tokens), miss = count(value.cache_miss_tokens), input = count(value.input_tokens);
    if (input === null || (hit !== null && hit > input) || (miss !== null && miss > input) || (hit !== null && miss !== null && hit + miss > input)) return missing;
    return { cache_hit_tokens: hit, cache_miss_tokens: miss };
  } catch { return missing; }
}
