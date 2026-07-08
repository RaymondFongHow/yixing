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

  // 行程是一个“自动日历”：每天一个有序队列，事件按预估时长自动向后叠放，
  // 相邻地点之间自动插入交通段并推后时钟；← → 在天与天之间切换。
  var DAYS = [
    { id: "arrival", label: "到达", startMin: 19 * 60, hasStay: false, hint: "到达当晚的缓冲段" },
    { id: "d1", label: "Day 1", startMin: 9 * 60, hasStay: true },
    { id: "d2", label: "Day 2", startMin: 9 * 60, hasStay: true },
    { id: "d3", label: "Day 3", startMin: 9 * 60, hasStay: false, hint: "午餐后返程" }
  ];
  var dayById = {};
  DAYS.forEach(function (d) { dayById[d.id] = d; });

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
    filter: "all", view: "intro", activeDay: "d1",
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

  // 全程顺序：到达 → Day1 → 住宿1 → Day2 → 住宿2 → Day3（路线图沿用）
  function selectedItems() {
    var ids = [];
    DAYS.forEach(function (d) {
      ids = ids.concat(state.days[d.id]);
      if (d.hasStay && state.stays[d.id]) ids.push(state.stays[d.id]);
    });
    return ids.map(function (id) { return cardById[id]; }).filter(Boolean);
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

  function currentGraph() {
    return buildRouteGraph(selectedItems(), EDGES, BLOCKED, REGION_TIMES, SAME_REGION);
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        v: 2, filter: state.filter, view: state.view, activeDay: state.activeDay,
        days: state.days, stays: state.stays
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
    if (dayById[data.activeDay]) state.activeDay = data.activeDay;

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
    var idx = DAYS.indexOf(dayById[state.activeDay]) + delta;
    idx = Math.max(0, Math.min(DAYS.length - 1, idx));
    state.activeDay = DAYS[idx].id;
    save();
    renderDay();
  }

  function renderDay() {
    var day = dayById[state.activeDay];
    var idx = DAYS.indexOf(day);
    dayTitleEl.textContent = day.label + (day.hint ? " · " + day.hint : "");
    var prevBtn = document.querySelector('[data-day-nav="-1"]');
    var nextBtn = document.querySelector('[data-day-nav="1"]');
    if (prevBtn) prevBtn.disabled = idx === 0;
    if (nextBtn) nextBtn.disabled = idx === DAYS.length - 1;

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
    var from = findCardLoc(selection.cardId);
    hintTextEl.textContent = (from ? "移动「" : "已选「") + card.title
      + "」— 点日历空白排到最后，点已有卡插到它前面";
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
    renderDay();
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

  function draftSnapshot() {
    return JSON.parse(JSON.stringify({ days: state.days, stays: state.stays }));
  }

  function undoAssign(u) {
    state.days = u.snap.days;
    state.stays = u.snap.stays;
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

  function applyPreset(presetId) {
    var preset = null;
    for (var i = 0; i < PRESETS.length; i += 1) {
      if (PRESETS[i].id === presetId) { preset = PRESETS[i]; break; }
    }
    if (!preset) return;

    hideSnackbar();
    var n = normalizedDraft(preset.days || {}, preset.stays || {});
    state.days = n.days;
    state.stays = n.stays;
    state.activeDay = "d1";

    clearSelection();
    save();
    renderAll();
    toast(preset.note || (preset.title + " 已载入"));
  }

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

  load();
  document.body.setAttribute("data-view", state.view);
  applyPoolTheme();
  renderTabBar();
  renderPresetButtons();
  renderRegionMap();
  renderAll();
})();
