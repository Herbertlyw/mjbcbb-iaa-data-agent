/** Explicit per-task limits for the disposable local stack. The independent
 * persistent provider ledger remains the cross-task authority. */
export function demoTaskLimits(env: NodeJS.ProcessEnv, deepseek: boolean): { maxCalls: number; maxKnownTokens: number } {
  const maxCalls = Number(env.DEMO_MAX_MODEL_CALLS ?? (deepseek ? "10" : "24"));
  const maxKnownTokens = Number(env.DEMO_MAX_KNOWN_TOKENS ?? (deepseek ? "120000" : "200000"));
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > (deepseek ? 20 : 128)) throw new Error("DEMO_MAX_MODEL_CALLS 超出本机演示允许范围。");
  if (!Number.isSafeInteger(maxKnownTokens) || maxKnownTokens < 1 || maxKnownTokens > 1_000_000) throw new Error("DEMO_MAX_KNOWN_TOKENS 超出本机演示允许范围。");
  return { maxCalls, maxKnownTokens };
}
