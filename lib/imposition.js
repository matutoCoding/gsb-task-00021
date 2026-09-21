(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Imposition = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FORMATS = {
    FULL: { label: '全开', value: 1, w: 889, h: 1194 },
    TWO: { label: '对开', value: 2, w: 597, h: 889 },
    FOUR: { label: '4开', value: 4, w: 444, h: 597 },
    EIGHT: { label: '8开', value: 8, w: 298, h: 444 },
    SIXTEEN: { label: '16开', value: 16, w: 222, h: 298 },
    THIRTYTWO: { label: '32开', value: 32, w: 148, h: 222 },
    SIXTYFOUR: { label: '64开', value: 64, w: 111, h: 148 }
  };

  function getDefaults() {
    return {
      spec: { paperW: 889, paperH: 1194, gripper: 12, bleed: 3, gap: 0, gripperEdge: 'bottom' },
      items: [],
      sheets: [{}],
      placements: [],
      nextItemId: 1,
      draft: null
    };
  }

  function isFinitePos(n) { return typeof n === 'number' && isFinite(n) && n > 0; }

  function validateSpec(spec) {
    if (!spec) return '缺少纸张参数';
    if (!isFinitePos(spec.paperW) || !isFinitePos(spec.paperH)) return '纸张幅面无效';
    if (!isFinitePos(spec.gripper)) return '咬口宽度无效';
    if (typeof spec.bleed !== 'number' || spec.bleed < 0) return '出血边无效';
    if (typeof spec.gap !== 'number' || spec.gap < 0) return '留边无效';
    if (['bottom', 'top', 'left', 'right'].indexOf(spec.gripperEdge) < 0) return '咬口位置无效';
    const gSpan = spec.gripperEdge === 'bottom' || spec.gripperEdge === 'top' ? spec.paperH : spec.paperW;
    if (spec.gripper >= gSpan) return '咬口宽度不能大于纸张幅面';
    return null;
  }

  function paperRect(spec) { return { x: 0, y: 0, w: spec.paperW, h: spec.paperH }; }

  function gripperRect(spec) {
    const { paperW: W, paperH: H, gripper: g, gripperEdge: edge } = spec;
    if (edge === 'bottom') return { x: 0, y: H - g, w: W, h: g };
    if (edge === 'top') return { x: 0, y: 0, w: W, h: g };
    if (edge === 'left') return { x: 0, y: 0, w: g, h: H };
    return { x: W - g, y: 0, w: g, h: H };
  }

  function usableRect(spec) {
    const { paperW: W, paperH: H, gripper: g, gripperEdge: edge } = spec;
    if (edge === 'bottom') return { x: 0, y: 0, w: W, h: H - g };
    if (edge === 'top') return { x: 0, y: g, w: W, h: H - g };
    if (edge === 'left') return { x: g, y: 0, w: W - g, h: H };
    return { x: 0, y: 0, w: W - g, h: H };
  }

  function isItemReady(item) {
    return !!item &&
      typeof item.name === 'string' && item.name.trim() !== '' &&
      isFinitePos(item.w) && isFinitePos(item.h) &&
      Number.isInteger(item.k) && item.k > 0;
  }

  function footprint(item, bleed) {
    return { w: item.w + 2 * bleed, h: item.h + 2 * bleed };
  }

  function bleedBox(item, p, bleed) {
    const fp = footprint(item, bleed);
    return { x: p.x, y: p.y, w: fp.w, h: fp.h };
  }

  function overlap(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  }

  function contains(outer, inner) {
    return inner.x >= outer.x - 1e-6 && inner.y >= outer.y - 1e-6 &&
      inner.x + inner.w <= outer.x + outer.w + 1e-6 &&
      inner.y + inner.h <= outer.y + outer.h + 1e-6;
  }

  function orderItems(items) {
    return items.slice().sort((a, b) =>
      (a.k - b.k) || (a.id - b.id) || String(a.name).localeCompare(String(b.name)));
  }

  function findPosition(rect, obstacles, area, gap) {
    const xs = new Set([area.x]);
    const ys = new Set([area.y]);
    for (const o of obstacles) {
      xs.add(o.x + o.w + gap);
      ys.add(o.y + o.h + gap);
      // 障碍左下、左上角落，保证 L 形空位也能被利用
      xs.add(area.x);
      ys.add(o.y + o.h + gap);
      xs.add(o.x);
      ys.add(area.y);
    }
    let best = null;
    const pts = [];
    for (const y of ys) for (const x of xs) pts.push([x, y]);
    pts.sort((a, b) => (a[1] - b[1]) || (a[0] - b[0]));
    for (const [x, y] of pts) {
        const cand = { x, y, w: rect.w, h: rect.h };
        if (!contains(area, cand)) continue;
        let bad = false;
        for (const o of obstacles) {
          if (overlap(cand, o)) { bad = true; break; }
        }
        if (bad) continue;
        if (!best || cand.y < best.y || (cand.y === best.y && cand.x < best.x)) best = cand;
      }
    return best;
  }

  function placementFlags(item, p, spec) {
    const box = bleedBox(item, p, spec.bleed);
    return {
      box,
      overflow: !contains(paperRect(spec), box),
      gripperCovered: overlap(box, gripperRect(spec)),
      outOfUsable: !contains(usableRect(spec), box)
    };
  }

  function itemMap(items) {
    const m = new Map();
    for (const it of items) m.set(it.id, it);
    return m;
  }

  function assertPlacementInvariant(placements, items) {
    const ready = new Set(items.filter(isItemReady).map((i) => i.id));
    const seen = new Set();
    for (const p of placements) {
      if (!ready.has(p.itemId)) {
        return new Error('存在资料不全（缺成品尺寸或开数）的件被放上了纸: itemId=' + p.itemId);
      }
      if (seen.has(p.itemId)) {
        return new Error('同一个成品件不能同时出现在两张纸上: itemId=' + p.itemId);
      }
      seen.add(p.itemId);
    }
    return null;
  }

  // 从 startSheetIndex 起按开数顺序级联重排；手动件（含拖动中的草稿）作为障碍保留原位。
  function reflow(state, startSheetIndex) {
    const spec = state.spec;
    const items = state.items;
    const err = validateSpec(spec) || assertPlacementInvariant(state.placements, items);
    if (err) throw err;

    const byId = itemMap(items);
    const area = usableRect(spec);
    let sheets = (state.sheets && state.sheets.length ? state.sheets.slice() : [{}]);
    if (sheets.length <= startSheetIndex) startSheetIndex = Math.max(0, sheets.length - 1);
    if (startSheetIndex < 0) startSheetIndex = 0;

    const kept = [];
    const autoBySheet = new Map();
    for (const p of state.placements) {
      if (p.sheetIndex < startSheetIndex || p.mode === 'manual') {
        kept.push(p);
      } else {
        const list = autoBySheet.get(p.sheetIndex) || [];
        list.push(p.itemId);
        autoBySheet.set(p.sheetIndex, list);
      }
    }

    const result = kept.slice();
    let queue = [];
    let i = startSheetIndex;
    for (;;) {
      if (i >= sheets.length) sheets.push({});
      const obstacles = [];
      for (const p of result) {
        if (p.sheetIndex !== i) continue;
        const item = byId.get(p.itemId);
        if (item) obstacles.push(bleedBox(item, p, spec.bleed));
      }
      const candidateIds = Array.from(new Set(queue.concat(autoBySheet.get(i) || [])));
      const candidates = orderItems(candidateIds.map((id) => byId.get(id)).filter(isItemReady));
      const nextQueue = [];
      for (const item of candidates) {
        const fp = footprint(item, spec.bleed);
        const pos = findPosition({ x: area.x, y: area.y, w: fp.w, h: fp.h }, obstacles, area, spec.gap);
        if (pos) {
          const p = { itemId: item.id, sheetIndex: i, x: pos.x, y: pos.y, mode: 'auto', draft: false };
          result.push(p);
          obstacles.push(bleedBox(item, p, spec.bleed));
        } else {
          nextQueue.push(item.id);
        }
      }
      queue = nextQueue;
      i += 1;
      if (queue.length === 0 && !autoBySheet.has(i) && i > startSheetIndex) break;
      if (i > startSheetIndex + 10000) throw new Error('拼版重排异常');
    }

    const maxUsed = result.reduce((m, p) => Math.max(m, p.sheetIndex), startSheetIndex - 1);
    sheets = sheets.slice(0, Math.max(1, maxUsed + 1));

    return { sheets, placements: result, summary: summarize({ spec, items, sheets, placements: result }) };
  }

  // 手动拖放到指定位置，随后从受影响的纸张起级联重排。
  function placeManual(state, itemId, sheetIndex, x, y, draft) {
    const item = state.items.find((it) => it.id === itemId);
    if (!isItemReady(item)) {
      throw new Error('成品尺寸、开数必须齐全，缺一项都不能落版');
    }
    const prev = state.placements.find((q) => q.itemId === itemId);
    const placements = state.placements.filter((q) => q.itemId !== itemId);
    placements.push({ itemId, sheetIndex, x, y, mode: 'manual', draft: !!draft });
    const work = Object.assign({}, state, { placements });
    const from = prev ? Math.min(sheetIndex, prev.sheetIndex) : sheetIndex;
    return reflow(work, from);
  }

  // 手动件恢复为自动参与重排。
  function unpinPlacement(state, itemId) {
    const p = state.placements.find((q) => q.itemId === itemId);
    if (!p) return reflow(state, 0);
    const placements = state.placements.map((q) =>
      q.itemId === itemId ? Object.assign({}, q, { mode: 'auto', draft: false }) : q);
    return reflow(Object.assign({}, state, { placements }), p.sheetIndex);
  }

  function removePlacement(state, itemId) {
    const p = state.placements.find((q) => q.itemId === itemId);
    const placements = state.placements.filter((q) => q.itemId !== itemId);
    const work = Object.assign({}, state, { placements });
    return reflow(work, p ? p.sheetIndex : 0);
  }

  function autoPack(state) {
    const placed = new Set(state.placements.map((p) => p.itemId));
    const maxSheet = state.placements.reduce((m, p) => Math.max(m, p.sheetIndex), 0);
    const placements = state.placements.slice();
    for (const item of orderItems(state.items.filter(isItemReady))) {
      if (placed.has(item.id)) continue;
      placements.push({ itemId: item.id, sheetIndex: maxSheet, x: 0, y: 0, mode: 'auto', draft: false });
    }
    return reflow(Object.assign({}, state, { placements }), 0);
  }

  function summarize(state) {
    const { spec, items, sheets, placements } = state;
    const byId = itemMap(items);
    const sheetInfo = sheets.map((_, idx) => {
      const here = placements.filter((p) => p.sheetIndex === idx);
      let overflow = false;
      let gripperCovered = false;
      const overflowItemIds = [];
      const gripperItemIds = [];
      for (const p of here) {
        const item = byId.get(p.itemId);
        if (!item) continue;
        const f = placementFlags(item, p, spec);
        if (f.overflow) { overflow = true; overflowItemIds.push(p.itemId); }
        if (f.gripperCovered) { gripperCovered = true; gripperItemIds.push(p.itemId); }
      }
      return {
        index: idx,
        itemIds: here.map((p) => p.itemId),
        overflow,
        gripperCovered,
        valid: !overflow && !gripperCovered,
        overflowItemIds,
        gripperItemIds
      };
    });
    const placedSet = new Set(placements.map((p) => p.itemId));
    return {
      sheets: sheetInfo,
      unplaced: items.filter((it) => isItemReady(it) && !placedSet.has(it.id)).map((it) => it.id),
      incomplete: items.filter((it) => !isItemReady(it)).map((it) => it.id)
    };
  }

  return {
    FORMATS, getDefaults, validateSpec, isItemReady, orderItems,
    paperRect, gripperRect, usableRect, footprint, bleedBox, overlap, contains,
    findPosition, placementFlags, reflow, placeManual, unpinPlacement,
    removePlacement, autoPack, summarize
  };
});
