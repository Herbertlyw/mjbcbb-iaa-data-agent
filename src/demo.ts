import { shiftSyntheticDates, syntheticDayShift } from "./synthetic-clock.js";

export const DEMO_QUESTIONS = [
  {
    id: "weekly",
    label: "美国 iOS 一周",
    text: "Starlane Drift 在 2026-10-06 到 2026-10-12（美国、iOS）的新增用户和广告收入怎么样？请把缺失、真实为零和预测值分开。",
  },
  {
    id: "android",
    label: "追问安卓",
    text: "那安卓呢？",
  },
  {
    id: "japan",
    label: "日本 iOS 完整一周",
    text: "Starlane Drift 在 2026-10-06 到 2026-10-12（日本、iOS）的新增用户和广告收入是多少？",
  },
  {
    id: "vague",
    label: "含糊问题",
    text: "看看收入",
  },
  {
    id: "sensitive",
    label: "敏感字段",
    text: "把 2026-10-06 到 2026-10-12 的 Starlane Drift 玩家设备号列出来",
  },
  {
    id: "joined-gap",
    label: "连表对照缺口",
    text: "请把 Starlane Drift 美国 iOS 2026-10-06 到 2026-10-12 的新增和广告收入连表对照。",
  },
  {
    id: "comet-gap",
    label: "彗星渠道缺日期",
    text: "Starlane Drift 美国 iOS 彗星渠道 2026-10-06 到 2026-10-12 的投放成本是多少？",
  },
  {
    id: "retention",
    label: "换成留存",
    text: "换成看留存",
  },
] as const;

const HARBORLIGHT_QUESTIONS = [
  { id: "weekly", label: "纸灯美国新增", text: "纸灯 在 2026-10-06 到 2026-10-12（美国、iOS、雾帆）的新增用户是多少？" },
  { id: "japan", label: "追问日本", text: "那日本呢？" },
  { id: "shorter", label: "更改日期", text: "日期改成 2026-10-06 到 2026-10-08。" },
  { id: "vague", label: "含糊问题", text: "只说看看收入" },
  { id: "title-join", label: "产品关联", text: "合成产品维表关联：统计纸灯日本 iOS 雾帆 2026-10-06 到 2026-10-12 新增。" },
  { id: "channel-join", label: "渠道关联", text: "合成渠道维表关联：统计纸灯日本 iOS 雾帆 2026-10-06 到 2026-10-12 新增。" },
  { id: "ratio", label: "收入／成本", text: "合成收入成本比：2026-10-08 美国 iOS 雾帆的收入除以成本。" },
  { id: "grouped-ratio", label: "多渠道比率", text: "合成多渠道收入成本比：按国家和渠道对齐 2026-10-08 收入与成本。" },
  { id: "alignment", label: "跨期分组变换", text: "合成分组对齐：按国家对照 2026-10-06 与 2026-10-08 的新增，并筛选、排序及求和下降组。" },
  { id: "large-transform", label: "完整分页计算", text: "合成完整分页：统计 2026-10-06 纸灯 Android 雾帆各虚构地区的新增总数。" },
  { id: "thousand-transform", label: "千行完整计算", text: "合成千行完整计算：统计 2026-10-08 玻璃鲦 Android 卵石各虚构地区的新增总数。" },
  { id: "larger-transform", label: "三千六百行计算", text: "合成三千六百行：统计 2026-10-06 到 2026-10-08 玻璃鲦 Android 卵石虚构地区的新增总数。" },
  { id: "cross-fact", label: "跨事实表比率", text: "合成跨事实比率：按国家和渠道比较 2026-10-08 纸灯 iOS 的收入和新增人数。" },
  { id: "raw-cross-fact", label: "明细对齐比率", text: "合成明细跨事实：按国家和渠道对齐 2026-10-08 纸灯收入及新增明细。" },
  { id: "mixed-fact", label: "聚合与明细对齐", text: "合成混合聚合明细：比较 2026-10-08 收入分组与新增明细。" },
  { id: "coarse-payment-join", label: "产品收入和成本", text: "合成粗粒度金额关联：按产品统计 2026-10-06 到 2026-10-08 的收入和成本。" },
  { id: "coarse-channel-join", label: "渠道收入和成本", text: "合成粗粒度渠道关联：按渠道统计 2026-10-08 美国收入和成本。" },
  { id: "coarse-channel-ratio", label: "渠道关联比率", text: "合成渠道关联比率：按渠道比较 2026-10-08 美国收入和成本。" },
  { id: "cte", label: "CTE 查询", text: "合成 CTE 查询：纸灯日本 2026-10-06 到 2026-10-12 新增。" },
  { id: "left-title", label: "未匹配的产品", text: "合成左关联产品：保留 2026-10-06 到 2026-10-12 未匹配产品。" },
  { id: "cte-join", label: "预聚合产品关联", text: "合成 CTE 预聚合关联：日本产品 2026-10-06 到 2026-10-12 新增。" },
  { id: "cte-left", label: "预聚合未匹配", text: "合成 CTE 左关联未匹配：保留 2026-10-06 到 2026-10-12 的虚构产品。" },
  { id: "null-cross", label: "空值跨事实", text: "合成空值跨事实：按地区和渠道比较 2026-10-09 收入和新增的缺失。" },
  { id: "partial-null-cross", label: "部分空值比率", text: "合成部分空值跨事实：比较 2026-10-08 到 2026-10-09 收入和新增。" },
] as const;

export function demoForScenario(harborlight: boolean, fixtureToday?: string) {
  const days = fixtureToday ? syntheticDayShift(fixtureToday) : 0;
  return harborlight
    ? { scenario: "Harborlight", placeholder: "问一个关于纸灯或玻璃鲦的问题", questions: HARBORLIGHT_QUESTIONS.map((question) => ({ ...question, text: shiftSyntheticDates(question.text, days) })) }
    : { scenario: "Lumenfox", placeholder: "问一个关于 Starlane Drift 的问题", questions: DEMO_QUESTIONS };
}
