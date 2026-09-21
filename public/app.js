'use strict';

const I = window.Imposition;

const els = {};
[
  'saveState', 'specPaperW', 'specPaperH', 'specGripper', 'specBleed', 'specGap',
  'specEdge', 'specHint', 'newName', 'newK', 'newQty', 'newW', 'newH',
  'btnAddItem', 'itemPool', 'poolCount', 'sheetTabs', 'btnAutoPack', 'btnAddSheet',
  'sheetBadge', 'canvasScroll', 'canvas', 'sheetLegend',
  'draftBanner', 'draftText', 'btnDraftResume', 'btnDraftCommit', 'btnDraftDiscard', 'toast'
].forEach((id) => { els[id] = document.getElementById(id); });

let state = null;
let activeSheet = 0;
let scale = 1;
let selectedItemId = null;
let drag = null;
let draftSaveTimer = null;

function toast(msg, ms) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.add('hidden'), ms || 3200);
}

function setSaveState(kind, text) {
  els.saveState.className = 'save-state ' + kind;
  els.saveState.textContent = text;
}

async function api(action, body) {
  setSaveState('saving', '保存中…');
  const res = await fetch('/api/action/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    setSaveState('error', '保存失败');
    throw new Error(data.error || ('HTTP ' + res.status));
  }
  state = data;
  setSaveState('saved', '已保存 · ' + new Date().toLocaleTimeString());
  render();
  return data;
}

async function refresh() {
  const res = await fetch('/api/state');
  state = await res.json();
  setSaveState('saved', '已保存 · ' + new Date().toLocaleTimeString());
}

function itemById(id) {
  return state.items.find((it) => it.id === id);
}

function placementOf(itemId) {
  return state.placements.find((p) => p.itemId === id);
}

