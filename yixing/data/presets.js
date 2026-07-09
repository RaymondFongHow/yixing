/*
 * presets —— 两个默认模板（起点，可自由改动）
 *
 * 见 docs/card-composition-model.md：
 * - fri-night-arrival（周五晚到）
 * - sat-morning-arrival（周六早到）
 *
 * 结构与 app.js 的日历模型一致：days 是每天的有序卡片队列
 * （时间由页面按时长与交通自动排），stays 是 Day 1/2 的住宿位。
 *
 * 可重复卡（repeatable）要在一份行程里出现多次，需用「实例 id」= 基础 id + "~" + 任意后缀
 * （如 yixing-station~arr / ~ret）。app.js 的 baseId() 会去掉 "~…" 还原成基础卡。
 */

window.YX = window.YX || {};

window.YX.presets = [
  {
    id: "fri-night-arrival",
    title: "示例 · 周五晚到",
    format: "fri",
    note: "周五晚上高铁到，先简单吃一碗，第二天进丁蜀线。",
    days: {
      arrival: ["yixing-station~arr", "noodle-shop"],
      d1: ["shushan-old-street", "zisha-workshop", "yibang-dinner"],
      d2: ["tea-fields", "free-time-saboteur~a", "dongjiu-lake"],
      d3: ["taoerchang", "yixing-station~ret"]
    },
    stays: { d1: "stay-center", d2: "stay-dingshu-lake" }
  },
  {
    id: "sat-morning-arrival",
    title: "示例 · 周六早到",
    format: "sat",
    note: "周六早上高铁到，放下行李直接进丁蜀。第二晚住宿留白待讨论。",
    days: {
      d1: ["yixing-station~arr", "shushan-old-street", "taoerchang", "yibang-dinner"],
      d2: ["bamboo-sea", "shanjuan-cave", "free-time-saboteur~a"],
      d3: ["dongjiu-lake", "noodle-shop", "yixing-station~ret"]
    },
    stays: { d1: "stay-center", d2: null }
  },
  {
    id: "caves-and-nightview",
    title: "示例 · 溶洞与夜景",
    format: "sat",
    note: "周六早高铁到，上午陶博馆避暑、下午善卷洞、傍晚龙背山看夜景；周日竹海配张公洞。",
    days: {
      d1: ["yixing-station~arr", "ceramics-museum", "shanjuan-cave", "longbeishan-forest-park"],
      d2: ["bamboo-sea", "zhanggong-cave"],
      d3: ["yixing-station~ret"]
    },
    stays: { d1: "stay-center", d2: "stay-center" }
  }
];
