/*
 * 宜兴 · 感官拼配 —— 主逻辑
 *
 * 结构：
 *   1. 数据与常量
 *   2. 纯数据逻辑（buildRouteGraph 等，与 DOM 渲染分离）
 *   3. 状态与持久化（localStorage）
 *   4. 渲染（卡片池 / 时间槽 / 路线图 / 提示条）
 *   5. 交互（点选拼配 + pointer events 拖拽）
 *
 * 交互约定（docs/card-composition-model.md）：
 *   - 触屏优先：点卡片再点槽位；拖拽用 pointer events，不用 HTML5 原生 DnD。
 *   - 同一份草案内卡片默认不重复：再次放入等于移动。
 *   - 主题切换由点选驱动，hover 只是增强。
 */

(function () {
  "use strict";

  /* ================= 1. 数据与常量 ================= */

  var YXD = window.YX || {};
  var PLACES = YXD.places || [];
  var EDGES = YXD.transportEdges || [];
  var BLOCKED = YXD.blockedEdges || [];
  var PRESETS = YXD.presets || [];
  var REGION_TIMES = YXD.regionTimes || {};
  var SAME_REGION = YXD.sameRegionTime || null;
  var REGION_COORDS = YXD.regionCoords || {};
  var REGION_MAP_EDGES = YXD.regionMapEdges || [];

  var STORAGE_KEY = "yixing-draft-v1";
  var THEMES = ["dingshu", "spring", "bamboo-water", "night"];
  var VIEWS = ["intro", "pool", "plan", "graph"]; // 移动端四个子页；桌面端三栏并排
  var HEAVY_EDGE_MIN = 60; // 达到这个分钟数即提示“移动偏重”

  // 拼配区槽位：1 小时网格（Day 1/2 为 08:00-20:00 + 住宿，Day 3 到午餐返程）。
  // kind 用于热度/住宿等提示：08-11 morning，12-16 afternoon，17-20 evening。
  // day 用于分组表头；time: true 的空槽渲染成紧凑单行。
  // 放入卡片后，按其 durationMin 覆盖到的后续空槽会自动隐藏（见 coveredSlots）。
  var SLOTS = (function () {
    var list = [{ id: "arrival", label: "到达", sub: "Arrival", kind: "flex", day: null }];
    function pad(h) { return h < 10 ? "0" + h : "" + h; }
    function kindOf(h) { return h < 12 ? "morning" : (h < 17 ? "afternoon" : "evening"); }
    [1, 2].forEach(function (d) {
      for (var h = 8; h <= 20; h += 1) {
        list.push({ id: "d" + d + "-" + pad(h), label: pad(h) + ":00", kind: kindOf(h), day: "Day " + d, time: true });
      }
      list.push({ id: "stay" + d, label: "住宿", sub: "Stay " + d, kind: "stay", day: "Day " + d });
    });
    for (var h3 = 8; h3 <= 11; h3 += 1) {
      list.push({ id: "d3-" + pad(h3), label: pad(h3) + ":00", kind: kindOf(h3), day: "Day 3", time: true });
    }
    list.push({ id: "return", label: "12:00 · 午餐 / 返程", sub: "Return", kind: "flex", day: "Day 3" });
    return list;
  })();

  // 槽位对用户的完整称呼（toast、已在标签、路线图都用它）
  function slotLabel(slot) {
    return (slot.day ? slot.day + " · " : "") + slot.label;
  }

  var THEME_GROUPS = [
    { theme: "dingshu", label: "丁蜀 · 泥与窑火" },
    { theme: "spring", label: "春日 · 茶与田野" },
    { theme: "bamboo-water", label: "竹洞水 · 清凉" },
    { theme: "night", label: "夜晚 · 饭局 / 住宿 / 自由" }
  ];

  var TYPE_LABELS = {
    place: "地点",
    experience: "体验",
    food: "餐饮",
    stay: "住宿",
    "free-time": "自由时间",
    buffer: "缓冲"
  };

  var MODE_LABELS = {
    car: "打车",
    walk: "步行",
    "walk-or-car": "步行或打车",
    "walk-or-short-car": "步行 / 短驳",
    bike: "骑行"
  };

  // locationCode 只是内部数据键，UI 一律显示中文名
  // （区域表见 docs/static-interaction-model.md）
  var LOC_LABELS = {
    DS: "丁蜀",
    YX: "阳羡",
    ZH: "竹海",
    SD: "善卷洞",
    LC: "龙池山",
    DT: "东氿",
    CENTER: "宜兴城区",
    TBD: "位置待定",
    CURRENT: "原地"
  };

  function locLabel(code) {
    return LOC_LABELS[code] || code;
  }

  var cardById = {};
  PLACES.forEach(function (p) { cardById[p.id] = p; });

  var slotById = {};
  SLOTS.forEach(function (s) { slotById[s.id] = s; });

  /* ================= 2. 纯数据逻辑（与渲染分离） ================= */

  function findDirectEdge(fromId, toId, edges) {
    for (var i = 0; i < edges.length; i += 1) {
      var e = edges[i];
      if (!e.direct) continue;
      if ((e.from === fromId && e.to === toId) || (e.from === toId && e.to === fromId)) {
        return e;
      }
    }
    return null;
  }

  function findBlockedEdge(fromId, toId, blocked) {
    for (var i = 0; i < blocked.length; i += 1) {
      var b = blocked[i];
      if ((b.from === fromId && b.to === toId) || (b.from === toId && b.to === fromId)) {
        return b;
      }
    }
    return null;
  }

  // locationCode "CURRENT"（自由时间 / 缓冲）不改变位置，不触发交通边
  function isRouteNode(card) {
    return card && card.type !== "note" && card.mapNode && card.locationCode !== "CURRENT";
  }

  // 区域粗估：两点没有 direct edge 时按 locationCode 对兜底，行程里永远有个底
  function regionEstimate(fromCard, toCard, regionTimes, sameRegion) {
    var a = fromCard.locationCode;
    var b = toCard.locationCode;
    if (!a || !b || a === "TBD" || b === "TBD") return null;
    if (a === b) {
      return sameRegion ? { minutes: sameRegion.minutes, range: sameRegion.range, same: true } : null;
    }
    var hit = regionTimes[a + ":" + b] || regionTimes[b + ":" + a];
    return hit ? { minutes: hit.minutes, range: hit.range, same: false } : null;
  }

  /**
   * 根据当前拼配顺序生成路线图数据。
   * 相邻两点的时间来源按优先级：direct edge > 禁连说明（断点）> 区域粗估 > 需单独确认。
   * 输出 { nodes, edges, breaks, segments, regionCount, regionMinutes }，
   * segments[i] 描述 nodes[i] 与 nodes[i+1] 之间的关系。纯函数，不接触 DOM。
   */
  function buildRouteGraph(selectedItems, transportEdges, blockedEdges, regionTimes, sameRegion) {
    var nodes = selectedItems.filter(isRouteNode);
    var edges = [];
    var breaks = [];
    var segments = [];
    var regionCount = 0;
    var regionMinutes = 0;

    for (var i = 0; i < nodes.length - 1; i += 1) {
      var from = nodes[i];
      var to = nodes[i + 1];
      var edge = findDirectEdge(from.id, to.id, transportEdges);

      if (edge) {
        edges.push(edge);
        segments.push({ kind: "edge", fromId: from.id, toId: to.id, edge: edge });
        continue;
      }

      var blocked = findBlockedEdge(from.id, to.id, blockedEdges);
      if (blocked) {
        var brk = {
          from: from.id,
          to: to.id,
          reason: blocked.reason,
          suggestedVia: blocked.suggestedVia || []
        };
        breaks.push(brk);
        segments.push({ kind: "break", fromId: from.id, toId: to.id, brk: brk });
        continue;
      }

      var est = regionEstimate(from, to, regionTimes || {}, sameRegion);
      if (est) {
        regionCount += 1;
        regionMinutes += est.minutes;
        segments.push({ kind: "region", fromId: from.id, toId: to.id, est: est });
        continue;
      }

      var brk2 = {
        from: from.id,
        to: to.id,
        reason: "这两点之间还没有确认的直接交通。",
        suggestedVia: []
      };
      breaks.push(brk2);
      segments.push({ kind: "break", fromId: from.id, toId: to.id, brk: brk2 });
    }

    return {
      nodes: nodes, edges: edges, breaks: breaks, segments: segments,
      regionCount: regionCount, regionMinutes: regionMinutes
    };
  }

  // 分钟 -> 连线像素长度，带上下限（docs/network-map-model.md）
  function edgeLength(minutes) {
    var pxPerMinute = 4;
    var minLength = 64;
    var maxLength = 260;
    return Math.max(minLength, Math.min(maxLength, minutes * pxPerMinute));
  }

  function totalTravelMinutes(graph) {
    var total = 0;
    graph.edges.forEach(function (e) { total += e.minutes || 0; });
    return total + (graph.regionMinutes || 0);
  }

  /* ================= 3. 状态与持久化 ================= */

  // filter：感官菜单的双重角色之二 —— 筛选卡片池（"all" 或某个主题）。
  // 只影响卡片池显示；已放入槽位的卡和路线图不受筛选影响。
  var state = { filter: "all", view: "intro", slots: {} };
  SLOTS.forEach(function (s) { state.slots[s.id] = null; });

  // 点选拼配：selection = { cardId } 或 null（来源槽位随时可从 slots 推导）
  var selection = null;

  function slotOfCard(cardId) {
    for (var i = 0; i < SLOTS.length; i += 1) {
      if (state.slots[SLOTS[i].id] === cardId) return SLOTS[i].id;
    }
    return null;
  }

  function selectedItems() {
    var items = [];
    SLOTS.forEach(function (s) {
      var id = state.slots[s.id];
      if (id && cardById[id]) items.push(cardById[id]);
    });
    return items;
  }

  function currentGraph() {
    return buildRouteGraph(selectedItems(), EDGES, BLOCKED, REGION_TIMES, SAME_REGION);
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, filter: state.filter, view: state.view, slots: state.slots }));
    } catch (err) { /* 隐私模式等场景下静默失败 */ }
  }

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (err) { return; }
    if (!raw) return;
    var data;
    try { data = JSON.parse(raw); } catch (err) { return; }
    if (!data || typeof data !== "object") return;

    if (data.filter === "all" || THEMES.indexOf(data.filter) !== -1) state.filter = data.filter;
    if (VIEWS.indexOf(data.view) !== -1) state.view = data.view; // 回访者接着上次的视图

    var seen = {};
    if (data.slots && typeof data.slots === "object") {
      SLOTS.forEach(function (s) {
        var id = data.slots[s.id];
        if (typeof id === "string" && cardById[id] && !seen[id]) {
          state.slots[s.id] = id;
          seen[id] = true;
        } else {
          state.slots[s.id] = null;
        }
      });
    }
  }

  /* ================= 4. 渲染 ================= */

  var poolEl = document.getElementById("card-pool");
  var slotListEl = document.getElementById("slot-list");
  var graphEl = document.getElementById("route-graph");
  var summaryEl = document.getElementById("route-summary");
  var hintBarEl = document.getElementById("hint-bar");
  var hintTextEl = document.getElementById("hint-text");
  var toastEl = document.getElementById("toast");
  var presetWrapEl = document.getElementById("preset-buttons");
  var snackbarEl = document.getElementById("snackbar");
  var snackbarTextEl = document.getElementById("snackbar-text");
  var poolSectionEl = document.getElementById("view-pool");
  var regionMapEl = document.getElementById("region-map");
  var importFileEl = document.getElementById("import-file");

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function chip(text, className) {
    return el("span", className || "chip", text);
  }

  function durationText(card) {
    if (card.type === "stay") return "过夜";
    if (!card.durationMin) return "";
    return "约 " + card.durationMin + " 分";
  }

  // 主题只作用于菜单（卡片池）区域：筛选某个感官时该区着色，
  // 「全部」与其余视图始终素色（用户决定：出了菜单就是白）
  function applyPoolTheme() {
    if (state.filter !== "all" && THEMES.indexOf(state.filter) !== -1) {
      poolSectionEl.setAttribute("data-theme", state.filter);
    } else {
      poolSectionEl.removeAttribute("data-theme");
    }
  }

  // 视图切换只在移动端有布局效果；桌面端三栏常驻，data-view 不影响显示
  function isMobile() {
    return window.matchMedia("(max-width: 1023px)").matches;
  }

  function setView(view) {
    if (VIEWS.indexOf(view) === -1) return;
    var changed = state.view !== view;
    state.view = view;
    document.body.setAttribute("data-view", view);
    renderTabBar();
    save();
    if (changed && isMobile()) window.scrollTo(0, 0);
  }

  function renderTabBar() {
    var btns = document.querySelectorAll("[data-view-btn]");
    for (var i = 0; i < btns.length; i += 1) {
      var v = btns[i].getAttribute("data-view-btn");
      btns[i].setAttribute("aria-pressed", v === state.view ? "true" : "false");
    }
  }

  // 感官菜单按钮的按下态跟随筛选状态（菜单 = 主题切换 + 卡片池筛选）
  function renderThemeMenu() {
    var btns = document.querySelectorAll("[data-theme-btn]");
    for (var i = 0; i < btns.length; i += 1) {
      var t = btns[i].getAttribute("data-theme-btn");
      btns[i].setAttribute("aria-pressed", t === state.filter ? "true" : "false");
    }
    var allBtn = document.querySelector("[data-filter-all]");
    if (allBtn) allBtn.setAttribute("aria-pressed", state.filter === "all" ? "true" : "false");
  }

  function buildCardEl(card) {
    var used = slotOfCard(card.id);
    var isLight = card.type === "free-time" || card.type === "buffer";
    var cls = "card";
    if (isLight) cls += " card--light";
    if (used) cls += " card--assigned";
    if (selection && selection.cardId === card.id) cls += " card--selected";

    var node = el("article", cls);
    node.setAttribute("data-card-id", card.id);
    node.setAttribute("data-drag-card", "");
    node.setAttribute("data-card-theme", card.theme);

    var top = el("div", "card-top");
    top.appendChild(el("h3", "card-title", card.title));
    var dur = durationText(card);
    if (dur) top.appendChild(el("span", "card-duration", dur));
    node.appendChild(top);

    if (card.summary) node.appendChild(el("p", "card-summary", card.summary));

    var meta = el("div", "card-meta");
    meta.appendChild(chip(locLabel(card.locationCode), "chip chip-loc"));
    meta.appendChild(chip(TYPE_LABELS[card.type] || card.type));
    if (card.reservationNeeded) meta.appendChild(chip("需预约", "badge badge-res"));
    if (card.heatRisk === "medium") meta.appendChild(chip("偏晒", "badge badge-heat"));
    if (card.heatRisk === "high") meta.appendChild(chip("暴晒", "badge badge-heat"));
    if (card.pending) meta.appendChild(chip("待确认", "badge badge-tbc"));
    if (used) meta.appendChild(chip("已在 " + slotLabel(slotById[used]), "chip chip-assigned"));
    node.appendChild(meta);

    return node;
  }

  function renderPool() {
    poolEl.innerHTML = "";
    THEME_GROUPS.forEach(function (group) {
      if (state.filter !== "all" && group.theme !== state.filter) return;
      var cards = PLACES.filter(function (p) { return p.theme === group.theme; });
      if (!cards.length) return;
      var wrap = el("section", "pool-group");
      var title = el("h3", "pool-group-title", group.label);
      title.setAttribute("data-card-theme", group.theme);
      wrap.appendChild(title);
      var list = el("div", "pool-cards");
      cards.forEach(function (card) { list.appendChild(buildCardEl(card)); });
      wrap.appendChild(list);
      poolEl.appendChild(wrap);
    });
  }

  function slotWarnings(slot, card, overlapped) {
    var items = [];
    if (overlapped) {
      items.push({ text: "与上一项的预估时长重叠，建议挪后", strong: true });
    }
    if (card.type === "stay" && slot.kind !== "stay") {
      items.push({ text: "住宿卡不在住宿槽 — 建议移到 Stay 槽", strong: true });
    }
    if (slot.kind === "afternoon" && (card.heatRisk === "medium" || card.heatRisk === "high")) {
      items.push({ text: "午后偏晒（heatRisk: " + card.heatRisk + "），建议挪到上午或傍晚", strong: true });
    }
    if (card.reservationNeeded) {
      items.push({ text: "需要提前预约", strong: false });
    }
    return items;
  }

  /**
   * 覆盖计算：时间槽里的卡按预估时长向后占格（1 小时一格，向上取整）。
   * 被覆盖的空槽隐藏；被覆盖但已被占用的槽保持可见并出重叠提醒。
   * 覆盖不跨天、不跨住宿槽。
   */
  function coveredSlots() {
    var hidden = {};
    var overlapped = {};
    for (var i = 0; i < SLOTS.length; i += 1) {
      var slot = SLOTS[i];
      if (!slot.time) continue;
      var cardId = state.slots[slot.id];
      if (!cardId || !cardById[cardId]) continue;
      var span = Math.max(1, Math.ceil((cardById[cardId].durationMin || 0) / 60));
      for (var k = 1; k < span; k += 1) {
        var nxt = SLOTS[i + k];
        if (!nxt || !nxt.time || nxt.day !== slot.day) break;
        if (state.slots[nxt.id]) overlapped[nxt.id] = true;
        else hidden[nxt.id] = true;
      }
    }
    return { hidden: hidden, overlapped: overlapped };
  }

  function buildSlotEl(slot, overlapped) {
    var cardId = state.slots[slot.id];
    var card = cardId ? cardById[cardId] : null;
    var cls = "slot " + (card ? "slot--filled" : "slot--empty");
    if (slot.kind === "stay") cls += " slot--stay";

    if (slot.time) cls += " slot--time";
    var node = el("section", cls);
    node.setAttribute("data-slot-id", slot.id);

    var head = el("div", "slot-head");
    head.appendChild(el("span", "slot-label", slot.label));
    if (slot.sub) head.appendChild(el("span", "slot-sub", slot.sub));
    else if (slot.time && !card) head.appendChild(el("span", "slot-sub", "留白"));
    node.appendChild(head);

    if (card) {
      var occ = el("div", "slot-card" + (selection && selection.cardId === card.id ? " card--selected" : ""));
      occ.setAttribute("data-card-id", card.id);
      occ.setAttribute("data-drag-card", "");
      occ.setAttribute("data-card-theme", card.theme);
      occ.appendChild(el("span", "slot-card-title", card.title));
      occ.appendChild(chip(locLabel(card.locationCode), "chip chip-loc"));
      var dur = durationText(card);
      if (dur) occ.appendChild(chip(dur));
      if (card.pending) occ.appendChild(chip("待确认", "badge badge-tbc"));
      var removeBtn = el("button", "slot-remove", "移出");
      removeBtn.setAttribute("type", "button");
      removeBtn.setAttribute("data-remove-slot", slot.id);
      removeBtn.setAttribute("aria-label", "把「" + card.title + "」移出行程");
      occ.appendChild(removeBtn);
      node.appendChild(occ);

      var warnings = slotWarnings(slot, card, overlapped);
      if (warnings.length) {
        var ul = el("ul", "slot-warnings");
        warnings.forEach(function (w) {
          ul.appendChild(el("li", w.strong ? "" : "note-hint", w.text));
        });
        node.appendChild(ul);
      }
    } else if (!slot.time) {
      // 时间槽的空态只在标题行标「留白」，不再占一段文字
      var emptyText = slot.kind === "stay" ? "还没选住宿" : "留白";
      node.appendChild(el("p", "slot-empty-note", emptyText));
    }

    return node;
  }

  function buildTravelChip(seg) {
    var toCard = cardById[seg.toId];
    var toName = toCard ? toCard.title : seg.toId;

    if (seg.kind === "edge") {
      var e = seg.edge;
      var mode = MODE_LABELS[e.mode] || e.mode;
      var text = "下一站 " + toName + " · " + e.label + " · " + mode;
      if ((e.minutes || 0) >= HEAVY_EDGE_MIN) text += " · 移动偏重";
      return el("div", "travel-chip", text);
    }

    if (seg.kind === "region") {
      var est = seg.est;
      var rText = "下一站 " + toName + " · 约 " + est.range[0] + "-" + est.range[1] + " 分（"
        + (est.same ? "同区粗估" : "区域粗估") + "）· 打车";
      return el("div", "travel-chip travel-chip--region", rText);
    }

    var node = el("div", "travel-chip travel-chip--break");
    node.appendChild(document.createTextNode("下一站 " + toName + " · 需单独确认"));
    var detail = seg.brk.reason;
    if (seg.brk.suggestedVia.length) {
      var vias = seg.brk.suggestedVia.map(function (id) {
        return cardById[id] ? cardById[id].title : id;
      });
      detail += " 建议中转：" + vias.join("、");
    }
    var small = document.createElement("small");
    small.textContent = detail;
    node.appendChild(small);
    return node;
  }

  function renderSlots() {
    slotListEl.innerHTML = "";
    var slotEls = {};
    var lastDay = null;
    var cover = coveredSlots();
    SLOTS.forEach(function (slot) {
      if (slot.day && slot.day !== lastDay) {
        slotListEl.appendChild(el("h3", "slot-day-head", slot.day));
        lastDay = slot.day;
      }
      if (cover.hidden[slot.id]) return; // 被上一项时长覆盖的空槽不渲染
      var elx = buildSlotEl(slot, cover.overlapped[slot.id]);
      slotEls[slot.id] = elx;
      slotListEl.appendChild(elx);
    });

    // 相邻已选地点间的交通反馈，插在起点卡所在槽位之后
    currentGraph().segments.forEach(function (seg) {
      var fromSlotId = slotOfCard(seg.fromId);
      var anchor = fromSlotId ? slotEls[fromSlotId] : null;
      if (anchor) anchor.insertAdjacentElement("afterend", buildTravelChip(seg));
    });
  }

  function buildGraphNode(card) {
    var node = el("div", "graph-node");
    node.setAttribute("data-card-id", card.id);
    node.setAttribute("data-card-theme", card.theme);
    node.setAttribute("data-graph-node", "");

    var imp = card.mapNode.importance || 2;
    node.appendChild(el("span", "graph-dot imp-" + imp));

    var text = el("div", "graph-node-text");
    text.appendChild(el("span", "graph-node-label", card.mapNode.shortLabel));
    var slotId = slotOfCard(card.id);
    if (slotId) text.appendChild(el("span", "graph-node-slot", slotLabel(slotById[slotId])));
    node.appendChild(text);
    return node;
  }

  function buildGraphSegment(seg) {
    if (seg.kind === "edge") {
      var e = seg.edge;
      var heavy = (e.minutes || 0) >= HEAVY_EDGE_MIN;
      var node = el("div", "graph-edge" + (heavy ? " graph-edge--heavy" : ""));
      node.style.height = edgeLength(e.minutes || 0) + "px";
      node.appendChild(el("span", "graph-edge-line"));
      var mode = MODE_LABELS[e.mode] || e.mode;
      var label = e.label + " · " + mode + (heavy ? " · 移动偏重" : "");
      node.appendChild(el("span", "graph-edge-label", label));
      return node;
    }

    if (seg.kind === "region") {
      var est = seg.est;
      var heavyR = est.minutes >= HEAVY_EDGE_MIN;
      var rNode = el("div", "graph-edge graph-edge--region" + (heavyR ? " graph-edge--heavy" : ""));
      rNode.style.height = edgeLength(est.minutes) + "px";
      rNode.appendChild(el("span", "graph-edge-line"));
      var rLabel = "约 " + est.range[0] + "-" + est.range[1] + " 分（"
        + (est.same ? "同区" : "区域") + "粗估）" + (heavyR ? " · 移动偏重" : "");
      rNode.appendChild(el("span", "graph-edge-label", rLabel));
      return rNode;
    }

    var brkEl = el("div", "graph-break");
    brkEl.appendChild(el("strong", null, "需单独确认"));
    var detail = seg.brk.reason;
    if (seg.brk.suggestedVia.length) {
      var vias = seg.brk.suggestedVia.map(function (id) {
        return cardById[id] ? cardById[id].title : id;
      });
      detail += " 建议中转：" + vias.join("、");
    }
    brkEl.appendChild(el("span", null, detail));
    return brkEl;
  }

  function renderRouteGraph() {
    graphEl.innerHTML = "";
    var graph = currentGraph();

    if (!graph.nodes.length) {
      graphEl.appendChild(el("p", "graph-empty", "还没有路线：先在行程里放入两个地点。"));
      summaryEl.textContent = "";
      updateRegionHighlight(graph);
      return;
    }

    graph.nodes.forEach(function (card, i) {
      graphEl.appendChild(buildGraphNode(card));
      if (i < graph.nodes.length - 1) {
        graphEl.appendChild(buildGraphSegment(graph.segments[i]));
      }
    });

    var total = totalTravelMinutes(graph);
    var parts = [];
    if (total > 0) parts.push("全程移动合计 约 " + total + " 分钟（粗估）");
    if (graph.regionCount) parts.push(graph.regionCount + " 段为区域粗估");
    if (graph.breaks.length) parts.push(graph.breaks.length + " 段需单独确认");
    summaryEl.textContent = parts.join(" · ");

    updateRegionHighlight(graph);
  }

  /* ---------- 区域概览图（SVG，静态节点 + 时距连线） ---------- */

  function renderRegionMap() {
    if (!regionMapEl) return;
    var codes = Object.keys(REGION_COORDS);
    if (!codes.length) return;
    var svgNS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", YXD.regionMapViewBox || "0 0 300 440");
    svg.setAttribute("class", "region-map-svg");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "各区域相对位置与打车时距概览");

    // 只画时间较短的“天然邻居”，全画 21 条会糊成一团
    REGION_MAP_EDGES.forEach(function (key) {
      var pair = key.split(":");
      var a = REGION_COORDS[pair[0]];
      var b = REGION_COORDS[pair[1]];
      var t = REGION_TIMES[key] || REGION_TIMES[pair[1] + ":" + pair[0]];
      if (!a || !b || !t) return;
      var line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", a.x);
      line.setAttribute("y1", a.y);
      line.setAttribute("x2", b.x);
      line.setAttribute("y2", b.y);
      line.setAttribute("class", "region-map-line");
      svg.appendChild(line);
      var label = document.createElementNS(svgNS, "text");
      label.setAttribute("x", (a.x + b.x) / 2);
      label.setAttribute("y", (a.y + b.y) / 2 - 3);
      label.setAttribute("class", "region-map-time");
      label.textContent = t.minutes + "'";
      svg.appendChild(label);
    });

    codes.forEach(function (code) {
      var c = REGION_COORDS[code];
      var g = document.createElementNS(svgNS, "g");
      g.setAttribute("class", "region-map-node");
      g.setAttribute("data-region", code);
      var dot = document.createElementNS(svgNS, "circle");
      dot.setAttribute("cx", c.x);
      dot.setAttribute("cy", c.y);
      dot.setAttribute("r", 5);
      g.appendChild(dot);
      var name = document.createElementNS(svgNS, "text");
      // 标签朝向按数据手工指定，避免相邻节点文字重叠
      if (c.side === "left") {
        name.setAttribute("x", c.x - 9);
        name.setAttribute("text-anchor", "end");
      } else {
        name.setAttribute("x", c.x + 9);
      }
      name.setAttribute("y", c.y + 4);
      name.textContent = locLabel(code);
      g.appendChild(name);
      svg.appendChild(g);
    });

    regionMapEl.innerHTML = "";
    regionMapEl.appendChild(svg);
  }

  // 概览图上点亮当前行程涉及的区域
  function updateRegionHighlight(graph) {
    if (!regionMapEl) return;
    var active = {};
    graph.nodes.forEach(function (card) { active[card.locationCode] = true; });
    var nodes = regionMapEl.querySelectorAll(".region-map-node");
    for (var i = 0; i < nodes.length; i += 1) {
      nodes[i].classList.toggle("on", !!active[nodes[i].getAttribute("data-region")]);
    }
  }

  function renderHintBar() {
    if (!selection) {
      hintBarEl.hidden = true;
      return;
    }
    var card = cardById[selection.cardId];
    var from = slotOfCard(selection.cardId);
    hintTextEl.textContent = from
      ? "移动「" + card.title + "」— 点目标槽位（占用则交换）"
      : "已选「" + card.title + "」— 点一个时间槽放入";
    hintBarEl.hidden = false;
  }

  function renderPresetButtons() {
    presetWrapEl.innerHTML = "";
    PRESETS.forEach(function (preset) {
      var btn = el("button", null, preset.title);
      btn.setAttribute("type", "button");
      btn.setAttribute("data-preset", preset.id);
      presetWrapEl.appendChild(btn);
    });
  }

  function renderAll() {
    renderPool();
    renderSlots();
    renderRouteGraph();
    renderHintBar();
    renderThemeMenu();
  }

  var toastTimer = null;
  function toast(message, kind) {
    toastEl.textContent = message;
    toastEl.className = "toast" + (kind === "warn" ? " toast--warn" : "");
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 2800);
  }

  /* snackbar：移动端放卡后的即时反馈，带撤销 / 继续选卡，
     支撑「选卡 → 放入 → 一键回卡片池」的快速循环 */

  var snackbarTimer = null;
  var pendingUndo = null;

  function showSnackbar(message, kind, undoData) {
    pendingUndo = undoData || null;
    snackbarTextEl.textContent = message;
    snackbarEl.className = "snackbar" + (kind === "warn" ? " snackbar--warn" : "");
    snackbarEl.hidden = false;
    if (snackbarTimer) clearTimeout(snackbarTimer);
    snackbarTimer = setTimeout(hideSnackbar, 4200);
  }

  function hideSnackbar() {
    if (snackbarTimer) clearTimeout(snackbarTimer);
    snackbarTimer = null;
    pendingUndo = null;
    snackbarEl.hidden = true;
  }

  function undoAssign(u) {
    state.slots[u.target] = u.displaced || null;
    if (u.source) state.slots[u.source] = u.cardId;
    clearSelection();
    hideSnackbar();
    save();
    renderAll();
    toast("已撤销");
  }

  /* ================= 5. 交互 ================= */

  function clearSelection() {
    selection = null;
  }

  function performAssign(cardId, targetSlotId) {
    var card = cardById[cardId];
    var slot = slotById[targetSlotId];
    if (!card || !slot) return;

    var sourceSlotId = slotOfCard(cardId);
    if (sourceSlotId === targetSlotId) {
      clearSelection();
      renderAll();
      return;
    }

    var displacedId = state.slots[targetSlotId] || null;
    // 撤销快照：记录这次放置动了哪两个槽位
    var undoData = { target: targetSlotId, source: sourceSlotId, displaced: displacedId, cardId: cardId };
    state.slots[targetSlotId] = cardId;
    if (sourceSlotId) {
      // 同一草案不重复：从原槽位移走；目标被占用则两卡交换
      state.slots[sourceSlotId] = displacedId;
    }

    // 即时反馈，按重要性只出一条；持久提示由槽位内警告承担
    var msg;
    var kind = null;
    if (card.type === "stay" && slot.kind !== "stay") {
      msg = "注意：「" + card.title + "」是住宿卡，通常放住宿槽";
      kind = "warn";
    } else if (slot.kind === "afternoon" && (card.heatRisk === "medium" || card.heatRisk === "high")) {
      msg = "「" + card.title + "」午后偏晒，建议放上午或傍晚";
      kind = "warn";
    } else if (card.reservationNeeded) {
      msg = "「" + card.title + "」需要提前预约";
    } else if (sourceSlotId && displacedId) {
      msg = "两张卡已交换";
    } else if (sourceSlotId) {
      msg = "已移动到 " + slotLabel(slot);
    } else if (displacedId && cardById[displacedId]) {
      msg = "「" + cardById[displacedId].title + "」已移回菜单";
    } else {
      msg = "已放入 " + slotLabel(slot);
    }

    clearSelection();
    save();
    renderAll();

    // 移动端用 snackbar（可撤销、可跳回卡片池），桌面端卡片池常驻，轻提示即可
    if (isMobile()) {
      showSnackbar(msg, kind, undoData);
    } else {
      toast(msg, kind);
    }
  }

  function removeFromSlot(slotId) {
    var cardId = state.slots[slotId];
    if (!cardId) return;
    hideSnackbar(); // 槽位又变了，旧的撤销快照作废
    state.slots[slotId] = null;
    if (selection && selection.cardId === cardId) clearSelection();
    save();
    renderAll();
    if (cardById[cardId]) toast("「" + cardById[cardId].title + "」已移出行程");
  }

  // 选中反馈动画：卡片影子滑向底部悬置区（hint bar 的位置），再进行程视图
  function animateCardToDock(cardEl) {
    if (!cardEl) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var rect = cardEl.getBoundingClientRect();
    if (!rect.width) return;
    var ghost = cardEl.cloneNode(true);
    ghost.className += " fly-ghost";
    ghost.style.left = rect.left + "px";
    ghost.style.top = rect.top + "px";
    ghost.style.width = rect.width + "px";
    document.body.appendChild(ghost);
    var dx = window.innerWidth / 2 - (rect.left + rect.width / 2);
    var dy = window.innerHeight - 96 - rect.top;
    // 两次 rAF：先让初始位置渲染出来，transition 才有起点
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        ghost.style.transform = "translate(" + dx + "px, " + dy + "px) scale(0.4)";
        ghost.style.opacity = "0";
      });
    });
    setTimeout(function () {
      if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
    }, 420);
  }

  function onCardTap(cardId, cardEl) {
    var card = cardById[cardId];
    if (!card) return;
    if (selection && selection.cardId === cardId) {
      clearSelection();
      renderAll();
      return;
    }
    hideSnackbar();
    selection = { cardId: cardId };
    animateCardToDock(cardEl); // 克隆要在重渲染替换元素之前做
    renderAll();
    // 移动端：选中即跳到行程视图，下一步点槽位放入（hint bar 可取消）
    if (isMobile() && state.view !== "plan") setView("plan");
  }

  function onSlotTap(slotId) {
    if (selection) {
      performAssign(selection.cardId, slotId);
      return;
    }
    var occupant = state.slots[slotId];
    if (occupant) {
      onCardTap(occupant); // 点已放置的卡 = 选中它准备移动
      return;
    }
    toast("先在菜单点选一张卡片，再点这个槽位");
  }

  function applyPreset(presetId) {
    var preset = null;
    for (var i = 0; i < PRESETS.length; i += 1) {
      if (PRESETS[i].id === presetId) { preset = PRESETS[i]; break; }
    }
    if (!preset) return;

    hideSnackbar();
    var seen = {};
    SLOTS.forEach(function (s) {
      var id = preset.slots ? preset.slots[s.id] : null;
      if (typeof id === "string" && cardById[id] && !seen[id]) {
        state.slots[s.id] = id;
        seen[id] = true;
      } else {
        state.slots[s.id] = null;
      }
    });

    clearSelection();
    save();
    renderAll();
    toast(preset.note || (preset.title + " 已载入"));
  }

  /* ---------- 行程的导出 / 导入（本地 JSON 文件，便于朋友间传） ---------- */

  function exportDraft() {
    var payload = { v: 1, site: "yixing", slots: state.slots };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "yixing-itinerary.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast("已导出行程文件");
  }

  // 先整体校验再落盘：至少要有一张能认出的卡，避免坏文件清空现有行程
  function applyImportedSlots(data) {
    if (!data || typeof data !== "object" || !data.slots || typeof data.slots !== "object") return false;
    var next = {};
    var seen = {};
    var found = false;
    SLOTS.forEach(function (s) {
      var id = data.slots[s.id];
      if (typeof id === "string" && cardById[id] && !seen[id]) {
        next[s.id] = id;
        seen[id] = true;
        found = true;
      } else {
        next[s.id] = null;
      }
    });
    if (!found) return false;
    state.slots = next;
    return true;
  }

  importFileEl.addEventListener("change", function () {
    var file = importFileEl.files && importFileEl.files[0];
    importFileEl.value = ""; // 允许连续导入同一个文件
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var data = null;
      try { data = JSON.parse(String(reader.result)); } catch (err) { /* 落到下面的报错 */ }
      hideSnackbar();
      if (data && applyImportedSlots(data)) {
        clearSelection();
        save();
        renderAll();
        toast("行程已导入");
      } else {
        toast("读不懂这个文件：需要本站导出的行程 JSON", "warn");
      }
    };
    reader.readAsText(file);
  });

  function resetDraft() {
    if (!window.confirm("清空当前拼配草稿？")) return;
    hideSnackbar();
    SLOTS.forEach(function (s) { state.slots[s.id] = null; });
    clearSelection();
    try { localStorage.removeItem(STORAGE_KEY); } catch (err) { /* ignore */ }
    renderAll();
    toast("已清空");
  }

  /* ---------- 点击（含拖拽后的 click 抑制） ---------- */

  var suppressClick = false;

  document.addEventListener("click", function (e) {
    if (suppressClick) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    var viewBtn = e.target.closest("[data-view-btn]");
    if (viewBtn) { setView(viewBtn.getAttribute("data-view-btn")); return; }

    var gotoBtn = e.target.closest("[data-goto]");
    if (gotoBtn) { setView(gotoBtn.getAttribute("data-goto")); return; }

    // 简介里的感官入口：筛选菜单并给菜单区着色，跳到菜单
    var themeGo = e.target.closest("[data-theme-go]");
    if (themeGo) {
      state.filter = themeGo.getAttribute("data-theme-go");
      applyPoolTheme();
      save();
      renderPool();
      renderThemeMenu();
      setView("pool");
      return;
    }

    if (e.target.closest("#snackbar-undo")) {
      if (pendingUndo) undoAssign(pendingUndo);
      else hideSnackbar();
      return;
    }

    if (e.target.closest("#snackbar-back")) {
      hideSnackbar();
      setView("pool");
      return;
    }

    var themeBtn = e.target.closest("[data-theme-btn]");
    if (themeBtn) {
      state.filter = themeBtn.getAttribute("data-theme-btn"); // 筛选 + 菜单区着色
      applyPoolTheme();
      save();
      renderPool();
      renderThemeMenu();
      return;
    }

    if (e.target.closest("[data-filter-all]")) {
      state.filter = "all"; // 全部 = 素色完整菜单
      applyPoolTheme();
      save();
      renderPool();
      renderThemeMenu();
      return;
    }

    var presetBtn = e.target.closest("[data-preset]");
    if (presetBtn) { applyPreset(presetBtn.getAttribute("data-preset")); return; }

    if (e.target.closest("#reset-btn")) { resetDraft(); return; }
    if (e.target.closest("#export-btn")) { exportDraft(); return; }
    if (e.target.closest("#import-btn")) { importFileEl.click(); return; }

    if (e.target.closest("[data-cancel-selection]")) {
      clearSelection();
      renderAll();
      return;
    }

    var removeBtn = e.target.closest("[data-remove-slot]");
    if (removeBtn) { removeFromSlot(removeBtn.getAttribute("data-remove-slot")); return; }

    var slotEl = e.target.closest(".slot");
    if (slotEl) { onSlotTap(slotEl.getAttribute("data-slot-id")); return; }

    var cardEl = e.target.closest("[data-drag-card]");
    if (cardEl) { onCardTap(cardEl.getAttribute("data-card-id"), cardEl); return; }
  });

  /* ---------- 拖拽（pointer events，触屏长按提起） ---------- */

  var drag = null;

  function cancelDrag() {
    if (!drag) return;
    if (drag.timer) clearTimeout(drag.timer);
    if (drag.scrollTimer) clearInterval(drag.scrollTimer);
    try { document.body.releasePointerCapture(drag.pointerId); } catch (err) { /* 未捕获时忽略 */ }
    if (drag.ghost && drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
    if (drag.overSlot) drag.overSlot.classList.remove("slot--over");
    if (drag.el) drag.el.classList.remove("drag-source");
    document.body.classList.remove("drag-active");
    drag = null;
  }

  function liftDrag() {
    if (!drag || drag.lifted) return;
    drag.lifted = true;
    var card = cardById[drag.cardId];
    var ghost = el("div", "drag-ghost", card ? card.title : "");
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    positionGhost();
    document.body.classList.add("drag-active");
    drag.el.classList.add("drag-source");

    // 把 pointer 捕获转到 body：移动端提起后切视图会隐藏拖拽源，
    // 不转移的话后续 pointer 事件可能随源元素一起消失
    try { document.body.setPointerCapture(drag.pointerId); } catch (err) { /* 不支持则依赖隐式捕获 */ }

    // 移动端：提起卡片即切到行程拼配，槽位成为可放目标
    if (isMobile() && state.view !== "plan") setView("plan");

    // 槽位列表通常比视口高：指针停在上下边缘时自动滚动，拖得到画面外的槽位
    drag.scrollTimer = setInterval(autoScrollDuringDrag, 30);
  }

  function autoScrollDuringDrag() {
    if (!drag || !drag.lifted) return;
    var edge = 72;
    var step = 0;
    if (drag.lastY < edge) step = -9;
    else if (drag.lastY > window.innerHeight - edge) step = 9;
    if (step) {
      window.scrollBy(0, step);
      updateDropTarget(); // 页面滚了，指针下方的槽位会变
    }
  }

  function positionGhost() {
    if (!drag || !drag.ghost) return;
    drag.ghost.style.transform =
      "translate(" + (drag.lastX + 14) + "px, " + (drag.lastY - 22) + "px)";
  }

  function updateDropTarget() {
    if (!drag || !drag.lifted) return;
    var under = document.elementFromPoint(drag.lastX, drag.lastY);
    var slotEl = under ? under.closest(".slot") : null;
    if (drag.overSlot && drag.overSlot !== slotEl) drag.overSlot.classList.remove("slot--over");
    if (slotEl) slotEl.classList.add("slot--over");
    drag.overSlot = slotEl;
  }

  document.addEventListener("pointerdown", function (e) {
    if (!e.isPrimary) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.target.closest("[data-remove-slot]")) return;
    var cardEl = e.target.closest("[data-drag-card]");
    if (!cardEl) return;

    drag = {
      cardId: cardEl.getAttribute("data-card-id"),
      el: cardEl,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      lifted: false,
      overSlot: null,
      ghost: null,
      timer: null,
      scrollTimer: null
    };

    // 触屏：按住 230ms 不动才提起，先保证页面还能滚动
    if (e.pointerType !== "mouse") {
      drag.timer = setTimeout(function () {
        if (drag && !drag.lifted) liftDrag();
      }, 230);
    }
  });

  document.addEventListener("pointermove", function (e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    var dist = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);

    if (!drag.lifted) {
      if (drag.pointerType === "mouse") {
        if (dist > 6) liftDrag();
      } else if (dist > 12) {
        cancelDrag(); // 触屏位移在先 = 想滚动页面，取消长按提起
        return;
      }
    }

    if (drag && drag.lifted) {
      positionGhost();
      updateDropTarget();
    }
  });

  document.addEventListener("pointerup", function (e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    var lifted = drag.lifted;
    var cardId = drag.cardId;
    var overSlot = drag.overSlot;
    cancelDrag();

    if (lifted) {
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 150);
      if (overSlot) performAssign(cardId, overSlot.getAttribute("data-slot-id"));
    }
  });

  document.addEventListener("pointercancel", function (e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    var lifted = drag.lifted;
    cancelDrag();
    if (lifted) {
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 150);
    }
  });

  // 提起后阻止页面滚动（touch-action: pan-y 之外的兜底）
  document.addEventListener("touchmove", function (e) {
    if (drag && drag.lifted) e.preventDefault();
  }, { passive: false });

  document.addEventListener("contextmenu", function (e) {
    if (drag && drag.lifted) e.preventDefault();
  });

  /* ================= 初始化 ================= */

  load();
  document.body.setAttribute("data-view", state.view);
  applyPoolTheme();
  renderTabBar();
  renderPresetButtons();
  renderRegionMap();
  renderAll();
})();
