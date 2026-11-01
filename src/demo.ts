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
