# 静态交互与数据模型

## 技术约束

最终网站必须能用 GitHub Pages 托管，因此默认技术边界是：

- HTML / CSS / JavaScript。
- 不需要后端。
- 不需要数据库。
- 不需要登录。
- 不需要服务端 API。
- 地点、住宿、交通估算都可以写成本地 JSON 或 JavaScript object。
- 朋友大概率用手机（微信内置浏览器）打开：拖拽必须用 pointer events 实现，或提供“点卡片再点槽位”的备选交互；HTML5 原生 drag-and-drop 在触屏上不可用。
- 主题切换不能只依赖 hover，触屏上用点选 / selected state 驱动。

如果后续使用构建工具，也必须能生成静态文件，例如 Vite build 后部署到 GitHub Pages。

## 单页结构草案

页面可以分为四个区域。第一版的产品目标是“拼配工具”，不是“固定行程页”：

1. 感官菜单
   - 丁蜀
   - 春日
   - 竹洞水
   - 夜晚

2. 候选模块池
   - 景点
   - 体验
   - 餐饮
   - 住宿
   - 空档 / 自由时间
   - 桌游 / Saboteur / 打牌
   - 每个候选项是一张可拖拽卡片

3. 行程拼配区
   - 完整槽位列表以 `docs/card-composition-model.md` 的拼配区为准（Arrival、Day 1-3 各时段、Stay 1/2、Lunch / Return）。

4. 交通提示层
   - 当上下两个模块区域不同，自动插入大致交通时间。
   - 例如：丁蜀 -> 竹海，提示 `约 45-60 min`。
   - 同时驱动一张交通时距网络图，只有确认存在直接交通的两点才画线。

## 不预设固定行程

网站可以内置一个“建议拼法”作为示例，但默认体验应是：

- 先展示候选卡片池。
- 让朋友按兴趣拖拽到时间槽。
- 交通、热度、预约、体验强度等作为即时反馈出现。
- 住宿也像景点一样进入拼配系统。
- 页面不强迫用户接受唯一行程。
- 空白、休息、临时打牌也应是合法安排，不把每个时段塞满。

实际内容层级应是：

1. 地点 / 体验 / 住宿卡片。
2. 休息 / 自由时间 / Saboteur 卡片。
3. 可拖拽时间槽。
4. 实时交通网络图。
5. 可选的示例组合或推荐 preset。

## Theme 切换机制

用 `data-theme` 和 CSS variables 处理主题切换：

```html
<body data-theme="dingshu">
```

```css
:root {
  --bg: #f7f4ee;
  --text: #1f1f1f;
  --accent: #b44a2c;
  --surface: #ffffff;
}

body[data-theme="dingshu"] {
  --bg: #f7eee7;
  --accent: #b74b2b;
}

body[data-theme="spring"] {
  --bg: #f4f6df;
  --accent: #9bbf3f;
}

body[data-theme="bamboo-water"] {
  --bg: #edf5f2;
  --accent: #2d8f83;
}

body[data-theme="night"] {
  --bg: #181715;
  --text: #f4efe7;
  --accent: #d8a451;
}
```

JavaScript 只负责根据 hover 或 selected state 更新 `data-theme`，不直接大量改 style。

## 地点数据模型

每个地点或体验都可以作为一个可拖拽模块。住宿也使用同一套模型，只是 `type` 不同。

```js
const places = [
  {
    id: "shushan-old-street",
    title: "蜀山古南街",
    type: "place",
    theme: "dingshu",
    locationCode: "DS",
    cardRole: "anchor",
    durationMin: 90,
    bestTime: ["afternoon"],
    tags: ["紫砂", "老街", "工坊", "散步"],
    reservationNeeded: false,
    heatRisk: "medium",
    experienceValue: 4,
    visualValue: 4,
    groupFit: "all-four",
    notes: "适合作为进入丁蜀线的第一站。"
  },
  {
    id: "sample-hotel",
    title: "待选住宿 A",
    type: "stay",
    theme: "night",
    locationCode: "CENTER",
    cardRole: "stay",
    durationMin: 0,
    bestTime: ["night"],
    tags: ["住宿", "交通方便"],
    reservationNeeded: true,
    heatRisk: "none",
    experienceValue: 1,
    visualValue: 2,
    groupFit: "all-four",
    notes: "住宿像景点一样进入拼配系统。"
  },
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
    groupFit: "all-four",
    notes: "用于保留旅行中的松弛时间，不进入交通网络图。"
  }
];
```

