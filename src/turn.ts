import { readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./config.js";
import type { MetricName, Slots, TurnIntent, TurnKind, TurnResolution, WarehouseBinding } from "./types.js";

const DATE_RANGE = /(\d{4}-\d{2}-\d{2})\D+(\d{4}-\d{2}-\d{2})/;

interface NamedTerm {
  id: string;
  terms: string[];
  contracts?: string[];
  warehouse?: WarehouseBinding;
}

interface SemanticsFile {
  default_game: Slots["game"];
  sensitive_window: { start: string; end: string };
  products: NamedTerm[];
  platforms: NamedTerm[];
  countries: NamedTerm[];
  channels: NamedTerm[];
  group_by: NamedTerm[];
  compare_terms: string[];
  metrics: NamedTerm[];
  unsupported_terms: string[];
  sensitive_terms: string[];
  unauthorized_terms: string[];
  retention_terms: string[];
  performance_assets: string[];
  sensitive_contract: string;
  unauthorized_contract: string;
}

const semanticsCache = new Map<string, SemanticsFile>();
let semantics = loadSemantics(path.join(repoRoot(), "knowledge", "lumenfox"));

function loadSemantics(dir: string): SemanticsFile {
  const cached = semanticsCache.get(dir);
  if (cached) return cached;
  const loaded = JSON.parse(readFileSync(path.join(dir, "semantics.json"), "utf8")) as SemanticsFile;
  semanticsCache.set(dir, loaded);
  return loaded;
}

function hasTerm(text: string, term: string): boolean {
  if (/^[a-z0-9]+$/iu.test(term) && term.length <= 4) return new RegExp(`\\b${term}\\b`, "iu").test(text);
  return text.toLowerCase().includes(term.toLowerCase());
}

function firstId(text: string, items: NamedTerm[]): string | undefined {
  return items.find((item) => item.terms.some((term) => hasTerm(text, term)))?.id;
}

function anyTerm(text: string, terms: string[]): boolean {
  return terms.some((term) => hasTerm(text, term));
}

function extract(text: string): Partial<Slots> & { metrics?: Slots["metrics"] } {
  const positive = text
    .replace(/不是美国/gu, "")
    .replace(/不是日本/gu, "")
    .replace(/不是德国/gu, "")
    .replace(/不是安卓/gu, "")
    .replace(/不是苹果/gu, "")
    .replace(/不是\s*ios/giu, "")
    .replace(/不是\s*android/giu, "");
  const slots: Partial<Slots> = {};
  const game = firstId(positive, semantics.products);
  if (game) slots.game = game;
  const platform = firstId(positive, semantics.platforms);
  if (platform) slots.platform = platform;
  const country = firstId(positive, semantics.countries);
  if (country) slots.country = country;
  const channel = firstId(positive, semantics.channels);
  if (channel) slots.channel = channel;
  const group = firstId(text, semantics.group_by);
  if (group === "channel" || group === "platform" || group === "country" || group === "product") slots.group_by = group;
  if (anyTerm(text, semantics.compare_terms)) slots.compare = "previous_period";
  const dates = text.match(DATE_RANGE);
  if (dates?.[1] && dates[2]) {
    slots.start = dates[1];
    slots.end = dates[2];
  }
  const metrics = semantics.metrics.filter((item) => item.terms.some((term) => hasTerm(text, term))).map((item) => item.id as MetricName);
  if (metrics.length) slots.metrics = [...new Set(metrics)];
  return slots;
}

function classify(text: string, hasPrevious: boolean): TurnKind {
  if (/换成|改问|另外看|换个话题|留存/.test(text)) return "topic_switch";
  if (/不对|不是|改成|纠正|应该是/.test(text)) return "correction";
  if (hasPrevious && text.trim().length <= 40 && /那|呢|同样|继续|也看|安卓|android|苹果|\bios\b/i.test(text)) {
    return "follow_up";
  }
  return "new_question";
}

function intentOf(text: string): TurnIntent {
  if (anyTerm(text, semantics.unsupported_terms)) return "unsupported";
  if (anyTerm(text, semantics.sensitive_terms)) return "sensitive";
  if (anyTerm(text, semantics.unauthorized_terms)) return "unauthorized";
  if (anyTerm(text, semantics.retention_terms)) return "retention_missing";
  return "performance";
}

function definedSlots(extracted: Partial<Slots>): Partial<Slots> {
  const next: Partial<Slots> = {};
  if (extracted.game) next.game = extracted.game;
  if (extracted.platform) next.platform = extracted.platform;
  if (extracted.country) next.country = extracted.country;
  if (extracted.channel) next.channel = extracted.channel;
  if (extracted.group_by) next.group_by = extracted.group_by;
  if (extracted.compare) next.compare = extracted.compare;
  if (extracted.start) next.start = extracted.start;
  if (extracted.end) next.end = extracted.end;
  if (extracted.metrics) next.metrics = extracted.metrics;
  return next;
}

export function resolveTurn(previous: Slots | null, rawText: string, knowledgeDir?: string): TurnResolution {
  const previousSemantics = semantics;
  if (knowledgeDir) semantics = loadSemantics(knowledgeDir);
  try {
    return resolveTurnNow(previous, rawText);
  } finally {
    semantics = previousSemantics;
  }
}

function resolveTurnNow(previous: Slots | null, rawText: string): TurnResolution {
  const text = rawText.trim();
  const kind = classify(text, previous !== null);
  const intent = intentOf(text);
  const extracted = definedSlots(extract(text));
  let slots: Slots;
  let inherited: string[] = [];
  let replaced: string[] = [];
  if ((kind === "follow_up" || kind === "correction") && previous) {
    slots = {
      ...previous,
      ...extracted,
      metrics: extracted.metrics ?? previous.metrics,
    };
    replaced = Object.entries(extracted)
      .filter(([key, value]) => previous[key as keyof Slots] !== value)
      .map(([key]) => key);
    if (extracted.metrics && previous.metrics.join() !== extracted.metrics.join()) replaced.push("metrics");
    inherited = ["game", "platform", "country", "channel", "group_by", "compare", "start", "end", "metrics"].filter((key) => {
      if (replaced.includes(key)) return false;
      const value = slots[key as keyof Slots];
      return value !== undefined && !(Array.isArray(value) && value.length === 0);
    });
  } else {
    slots = {
      game: semantics.default_game,
      ...extracted,
      metrics: extracted.metrics ?? (intent === "performance" ? [] : []),
    };
    replaced = Object.keys(extracted);
  }

  if (intent === "sensitive" && !slots.start) {
    slots.start = semantics.sensitive_window.start;
    slots.end = semantics.sensitive_window.end;
  }
  if (slots.compare === "previous_period" && slots.start && slots.end) {
    const previous = previousWindow(slots.start, slots.end);
    slots.previous_start = previous.start;
    slots.previous_end = previous.end;
  }

  const missing: string[] = [];
  if (intent === "performance") {
    if (!slots.start || !slots.end) missing.push("date_range");
    if (!slots.metrics.length) missing.push("metric");
  }

  let clarification: string | null = null;
  if (intent === "unsupported") {
    clarification = "演示模式只做可计算的描述，不会判断原因，也不会自动改投放。请改问新增、收入、成本、回收、ROI、分组或环比，并给出日期范围。";
  } else if (intent === "retention_missing") {
    clarification = "知识库里没有留存的已发布契约。请改问新增、广告收入、成本或 ROI，并给出日期范围。";
  } else if (missing.length) {
    clarification = `请补充：${missing.map(labelOf).join("、")}。当前范围还不能形成只读查询，只识别登记过的产品、地区、平台、渠道、指标和日期。`;
  }

  const performanceAssets = semantics.performance_assets;
  return {
    kind,
    intent,
    raw_text: text,
    slots,
    inherited,
    replaced,
    missing_slots: missing,
    search_query:
      intent === "sensitive"
        ? "玩家 设备"
        : intent === "unauthorized"
          ? "财务流水"
          : intent === "retention_missing"
            ? "留存"
            : "Starlane Drift 新增 广告收入 契约",
    read_asset_ids: intent === "performance" && missing.length === 0 ? performanceAssets : [],
    contract_asset_ids:
      intent === "sensitive"
        ? [semantics.sensitive_contract]
        : intent === "unauthorized"
          ? [semantics.unauthorized_contract]
          : intent === "performance" && missing.length === 0
            ? contractsFor(slots.metrics)
            : [],
    clarification_question: clarification,
    ...warehouseFromSemantics(),
  };
}

function warehouseFromSemantics(): { warehouse?: TurnResolution["warehouse"] } {
  const warehouse: NonNullable<TurnResolution["warehouse"]> = {};
  for (const metric of semantics.metrics) {
    if (!metric.warehouse) continue;
    warehouse[metric.id as MetricName] = metric.warehouse;
  }
  return Object.keys(warehouse).length ? { warehouse } : {};
}

function contractsFor(metrics: MetricName[]): string[] {
  const ids = new Set<string>();
  for (const metric of metrics) {
    for (const contract of semantics.metrics.find((item) => item.id === metric)?.contracts ?? []) ids.add(contract);
  }
  return [...ids];
}

export function passthroughTurn(rawText: string): TurnResolution {
  return {
    kind: "new_question",
    intent: "performance",
    raw_text: rawText.trim(),
    slots: { game: semantics.default_game, metrics: [] },
    inherited: [],
    replaced: [],
    missing_slots: [],
    search_query: "",
    read_asset_ids: [],
    contract_asset_ids: [],
    clarification_question: null,
  };
}

function previousWindow(start: string, end: string): { start: string; end: string } {
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  const days = Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;
  const previousEnd = new Date(startDate.getTime() - 86_400_000);
  const previousStart = new Date(previousEnd.getTime() - (days - 1) * 86_400_000);
  const format = (date: Date) => date.toISOString().slice(0, 10);
  return { start: format(previousStart), end: format(previousEnd) };
}

function labelOf(slot: string): string {
  switch (slot) {
    case "platform":
      return "平台";
    case "country":
      return "国家";
    case "date_range":
      return "封闭的日期范围";
    case "metric":
      return "指标";
    default:
      return slot;
  }
}
