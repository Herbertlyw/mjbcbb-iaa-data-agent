import type { AppConfig } from "./config.js";

export interface CatalogModel {
  id: string;
  provider: string;
  reasoning: string[];
  enabled: true;
  context_window: number | null;
  max_output_tokens: number | null;
  verified_here: boolean;
}

export interface ModelCatalog {
  remote_https_configured: boolean;
  dispatch: "loopback-only";
  tls_verification: "node-default";
  verified_protocols: string[];
  models: CatalogModel[];
}

export interface ModelChoice {
  provider: string;
  modelId: string;
  reasoning: string;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function thinkingLevelMap(levels: string[]): Record<string, string | null> {
  const allowed = new Set(levels);
  return Object.fromEntries(THINKING_LEVELS.map((level) => [level, allowed.has(level) ? level : null]));
}

export function modelCatalog(config: AppConfig): ModelCatalog {
  const models: CatalogModel[] = [];
  if (config.modelMode !== "pi" || config.piProvider === "faux") {
    models.push({
      id: "deterministic-analyst",
      provider: config.piProvider === "faux" ? "faux" : "deterministic",
      reasoning: ["off"],
      enabled: true,
      context_window: config.modelMode === "pi" ? config.fauxContextWindow : null,
      max_output_tokens: null,
      verified_here: false,
    });
  } else if (config.piProvider === "openai-compatible" && config.piModel.trim()) {
    models.push({
      id: config.piModel,
      provider: "openai-compatible",
      reasoning: config.enabledReasoning,
      enabled: true,
      context_window: config.piContextWindow,
      max_output_tokens: config.piMaxOutputTokens,
      // A configured endpoint/model has not itself been verified. Protocol
      // tests of the adapter do not establish the service's capabilities.
      verified_here: false,
    });
  }
  return {
    remote_https_configured: config.allowRemoteHttps,
    dispatch: "loopback-only",
    tls_verification: "node-default",
    verified_protocols: ["pi-ai@1.1.0 openai-completions streamed tool calls, only against http://127.0.0.1"],
    models,
  };
}

export function resolveModelChoice(config: AppConfig, requested?: { modelId?: string; reasoning?: string }): ModelChoice {
  const catalog = modelCatalog(config);
  const modelId = requested?.modelId?.trim() || catalog.models.find((item) => item.enabled)?.id || "";
  const reasoning = requested?.reasoning?.trim() || (catalog.models.find((item) => item.id === modelId)?.reasoning[0] ?? "off");
  const entry = catalog.models.find((item) => item.id === modelId && item.enabled);
  if (!entry) {
    const error = new Error("model_not_enabled");
    error.name = "model_not_enabled";
    throw error;
  }
  if (!entry.reasoning.includes(reasoning)) {
    const error = new Error("reasoning_not_enabled");
    error.name = "reasoning_not_enabled";
    throw error;
  }
  return { provider: entry.provider, modelId, reasoning };
}