## Location Code

地点代码用于粗略判断区域关系，不追求精确导航。建议先用少量稳定区域：

| Code | 区域 | 说明 |
| --- | --- | --- |
| DS | 丁蜀 | 紫砂、陶艺、古南街、陶二厂、博物馆 |
| YX | 阳羡 | 茶园、山地、度假区 |
| ZH | 竹海 | 竹海及周边山林 |
| SD | 善卷洞 | 洞穴、山水景区 |
| LC | 龙池山 | 森林、骑行、轻徒步 |
| DT | 东氿 / 城区 | 湖边、餐饮、交通、部分住宿 |
| CENTER | 宜兴城区 | 高铁、餐饮、住宿、集合解散 |
| TBD | 待定 | 还没定位清楚的候选项 |

后续可以合并或拆分，当前不需要过细。

## 交通时间数据

交通时间的唯一数据源是 `transportEdges`（见 `docs/network-map-model.md`），按地点 id 记录确认过的直接交通。早期草案曾用区域间矩阵（`"CENTER:DS": "25-35 min"` 这类）做粗提示，现已废弃：同一段交通只保留一个数据来源。

当用户把两个地点拖到上下相邻的行程板块里：

- 如果两点 id 之间存在 direct edge，显示该 edge 的时间范围。
- 如果其中一张卡片 `locationCode` 为 `CURRENT`（自由时间等），不触发交通提示。
- 如果查不到 edge，显示“需单独确认”，并在交通图上显示断点。

## 交通时距网络图

行程拼配不只显示文字提示，还可以实时生成一张近似地图：

- 节点来自当前已选地点、餐饮、住宿。
- 连线来自预先确认的 direct edge。
- 线长按交通时间映射。
- 如果两个相邻地点没有 direct edge，不画线，只显示断点提示。
- 如果路线需要经过第三个候选地点，应拆成两条线，不画跨越第三地的直连。
- 这张图不依赖地图 API，用本地 JSON / JS 数据实现；第一版顺序路线图用普通 HTML 渲染，SVG 留给后续网络模式（见 `docs/network-map-model.md`）。

第一版可以先做“按拼配顺序生成的路线图”，后续再扩展为显示所有已选节点之间 direct edge 的网络图。

## 拖拽拼配

实现方式可以保持简单：

- 每个地点 / 体验 / 餐饮 / 住宿 / 自由时间是一个 draggable card。
- 行程时段是 drop zone。
- drop 后保存到本地 JS 状态。
- 可选：用 `localStorage` 保存朋友上次拼出的版本。
- 可选：用 URL hash 保存一个可分享的拼配版本。
- 不需要账号或远端同步。

可拖拽模块类型：

- 景点。
- 手作体验。
- 茶 / 咖啡 / 餐饮。
- 住宿。
- 自由时间。
- Saboteur / 打牌。
- 交通缓冲。

## 住宿作为模块

住宿不只是列表，可以像景点一样进入拼配：

- 位置会影响第二天动线。
- 价格和房型会影响四人分配。
- 风格会影响旅行气质。
- 是否靠近丁蜀、城区、湖边或山里，会影响交通时间。

住宿数据字段可加：

```js
{
  id: "stay-example",
  title: "待选住宿",
  type: "stay",
  locationCode: "CENTER",
  roomPlan: "2 rooms / 4 people",
  priceLevel: "$$",
  vibe: "modern quiet",
  parking: true,
  notes: "适合作为默认安全选项。"
}
```