function sheetInfo(idx) {
  return state.summary && state.summary.sheets && state.summary.sheets[idx];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- 规格区 ---------- */

function fillSpecForm() {
  const s = state.spec;
  els.specPaperW.value = s.paperW;
  els.specPaperH.value = s.paperH;
  els.specGripper.value = s.gripper;
  els.specBleed.value = s.bleed;
  els.specGap.value = s.gap;
  els.specEdge.value = s.gripperEdge;
  const area = I.usableRect(s);
  els.specHint.textContent =
    '拼版区 ' + area.w + ' × ' + area.h + ' mm（已扣除咬口 ' + s.gripper +
    'mm，出血 ' + s.bleed + 'mm 计入每件占位，件间留边 ' + s.gap + 'mm）';
}

let specTimer = null;
function specChanged() {
  clearTimeout(specTimer);
  specTimer = setTimeout(async () => {
    try {
      await api('updateSpec', {
        paperW: Number(els.specPaperW.value),
        paperH: Number(els.specPaperH.value),
        gripper: Number(els.specGripper.value),
        bleed: Number(els.specBleed.value),
        gap: Number(els.specGap.value),
        gripperEdge: els.specEdge.value
      });
    } catch (e) { toast(e.message); fillSpecForm(); }
  }, 350);
}

['specPaperW', 'specPaperH', 'specGripper', 'specBleed', 'specGap', 'specEdge']
  .forEach((id) => els[id].addEventListener('change', specChanged));

/* ---------- 新增件 ---------- */

els.btnAddItem.addEventListener('click', async () => {
  const body = {
    name: els.newName.value.trim(),
    k: els.newK.value === '' ? null : Number(els.newK.value),
    qty: Math.max(1, Number(els.newQty.value) || 1),
    w: els.newW.value === '' ? null : Number(els.newW.value),
    h: els.newH.value === '' ? null : Number(els.newH.value)
  };
  try {
    await api('addItem', body);
    ['newName', 'newK', 'newW', 'newH'].forEach((id) => { els[id].value = ''; });
    els.newQty.value = '1';
  } catch (e) { toast(e.message); }
});

/* ---------- 待排清单 ---------- */

function renderPool() {
  const list = state.items.slice().sort((a, b) => a.id - b.id);
  els.poolCount.textContent = state.items.length + ' 种';
  els.itemPool.innerHTML = '';

  for (const item of list) {
    const ready = I.isItemReady(item);
    const p = placementOf(item.id);
    const li = document.createElement('li');
    li.className = 'item-card ' + (ready ? 'draggable' : 'locked');
    li.dataset.itemId = item.id;
    li.draggable = ready;

    const where = p ? ('已在第 ' + (p.sheetIndex + 1) + ' 张' + (p.draft ? ' · 未落版' : ''))
      : (ready ? '未上纸 · 拖到画布' : '');
    li.innerHTML =
      '<span class="nm">' + escapeHtml(item.name) +
        (ready ? ' <span class="badge-k">' + item.k + '开</span>'
               : ' <span class="badge-incomplete">资料不全</span>') + '</span>' +
      '<span class="meta">' +
        (ready ? (item.w + ' × ' + item.h + ' mm（含出血占位 ' +
          (item.w + 2 * state.spec.bleed) + ' × ' + (item.h + 2 * state.spec.bleed) + '）')
               : '缺：' + [
            !item.name ? '名称' : null,
            !(item.w > 0) ? '成品宽' : null,
            !(item.h > 0) ? '成品高' : null,
            !(Number.isInteger(item.k) && item.k > 0) ? '开数' : null
          ].filter(Boolean).join('、')) + '</span>' +
      '<span class="where">' + where + '</span>' +
      '<span class="ops">' +
        '<button class="icon-btn" data-op="edit" title="编辑">✎</button>' +
        '<button class="icon-btn" data-op="del" title="删除">✕</button>' +
      '</span>';

    if (ready) {
      li.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.setData('text/plain', String(item.id));
        ev.dataTransfer.effectAllowed = 'move';
        drag = { kind: 'new', itemId: item.id };
      });
      li.addEventListener('dragend', () => { drag = null; });
    } else {
      li.addEventListener('click', (ev) => {
        if (ev.target.dataset.op !== 'edit') toast('成品尺寸、开数缺一项，不能落版');
      });
    }

    li.querySelector('[data-op="del"]').addEventListener('click', async () => {
      if (!confirm('删除「' + item.name + '」？已上纸也会撤下并重新拼版。')) return;
      await api('deleteItem', { id: item.id });
    });
    li.querySelector('[data-op="edit"]').addEventListener('click', () => startInlineEdit(li, item));
    els.itemPool.appendChild(li);
  }
}

function startInlineEdit(li, item) {
  if (li.querySelector('.inline-edit')) return;
  const row = (label, val, key, step) =>
    '<label class="inline-edit">' + label +
    '<input class="inline-edit" data-k="' + key + '" type="number" step="' + (step || '0.1') +
      '" value="' + (val == null ? '' : val) + '"></label>';
  const div = document.createElement('div');
  div.className = 'editing-row';
  div.style.gridColumn = '1 / -1';
  div.style.display = 'flex';
  div.style.gap = '6px';
  div.style.marginTop = '4px';
  div.innerHTML =
    '<input class="inline-edit" data-k="name" type="text" value="' + escapeHtml(item.name) + '">' +
    row('开', item.k, 'k', '1') +
    row('宽', item.w, 'w') +
    row('高', item.h, 'h') +
    '<button class="icon-btn" data-op="save">存</button>';
  li.appendChild(div);
  div.querySelector('[data-op="save"]').addEventListener('click', async () => {
    const get = (k) => {
      const input = div.querySelector('[data-k="' + k + '"]');
      if (k === 'name') return input.value;
      return input.value === '' ? null : Number(input.value);
    };
    try {
      await api('updateItem', { id: item.id, name: get('name'), k: get('k'), w: get('w'), h: get('h') });
    } catch (e) { toast(e.message); }
  });
}

/* ---------- 纸张标签 ---------- */

