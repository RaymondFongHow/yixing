/*
 * presets —— 两个默认模板（起点，可自由改动）
 *
 * 见 docs/card-composition-model.md：
 * - fri-night-arrival（周五晚到）
 * - sat-morning-arrival（周六早到）
 *
 * 结构与 app.js 的日历模型一致：days 是每天的有序卡片队列
 * （时间由页面按时长与交通自动排），stays 是 Day 1/2 的住宿位。
 */

window.YX = window.YX || {};

window.YX.presets = [
  {
    id: "fri-night-arrival",
    title: "周五晚到",
    note: "周五晚上高铁到，先简单吃一碗，第二天进丁蜀线。",
    days: {
      arrival: ["noodle-shop"],
      d1: ["shushan-old-street", "zisha-workshop", "yibang-dinner"],
      d2: ["tea-fields", "free-time-saboteur", "dongjiu-lake"],
      d3: ["taoerchang"]
    },
    stays: { d1: "stay-center", d2: "stay-dingshu-lake" }
  },
  {
    id: "sat-morning-arrival",
    title: "周六早到",
    note: "周六早上高铁到，放下行李直接进丁蜀。第二晚住宿留白待讨论。",
    days: {
      arrival: ["transport-buffer"],
      d1: ["shushan-old-street", "taoerchang", "yibang-dinner"],
      d2: ["bamboo-sea", "shanjuan-cave", "free-time-saboteur"],
      d3: ["dongjiu-lake", "noodle-shop"]
    },
    stays: { d1: "stay-center", d2: null }
  }
];
