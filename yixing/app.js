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
  var DEFAULT_PLACES = YXD.places || [];   // 仓库自带的默认卡池（只读种子，「恢复默认」用它）
  var PLACES = [];                         // 工作卡池：首访从默认播种，之后存 localStorage，可增删改
  var EDGES = YXD.transportEdges || [];
  var BLOCKED = YXD.blockedEdges || [];
  var PRESETS = YXD.presets || [];
  var REGION_TIMES = YXD.regionTimes || {};
  var SAME_REGION = YXD.sameRegionTime || null;
  var REGION_COORDS = YXD.regionCoords || {};
  var REGION_MAP_EDGES = YXD.regionMapEdges || [];

  var STORAGE_KEY = "yixing-draft-v1";
  var POOL_KEY = "yixing-pool-v1";   // 用户的工作卡池（菜单）持久化位置
  var THEMES = ["dingshu", "spring", "bamboo-water", "food", "night"];
  var VIEWS = ["intro", "pool", "plan", "graph"]; // 移动端四个子页；桌面端三栏并排
  var HEAVY_EDGE_MIN = 60; // 达到这个分钟数即提示“移动偏重”

  // 行程是一个“自动日历”：每天一个有序队列，事件按预估时长自动向后叠放，
  // 相邻地点之间自动插入交通段并推后时钟；← → 在天与天之间切换。
  // 行程日期：7 月 25 日（周六）为主日，周五晚可提前到，周一午后返程
  var DAYS = [
    { id: "arrival", label: "July 24 Fri", startMin: 19 * 60, hasStay: false, hint: "到达当晚的缓冲段（周六早到则留白）" },
    { id: "d1", label: "July 25 Sat", startMin: 9 * 60, hasStay: true },
    { id: "d2", label: "July 26 Sun", startMin: 9 * 60, hasStay: true },
    { id: "d3", label: "July 27 Mon", startMin: 9 * 60, hasStay: false, hint: "午餐后返程" }
  ];
  var dayById = {};
  DAYS.forEach(function (d) { dayById[d.id] = d; });

  // 行程格式（“模板”只管结构）：fri = 含周五晚到达页；sat = 周六早到，无到达页
  function activeDays() {
    return state.tripFormat === "sat"
      ? DAYS.filter(function (d) { return d.id !== "arrival"; })
      : DAYS;
  }

  var DAY_END_WARN_MIN = 22 * 60; // 排到这个点之后提示“偏满”
  var CAL_PX_PER_MIN = 1.1;       // 日历块高度与分钟的比例

  function timeLabel(min) {
    var h = Math.floor(min / 60);
    var m = min % 60;
    return (h < 10 ? "0" + h : "" + h) + ":" + (m < 10 ? "0" + m : "" + m);
  }

  var THEME_GROUPS = [
    { theme: "dingshu", label: "丁蜀 · 泥与窑火" },
    { theme: "spring", label: "春日 · 茶与田野" },
    { theme: "bamboo-water", label: "竹洞水 · 清凉" },
    { theme: "food", label: "餐饮 · 不分早晚" },
    { theme: "night", label: "夜晚 · 住宿 / 自由" }
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

  var cardById = {};   // 由 rebuildIndex() 依据当前 PLACES 重建（见「卡池」一节）

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

  // 相邻两张卡之间的交通段（日历排时用）；null 表示不加交通（自由时间等）
  function travelSegment(prevCard, nextCard) {
    if (!isRouteNode(prevCard) || !isRouteNode(nextCard)) return null;
    var edge = findDirectEdge(prevCard.id, nextCard.id, EDGES);
    if (edge) {
      return { minutes: edge.minutes || 0, label: edge.label + " · " + (MODE_LABELS[edge.mode] || edge.mode), est: false };
    }
    var blocked = findBlockedEdge(prevCard.id, nextCard.id, BLOCKED);
    if (blocked) {
      var via = (blocked.suggestedVia || []).map(function (id) { return cardById[id] ? cardById[id].title : id; });
      return { minutes: 60, label: "需单独确认（暂按 60 分）" + (via.length ? " · 建议中转 " + via.join("、") : ""), est: true, broken: true };
    }
    var est = regionEstimate(prevCard, nextCard, REGION_TIMES, SAME_REGION);
    if (est) {
      return { minutes: est.minutes, label: "约 " + est.range[0] + "-" + est.range[1] + " 分（" + (est.same ? "同区" : "区域") + "粗估）· 打车", est: true };
    }
    return { minutes: 45, label: "需单独确认（暂按 45 分）", est: true, broken: true };
  }

  // 一天的自动叠放：事件按时长顺排，地点变化时插入交通段并推后时钟。
  // 交通按“上一个真实地点”计算：自由时间/缓冲（原地）夹在中间不吞掉那段路。
  function buildDaySchedule(dayId) {
    var day = dayById[dayId];
    var blocks = [];
    var t = day.startMin;
    var travelTotal = 0;
    var prevRoute = null;
    state.days[dayId].forEach(function (id) {
      var card = cardById[id];
      if (!card) return;
      if (prevRoute && isRouteNode(card)) {
        var seg = travelSegment(prevRoute, card);
        if (seg && seg.minutes > 0) {
          blocks.push({ type: "travel", start: t, end: t + seg.minutes, seg: seg });
          t += seg.minutes;
          travelTotal += seg.minutes;
        }
      }
      var dur = card.durationMin || 0;
      blocks.push({ type: "event", card: card, start: t, end: t + dur });
      t += dur;
      if (isRouteNode(card)) prevRoute = card;
    });
    return { day: day, blocks: blocks, endMin: t, travelTotal: travelTotal, empty: blocks.length === 0 };
  }

  /* ================= 3. 状态与持久化 ================= */

  // filter：感官菜单的双重角色之二 —— 筛选卡片池（"all" 或某个主题）。
  // days：每天的有序卡片队列；stays：Day 1/2 的住宿位；activeDay：日历当前页。
  var state = {
    filter: "all", view: "intro", activeDay: "d1", tripFormat: "fri",
    days: { arrival: [], d1: [], d2: [], d3: [] },
    stays: { d1: null, d2: null }
  };

  // 点选拼配：selection = { cardId } 或 null
  var selection = null;

  function findCardLoc(cardId) {
    for (var i = 0; i < DAYS.length; i += 1) {
      var idx = state.days[DAYS[i].id].indexOf(cardId);
      if (idx !== -1) return { kind: "day", day: DAYS[i].id, index: idx };
    }
    if (state.stays.d1 === cardId) return { kind: "stay", day: "d1" };
    if (state.stays.d2 === cardId) return { kind: "stay", day: "d2" };
    return null;
  }

  function removeCardEverywhere(cardId) {
    DAYS.forEach(function (d) {
      var idx = state.days[d.id].indexOf(cardId);
      if (idx !== -1) state.days[d.id].splice(idx, 1);
    });
    if (state.stays.d1 === cardId) state.stays.d1 = null;
    if (state.stays.d2 === cardId) state.stays.d2 = null;
  }

  // 全程顺序：到达（若含）→ Day1 → 住宿1 → Day2 → 住宿2 → Day3（路线图沿用）
  function selectedItems() {
    var ids = [];
    activeDays().forEach(function (d) {
      ids = ids.concat(state.days[d.id]);
      if (d.hasStay && state.stays[d.id]) ids.push(state.stays[d.id]);
    });
    return ids.map(function (id) { return cardById[id]; }).filter(Boolean);
  }

  function draftIsEmpty() {
    var empty = true;
    DAYS.forEach(function (d) { if (state.days[d.id].length) empty = false; });
    if (state.stays.d1 || state.stays.d2) empty = false;
    return empty;
  }

  // 清洗一份草稿（模板 / 导入 / 旧存档共用）：只保留认识的卡，去重
  function normalizedDraft(rawDays, rawStays) {
    var seen = {};
    var days = { arrival: [], d1: [], d2: [], d3: [] };
    var stays = { d1: null, d2: null };
    DAYS.forEach(function (d) {
      var list = rawDays && Array.isArray(rawDays[d.id]) ? rawDays[d.id] : [];
      list.forEach(function (id) {
        if (typeof id === "string" && cardById[id] && !seen[id]) {
          days[d.id].push(id);
          seen[id] = true;
        }
      });
    });
    ["d1", "d2"].forEach(function (d) {
      var id = rawStays ? rawStays[d] : null;
      if (typeof id === "string" && cardById[id] && !seen[id]) {
        stays[d] = id;
        seen[id] = true;
      }
    });
    return { days: days, stays: stays, any: Object.keys(seen).length > 0 };
  }

  // 旧版槽位制草稿 / 导出文件的转换：按槽位 id 前缀与时间顺序归入对应天
  function convertV1Slots(slots) {
    var rawDays = { arrival: [], d1: [], d2: [], d3: [] };
    var rawStays = { d1: slots.stay1 || null, d2: slots.stay2 || null };
    Object.keys(slots).sort().forEach(function (sid) {
      var id = slots[sid];
      if (!id || sid === "stay1" || sid === "stay2") return;
      if (sid === "arrival") rawDays.arrival.push(id);
      else if (/^d1-/.test(sid)) rawDays.d1.push(id);
      else if (/^d2-/.test(sid)) rawDays.d2.push(id);
      else if (/^d3-/.test(sid) || sid === "return") rawDays.d3.push(id);
    });
    return { days: rawDays, stays: rawStays };
  }

  /* ---------- 卡池（菜单）：首访从仓库默认播种，之后存 localStorage，可增删改 ---------- */

  var CARD_TYPES = ["place", "experience", "food", "stay", "free-time", "buffer"];
  var HEAT_LEVELS = ["none", "low", "medium", "high"];
  var BEST_TIMES = ["morning", "afternoon", "evening", "night"];

  function rebuildIndex() {
    cardById = {};
    PLACES.forEach(function (p) { cardById[p.id] = p; });
  }

  function genCardId() {
    return "card-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 46656).toString(36);
  }

  function defaultRole(type) {
    if (type === "stay") return "stay";
    if (type === "food") return "food";
    if (type === "free-time" || type === "buffer") return "buffer";
    return "optional";
  }

  function str(v) { return typeof v === "string" ? v : ""; }

  // 把任意来源（默认数据 / 导入文件 / 表单）的卡片补全字段并校验；坏卡返回 null。
  function normalizeCard(raw) {
    if (!raw || typeof raw !== "object") return null;
    var title = str(raw.title).trim();
    if (!title) return null;
    var type = CARD_TYPES.indexOf(raw.type) !== -1 ? raw.type : "place";
    var theme = str(raw.theme) || "night"; // 未知主题保留，renderPool 有「其他」兜底组
    var loc = str(raw.locationCode) || "TBD";
    var dur = (typeof raw.durationMin === "number" && raw.durationMin >= 0)
      ? Math.round(raw.durationMin) : (type === "stay" ? 0 : 60);
    var best = Array.isArray(raw.bestTime)
      ? raw.bestTime.filter(function (t) { return BEST_TIMES.indexOf(t) !== -1; }) : [];
    if (!best.length) best = ["afternoon"];
    var card = {
      id: str(raw.id).trim() || genCardId(),
      title: title,
      type: type,
      theme: theme,
      locationCode: loc,
      cardRole: str(raw.cardRole) || defaultRole(type),
      durationMin: dur,
      bestTime: best,
      tags: Array.isArray(raw.tags) ? raw.tags.filter(function (t) { return typeof t === "string"; }) : [],
      reservationNeeded: !!raw.reservationNeeded,
      heatRisk: HEAT_LEVELS.indexOf(raw.heatRisk) !== -1 ? raw.heatRisk : "none",
      experienceValue: typeof raw.experienceValue === "number" ? raw.experienceValue : 3,
      visualValue: typeof raw.visualValue === "number" ? raw.visualValue : 3,
      budgetLevel: str(raw.budgetLevel) || "$",
      groupFit: str(raw.groupFit) || "all-four",
      summary: str(raw.summary),
      cautions: Array.isArray(raw.cautions) ? raw.cautions.filter(function (c) { return typeof c === "string"; }) : [],
      sourceLinks: Array.isArray(raw.sourceLinks) ? raw.sourceLinks : []
    };
    if (raw.pending) card.pending = true;
    if (raw.mapNode === null) card.mapNode = null;
    else if (raw.mapNode && typeof raw.mapNode === "object") card.mapNode = raw.mapNode;
    else card.mapNode = (loc === "CURRENT" || type === "free-time" || type === "buffer")
      ? null : { shortLabel: title.slice(0, 4), cluster: theme, importance: 2 };
    if (type === "stay") {
      card.roomPlan = str(raw.roomPlan) || "2 rooms / 4 people";
      card.priceLevel = str(raw.priceLevel) || "$";
      card.vibe = str(raw.vibe);
    }
    return card;
  }

  function normalizePool(arr) {
    if (!Array.isArray(arr)) return [];
    var seen = {}, out = [];
    arr.forEach(function (raw) {
      var c = normalizeCard(raw);
      if (c && !seen[c.id]) { seen[c.id] = true; out.push(c); }
    });
    return out;
  }

  function persistPool() {
    try {
      localStorage.setItem(POOL_KEY, JSON.stringify({ v: 1, site: "yixing", kind: "pool", places: PLACES }));
    } catch (err) { /* 隐私模式等场景静默失败 */ }
  }

  function loadPool() {
    var raw = null;
    try { raw = localStorage.getItem(POOL_KEY); } catch (err) { /* ignore */ }
    var arr = null;
    if (raw) {
      try {
        var d = JSON.parse(raw);
        arr = Array.isArray(d) ? d : (d && Array.isArray(d.places) ? d.places : null);
      } catch (err) { /* 坏数据 → 落到默认 */ }
    }
    var pool = arr ? normalizePool(arr) : [];
    if (!pool.length) pool = normalizePool(DEFAULT_PLACES); // 首访 / 空 / 坏文件 → 仓库默认
    PLACES = pool;
    rebuildIndex();
  }

  // 卡池增删后：把行程里已不存在的卡一并清掉，避免留下渲染时被跳过的孤儿 id
  function purgeMissingFromDraft() {
    var changed = false;
    DAYS.forEach(function (d) {
      var before = state.days[d.id].length;
      state.days[d.id] = state.days[d.id].filter(function (id) { return cardById[id]; });
      if (state.days[d.id].length !== before) changed = true;
    });
    ["d1", "d2"].forEach(function (d) {
      if (state.stays[d] && !cardById[state.stays[d]]) { state.stays[d] = null; changed = true; }
    });
    if (changed) save();
  }

  function currentGraph() {
    return buildRouteGraph(selectedItems(), EDGES, BLOCKED, REGION_TIMES, SAME_REGION);
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        v: 2, filter: state.filter, view: state.view, activeDay: state.activeDay,
        tripFormat: state.tripFormat, days: state.days, stays: state.stays
      }));
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
    if (data.tripFormat === "fri" || data.tripFormat === "sat") state.tripFormat = data.tripFormat;
    if (dayById[data.activeDay]) state.activeDay = data.activeDay;
    if (state.tripFormat === "sat" && state.activeDay === "arrival") state.activeDay = "d1";

    var raw = null;
    if (data.days && typeof data.days === "object") raw = { days: data.days, stays: data.stays || {} };
    else if (data.slots && typeof data.slots === "object") raw = convertV1Slots(data.slots);
    if (raw) {
      var n = normalizedDraft(raw.days, raw.stays);
      state.days = n.days;
      state.stays = n.stays;
    }
  }

  /* ================= 4. 渲染 ================= */

  var poolEl = document.getElementById("card-pool");
  var dayCanvasEl = document.getElementById("day-canvas");
  var dayTitleEl = document.getElementById("day-title");
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
    var used = findCardLoc(card.id);
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
    var right = el("div", "card-top-right");
    var dur = durationText(card);
    if (dur) right.appendChild(el("span", "card-duration", dur));
    var editBtn = el("button", "card-edit-btn", "编辑");
    editBtn.type = "button";
    editBtn.setAttribute("data-edit-card", card.id);
    right.appendChild(editBtn);
    top.appendChild(right);
    node.appendChild(top);

    if (card.summary) node.appendChild(el("p", "card-summary", card.summary));

    var meta = el("div", "card-meta");
    meta.appendChild(chip(locLabel(card.locationCode), "chip chip-loc"));
    meta.appendChild(chip(TYPE_LABELS[card.type] || card.type));
    if (card.reservationNeeded) meta.appendChild(chip("需预约", "badge badge-res"));
    if (card.heatRisk === "medium") meta.appendChild(chip("偏晒", "badge badge-heat"));
    if (card.heatRisk === "high") meta.appendChild(chip("暴晒", "badge badge-heat"));
    if (card.pending) meta.appendChild(chip("待确认", "badge badge-tbc"));
    if (used) meta.appendChild(chip("已在 " + dayById[used.day].label + (used.kind === "stay" ? " 住宿" : ""), "chip chip-assigned"));
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
    // 兜底：主题不在四感官里的卡（导入或改过的）也要看得到、能编辑
    if (state.filter === "all") {
      var others = PLACES.filter(function (p) { return THEMES.indexOf(p.theme) === -1; });
      if (others.length) {
        var w = el("section", "pool-group");
        w.appendChild(el("h3", "pool-group-title", "其他"));
        var l = el("div", "pool-cards");
        others.forEach(function (card) { l.appendChild(buildCardEl(card)); });
        w.appendChild(l);
        poolEl.appendChild(w);
      }
    }
  }

  // 事件块上的即时提醒（按自动排出的实际时段判断）
  function calWarnings(block) {
    var card = block.card;
    var items = [];
    if ((card.heatRisk === "medium" || card.heatRisk === "high") && block.start < 16 * 60 && block.end > 12 * 60) {
      items.push({ text: "正午偏晒时段", cls: "badge badge-heat" });
    }
    if (card.reservationNeeded) {
      items.push({ text: "需预约", cls: "badge badge-res" });
    }
    return items;
  }

  function buildEventBlock(block) {
    var card = block.card;
    var cls = "cal-event" + (selection && selection.cardId === card.id ? " card--selected" : "");
    var node = el("article", cls);
    node.setAttribute("data-card-id", card.id);
    node.setAttribute("data-drag-card", "");
    node.setAttribute("data-card-theme", card.theme);
    var dur = card.durationMin || 0;
    node.style.minHeight = Math.max(34, Math.min(240, dur * CAL_PX_PER_MIN)) + "px";

    var head = el("div", "cal-event-head");
    head.appendChild(el("span", "cal-time", timeLabel(block.start) + (dur ? " – " + timeLabel(block.end) : "")));
    var removeBtn = el("button", "slot-remove", "移出");
    removeBtn.setAttribute("type", "button");
    removeBtn.setAttribute("data-remove-card", card.id);
    removeBtn.setAttribute("aria-label", "把「" + card.title + "」移出行程");
    head.appendChild(removeBtn);
    node.appendChild(head);

    node.appendChild(el("div", "cal-event-title", card.title));

    var meta = el("div", "card-meta");
    meta.appendChild(chip(locLabel(card.locationCode), "chip chip-loc"));
    if (dur) meta.appendChild(chip("约 " + dur + " 分"));
    if (card.pending) meta.appendChild(chip("待确认", "badge badge-tbc"));
    calWarnings(block).forEach(function (w) { meta.appendChild(chip(w.text, w.cls)); });
    node.appendChild(meta);
    return node;
  }

  function buildTravelBlock(block) {
    var cls = "cal-travel" + (block.seg.broken ? " cal-travel--broken" : (block.seg.est ? " cal-travel--est" : ""));
    var node = el("div", cls);
    node.style.minHeight = Math.max(20, Math.min(90, block.seg.minutes * CAL_PX_PER_MIN * 0.8)) + "px";
    node.appendChild(el("span", null, timeLabel(block.start) + " · " + block.seg.label));
    return node;
  }

  function stepDay(delta) {
    var list = activeDays();
    var idx = list.indexOf(dayById[state.activeDay]);
    if (idx === -1) idx = 0;
    idx = Math.max(0, Math.min(list.length - 1, idx + delta));
    state.activeDay = list[idx].id;
    save();
    renderDay();
  }

  function renderDay() {
    var list = activeDays();
    if (list.indexOf(dayById[state.activeDay]) === -1) state.activeDay = "d1";
    var day = dayById[state.activeDay];
    var idx = list.indexOf(day);
    dayTitleEl.textContent = day.label + (day.hint ? " · " + day.hint : "");
    var prevBtn = document.querySelector('[data-day-nav="-1"]');
    var nextBtn = document.querySelector('[data-day-nav="1"]');
    if (prevBtn) prevBtn.disabled = idx === 0;
    if (nextBtn) nextBtn.disabled = idx === list.length - 1;

    dayCanvasEl.innerHTML = "";
    var sched = buildDaySchedule(day.id);
    if (sched.empty) {
      dayCanvasEl.appendChild(el("p", "cal-empty", "留白。点选或拖一张卡到这里，从 " + timeLabel(day.startMin) + " 开始自动排。"));
    } else {
      sched.blocks.forEach(function (b) {
        dayCanvasEl.appendChild(b.type === "event" ? buildEventBlock(b) : buildTravelBlock(b));
      });
      var sumText = "结束于 " + timeLabel(sched.endMin)
        + (sched.travelTotal ? " · 交通合计约 " + sched.travelTotal + " 分（估）" : "");
      var warnFull = sched.endMin > DAY_END_WARN_MIN;
      var sumEl = el("p", "cal-summary" + (warnFull ? " cal-summary--warn" : ""), sumText + (warnFull ? " · 排得偏满" : ""));
      dayCanvasEl.appendChild(sumEl);
    }

    if (day.hasStay) {
      var stayId = state.stays[day.id];
      var stayCard = stayId ? cardById[stayId] : null;
      var stayWrap = el("div", "cal-stay" + (stayCard ? "" : " cal-stay--empty"));
      stayWrap.setAttribute("data-stay-drop", day.id);
      if (stayCard) {
        stayWrap.setAttribute("data-card-id", stayCard.id);
        stayWrap.setAttribute("data-drag-card", "");
        stayWrap.setAttribute("data-card-theme", stayCard.theme);
        if (selection && selection.cardId === stayCard.id) stayWrap.className += " card--selected";
        stayWrap.appendChild(el("span", "cal-stay-title", "住宿 · " + stayCard.title));
        var rm = el("button", "slot-remove", "移出");
        rm.setAttribute("type", "button");
        rm.setAttribute("data-remove-card", stayCard.id);
        stayWrap.appendChild(rm);
      } else {
        stayWrap.appendChild(el("span", null, "住宿：把住宿卡放到这里"));
      }
      dayCanvasEl.appendChild(stayWrap);
    }
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
    var loc = findCardLoc(card.id);
    if (loc) text.appendChild(el("span", "graph-node-slot", dayById[loc.day].label + (loc.kind === "stay" ? " · 住宿" : "")));
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

    // 动线层：在参考线之上、节点之下（updateRegionRoutes 动态填充）
    var routesG = document.createElementNS(svgNS, "g");
    routesG.setAttribute("id", "region-routes");
    svg.appendChild(routesG);

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
    updateRegionRoutes();
  }

  /* ---------- 概览图动线：按天着色的方向路线 ---------- */

  // 每天的区域路径：本天事件按顺序取区域并去连续重复；
  // 住宿收尾，且作为第二天的起点（跨天动线经由住宿衔接）
  function dayRegionPaths() {
    var paths = [];
    var prevStayRegion = null;
    activeDays().forEach(function (d) {
      var regions = [];
      if (prevStayRegion) regions.push(prevStayRegion);
      state.days[d.id].forEach(function (id) {
        var c = cardById[id];
        if (!c || !isRouteNode(c)) return;
        var code = c.locationCode;
        if (!REGION_COORDS[code]) return; // TBD 等没有坐标的不画
        if (regions[regions.length - 1] !== code) regions.push(code);
      });
      if (d.hasStay) {
        var stayCard = state.stays[d.id] ? cardById[state.stays[d.id]] : null;
        if (stayCard && REGION_COORDS[stayCard.locationCode]) {
          if (regions[regions.length - 1] !== stayCard.locationCode) regions.push(stayCard.locationCode);
          prevStayRegion = stayCard.locationCode;
        } else {
          prevStayRegion = null;
        }
      }
      if (regions.length >= 2) paths.push({ day: d, regions: regions });
    });
    return paths;
  }

  var regionFocusDay = null; // 图例上被点选“单独看”的那天（null = 全部）

  function updateRegionRoutes() {
    var g = document.getElementById("region-routes");
    var legend = document.getElementById("region-legend");
    if (!g) return;
    var svgNS = "http://www.w3.org/2000/svg";
    g.innerHTML = "";
    if (legend) legend.innerHTML = "";

    var paths = dayRegionPaths();
    paths.forEach(function (p) {
      var idx = DAYS.indexOf(p.day);
      var off = (idx - 1.5) * 2.4; // 每天一条平行偏移，重叠路段不会互相盖死
      var cls = p.day.id;
      for (var i = 0; i < p.regions.length - 1; i += 1) {
        var a = REGION_COORDS[p.regions[i]];
        var b = REGION_COORDS[p.regions[i + 1]];
        var dx = b.x - a.x;
        var dy = b.y - a.y;
        var len = Math.hypot(dx, dy) || 1;
        var ux = dx / len;
        var uy = dy / len;
        var px = -uy;
        var py = ux;
        var trim = len > 26 ? 9 : 4; // 两端缩进，别压住节点圆点
        var x1 = a.x + ux * trim + px * off;
        var y1 = a.y + uy * trim + py * off;
        var x2 = b.x - ux * trim + px * off;
        var y2 = b.y - uy * trim + py * off;

        var line = document.createElementNS(svgNS, "line");
        line.setAttribute("x1", x1);
        line.setAttribute("y1", y1);
        line.setAttribute("x2", x2);
        line.setAttribute("y2", y2);
        line.setAttribute("class", "region-route region-route--" + cls);
        g.appendChild(line);

        // 段中点的方向箭头
        var mx = (x1 + x2) / 2;
        var my = (y1 + y2) / 2;
        var tri = document.createElementNS(svgNS, "path");
        tri.setAttribute("d",
          "M" + (mx + ux * 4.5) + " " + (my + uy * 4.5) +
          "L" + (mx - ux * 2.5 + px * 3) + " " + (my - uy * 2.5 + py * 3) +
          "L" + (mx - ux * 2.5 - px * 3) + " " + (my - uy * 2.5 - py * 3) + "Z");
        tri.setAttribute("class", "region-arrow region-arrow--" + cls);
        g.appendChild(tri);
      }
      if (legend) {
        var lg = el("span", "region-legend-item region-legend--" + cls, p.day.label);
        lg.setAttribute("data-hi-day", cls); // 悬浮此项时高亮当天动线
        legend.appendChild(lg);
      }
    });

    if (legend && !paths.length) {
      legend.appendChild(el("span", "region-legend-item", "放入两个不同区域的地点后，动线会按天画在图上"));
    }

    // 提示只在真有动线时出现；动线一变就清掉之前固定的“单独看”
    var hint = document.getElementById("region-legend-hint");
    if (hint) hint.hidden = !paths.length;
    regionFocusDay = null;
    if (legend) { var ov = legend.closest(".region-overview"); if (ov) ov.removeAttribute("data-hi"); }
  }

  // 图例上的某天：点一下“单独看”它的动线（触屏主路径），桌面端悬停可预览。
  // data-hi 挂在 .region-overview 上，CSS 据此高亮该天、淡化其余。
  function setupRegionLegendHover() {
    var legend = document.getElementById("region-legend");
    var overview = legend ? legend.closest(".region-overview") : null;
    if (!legend || !overview) return;
    function applyFocus() {
      if (regionFocusDay) overview.setAttribute("data-hi", regionFocusDay);
      else overview.removeAttribute("data-hi");
    }
    legend.addEventListener("click", function (e) {
      var item = e.target.closest("[data-hi-day]");
      if (!item) return;
      var day = item.getAttribute("data-hi-day");
      regionFocusDay = (regionFocusDay === day) ? null : day; // 再点一次取消
      applyFocus();
    });
    legend.addEventListener("mouseover", function (e) {
      var item = e.target.closest("[data-hi-day]");
      if (item) overview.setAttribute("data-hi", item.getAttribute("data-hi-day")); // 悬停预览
    });
    legend.addEventListener("mouseleave", applyFocus); // 离开后回到固定的那天（或全部）
  }

  function renderHintBar() {
    if (!selection) {
      hintBarEl.hidden = true;
      return;
    }
    var card = cardById[selection.cardId];
    var from = findCardLoc(selection.cardId);
    hintTextEl.textContent = (from ? "移动「" : "已选「") + card.title
      + "」— 点日历空白排到最后，点已有卡插到它前面";
    hintBarEl.hidden = false;
  }

  function renderFormatButtons() {
    var btns = document.querySelectorAll("[data-format]");
    for (var i = 0; i < btns.length; i += 1) {
      btns[i].setAttribute("aria-pressed", btns[i].getAttribute("data-format") === state.tripFormat ? "true" : "false");
    }
  }

  // 方案行：内置示例 + 用户保存的（带删除 ×）
  function renderPresetButtons() {
    presetWrapEl.innerHTML = "";
    PRESETS.forEach(function (preset) {
      var btn = el("button", null, preset.title);
      btn.setAttribute("type", "button");
      btn.setAttribute("data-plan", "preset:" + preset.id);
      presetWrapEl.appendChild(btn);
    });
    loadSavedPlans().forEach(function (plan) {
      var wrap = el("span", "saved-plan");
      var btn = el("button", null, plan.title);
      btn.setAttribute("type", "button");
      btn.setAttribute("data-plan", "saved:" + plan.id);
      wrap.appendChild(btn);
      var del = el("button", "saved-plan-del", "×");
      del.setAttribute("type", "button");
      del.setAttribute("data-del-plan", plan.id);
      del.setAttribute("aria-label", "删除方案「" + plan.title + "」");
      wrap.appendChild(del);
      presetWrapEl.appendChild(wrap);
    });
  }

  function renderAll() {
    renderPool();
    renderDay();
    renderRouteGraph();
    renderHintBar();
    renderThemeMenu();
    renderFormatButtons();
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

  function draftSnapshot() {
    return JSON.parse(JSON.stringify({ days: state.days, stays: state.stays, tripFormat: state.tripFormat }));
  }

  function undoAssign(u) {
    state.days = u.snap.days;
    state.stays = u.snap.stays;
    if (u.snap.tripFormat) state.tripFormat = u.snap.tripFormat;
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

  /**
   * 把卡放进日历。target: { day, beforeId?, stay? }
   * - 住宿卡自动进该天的住宿位（替换原有）；
   * - beforeId 指定插到某张卡前面，否则排到当天最后；
   * - 已在行程里的卡等于移动（先移除再插入）。
   */
  function placeCard(cardId, target) {
    var card = cardById[cardId];
    var day = dayById[target.day];
    if (!card || !day) return;
    if (target.beforeId === cardId) { clearSelection(); renderAll(); return; }

    var snap = draftSnapshot();
    var msg = null;
    var kind = null;

    if (card.type === "stay") {
      if (!day.hasStay) {
        toast("「" + card.title + "」是住宿卡，" + day.label + " 没有住宿位", "warn");
        return;
      }
      removeCardEverywhere(cardId);
      var displaced = state.stays[day.id];
      state.stays[day.id] = cardId;
      msg = displaced && cardById[displaced]
        ? "已替换 " + day.label + " 住宿「" + cardById[displaced].title + "」"
        : "已设为 " + day.label + " 住宿";
    } else if (target.stay) {
      toast("住宿位只放住宿卡", "warn");
      return;
    } else {
      removeCardEverywhere(cardId);
      var list = state.days[day.id];
      var idx = target.beforeId ? list.indexOf(target.beforeId) : -1;
      if (idx === -1) list.push(cardId);
      else list.splice(idx, 0, cardId);
      msg = "已放入 " + day.label;
    }

    // 放置后按自动排出的时段给一条即时提醒（正午暴晒 / 预约）
    var sched = buildDaySchedule(day.id);
    for (var i = 0; i < sched.blocks.length; i += 1) {
      var b = sched.blocks[i];
      if (b.type === "event" && b.card.id === cardId) {
        var warns = calWarnings(b);
        if (warns.length) {
          msg = "「" + card.title + "」" + warns[0].text;
          if (warns[0].cls.indexOf("heat") !== -1) kind = "warn";
        }
        break;
      }
    }

    clearSelection();
    save();
    renderAll();
    var undoData = { snap: snap };
    if (isMobile()) showSnackbar(msg, kind, undoData);
    else toast(msg, kind);
  }

  function removeCard(cardId) {
    if (!findCardLoc(cardId)) return;
    hideSnackbar(); // 行程又变了，旧的撤销快照作废
    removeCardEverywhere(cardId);
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
    // 克隆只是视觉残影：剥掉语义属性，避免被选择器 / 命中测试当成真卡
    ghost.removeAttribute("data-card-id");
    ghost.removeAttribute("data-drag-card");
    ghost.removeAttribute("data-stay-drop");
    ghost.style.left = rect.left + "px";
    ghost.style.top = rect.top + "px";
    ghost.style.width = rect.width + "px";
    document.body.appendChild(ghost);
    var dx = window.innerWidth / 2 - (rect.left + rect.width / 2);
    var dy = window.innerHeight - 96 - rect.top;
    void ghost.offsetHeight; // 强制 reflow，让 transition 有起点（不依赖 rAF）
    ghost.style.transform = "translate(" + dx + "px, " + dy + "px) scale(0.4)";
    ghost.style.opacity = "0";
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

  /* ---------- 格式与方案 ----------
     “模板”只管格式（有没有周五晚）；“方案”是完整行程：
     内置示例 + 用户保存在 localStorage 的方案，载入前防覆盖。 */

  function setTripFormat(fmt) {
    if (fmt !== "fri" && fmt !== "sat") return;
    if (fmt === state.tripFormat) return;
    if (fmt === "sat" && state.days.arrival.length) {
      var ok = window.confirm("切换到周六早到会去掉周五到达页，其中 " + state.days.arrival.length + " 张卡将移回菜单。继续？");
      if (!ok) { renderFormatButtons(); return; }
      state.days.arrival = [];
    }
    state.tripFormat = fmt;
    if (state.tripFormat === "sat" && state.activeDay === "arrival") state.activeDay = "d1";
    hideSnackbar();
    save();
    renderAll();
  }

  var PLANS_KEY = "yixing-saved-plans-v1";

  function loadSavedPlans() {
    try {
      var raw = localStorage.getItem(PLANS_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (err) { return []; }
  }

  function persistSavedPlans(list) {
    try { localStorage.setItem(PLANS_KEY, JSON.stringify(list)); } catch (err) { /* 存不进就算了 */ }
  }

  function saveCurrentPlan(title) {
    var list = loadSavedPlans();
    list.unshift({
      id: "p" + Date.now(),
      title: title,
      format: state.tripFormat,
      days: state.days,
      stays: state.stays
    });
    if (list.length > 12) list.length = 12; // 别让缓存无限膨胀
    persistSavedPlans(list);
    renderPresetButtons();
    toast("已保存「" + title + "」");
  }

  function deleteSavedPlan(planId) {
    var list = loadSavedPlans();
    var plan = null;
    for (var i = 0; i < list.length; i += 1) if (list[i].id === planId) plan = list[i];
    if (!plan) return;
    if (!window.confirm("删除方案「" + plan.title + "」？")) return;
    persistSavedPlans(list.filter(function (p) { return p.id !== planId; }));
    renderPresetButtons();
    toast("已删除「" + plan.title + "」");
  }

  function findPlan(ref) {
    var i;
    if (ref.indexOf("preset:") === 0) {
      var pid = ref.slice(7);
      for (i = 0; i < PRESETS.length; i += 1) if (PRESETS[i].id === pid) return PRESETS[i];
    } else if (ref.indexOf("saved:") === 0) {
      var sid = ref.slice(6);
      var list = loadSavedPlans();
      for (i = 0; i < list.length; i += 1) if (list[i].id === sid) return list[i];
    }
    return null;
  }

  function applyPlan(plan) {
    if (!plan) return;
    // 防冲洗：当前有内容时先确认（可先用「保存当前」存档）
    if (!draftIsEmpty()) {
      var ok = window.confirm("载入「" + plan.title + "」会替换当前行程；不想丢的话可以先点「保存当前」。继续？");
      if (!ok) return;
    }
    hideSnackbar();
    var snap = draftSnapshot();
    var n = normalizedDraft(plan.days || {}, plan.stays || {});
    state.days = n.days;
    state.stays = n.stays;
    if (plan.format === "fri" || plan.format === "sat") state.tripFormat = plan.format;
    state.activeDay = "d1";
    clearSelection();
    save();
    renderAll();
    var msg = "已载入「" + plan.title + "」";
    if (isMobile()) showSnackbar(msg, null, { snap: snap });
    else toast(msg);
  }

  /* 保存方案的取名弹窗 */

  var saveOverlayEl = document.getElementById("save-overlay");
  var planNameInputEl = document.getElementById("plan-name-input");

  function openSaveOverlay() {
    if (draftIsEmpty()) { toast("行程还是空的，先拼一点再保存"); return; }
    planNameInputEl.value = "";
    planNameInputEl.placeholder = "我的方案 " + (loadSavedPlans().length + 1);
    saveOverlayEl.hidden = false;
    planNameInputEl.focus();
  }

  function closeSaveOverlay() {
    saveOverlayEl.hidden = true;
  }

  function confirmSaveOverlay() {
    var title = planNameInputEl.value.trim() || planNameInputEl.placeholder;
    closeSaveOverlay();
    saveCurrentPlan(title);
  }

  planNameInputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter") confirmSaveOverlay();
    if (e.key === "Escape") closeSaveOverlay();
  });

  saveOverlayEl.addEventListener("click", function (e) {
    if (e.target === saveOverlayEl) closeSaveOverlay(); // 点背景关闭
  });

  /* ---------- 行程的导出 / 导入（本地 JSON 文件，便于朋友间传） ---------- */

  function exportDraft() {
    var payload = { v: 2, site: "yixing", days: state.days, stays: state.stays };
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

  // 先整体校验再落盘：至少要有一张能认出的卡，避免坏文件清空现有行程。
  // 兼容旧版槽位制导出文件（data.slots）。
  function applyImportedSlots(data) {
    if (!data || typeof data !== "object") return false;
    var raw = null;
    if (data.days && typeof data.days === "object") raw = { days: data.days, stays: data.stays || {} };
    else if (data.slots && typeof data.slots === "object") raw = convertV1Slots(data.slots);
    if (!raw) return false;
    var n = normalizedDraft(raw.days, raw.stays);
    if (!n.any) return false;
    state.days = n.days;
    state.stays = n.stays;
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
    state.days = { arrival: [], d1: [], d2: [], d3: [] };
    state.stays = { d1: null, d2: null };
    clearSelection();
    try { localStorage.removeItem(STORAGE_KEY); } catch (err) { /* ignore */ }
    renderAll();
    toast("已清空");
  }

  /* ---------- 菜单（卡池）的编辑 / 导入 / 导出 / 恢复默认 ---------- */

  var cardOverlayEl = document.getElementById("card-overlay");
  var menuImportOverlayEl = document.getElementById("menu-import-overlay");
  var menuImportFileEl = document.getElementById("menu-import-file");
  var editingCardId = null;
  var pendingImportPool = null;

  function fillSelect(sel, entries) {
    if (!sel) return;
    sel.innerHTML = "";
    entries.forEach(function (e) {
      var o = document.createElement("option");
      o.value = e[0];
      o.textContent = e[1];
      sel.appendChild(o);
    });
  }

  function initCardForm() {
    fillSelect(document.getElementById("cf-type"), CARD_TYPES.map(function (t) { return [t, TYPE_LABELS[t] || t]; }));
    fillSelect(document.getElementById("cf-theme"), THEME_GROUPS.map(function (g) { return [g.theme, g.label]; }));
    fillSelect(document.getElementById("cf-loc"), Object.keys(LOC_LABELS).map(function (k) { return [k, LOC_LABELS[k]]; }));
    fillSelect(document.getElementById("cf-heat"), [["none", "无"], ["low", "低"], ["medium", "偏晒"], ["high", "暴晒"]]);
  }

  function openCardEditor(cardId) {
    var c = cardId ? cardById[cardId] : null;
    editingCardId = c ? cardId : null;
    document.getElementById("card-overlay-title").textContent = c ? "编辑卡片" : "新增卡片";
    document.getElementById("cf-title").value = c ? c.title : "";
    document.getElementById("cf-type").value = c ? c.type : "place";
    document.getElementById("cf-theme").value = c && THEMES.indexOf(c.theme) !== -1 ? c.theme : "dingshu";
    document.getElementById("cf-loc").value = c && LOC_LABELS[c.locationCode] ? c.locationCode : "DS";
    document.getElementById("cf-duration").value = c ? (c.durationMin || 0) : 60;
    document.getElementById("cf-heat").value = c ? c.heatRisk : "none";
    document.getElementById("cf-tags").value = c ? (c.tags || []).join("、") : "";
    document.getElementById("cf-summary").value = c ? (c.summary || "") : "";
    document.getElementById("cf-reservation").checked = c ? !!c.reservationNeeded : false;
    document.getElementById("cf-pending").checked = c ? !!c.pending : false;
    var times = c ? (c.bestTime || []) : ["afternoon"];
    var boxes = document.querySelectorAll(".cf-time");
    for (var i = 0; i < boxes.length; i += 1) boxes[i].checked = times.indexOf(boxes[i].value) !== -1;
    document.getElementById("cf-delete").style.display = c ? "" : "none";
    cardOverlayEl.hidden = false;
    document.getElementById("cf-title").focus();
  }

  function closeCardEditor() {
    cardOverlayEl.hidden = true;
    editingCardId = null;
  }

  function collectCardFromForm() {
    var title = document.getElementById("cf-title").value.trim();
    if (!title) { toast("先给卡片起个名字", "warn"); return null; }
    var times = [];
    var boxes = document.querySelectorAll(".cf-time");
    for (var i = 0; i < boxes.length; i += 1) if (boxes[i].checked) times.push(boxes[i].value);
    var tags = document.getElementById("cf-tags").value
      .split(/[、,，\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    var base = (editingCardId && cardById[editingCardId]) ? cardById[editingCardId] : {};
    var merged = {};
    for (var k in base) if (base.hasOwnProperty(k)) merged[k] = base[k]; // 保留进阶字段（价位/评分/mapNode 等）
    merged.id = editingCardId || genCardId();
    merged.title = title;
    merged.type = document.getElementById("cf-type").value;
    merged.theme = document.getElementById("cf-theme").value;
    merged.locationCode = document.getElementById("cf-loc").value;
    merged.durationMin = parseInt(document.getElementById("cf-duration").value, 10) || 0;
    merged.heatRisk = document.getElementById("cf-heat").value;
    merged.bestTime = times.length ? times : ["afternoon"];
    merged.tags = tags;
    merged.summary = document.getElementById("cf-summary").value.trim();
    merged.reservationNeeded = document.getElementById("cf-reservation").checked;
    if (document.getElementById("cf-pending").checked) merged.pending = true;
    else delete merged.pending;
    if (base.mapNode && typeof base.mapNode === "object") delete merged.mapNode; // 让 normalizeCard 按新主题/位置重算
    return normalizeCard(merged);
  }

  function saveCardFromForm() {
    var c = collectCardFromForm();
    if (!c) return;
    var idx = -1;
    for (var i = 0; i < PLACES.length; i += 1) if (PLACES[i].id === c.id) idx = i;
    if (idx !== -1) PLACES[idx] = c; else PLACES.push(c);
    persistPool();
    rebuildIndex();
    closeCardEditor();
    renderAll();
    toast(idx !== -1 ? "已更新「" + c.title + "」" : "已新增「" + c.title + "」");
  }

  function deleteCurrentCard() {
    if (!editingCardId) { closeCardEditor(); return; }
    var c = cardById[editingCardId];
    if (!c) { closeCardEditor(); return; }
    if (!window.confirm("删除卡片「" + c.title + "」？行程里若已放入也会一并移出。")) return;
    var delId = editingCardId;
    PLACES = PLACES.filter(function (p) { return p.id !== delId; });
    removeCardEverywhere(delId);
    persistPool();
    rebuildIndex();
    save();
    closeCardEditor();
    renderAll();
    toast("已删除「" + c.title + "」");
  }

  function exportPool() {
    var payload = { v: 1, site: "yixing", kind: "pool", places: PLACES };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "yixing-menu.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast("已导出菜单文件");
  }

  function applyImportPool(mode) {
    if (!pendingImportPool) return;
    if (mode === "replace") {
      PLACES = pendingImportPool;
    } else {
      var idxById = {};
      PLACES.forEach(function (p, i) { idxById[p.id] = i; });
      pendingImportPool.forEach(function (c) {
        if (idxById[c.id] !== undefined) PLACES[idxById[c.id]] = c;
        else PLACES.push(c);
      });
    }
    pendingImportPool = null;
    menuImportOverlayEl.hidden = true;
    persistPool();
    rebuildIndex();
    purgeMissingFromDraft();
    renderAll();
    toast(mode === "replace" ? "菜单已整体替换" : "菜单已合并追加");
  }

  menuImportFileEl.addEventListener("change", function () {
    var file = menuImportFileEl.files && menuImportFileEl.files[0];
    menuImportFileEl.value = ""; // 允许连续导入同一个文件
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var data = null;
      try { data = JSON.parse(String(reader.result)); } catch (err) { /* 落到下面报错 */ }
      var arr = Array.isArray(data) ? data : (data && Array.isArray(data.places) ? data.places : null);
      var pool = normalizePool(arr);
      if (!pool.length) { toast("读不懂这个文件：需要本站导出的菜单 JSON", "warn"); return; }
      pendingImportPool = pool;
      document.getElementById("menu-import-msg").textContent =
        "文件里有 " + pool.length + " 张卡片。整体替换会覆盖当前菜单；合并追加按 id 覆盖同名、追加新卡。";
      menuImportOverlayEl.hidden = false;
    };
    reader.readAsText(file);
  });

  function resetPool() {
    if (!window.confirm("用仓库默认菜单覆盖当前菜单？你对卡片的增删改会丢失（被删掉的卡也会从行程移出）。")) return;
    PLACES = normalizePool(DEFAULT_PLACES);
    persistPool();
    rebuildIndex();
    purgeMissingFromDraft();
    renderAll();
    toast("已恢复默认菜单");
  }

  cardOverlayEl.addEventListener("click", function (e) {
    if (e.target === cardOverlayEl) closeCardEditor(); // 点背景关闭
  });
  menuImportOverlayEl.addEventListener("click", function (e) {
    if (e.target === menuImportOverlayEl) { pendingImportPool = null; menuImportOverlayEl.hidden = true; }
  });

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

    var fmtBtn = e.target.closest("[data-format]");
    if (fmtBtn) { setTripFormat(fmtBtn.getAttribute("data-format")); return; }

    var delPlanBtn = e.target.closest("[data-del-plan]");
    if (delPlanBtn) { deleteSavedPlan(delPlanBtn.getAttribute("data-del-plan")); return; }

    var planBtn = e.target.closest("[data-plan]");
    if (planBtn) { applyPlan(findPlan(planBtn.getAttribute("data-plan"))); return; }

    if (e.target.closest("#save-plan-btn")) { openSaveOverlay(); return; }
    if (e.target.closest("#save-plan-cancel")) { closeSaveOverlay(); return; }
    if (e.target.closest("#save-plan-confirm")) { confirmSaveOverlay(); return; }

    if (e.target.closest("#reset-btn")) { resetDraft(); return; }
    if (e.target.closest("#export-btn")) { exportDraft(); return; }
    if (e.target.closest("#import-btn")) { importFileEl.click(); return; }

    // 菜单（卡池）：编辑 / 新增 / 导入 / 导出 / 恢复默认
    var editCardBtn = e.target.closest("[data-edit-card]");
    if (editCardBtn) { openCardEditor(editCardBtn.getAttribute("data-edit-card")); return; }
    if (e.target.closest("#menu-add-btn")) { openCardEditor(null); return; }
    if (e.target.closest("#menu-export-btn")) { exportPool(); return; }
    if (e.target.closest("#menu-import-btn")) { menuImportFileEl.click(); return; }
    if (e.target.closest("#menu-reset-btn")) { resetPool(); return; }
    if (e.target.closest("#cf-save")) { saveCardFromForm(); return; }
    if (e.target.closest("#cf-delete")) { deleteCurrentCard(); return; }
    if (e.target.closest("#cf-cancel")) { closeCardEditor(); return; }
    if (e.target.closest("#menu-import-replace")) { applyImportPool("replace"); return; }
    if (e.target.closest("#menu-import-merge")) { applyImportPool("merge"); return; }
    if (e.target.closest("#menu-import-cancel")) { pendingImportPool = null; menuImportOverlayEl.hidden = true; return; }

    if (e.target.closest("[data-cancel-selection]")) {
      clearSelection();
      renderAll();
      return;
    }

    var removeBtn = e.target.closest("[data-remove-card]");
    if (removeBtn) { removeCard(removeBtn.getAttribute("data-remove-card")); return; }

    var navBtn = e.target.closest("[data-day-nav]");
    if (navBtn) { stepDay(parseInt(navBtn.getAttribute("data-day-nav"), 10)); return; }

    // 日历内点击：有选中卡时是“放置”，没有时是“选中”
    if (selection) {
      var evEl = e.target.closest(".cal-event");
      if (evEl) {
        var beforeId = evEl.getAttribute("data-card-id");
        if (beforeId === selection.cardId) { clearSelection(); renderAll(); return; }
        placeCard(selection.cardId, { day: state.activeDay, beforeId: beforeId });
        return;
      }
      var stayEl = e.target.closest("[data-stay-drop]");
      if (stayEl) { placeCard(selection.cardId, { day: stayEl.getAttribute("data-stay-drop"), stay: true }); return; }
      if (e.target.closest("#day-canvas")) {
        placeCard(selection.cardId, { day: state.activeDay, beforeId: null });
        return;
      }
    } else {
      var calCard = e.target.closest(".cal-event, .cal-stay[data-card-id]");
      if (calCard) { onCardTap(calCard.getAttribute("data-card-id"), calCard); return; }
      if (e.target.closest("#day-canvas")) { toast("先在菜单点选一张卡片"); return; }
    }

    var cardEl = e.target.closest("[data-drag-card]");
    if (cardEl) { onCardTap(cardEl.getAttribute("data-card-id"), cardEl); return; }
  });

  /* ---------- 拖拽（pointer events，触屏长按提起） ---------- */

  var drag = null;

  function clearDropHints() {
    var marked = document.querySelectorAll(".cal-event--before, .drop-hint");
    for (var i = 0; i < marked.length; i += 1) {
      marked[i].classList.remove("cal-event--before");
      marked[i].classList.remove("drop-hint");
    }
  }

  function cancelDrag() {
    if (!drag) return;
    if (drag.timer) clearTimeout(drag.timer);
    if (drag.scrollTimer) clearInterval(drag.scrollTimer);
    try { document.body.releasePointerCapture(drag.pointerId); } catch (err) { /* 未捕获时忽略 */ }
    if (drag.ghost && drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
    clearDropHints();
    if (drag.el) drag.el.classList.remove("drag-source");
    document.body.classList.remove("drag-active");
    drag = null;
  }

  function liftDrag() {
    if (!drag || drag.lifted) return;
    drag.lifted = true;
    var card = cardById[drag.cardId];
    var ghost = el("div", "drag-ghost");
    ghost.appendChild(el("span", "drag-ghost-title", card ? card.title : ""));
    if (card && card.durationMin) {
      ghost.appendChild(el("span", "drag-ghost-dur", "约 " + card.durationMin + " 分"));
    }
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

    // ghost 伸展到它在日历里将占据的高度（与事件块同一分钟比例）
    var dur = (card && card.durationMin) || 0;
    ghost.style.height = "34px";
    var targetH = Math.max(34, Math.min(240, dur * CAL_PX_PER_MIN));
    void ghost.offsetHeight; // 强制 reflow，让 transition 有起点（不依赖 rAF）
    ghost.style.height = targetH + "px";

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

  // 拖拽目标解析：某张卡（插到它前面）> 住宿位 > 日历任意空白（排到最后）
  function updateDropTarget() {
    if (!drag || !drag.lifted) return;
    var under = document.elementFromPoint(drag.lastX, drag.lastY);
    clearDropHints();
    drag.drop = null;
    if (!under) return;
    var ev = under.closest(".cal-event");
    if (ev && ev.getAttribute("data-card-id") !== drag.cardId) {
      ev.classList.add("cal-event--before");
      drag.drop = { type: "before", beforeId: ev.getAttribute("data-card-id") };
      return;
    }
    var stay = under.closest("[data-stay-drop]");
    if (stay) {
      stay.classList.add("drop-hint");
      drag.drop = { type: "stay", day: stay.getAttribute("data-stay-drop") };
      return;
    }
    if (under.closest("#day-canvas") || under.closest("#view-plan")) {
      dayCanvasEl.classList.add("drop-hint");
      drag.drop = { type: "append" };
    }
  }

  document.addEventListener("pointerdown", function (e) {
    if (!e.isPrimary) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.target.closest("[data-remove-card]")) return;
    if (e.target.closest("[data-edit-card]")) return; // 卡上的「编辑」不启动拖拽
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
      drop: null,
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
    var drop = drag.drop;
    cancelDrag();

    if (lifted) {
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 150);
      if (drop) {
        if (drop.type === "before") placeCard(cardId, { day: state.activeDay, beforeId: drop.beforeId });
        else if (drop.type === "stay") placeCard(cardId, { day: drop.day, stay: true });
        else placeCard(cardId, { day: state.activeDay, beforeId: null });
      }
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

  loadPool();       // 先建卡池 + cardById，load() 里的草稿清洗依赖它
  initCardForm();   // 填充编辑表单里的下拉项
  load();
  document.body.setAttribute("data-view", state.view);
  applyPoolTheme();
  renderTabBar();
  renderPresetButtons();
  renderRegionMap();
  setupRegionLegendHover();
  renderAll();
})();
