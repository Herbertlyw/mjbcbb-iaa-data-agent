export interface ProviderUsageReceipt {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheHitTokens: number | null;
  cacheMissTokens: number | null;
}

const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Capture only explicit usage fields from streamed Chat Completions frames.
 * No message, knowledge body, headers or credential is retained or logged. */
export interface ProviderUsageObservation { done: Promise<ProviderUsageReceipt | null>; cancel(): void }

export function observeProviderUsage(response: Response): ProviderUsageObservation {
  let copy: Response;
  try { copy = response.clone(); } catch { return { done: Promise.resolve(null), cancel() {} }; }
  if (!copy.body) return { done: Promise.resolve(null), cancel() {} };
  const reader = copy.body.getReader();
  const done = (async () => {
    const decoder = new TextDecoder();
    let pending = "";
    let dropping = false;
    let usage: ProviderUsageReceipt | null = null;
    const line = (value: string) => {
      if (!value.startsWith("data:")) return;
      const data = value.slice(5).trim();
      if (!data || data === "[DONE]") return;
      try {
        const parsed = object(JSON.parse(data));
        const raw = object(parsed?.usage);
        if (!raw) return;
        const detail = object(raw.prompt_tokens_details);
        const next = {
          inputTokens: count(raw.prompt_tokens),
          outputTokens: count(raw.completion_tokens),
          cacheHitTokens: count(raw.prompt_cache_hit_tokens) ?? count(detail?.cached_tokens),
          cacheMissTokens: count(raw.prompt_cache_miss_tokens),
        };
        if (Object.values(next).some((value) => value !== null)) usage = next;
      } catch { /* malformed response is not a usage receipt */ }
    };
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const text = decoder.decode(chunk.value, { stream: true });
        for (const character of text) {
          if (character === "\n") {
            if (!dropping) line(pending.replace(/\r$/u, ""));
            pending = ""; dropping = false;
          } else if (!dropping) {
            pending += character;
            // Ignore an oversized frame rather than buffering arbitrary data.
            if (pending.length > 1_000_000) { pending = ""; dropping = true; }
          }
        }
      }
      if (pending && !dropping) line(pending);
      return usage;
    } catch { return null; }
    finally { reader.releaseLock(); }
  })();
  return { done, cancel() { void reader.cancel().catch(() => {}); } };
}

/** A failed or incomplete response must not leave settlement waiting forever. */
export async function waitForProviderUsage(observation: ProviderUsageObservation, timeoutMs = 1000): Promise<ProviderUsageReceipt | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([observation.done, new Promise<null>((resolve) => { timer = setTimeout(() => { observation.cancel(); resolve(null); }, timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}