function renderTabs() {
  els.sheetTabs.innerHTML = '';
  state.sheets.forEach((_, idx) => {
    const info = sheetInfo(idx);
    const btn = document.createElement('button');
    btn.className = 'sheet-tab' + (idx === activeSheet ? ' active' : '') +
      (info && !info.valid ? ' invalid' : '');
    btn.textContent = '第 ' + (idx + 1) + ' 张' +
      (info ? '（' + info.itemIds.length + '件）' : '');
    btn.title = info && !info.valid
      ? ('本张不算数：' + [
          info.overflow ? '有件超幅面' : null,
          info.gripperCovered ? '咬口被压住' : null
        ].filter(Boolean).join('、'))
      : '本张有效';
    btn.addEventListener('click', () => { activeSheet = idx; render(); });
    els.sheetTabs.appendChild(btn);
  });
}

els.btnAddSheet.addEventListener('click', async () => {
  await api('addSheet', {});
  activeSheet = state.sheets.length - 1;
  render();
});

els.btnAutoPack.addEventListener('click', () => api('autoPack', {}));

/* ---------- 画布 ---------- */

function computeScale() {
  const s = state.spec;
  const availW = els.canvasScroll.clientWidth - 60;
  const availH = els.canvasScroll.clientHeight - 60;
  return Math.min(1.2, Math.max(0.08, Math.min(availW / s.paperW, availH / s.paperH)));
}

function toMm(ev) {
  const rect = els.canvas.getBoundingClientRect();
  return {
    x: (ev.clientX - rect.left) / scale,
    y: (ev.clientY - rect.top) / scale
  };
}

