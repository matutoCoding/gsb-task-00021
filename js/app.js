/* 印刷拼版系统 —— 界面、拖拽、持久化 */
(function () {
  'use strict';
  var E = window.Imposition;
  var STORE_KEY = 'imposition/v1';

  /* ---------- 默认状态 ---------- */
  function defaultState() {
    return {
      cfg: { paperId: 'A3', paperW: 297, paperH: 420, gripper: 10, bleed: 3, allowRotate: true },
      pieces: [],
      seq: 0,
      sheetIndex: 0,
      zoom: 0,
      dragDraft: null
    };
  }

  var state = loadState() || defaultState();
  if (!state.dragDraft) state.dragDraft = null;

  function loadState() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || !s.cfg || !Array.isArray(s.pieces)) return null;
      return s;
    } catch (e) { return null; }
  }
  var saveQueued = false;
  function save() {
    if (saveQueued) return;
    saveQueued = true;
    requestAnimationFrame(function () {
      saveQueued = false;
      try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
    });
  }
  function saveNow() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') saveNow();
  });

  function uid() { return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  /* ---------- 视图模型 ----------
     每件三种落点：
       流水件 status=auto，参与 shelf 排页
       违规手放件 status=flag，带 fx/fy，落在某张纸的原始坐标（标红，该纸判无效）
       过大件 status=too_large，autoPack remainder，挂在末尾溢出纸（标红）
  */
  function currentOrder(excludeId) {
    return state.pieces
      .filter(function (p) { return p.status !== 'flag' && p.id !== excludeId; })
      .slice()
      .sort(function (a, b) { return a.seq - b.seq; });
  }

  /* 新件按开数顺序插入排序，取相邻 seq 中点 */
  function seqForNewPiece(format) {
    var sorted = state.pieces.slice().sort(E.byFormatThenSeq);
    var pos = 0;
    var order = E.formatOrder(format);
    while (pos < sorted.length && E.formatOrder(sorted[pos].format) <= order) pos++;
    var prev = pos > 0 ? sorted[pos - 1] : null;
    var next = pos < sorted.length ? sorted[pos] : null;
    if (prev && next) return (prev.seq + next.seq) / 2;
    if (prev) return prev.seq + 2;
    if (next) return next.seq - 2;
    return 2;
  }

  /* 扁平流水（跨纸张），供拖动插入时取前后件 */
  function flatOrder(excludeId) {
    var order = currentOrder(excludeId);
    var packed = E.autoPack(order, state.cfg, { allowRotate: state.cfg.allowRotate });
    var flat = [];
    packed.sheets.forEach(function (sh) {
      sh.placements.forEach(function (pl) { flat.push(pl.piece); });
    });
    packed.remainder.forEach(function (p) { flat.push(p); });
    return { flat: flat, packed: packed };
  }

  function buildView(drag) {
    var base = currentOrder(drag && drag.id);
    var insertAt = null; // 合法落点：{sheet}，插入锚点由 seq 决定
    var illegal = null;  // 违规落点：{x, y, flags}
    var order = base;

    if (drag) {
      var ghost0 = state.pieces.filter(function (p) { return p.id === drag.id; })[0];
      if (ghost0 && drag.target && drag.target.kind === 'sheet') {
        var ua0 = E.usableArea(state.cfg);
        var cell0 = E.cellSize(ghost0);
        var cx0 = drag.pointerX - cell0.w / 2;
        var cy0 = drag.pointerY - cell0.h / 2;
        var inside0 = cx0 >= ua0.x - 1e-6 && cy0 >= ua0.y - 1e-6 &&
          cx0 + cell0.w <= ua0.x + ua0.w + 1e-6 && cy0 + cell0.h <= ua0.y + ua0.h + 1e-6;
        if (inside0 && !drag.target.tab) {
          var anchorId = anchorAt(base, drag.target.sheet, drag.pointerX, drag.pointerY);
          order = insertAfter(base, ghost0, anchorId);
          insertAt = { sheet: drag.target.sheet };
        } else if (drag.target.tab) {
          // 悬停纸签：预览追加到该张末尾
          var endAnchor = anchorAt(base, drag.target.sheet, -1, -1);
          order = insertAfter(base, ghost0, endAnchor);
          insertAt = { sheet: drag.target.sheet };
        } else if (drag.target.raw &&
          drag.pointerX >= 0 && drag.pointerY >= 0 &&
          drag.pointerX <= state.cfg.paperW && drag.pointerY <= state.cfg.paperH) {
          illegal = { x: cx0, y: cy0, flags: E.flagsAt(ghost0, cx0, cy0, state.cfg) };
        }
      }
    }

    var packed = E.autoPack(order, state.cfg, { allowRotate: state.cfg.allowRotate });
    var sheets = packed.sheets.map(function (sh) {
      return { placements: sh.placements.map(function (pl) {
        return { piece: pl.piece, x: pl.x, y: pl.y, rotated: pl.rotated };
      }) };
    });

    // 把违规手放件合并到所属纸
    state.pieces.forEach(function (p) {
      if (p.status === 'flag') {
        while (sheets.length <= (p.flagSheet || 0)) sheets.push({ placements: [] });
        sheets[p.flagSheet].placements.push({ piece: p, x: p.fx, y: p.fy, rotated: !!p.rotated, flagged: true });
      }
    });

    // 过大件：末张溢出纸
    if (packed.remainder.length) {
      var ua2 = E.usableArea(state.cfg);
      var os = { placements: [], overflow: true };
      var ox = ua2.x, oy = ua2.y;
      packed.remainder.forEach(function (p, i) {
        var cell2 = E.cellSize(p);
        os.placements.push({
          piece: p, x: ua2.x, y: ua2.y + i * 8,
          rotated: false, flagged: true, tooLarge: true,
          displayW: Math.min(cell2.w, state.cfg.paperW - 8),
          displayH: Math.min(cell2.h, Math.max(60, state.cfg.paperH / 3))
        });
      });
      sheets.push(os);
    }

    return {
      sheets: sheets,
      ghostId: drag ? drag.id : null,
      insertAt: insertAt,
      illegal: illegal,
      targetSheet: drag && drag.target && drag.target.kind === 'sheet' ? drag.target.sheet : null
    };
  }

  /* 依据指针位置找锚点件：返回其 id（插到该件之后），null=插到最前 */
  function anchorAt(order, sheetIndex, px, py) {
    var packed = E.autoPack(order, state.cfg, { allowRotate: state.cfg.allowRotate });
    var sh = packed.sheets[sheetIndex];
    if (!sh || !sh.placements.length) {
      var flat = [];
      packed.sheets.forEach(function (s) {
        s.placements.forEach(function (pl) { flat.push(pl.piece); });
      });
      // 落到不存在的纸（后面的空纸签）→ 插到全局末尾
      return sheetIndex >= packed.sheets.length && flat.length ? flat[flat.length - 1].id : null;
    }
    var best = 0;
    sh.placements.forEach(function (pl, i) {
      var cell = E.cellSize(pl.piece);
      var cy = pl.y + cell.h / 2;
      if (py > cy) best = i + 1;
      else if (Math.abs(py - cy) <= cell.h / 2 && px > pl.x + cell.w / 2) best = i + 1;
    });
    return best === 0 ? null : sh.placements[best - 1].piece.id;
  }

  /* 把 piece 插到锚点件之后（锚点 null = 最前），返回新顺序 */
  function insertAfter(order, piece, anchorId) {
    var out = order.filter(function (p) { return p.id !== piece.id; });
    if (!anchorId) { out.unshift(piece); return out; }
    var i = out.findIndex(function (p) { return p.id === anchorId; });
    if (i < 0) { out.push(piece); return out; }
    out.splice(i + 1, 0, piece);
    return out;
  }

  function sheetInvalid(view, i) {
    return view.sheets[i].placements.some(function (pl) {
      if (pl.flagged) return true;
      return E.flagsAt(pl.piece, pl.x, pl.y, state.cfg).length > 0;
    });
  }

  /* ---------- DOM ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var els = {
    paperPreset: $('paperPreset'), paperW: $('paperW'), paperH: $('paperH'),
    gripper: $('gripper'), bleed: $('bleed'), allowRotate: $('allowRotate'),
    resetBtn: $('resetBtn'),
    pName: $('pName'), pW: $('pW'), pH: $('pH'), pFormat: $('pFormat'), pMargin: $('pMargin'),
    formHint: $('formHint'), addBtn: $('addBtn'),
    tray: $('tray'), trayCount: $('trayCount'),
    statTotal: $('statTotal'), statPlaced: $('statPlaced'), statOverflow: $('statOverflow'), statValid: $('statValid'),
    tabs: $('sheetTabs'), canvas: $('canvas'),
    zoomIn: $('zoomIn'), zoomOut: $('zoomOut'), zoomVal: $('zoomVal'),
    toast: $('toast'), resumeTip: $('resumeTip')
  };

  var drag = null;
  var toastTimer = null;
  function toast(msg, ms) {
    els.toast.textContent = msg;
    els.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.add('hidden'); }, ms || 2200);
  }

  /* ---------- 渲染 ---------- */
  function render() {
    var view = buildView(drag);
    renderTabs(view);
    renderCanvas(view);
    renderTray(view);
    renderStats(view);
  }
  var rafQueued = false;
  function scheduleRender() {
    if (rafQueued) return;
    rafQueued = true;
    requestAnimationFrame(function () { rafQueued = false; render(); });
  }

  function renderTabs(view) {
    var n = Math.max(1, view.sheets.length);
    if (state.sheetIndex > n - 1) state.sheetIndex = n - 1;
    els.tabs.innerHTML = '';
    for (var i = 0; i < n; i++) {
      var b = document.createElement('button');
      b.className = 'sheet-tab' + (i === state.sheetIndex ? ' active' : '') +
        (sheetInvalid(view, i) ? ' invalid' : '');
      var tag = view.sheets[i].overflow ? '溢出' : (sheetInvalid(view, i) ? '✗' : '✓');
      b.innerHTML = '第 ' + (i + 1) + ' 张 <span class="tab-state">[' + tag + ']</span>';
      b.addEventListener('pointerdown', function (idx) {
        return function () { state.sheetIndex = idx; save(); render(); };
      }(i));
      b.dataset.sheet = i;
      els.tabs.appendChild(b);
    }
  }

  var mmToPx = 96 / 25.4;
  function fitZoom() {
    var availW = Math.max(200, els.canvas.clientWidth - 80);
    var availH = Math.max(200, els.canvas.clientHeight - 110);
    var zW = availW / (state.cfg.paperW * mmToPx);
    var zH = availH / (state.cfg.paperH * mmToPx);
    return Math.max(0.15, Math.min(1.2, Math.min(zW, zH)));
  }

  function renderCanvas(view) {
    els.canvas.innerHTML = '';
    var cfg = state.cfg;
    if (!state.zoom) state.zoom = fitZoom();
    var z = state.zoom;
    var sheet = document.createElement('div');
    sheet.className = 'sheet' + (sheetInvalid(view, state.sheetIndex) ? ' invalid' : '');
    sheet.style.width = cfg.paperW + 'mm';
    sheet.style.height = cfg.paperH + 'mm';
    sheet.style.transform = 'scale(' + z + ')';
    sheet.dataset.sheet = '';

    var caption = document.createElement('div');
    caption.className = 'sheet-caption';
    var invalid = sheetInvalid(view, state.sheetIndex);
    var count = view.sheets[state.sheetIndex].placements.length;
    caption.innerHTML = '<span>第 ' + (state.sheetIndex + 1) + ' 张 · ' + cfg.paperW + '×' + cfg.paperH +
      'mm · 咬口' + cfg.gripper + 'mm · 出血' + cfg.bleed + 'mm · ' + count + ' 件</span>' +
      (invalid
        ? '<span class="state-bad">✗ 本张不算数（有溢出件或压住咬口）</span>'
        : '<span class="state-ok">✓ 有效</span>');
    sheet.appendChild(caption);

    var ua = E.usableArea(cfg);
    var bleedBox = document.createElement('div');
    bleedBox.className = 'bleed-area';
    bleedBox.style.cssText = boxCss({ x: cfg.bleed, y: cfg.bleed, w: cfg.paperW - 2 * cfg.bleed, h: cfg.paperH - 2 * cfg.bleed });
    sheet.appendChild(bleedBox);

    var usable = document.createElement('div');
    usable.className = 'usable-area';
    usable.style.cssText = boxCss(ua);
    sheet.appendChild(usable);

    if (cfg.gripper > 0) {
      var g = document.createElement('div');
      g.className = 'gripper-area';
      g.style.height = cfg.gripper + 'mm';
      g.textContent = '咬 口';
      sheet.appendChild(g);
    }

    var data = view.sheets[state.sheetIndex] || { placements: [] };
    data.placements.forEach(function (pl) {
      var cell = E.cellSize(pl.piece);
      var node = makePieceNode(pl.piece);
      node.style.left = (pl.x || 0) + 'mm';
      node.style.top = (pl.y || 0) + 'mm';
      node.style.width = (pl.displayW || cell.w) + 'mm';
      node.style.height = (pl.displayH || cell.h) + 'mm';
      if (pl.rotated) node.dataset.rotated = '1';
      if (pl.flagged) node.classList.add('flagged');
      if (pl.tooLarge) {
        node.querySelector('.p-meta').textContent = '超出可用区，任何纸都放不下';
      } else if (pl.flagged) {
        node.querySelector('.p-meta').textContent = flagText(pl.piece, pl.x, pl.y);
      }
      sheet.appendChild(node);
    });

    // 拖拽预览：绿框=松手槽位，红框=违规位置，浮层跟随指针
    if (drag) {
      var ghostPiece = state.pieces.filter(function (p) { return p.id === drag.id; })[0];
      var gc = E.cellSize(ghostPiece);
      var onThis = view.targetSheet === state.sheetIndex;
      if (onThis && !view.illegal && drag.target && !drag.target.tab) {
        var hint = document.createElement('div');
        hint.className = 'drop-hint';
        hint.style.cssText = boxCss({
          x: drag.pointerX - gc.w / 2, y: drag.pointerY - gc.h / 2, w: gc.w, h: gc.h
        });
        sheet.appendChild(hint);
      }
      if (onThis && view.illegal) {
        var bad = document.createElement('div');
        bad.className = 'drop-hint tray-hint';
        bad.style.cssText = boxCss({ x: view.illegal.x, y: view.illegal.y, w: gc.w, h: gc.h });
        sheet.appendChild(bad);
      }
      if (onThis) {
        var gnode = makePieceNode(ghostPiece);
        gnode.classList.add('ghost');
        gnode.classList.add(view.illegal ? 'drop-bad' : 'drop-ok');
        var gx = Math.max(0, Math.min(drag.pointerX - gc.w / 2, cfg.paperW - gc.w));
        var gy = Math.max(0, Math.min(drag.pointerY - gc.h / 2, cfg.paperH - gc.h));
        gnode.style.cssText = boxCss({ x: gx, y: gy, w: gc.w, h: gc.h });
        sheet.appendChild(gnode);
      }
    }

    var holder = document.createElement('div');
    holder.className = 'sheet-holder';
    holder.style.width = (cfg.paperW * mmToPx * z) + 'px';
    holder.style.height = (cfg.paperH * mmToPx * z) + 'px';
    holder.appendChild(sheet);
    els.canvas.appendChild(holder);
    els.zoomVal.textContent = Math.round(z * 100) + '%';
  }

  function boxCss(r) {
    return 'left:' + r.x + 'mm;top:' + r.y + 'mm;width:' + r.w + 'mm;height:' + r.h + 'mm;';
  }

  function flagText(p, x, y) {
    var fl = E.flagsAt(p, x, y, state.cfg);
    if (fl.indexOf(E.FLAG.TOO_LARGE) >= 0) return '溢出：大于可用区';
    var parts = [];
    if (fl.indexOf(E.FLAG.OVERFLOW) >= 0) parts.push('超幅面/出血');
    if (fl.indexOf(E.FLAG.GRIPPER) >= 0) parts.push('压住咬口');
    return '溢出件：' + parts.join('、');
  }

  function makePieceNode(p) {
    var node = document.createElement('div');
    node.className = 'piece';
    node.dataset.id = p.id;
    var name = document.createElement('div');
    name.className = 'p-name';
    name.textContent = p.name || ('件#' + p.seq);
    var meta = document.createElement('div');
    meta.className = 'p-meta';
    meta.textContent = p.format + '开 · ' + p.w + '×' + p.h;
    node.appendChild(name);
    node.appendChild(meta);
    var rb = document.createElement('button');
    rb.className = 'rotate-btn';
    rb.textContent = '⟳';
    rb.title = '旋转 90°';
    rb.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
    rb.addEventListener('click', function (ev) {
      ev.stopPropagation();
      p.rotated = !p.rotated;
      if (p.status === 'flag') { p.status = 'auto'; delete p.fx; delete p.fy; delete p.flagSheet; }
      save(); render();
    });
    node.appendChild(rb);
    attachDrag(node, p);
    return node;
  }

  function renderTray(view) {
    els.tray.innerHTML = '';
    // 全部件清单：显示所在纸张/状态，可作为拖拽源，可删除
    state.pieces.forEach(function (p) {
      var item = document.createElement('div');
      item.className = 'tray-item';
      item.dataset.id = p.id;
      var located = locatePiece(view, p.id);
      var dot = document.createElement('span');
      dot.className = 'dot';
      if (located.flagged) dot.style.background = 'var(--red)';
      var label = document.createElement('span');
      label.textContent = p.name || ('件#' + p.seq);
      var meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = p.format + ' · ' + p.w + '×' + p.h + ' · 第' + (located.sheet + 1) + '张';
      var del = document.createElement('button');
      del.className = 'del';
      del.textContent = '✕';
      del.title = '删除该件';
      del.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
      del.addEventListener('click', function (ev) {
        ev.stopPropagation();
        state.pieces = state.pieces.filter(function (q) { return q.id !== p.id; });
        save(); render();
      });
      item.appendChild(dot); item.appendChild(label); item.appendChild(meta); item.appendChild(del);
      attachDrag(item, p, true);
      els.tray.appendChild(item);
    });
    els.trayCount.textContent = state.pieces.length;
  }

  function locatePiece(view, id) {
    for (var i = 0; i < view.sheets.length; i++) {
      var pls = view.sheets[i].placements;
      for (var j = 0; j < pls.length; j++) {
        if (pls[j].piece.id === id) return { sheet: i, flagged: !!pls[j].flagged };
      }
    }
    return { sheet: 0, flagged: false };
  }

  function renderStats(view) {
    var placed = 0, overflow = 0, valid = 0;
    view.sheets.forEach(function (sh, i) {
      sh.placements.forEach(function (pl) {
        if (pl.flagged) overflow++; else placed++;
      });
      if (sh.placements.length > 0 && !sheetInvalid(view, i)) valid++;
    });
    els.statTotal.textContent = state.pieces.length;
    els.statPlaced.textContent = placed;
    els.statOverflow.textContent = overflow;
    els.statValid.textContent = valid;
  }

  /* ---------- 拖拽 ----------
     规则2：拖动期间实时重算所有流水件，摆不下的顺到下一张。
     规则7：拖动开始即持久化 dragDraft，切走/关闭后回来从原纸张续摆。 */
  var mmPerPx = 96 / 25.4;

  /* 拖拽采用 document 级监听：渲染会重建 piece 节点，节点级监听会随旧节点消失 */
  function attachDrag(node, piece, fromTray) {
    node.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0 && ev.pointerType === 'mouse') return;
      ev.preventDefault();
      var pos = pointerToSheet(ev);
      drag = {
        id: piece.id,
        pointerX: pos ? pos.x : 0,
        pointerY: pos ? pos.y : 0,
        target: pos ? { kind: 'sheet', sheet: state.sheetIndex, raw: true } : null,
        startX: ev.clientX, startY: ev.clientY, moved: false
      };
      state.dragDraft = {
        id: piece.id,
        sheet: state.sheetIndex,
        at: new Date().toISOString()
      };
      saveNow();
      scheduleRender();
    });
  }

  document.addEventListener('pointermove', function (ev) {
    if (!drag) return;
    var piece = state.pieces.filter(function (p) { return p.id === drag.id; })[0];
    if (!piece) { drag = null; return; }
    if (Math.abs(ev.clientX - drag.startX) + Math.abs(ev.clientY - drag.startY) > 4) drag.moved = true;
    var t = hitTarget(ev);
    var pos = t && t.kind === 'sheet' ? pointerToSheet(ev, t.sheet) : null;
    drag.target = t;
    if (pos) { drag.pointerX = pos.x; drag.pointerY = pos.y; }
    if (t && t.tab && t.sheet !== state.sheetIndex) state.sheetIndex = t.sheet;
    scheduleRender();
  });

  document.addEventListener('pointerup', function (ev) {
    if (!drag) return;
    var id = drag.id;
    var piece = state.pieces.filter(function (p) { return p.id === id; })[0];
    var d = drag;
    drag = null;
    state.dragDraft = null;
    saveNow();
    if (!piece) { render(); return; }
    if (!d.moved) { render(); return; }
    commitDrop(piece, ev);
  });
  document.addEventListener('pointercancel', function () {
    if (!drag) return;
    drag = null; state.dragDraft = null; saveNow(); render();
  });

  function hitTarget(ev) {
    var el = document.elementFromPoint(ev.clientX, ev.clientY);
    while (el && el !== document.body) {
      if (el.classList && el.classList.contains('sheet-tab')) {
        var si = parseInt(el.dataset.sheet, 10);
        return { kind: 'sheet', sheet: si, tab: true };
      }
      if (el.dataset && el.dataset.sheet !== undefined && el.classList && el.classList.contains('sheet')) {
        return { kind: 'sheet', sheet: state.sheetIndex, raw: true };
      }
      el = el.parentNode;
    }
    // 落在侧栏/画布空白 → 回原位（不算落版）
    return null;
  }

  function pointerToSheet(ev, sheetIndex) {
    var sheetEl = els.canvas.querySelector('.sheet');
    if (!sheetEl) return null;
    var rect = sheetEl.getBoundingClientRect();
    var pxW = rect.width / state.zoom;
    var pxH = rect.height / state.zoom;
    var x = (ev.clientX - rect.left) / state.zoom / mmPerPx;
    var y = (ev.clientY - rect.top) / state.zoom / mmPerPx;
    if (x < -20 || y < -20 || x > state.cfg.paperW + 20 || y > state.cfg.paperH + 20) return null;
    return { x: x, y: y };
  }

  function commitDrop(piece, ev) {
    var t = hitTarget(ev);
    var pos = t && t.kind === 'sheet' ? pointerToSheet(ev, t.sheet) : null;

    if (!t) { toast('已取消：未落到任何纸张，' + (piece.name || '该件') + ' 回到原位置'); render(); return; }

    if (t.tab) {
      // 落到纸签：追加到该纸末尾（若该纸已满则顺序续到后面的纸）
      state.sheetIndex = t.sheet;
      piece.status = 'auto';
      delete piece.fx; delete piece.fy; delete piece.flagSheet;
      appendToSheet(piece, t.sheet);
      toast('已挪到第 ' + (t.sheet + 1) + ' 张；摆不下的件已续排到后面的纸张');
      save(); render(); return;
    }

    if (!pos) { toast('落点不在纸张范围内，已回到原位置'); render(); return; }

    var cell = E.cellSize(piece);
    var ua = E.usableArea(state.cfg);
    var x = pos.x - cell.w / 2;
    var y = pos.y - cell.h / 2;
    var inside = x >= ua.x - 1e-6 && y >= ua.y - 1e-6 &&
      x + cell.w <= ua.x + ua.w + 1e-6 && y + cell.h <= ua.y + ua.h + 1e-6;

    if (!inside) {
      // 规则5、6：脱手位置违规 → 标红，该张纸判无效
      piece.status = 'flag';
      piece.fx = clamp(x, 0, state.cfg.paperW - cell.w);
      piece.fy = clamp(y, 0, state.cfg.paperH - cell.h);
      piece.flagSheet = state.sheetIndex;
      save(); render();
      toast('⚠ ' + flagText(piece, piece.fx, piece.fy) + '，第 ' + (state.sheetIndex + 1) + ' 张纸不算数；拖回可用区即可恢复');
      return;
    }

    // 合法落版：按落点找锚点件，seq 插到其后；shelf 重排决定最终坐标
    piece.status = 'auto';
    delete piece.fx; delete piece.fy; delete piece.flagSheet;
    var anchorId = anchorAt(currentOrder(piece.id), state.sheetIndex, pos.x, pos.y);
    placeAfterAnchor(piece, anchorId);
    save(); render();
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  /* 拖到纸签：追加到该张纸最后一件之后；纸满则自然续排（规则3） */
  function appendToSheet(piece, sheetIndex) {
    var info = flatOrder(piece.id);
    var sh = info.packed.sheets[sheetIndex];
    var anchor = sh && sh.placements.length
      ? sh.placements[sh.placements.length - 1].piece
      : info.flat[info.flat.length - 1];
    placeAfterAnchor(piece, anchor ? anchor.id : null);
  }

  /* seq 取锚点与下一件的中点；无锚点=最前，锚点在末尾=+2 */
  function placeAfterAnchor(piece, anchorId) {
    var flat = flatOrder(piece.id).flat;
    if (!anchorId) {
      piece.seq = flat.length ? flat[0].seq - 2 : (state.seq += 2);
      if (piece.seq <= 0) renormalize();
      return;
    }
    var i = flat.findIndex(function (p) { return p.id === anchorId; });
    if (i < 0) { piece.seq = (state.seq += 2); return; }
    var anchor = flat[i], next = flat[i + 1];
    piece.seq = next ? (anchor.seq + next.seq) / 2 : anchor.seq + 2;
    if (Math.abs(piece.seq - anchor.seq) < 1e-9) renormalize();
  }

  /* 中值插太多导致精度耗尽时，按当前顺序重排 seq */
  function renormalize() {
    var sorted = state.pieces.slice().sort(function (a, b) { return a.seq - b.seq; });
    sorted.forEach(function (p, i) { p.seq = (i + 1) * 2; });
    state.seq = sorted.length * 2 + 2;
  }

  /* ---------- 新增成品件（规则4） ---------- */
  function requiredFields() {
    return [
      { el: els.pW, v: parseFloat(els.pW.value) },
      { el: els.pH, v: parseFloat(els.pH.value) },
      { el: els.pFormat, v: els.pFormat.value },
      { el: els.pMargin, v: parseFloat(els.pMargin.value) }
    ];
  }

  function validateForm() {
    var fields = requiredFields();
    var missing = [];
    fields.forEach(function (f) {
      var bad = f.el === els.pFormat ? !f.v : !(f.v > 0) && !(f.el === els.pMargin && f.v === 0);
      f.el.classList.toggle('missing', bad && f.el.dataset.touched === '1');
      if (bad) {
        missing.push(f.el === els.pFormat ? '开数'
          : f.el === els.pW ? '成品宽'
          : f.el === els.pH ? '成品高' : '留边');
      }
    });
    els.addBtn.disabled = missing.length > 0;
    els.formHint.textContent = missing.length
      ? '缺项不能落版：还需填写「' + missing.join('、') + '」'
      : '';
    return missing.length === 0;
  }

  [els.pW, els.pH, els.pMargin].forEach(function (el) {
    el.addEventListener('input', function () { el.dataset.touched = '1'; validateForm(); });
  });
  els.pFormat.addEventListener('change', function () {
    els.pFormat.dataset.touched = '1';
    var f = E.FORMATS.filter(function (x) { return x.k === els.pFormat.value; })[0];
    if (f) {
      if (!els.pW.value) els.pW.value = f.w;
      if (!els.pH.value) els.pH.value = f.h;
    }
    validateForm();
  });

  els.addBtn.addEventListener('click', function () {
    if (!validateForm()) { toast('成品尺寸、开数、留边缺一不可，补齐后才能加入拼版'); return; }
    var p = {
      id: uid(),
      seq: seqForNewPiece(els.pFormat.value),
      name: els.pName.value.trim(),
      w: parseFloat(els.pW.value),
      h: parseFloat(els.pH.value),
      format: els.pFormat.value,
      margin: parseFloat(els.pMargin.value),
      rotated: false,
      status: 'auto'
    };
    state.pieces.push(p);
    state.seq = Math.max(state.seq, Math.ceil(p.seq));
    save(); render();
    toast('已加入：' + (p.name || ('件#' + p.seq)) + '，按开数顺序排入纸张');
    els.pName.value = '';
    els.pW.value = els.pH.value = els.pMargin.value = '';
    els.pFormat.value = '';
    [els.pW, els.pH, els.pMargin, els.pFormat].forEach(function (el) { delete el.dataset.touched; el.classList.remove('missing'); });
    validateForm();
  });

  /* ---------- 纸张配置（规则1） ---------- */
  E.PAPERS.forEach(function (pp) {
    var o = document.createElement('option');
    o.value = pp.id; o.textContent = pp.name;
    els.paperPreset.appendChild(o);
  });
  els.paperPreset.value = state.cfg.paperId || 'custom';

  els.paperPreset.addEventListener('change', function () {
    var pp = E.PAPERS.filter(function (x) { return x.id === els.paperPreset.value; })[0];
    state.cfg.paperId = pp.id;
    if (pp.w) { state.cfg.paperW = pp.w; state.cfg.paperH = pp.h; }
    syncCfgInputs(); save(); render();
  });
  [els.paperW, els.paperH, els.gripper, els.bleed].forEach(function (el) {
    el.addEventListener('input', function () {
      els.paperPreset.value = 'custom';
      state.cfg.paperId = 'custom';
      state.cfg.paperW = parseFloat(els.paperW.value) || 0;
      state.cfg.paperH = parseFloat(els.paperH.value) || 0;
      state.cfg.gripper = Math.max(0, parseFloat(els.gripper.value) || 0);
      state.cfg.bleed = Math.max(0, parseFloat(els.bleed.value) || 0);
      if (!(state.cfg.paperW > 0) || !(state.cfg.paperH > 0)) return;
      if (!E.validConfig(state.cfg)) {
        toast('咬口 + 出血已超出幅面，摆版区为 0，请调整');
        return;
      }
      save(); scheduleRender();
    });
  });
  els.allowRotate.addEventListener('change', function () {
    state.cfg.allowRotate = els.allowRotate.checked; save(); render();
  });
  els.resetBtn.addEventListener('click', function () {
    if (!confirm('确定清空全部成品件与拼版进度？此操作不可撤销。')) return;
    state = defaultState();
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    syncCfgInputs(); save(); render();
  });

  function syncCfgInputs() {
    els.paperW.value = state.cfg.paperW;
    els.paperH.value = state.cfg.paperH;
    els.gripper.value = state.cfg.gripper;
    els.bleed.value = state.cfg.bleed;
    els.allowRotate.checked = state.cfg.allowRotate !== false;
  }

  /* ---------- 缩放 ---------- */
  els.zoomIn.addEventListener('click', function () { state.zoom = Math.min(2, state.zoom + 0.12); save(); render(); });
  els.zoomOut.addEventListener('click', function () { state.zoom = Math.max(0.2, state.zoom - 0.12); save(); render(); });

  /* ---------- 规则7：断点续摆 ---------- */
  function resumeDraft() {
    var d = state.dragDraft;
    if (!d) return;
    var p = state.pieces.filter(function (q) { return q.id === d.id; })[0];
    if (!p) { state.dragDraft = null; save(); return; }
    state.sheetIndex = Math.min(d.sheet || 0, 9999);
    els.resumeTip.innerHTML =
      '上次在 <b>' + (d.at ? new Date(d.at).toLocaleString('zh-CN') : '') +
      '</b> 拖动「' + (p.name || ('件#' + p.seq)) + '」时离开。<br>已回到第 ' +
      (d.sheet + 1) + ' 张纸，从清单拖起即可继续摆放。' +
      '<br><button id="dismissDraft">知道了</button>';
    els.resumeTip.classList.remove('hidden');
    state.dragDraft = null;
    save();
    $('dismissDraft').addEventListener('click', function () {
      els.resumeTip.classList.add('hidden');
    });
  }

  /* ---------- 初始化 ---------- */
  E.FORMATS.forEach(function (f) {
    var o = document.createElement('option');
    o.value = f.k; o.textContent = f.k;
    els.pFormat.appendChild(o);
  });
  syncCfgInputs();
  validateForm();
  render();
  resumeDraft();
})();
