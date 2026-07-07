/*
 * presets —— 两个默认模板（起点，可自由改动）
 *
 * 见 docs/card-composition-model.md：
 * - fri-night-arrival（周五晚到）
 * - sat-morning-arrival（周六早到）
 *
 * 槽位 id 与 app.js 中 SLOTS 一致（30 分钟粒度，形如 d1-1000 = Day 1 10:00）；
 * 留空的槽位是有意的留白。
 */

window.YX = window.YX || {};

window.YX.presets = [
  {
    id: "fri-night-arrival",
    title: "周五晚到",
    note: "周五晚上高铁到，先简单吃一碗，第二天进丁蜀线。",
    slots: {
      "arrival": "noodle-shop",
      "d1-1000": "shushan-old-street",
      "d1-1400": "zisha-workshop",
      "d1-1800": "yibang-dinner",
      "stay1": "stay-center",
      "d2-0800": "tea-fields",
      "d2-1400": "free-time-saboteur",
      "d2-1800": "dongjiu-lake",
      "stay2": "stay-dingshu-lake",
      "d3-0800": "taoerchang",
      "return": null
    }
  },
  {
    id: "sat-morning-arrival",
    title: "周六早到",
    note: "周六早上高铁到，放下行李直接进丁蜀。第二晚住宿留白待讨论。",
    slots: {
      "arrival": "transport-buffer",
      "d1-1000": "shushan-old-street",
      "d1-1400": "taoerchang",
      "d1-1800": "yibang-dinner",
      "stay1": "stay-center",
      "d2-0800": "bamboo-sea",
      "d2-1400": "shanjuan-cave",
      "d2-1800": "free-time-saboteur",
      "stay2": null,
      "d3-0800": "dongjiu-lake",
      "return": "noodle-shop"
    }
  }
];