function renderCanvas() {
  const s = state.spec;
  scale = computeScale();
  els.canvas.style.width = s.paperW * scale + 'px';
  els.canvas.style.height = s.paperH * scale + 'px';
  els.canvas.innerHTML = '';

  const paper = document.createElement('div');
  paper.className = 'paper';
  els.canvas.appendChild(paper);

  const area = I.usableRect(s);
  const usable = document.createElement('div');
  usable.className = 'usable';
  Object.assign(usable.style, boxStyle(area, scale));
  els.canvas.appendChild(usable);

  const gr = I.gripperRect(s);
  const g = document.createElement('div');
  g.className = 'gripper';
  Object.assign(g.style, boxStyle(gr, scale));
  g.textContent = '咬口 ' + s.gripper + 'mm · 禁止压件';
  els.canvas.appendChild(g);

  const info = sheetInfo(activeSheet) || { itemIds: [], overflowItemIds: [], gripperItemIds: [] };
  for (const p of state.placements.filter((q) => q.sheetIndex === activeSheet)) {
    const item = itemById(p.itemId);
    if (!item) continue;
    const fp = I.footprint(item, s.bleed);
    const el = document.createElement('div');
    const isOverflow = info.overflowItemIds.indexOf(p.itemId) >= 0;
    const isGripper = info.gripperItemIds.indexOf(p.itemId) >= 0;
    el.className = 'piece' +
      (p.mode === 'manual' ? ' manual' : '') +
      (p.draft ? ' draft' : '') +
      (isOverflow ? ' overflow' : '') +
      (isGripper ? ' gripper-hit' : '') +
      (selectedItemId === p.itemId ? ' selected' : '');
    el.style.left = p.x * scale + 'px';
    el.style.top = p.y * scale + 'px';
    el.style.width = fp.w * scale + 'px';
    el.style.height = fp.h * scale + 'px';
    el.dataset.itemId = p.itemId;

    const fs = Math.max(8, Math.min(13, Math.min(fp.w, fp.h) * scale * 0.22));
    el.style.fontSize = fs + 'px';

    const trim = document.createElement('div');
    trim.className = 'trim-mark';
    Object.assign(trim.style, {
      left: s.bleed * scale + 'px',
      top: s.bleed * scale + 'px',
      width: item.w * scale + 'px',
      height: item.h * scale + 'px'
    });
    el.appendChild(trim);

    const name = document.createElement('span');
    name.className = 'p-name';
    name.textContent = item.name;
    el.appendChild(name);
    const k = document.createElement('span');
    k.className = 'p-k';
    k.textContent = item.k + '开 · ' + item.w + '×' + item.h;
    el.appendChild(k);

    const warnParts = [];
    if (isOverflow) warnParts.push('超幅面');
    if (isGripper) warnParts.push('压咬口');
    if (p.draft) warnParts.push('未落版');
    if (warnParts.length) {
      const w = document.createElement('span');
      w.className = 'p-warn';
      w.textContent = '⚠ ' + warnParts.join('/');
      el.appendChild(w);
    }

    el.addEventListener('pointerdown', onPiecePointerDown);
    el.addEventListener('dblclick', async () => {
      await api('unpin', { itemId: p.itemId });
      selectedItemId = null;
    });
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      selectedItemId = p.itemId;
      render();
    });
    els.canvas.appendChild(el);
  }

  const badge = els.sheetBadge;
  if (info.overflow || info.gripperCovered) {
    badge.className = 'sheet-badge bad';
    badge.textContent = '第 ' + (activeSheet + 1) + ' 张不算数：' +
      [info.overflow ? '有 ' + info.overflowItemIds.length + ' 件超幅面（红色）' : null,
       info.gripperCovered ? '咬口被 ' + info.gripperItemIds.length + ' 件压住（黄色）' : null]
        .filter(Boolean).join('，');
  } else {
    badge.className = 'sheet-badge ok';
    badge.textContent = '第 ' + (activeSheet + 1) + ' 张有效 ✓ 共 ' + info.itemIds.length + ' 件';
  }

  els.sheetLegend.innerHTML =
    '<span><i class="sw" style="background:rgba(191,219,254,.75)"></i>自动件</span>' +
    '<span><i class="sw" style="background:rgba(237,233,254,.85)"></i>手动件（双击恢复自动）</span>' +
    '<span><i class="sw" style="background:rgba(254,202,202,.9)"></i>超幅面</span>' +
    '<span><i class="sw" style="background:rgba(253,230,138,.9)"></i>压咬口</span>' +
    '<span><i class="sw" style="background:#fde68a"></i>咬口区</span>' +
    '<span><i class="sw" style="background:#fff;border-style:dashed"></i>可用拼版区（幅面−咬口）</span>';
}

function boxStyle(r, sc) {
  return {
    left: r.x * sc + 'px',
    top: r.y * sc + 'px',
    width: r.w * sc + 'px',
    height: r.h * sc + 'px'
  };
}

/* 拖入新件（HTML5 DnD） */
function onCanvasDragOver(ev) {
  if (!drag) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
}

async function onCanvasDrop(ev) {
  ev.preventDefault();
  if (!drag || drag.kind !== 'new') return;
  const item = itemById(drag.itemId);
  if (!I.isItemReady(item)) {
    toast('成品尺寸、开数缺一项，不能落版');
    return;
  }
  const m = toMm(ev);
  try {
    await api('placeManual', {
      itemId: drag.itemId, sheetIndex: activeSheet,
      x: clampDropX(m.x, item), y: clampDropY(m.y, item), draft: false
    });
  } catch (e) { toast(e.message); }
}

function clampDropX(x, item) {
  const s = state.spec;
  const fp = I.footprint(item, s.bleed);
  return Math.min(Math.max(0, x - fp.w / 2), s.paperW - fp.w);
}
function clampDropY(y, item) {
  const s = state.spec;
  const fp = I.footprint(item, s.bleed);
  return Math.min(Math.max(0, y - fp.h / 2), s.paperH - fp.h);
}

