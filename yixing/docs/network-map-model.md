# 交通时距网络图模型

这个模块用于扩展行程拼配功能：用户拖拽地点、体验、餐饮、住宿后，页面根据当前拼配顺序实时生成一张近似地图。它不是严格地理地图，而是一个以交通时间为视觉长度的网络图。

## 核心规则

- 节点是地点、体验、餐饮、住宿或交通枢纽。
- 连线是两个节点之间的直接交通。
- 连线长度近似代表交通时间。
- 两个地点只有在数据里明确存在 direct edge 时才连线。
- 如果两个地点之间需要经过第三个已存在地点，或者实际路线上不适合直接移动，则不画连线。
- 不通过 `locationCode` 自动推断连线；`locationCode` 只辅助分组和初步筛选。
- 所有数据必须静态存在本地文件中，不能依赖地图 API。

## 为什么不用普通地图

普通地图适合导航，但不适合表达旅行拼配的节奏。这个网站的地图更像一张“时间关系图”：

- 朋友能直观看到两个选择之间是否顺路。
- 长线会自然提示“这段移动很重”。
- 断开的地方会提示“这个组合需要重排或插入中转”。
- 住宿可以和景点一样参与动线判断。

## Direct Edge 定义

`direct edge` 表示两点之间可以作为一个行程段直接移动。它不是几何直线，也不是“地图上有路”就自动成立。

一个 edge 可以存在的条件：

- 两点之间有可接受的直接交通方式，例如自驾、打车、包车、步行、骑行。
- 这段移动不需要把第三个候选地点作为实际中转。
- 这段移动不会明显破坏当天节奏。
- 交通时间可以用一个稳定的近似值表达。

一个 edge 不应存在的情况：

- A 到 C 实际上应经过 B，且 B 是候选地点或重要中转点。
- A 到 C 虽然地图上能走，但绕路、耗时或体验上不适合直接拼接。
- 两点之间交通方式不确定。
- 这段移动需要预约车、换乘或其他复杂条件，而网站不准备解释清楚。

## 数据结构

### 节点

节点可以复用地点数据，但需要补充 `mapNode` 字段：

```js
{
  id: "shushan-old-street",
  title: "蜀山古南街",
  type: "place",
  theme: "dingshu",
  locationCode: "DS",
  mapNode: {
    shortLabel: "蜀山",
    cluster: "dingshu",
    importance: 3
  }
}
```

说明：

- `shortLabel`：网络图上使用的短名。
- `cluster`：视觉聚类，不等于自动连线。
- `importance`：节点视觉权重，可用于控制字号或圆点大小。

### 连线

直接交通关系单独维护，不从地点数据自动生成。

```js
const transportEdges = [
  {
    id: "center-to-dingshu",
    from: "yixing-station-or-center",
    to: "shushan-old-street",
    mode: "car",
    minutes: 30,
    range: [25, 35],
    direct: true,
    confidence: "medium",
    label: "约 25-35 min",
    notes: "城区或高铁到丁蜀的默认进入线。"
  },
  {
    id: "shushan-to-taoerchang",
    from: "shushan-old-street",
    to: "taoerchang",
    mode: "walk-or-short-car",
    minutes: 12,
    range: [8, 18],
    direct: true,
    confidence: "medium",
    label: "约 10-20 min",
    notes: "同属丁蜀线，可作为连续陶艺段。"
  }
];
```

字段说明：

| 字段 | 作用 |
| --- | --- |
| `from` / `to` | 两端节点 id |
| `mode` | 主要交通方式 |
| `minutes` | 用于图上长度计算的中心值 |
| `range` | 对用户展示的时间范围 |
| `direct` | 必须为 true 才能画线 |
| `confidence` | 时间估算可信度 |
| `label` | 图上展示文字 |
| `notes` | 给规划者看的备注 |

### 禁止连线

通常缺少 edge 就代表不可连线。但如果某两个地点容易被误认为可以直连，可以显式记录原因。

```js
const blockedEdges = [
  {
    from: "place-a",
    to: "place-c",
    reason: "应拆成 A -> B -> C，不画 A -> C 直连。",
    suggestedVia: ["place-b"]
  }
];
```

这类数据可以用于 UI 提示：

- “这两个点不建议直接连。”
- “建议插入：B。”
- “这段需要单独确认交通。”

## 实时生成逻辑

用户每次改变拼配顺序时，重新生成当前路线图。

输入：

- 当前行程 slot 列表。
- 每个 slot 内选中的地点或住宿。
- `places` 节点数据。
- `transportEdges` 直接交通数据。
- `blockedEdges` 禁止连线说明。

