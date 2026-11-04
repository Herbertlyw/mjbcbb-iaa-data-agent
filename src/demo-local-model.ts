import { assertDispatchTarget } from "./openai-gateway.js";

/** Configuration only: never probes the endpoint. The caller opts in and
 * the ordinary Pi gateway remains responsible for fencing and budgets. */
export function demoLocalModel(env: NodeJS.ProcessEnv): Record<string, string> {
  const url = env.PI_BASE_URL ?? "";
  const model = env.PI_MODEL?.trim() ?? "";
  // Many loopback-compatible servers do not require auth, while the adapter
  // expects a nonempty bearer value. This is a fictional local placeholder.
  const key = env.PI_API_KEY?.trim() ? env.PI_API_KEY : "local-placeholder";
  const context = Number(env.PI_CONTEXT_WINDOW);
  const output = Number(env.PI_MAX_OUTPUT_TOKENS);
  const reasoning = env.PI_REASONING || "off";
  const levels = (env.PI_ENABLED_REASONING || "off").split(",").map((item) => item.trim()).filter(Boolean);
  try { assertDispatchTarget(url); } catch { throw new Error("本机模型地址必须是带端口的 http://127.0.0.1 URL，且不能包含凭据、查询参数或片段。"); }
  if (!model || model.length > 200 || /[\u0000-\u001f\u007f]/u.test(model) || !Number.isSafeInteger(context) || context < 1 || !Number.isSafeInteger(output) || output < 1 || output > context || !levels.length || levels.some((level) => !["off", "low", "medium", "high"].includes(level)) || !levels.includes(reasoning)) {
    throw new Error("本机模型配置不完整：请在本机设置模型名、窗口、输出上限和受支持的推理档位。");
  }
  return { PI_PROVIDER: "openai-compatible", PI_MODEL: model, PI_API_KEY: key, PI_BASE_URL: url, PI_CONTEXT_WINDOW: String(context), PI_MAX_OUTPUT_TOKENS: String(output), PI_REASONING: reasoning, PI_ENABLED_REASONING: levels.join(","), PI_PROTOCOL_SCRIPT: "" };
}