/* 画布内拖动已上纸件（Pointer Events + 实时重排） */
function onPiecePointerDown(ev) {
  if (ev.button !== 0) return;
  const itemId = Number(ev.currentTarget.dataset.itemId);
  const p = placementOf(itemId);
  const item = itemById(itemId);
  if (!p || !item) return;
  ev.preventDefault();
  ev.currentTarget.setPointerCapture(ev.pointerId);
  const start = toMm(ev);
  drag = {
    kind: 'move', itemId,
    sheetIndex: p.sheetIndex,
    startX: p.x, startY: p.y,
    grabDx: start.x - p.x, grabDy: start.y - p.y,
    moved: false
  };
  selectedItemId = itemId;
  window.addEventListener('pointermove', onPiecePointerMove);
  window.addEventListener('pointerup', onPiecePointerUp, { once: true });
  window.addEventListener('pointercancel', onPiecePointerUp, { once: true });
}

async function sendDraft(x, y) {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(async () => {
    if (!drag || drag.kind !== 'move') return;
    const item = itemById(drag.itemId);
    try {
      await api('placeManual', {
        itemId: drag.itemId, sheetIndex: drag.sheetIndex,
        x: clampDropX(x - drag.grabDx, item),
        y: clampDropY(y - drag.grabDy, item),
        draft: true
      });
    } catch (e) { toast(e.message); }
  }, 120);
}

function onPiecePointerMove(ev) {
  if (!drag || drag.kind !== 'move') return;
  const m = toMm(ev);
  drag.moved = true;
  sendDraft(m.x, m.y);
}

async function onPiecePointerUp(ev) {
  if (!drag || drag.kind !== 'move') return;
  const d = drag;
  drag = null;
  clearTimeout(draftSaveTimer);
  window.removeEventListener('pointermove', onPiecePointerMove);
  if (!d.moved) {
    render();
    return;
  }
  const m = toMm(ev);
  const item = itemById(d.itemId);
  try {
    await api('placeManual', {
      itemId: d.itemId, sheetIndex: d.sheetIndex,
      x: clampDropX(m.x - d.grabDx, item),
      y: clampDropY(m.y - d.grabDy, item),
      draft: false
    });
  } catch (e) { toast(e.message); }
}

/* ---------- 草稿恢复（关掉页面/切走回来） ---------- */

function renderDraftBanner() {
  if (!state.draft) {
    els.draftBanner.classList.add('hidden');
    return;
  }
  const d = state.draft;
  const item = itemById(d.itemId);
  if (!item) {
    els.draftBanner.classList.add('hidden');
    return;
  }
  els.draftBanner.classList.remove('hidden');
  els.draftText.textContent =
    '上次「' + item.name + '」还拖在第 ' + (d.sheetIndex + 1) + ' 张，没落版 —— 接着刚才的位置继续摆。';
}

els.btnDraftResume.addEventListener('click', () => {
  if (!state.draft) return;
  activeSheet = state.draft.sheetIndex;
  selectedItemId = state.draft.itemId;
  render();
  toast('虚线框就是上次的草稿位，直接拖动或点“确认落版”');
});
els.btnDraftCommit.addEventListener('click', () => api('commitDraft', {}));
els.btnDraftDiscard.addEventListener('click', () => api('discardDraft', {}));

/* ---------- 渲染入口 ---------- */

function render() {
  if (!state) return;
  if (activeSheet >= state.sheets.length) activeSheet = state.sheets.length - 1;
  fillSpecForm();
  renderPool();
  renderTabs();
  renderCanvas();
  renderDraftBanner();
}

els.canvas.addEventListener('dragover', onCanvasDragOver);
els.canvas.addEventListener('drop', onCanvasDrop);
els.canvas.addEventListener('click', () => { selectedItemId = null; render(); });

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 120);
});

(async () => {
  try {
    await refresh();
    render();
    if (state.draft) {
      activeSheet = state.draft.sheetIndex;
      render();
      setTimeout(() => toast('检测到上次未完成的拖动，可在底部横幅继续'), 400);
    }
  } catch (e) {
    setSaveState('error', '连接失败');
    toast('无法连接服务器: ' + e.message);
  }
})();