输出：

- 当前路线节点。
- 当前路线边。
- 断点提示。
- 总交通时间估算。

伪代码：

```js
function buildRouteGraph(selectedItems, transportEdges, blockedEdges) {
  const nodes = selectedItems.filter((item) => item.type !== "note");
  const edges = [];
  const breaks = [];

  for (let i = 0; i < nodes.length - 1; i += 1) {
    const from = nodes[i];
    const to = nodes[i + 1];
    const edge = findDirectEdge(from.id, to.id, transportEdges);

    if (edge?.direct) {
      edges.push(edge);
      continue;
    }

    const blocked = findBlockedEdge(from.id, to.id, blockedEdges);
    breaks.push({
      from: from.id,
      to: to.id,
      reason: blocked?.reason || "没有确认的直接交通，不画连线。",
      suggestedVia: blocked?.suggestedVia || []
    });
  }

  return { nodes, edges, breaks };
}
```

## 视觉长度映射

连线长度按交通时间映射，但需要设置上下限，避免 5 分钟线太短或 70 分钟线撑破页面。

建议初版：

```js
function edgeLength(minutes) {
  const pxPerMinute = 4;
  const minLength = 64;
  const maxLength = 260;
  return Math.max(minLength, Math.min(maxLength, minutes * pxPerMinute));
}
```

也可以用分档：

| 时间 | 图上长度 |
| --- | --- |
| 0-10 min | 很短 |
| 10-25 min | 短 |
| 25-45 min | 中 |
| 45-70 min | 长 |
| 70+ min | 很长，并给出重排提示 |

## 渲染方式

第一版“顺序路线图”是一条线性链，用普通 HTML 实现即可，不引入 SVG：

- flex column 布局：节点是普通元素，节点之间的连接线是高度按分钟映射的 div，断点是样式化的间隔。
- 文字标签自动换行、CSS variables 主题直接生效、响应式和触屏交互都走普通文档流，比 SVG `<text>` 和 viewBox 省事。
- SVG 留给后续的“网络关系图 / 混合模式”：需要任意角度的点对点连线、交叉线和线上标签时才值得引入。
- 渲染层必须与 `buildRouteGraph` 的数据逻辑分离，便于以后替换渲染方式。

可选布局模式：

1. 顺序路线图
   - 按用户拼配顺序从上到下或从左到右排列。
   - 相邻节点之间的距离由 edge length 决定。
   - 最适合解释“当前行程走法”。

2. 网络关系图
   - 只显示当前已选节点之间存在的 direct edge。
   - 不一定只显示相邻行程段。
   - 适合比较哪些点天然成团。

3. 混合模式
   - 主线显示拼配顺序。
   - 非当前顺序但可直达的线用浅色细线显示。
   - 断点不画线，只在行程 slot 之间显示提示。

建议第一版做“顺序路线图”，之后再加混合模式。

## UI 行为

当用户拖拽改变行程：

- 右侧或下方路线图立即重绘。
- 相邻两站有 direct edge：画实线，显示交通时间。
- 相邻两站没有 direct edge：不画线，在两站之间显示断点。
- 如果存在 `blockedEdges` 说明：显示原因和建议中转。
- 如果某段超过阈值，例如 60 分钟：线加长，并显示“移动偏重”。
- hover 某个节点：页面 theme 切换到该节点主题。
- hover 某条线：高亮对应两个行程 slot。

## 与行程拼配的关系

行程拼配区仍然是主界面，网络图是反馈层：

- 拖拽决定顺序。
- 网络图解释顺序是否合理。
- 交通时间不是自动优化器，而是帮助朋友做选择。
- 不需要做最短路径算法。
- 不自动插入第三地，但可以提示建议插入。

## 与住宿的关系

住宿必须作为节点进入网络图，因为住宿决定第二天开局：

- Day 1 晚上最后一个地点 -> 住宿。
- 住宿 -> Day 2 第一个地点。
- 如果住宿和第二天主题不顺路，网络图会显示长线或断点。
- 山里民宿、城区酒店、丁蜀附近住宿应作为不同节点比较。

## 数据确认流程

在 actual page 之前，每个候选地点除了主题和停留时间，还要确认：

- 它是否应该成为地图节点。
- 它与哪些节点存在直接交通。
- 每条直接交通大约多少分钟。
- 有没有容易误连但实际应拆开的关系。
- 是否存在推荐中转点。

地点讨论完成后再生成：

- `data/places.js`
- `data/transport-edges.js`
- `data/blocked-edges.js`
- `scripts/build-route-graph.js` 或前端内置函数

