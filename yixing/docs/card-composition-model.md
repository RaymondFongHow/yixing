# 卡片拼配模型

这个项目第一版不做固定行程安排。页面的核心交互是把宜兴的地点、体验、餐饮、住宿和自由时间做成卡片，让朋友自己拖拽拼配，再由页面即时反馈交通时间、主题切换、热度风险、预约需求和动线是否顺。

## 产品定位

- 不是旅游攻略页。
- 不是死行程页。
- 是一个静态、轻量、可拖拽的旅行拼配工具。
- 可以内置示例 preset，但 preset 不能替代卡片池。
- 用户应能从卡片池里自由组合，而不是只阅读一条排好的路线。
- 旅行保持灵活，空档、休息、临时玩 Saboteur / 打牌都应被允许。

## 卡片类型

| Type | 含义 | 是否可拖拽 |
| --- | --- | --- |
| `place` | 景点或空间 | 是 |
| `experience` | 手作、茶、骑行、工作室探访等体验 | 是 |
| `food` | 午餐、晚餐、茶室、小吃 | 是 |
| `stay` | 住宿 | 是 |
| `free-time` | 休息、自由活动、Saboteur / 打牌 | 是 |
| `buffer` | 交通缓冲、午休、避暑 | 是 |
| `note` | 说明文字，不进入交通图 | 否或弱拖拽 |

住宿必须和景点同级进入卡片系统，因为它会影响第二天动线。自由时间也应该是正式卡片，因为用户明确希望旅行不要安排太死。

## 卡片字段

建议第一版每张卡片至少包含：

```js
{
  id: "shushan-old-street",
  title: "蜀山古南街",
  type: "place",
  theme: "dingshu",
  locationCode: "DS",
  cardRole: "anchor",
  durationMin: 90,
  bestTime: ["morning", "afternoon"],
  tags: ["紫砂", "老街", "工坊"],
  reservationNeeded: false,
  heatRisk: "medium",
  experienceValue: 4,
  visualValue: 4,
  budgetLevel: "$",
  groupFit: "all-four",
  mapNode: { shortLabel: "蜀山", cluster: "dingshu", importance: 3 },
  summary: "适合作为丁蜀线入口的紫砂生活街区。",
  cautions: ["不要只当拍照老街，需要看前店后坊和手艺脉络。"],
  sourceLinks: []
}
```

字段判断：

- `experienceValue`：是否真的能进入地方。
- `visualValue`：是否好看、好拍、适合网站呈现。
- `heatRisk`：夏季户外暴晒风险，取 `none / low / medium / high`。
- `bestTime`：取值仅限 `morning / afternoon / evening / night`，与槽位对应。
- `cardRole`：卡片在拼配中的角色，取 `anchor / optional / stay / food / buffer`。
- `mapNode`：`null` 表示不进入交通时距网络图；进入则为 `{ shortLabel, cluster, importance }`，见 `docs/network-map-model.md`。

## 自由时间卡片

自由时间不是 fallback，而是设计的一部分。

```js
{
  id: "saboteur-break",
  title: "Saboteur / 打牌",
  type: "free-time",
  theme: "night",
  locationCode: "CURRENT",
  cardRole: "buffer",
  durationMin: 60,
  bestTime: ["afternoon", "evening", "night"],
  tags: ["休息", "朋友", "灵活"],
  reservationNeeded: false,
  heatRisk: "none",
  experienceValue: 3,
  visualValue: 1,
  budgetLevel: "$",
  groupFit: "all-four",
  mapNode: null,
  summary: "用于保留旅行中的松弛时间。"
}
```

`locationCode: "CURRENT"` 表示不改变当前位置，不触发交通边计算。

## 拼配区

拼配区不需要一开始就绑定具体日期，可以先做通用时间槽：

- Arrival / 到达
- Day 1 Morning
- Day 1 Afternoon
- Day 1 Evening
- Stay 1
- Day 2 Morning
- Day 2 Afternoon
- Day 2 Evening
- Stay 2
- Day 3 Morning
- Lunch / Return

用户可以根据“周五晚到”或“周六早到”选择不同 preset：

- `fri-night-arrival`
- `sat-morning-arrival`

两个 preset 只是默认槽位状态，不是最终行程。

## 拖拽规则

- 卡片池里的卡片应可重复拖入不同草案，但同一份行程内默认不重复。
- 住宿卡片只能放入住宿槽，或至少应给出强提示。
- 餐饮卡片优先放入午餐 / 晚餐槽。
- 自由时间卡片可以放入任何非住宿槽。
- 如果卡片有 `reservationNeeded: true`，放入槽位后显示预约提示。
- 如果相邻卡片没有 direct edge，交通图不画线，并提示需要重排或补中转。
- 如果户外高热风险卡片被放到中午，显示热度提醒。
- 如果相邻卡片之一是 `free-time` 且 `locationCode` 为 `CURRENT`，它不触发新的交通边。
- 拖拽必须支持触屏：用 pointer events 实现，并提供“点卡片再点槽位”的备选方式；不用 HTML5 原生 drag-and-drop。

## 状态保存

因为必须静态部署，第一版状态保存只做本地：

- `localStorage`：保存当前浏览器中的拼配草案。
- URL hash：可选，用于把当前拼配分享给朋友。

不做：

- 登录。
- 远端数据库。
- 多人实时协作。
- 地图 API 实时路径规划。

## 视觉行为

- hover / 点选卡片时切换页面 `data-theme`，触屏以点选为准。
- 拖拽卡片时保留原主题色，但 drop zone 不应大幅跳动。
- 卡片不应做成旅游平台式大图卡；应像菜单选项，信息密度适中。
- 视觉主次优先展示：主题、时长、体验价值、位置、预约/热度风险。
- 自由时间卡片应视觉上更轻，不要像景点一样抢主位。

## 第一版验收标准

- 朋友能看懂有哪些可选项。
- 朋友能拖拽拼出自己的版本。
- 相邻地点的交通是否直连能被清楚反馈。
- 住宿能作为行程节点参与拼配。
- 空档和 Saboteur / 打牌能自然进入行程，不显得像错误状态。
- 页面仍然是纯静态 GitHub Pages 可部署。

