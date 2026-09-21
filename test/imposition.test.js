const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../lib/imposition');

const SPEC = { paperW: 889, paperH: 1194, gripper: 12, bleed: 3, gap: 0, gripperEdge: 'bottom' };

function mkState(items) {
  return { spec: SPEC, items, sheets: [{}], placements: [], nextItemId: items.length + 1, draft: null };
}

function item(id, k, w, h, name) {
  return { id, name: name || ('件' + id), k, w, h };
}

test('幅面/咬口/出血共同确定可用拼版区（咬口条在底边）', () => {
  assert.deepEqual(I.usableRect(SPEC), { x: 0, y: 0, w: 889, h: 1182 });
  assert.deepEqual(I.gripperRect(SPEC), { x: 0, y: 1182, w: 889, h: 12 });
  const left = Object.assign({}, SPEC, { gripperEdge: 'left' });
  assert.deepEqual(I.usableRect(left), { x: 12, y: 0, w: 877, h: 1194 });
});

test('开数顺序自动铺版，放不下级联到下一张', () => {
  const items = [];
  for (let i = 0; i < 12; i++) items.push(item(i + 1, 8, 298, 444));
  const out = I.autoPack(mkState(items));
  const counts = [0, 0, 0, 0];
  out.placements.forEach((p) => { counts[p.sheetIndex] += 1; });
  assert.equal(counts[0], 4, '889x1182 可用区并 2 列 x 2 行 = 4 个 304x450 出血框');
  assert.equal(counts[1], 4);
  assert.equal(counts[2], 4);
  assert.equal(out.placements.length, 12);
  const s0 = out.summary.sheets[0].itemIds;
  assert.deepEqual(s0, [1, 2, 3, 4]);
  assert.deepEqual(out.summary.sheets[2].itemIds, [9, 10, 11, 12]);
});

test('同一件不能同时出现在两张纸上（去重不变量）', () => {
  const state = mkState([item(1, 16, 222, 298)]);
  state.placements = [
    { itemId: 1, sheetIndex: 0, x: 0, y: 0, mode: 'auto', draft: false },
    { itemId: 1, sheetIndex: 1, x: 0, y: 0, mode: 'auto', draft: false }
  ];
  assert.throws(() => I.reflow(state, 0), /同一个成品件/);
});

test('缺成品尺寸/开数不能落版', () => {
  const state = mkState([{ id: 1, name: '资料不全', k: 16, w: 222 }]);
  assert.equal(I.isItemReady(state.items[0]), false);
  assert.throws(() => I.placeManual(state, 1, 0, 0, 0, false), /缺一项/);
  const base = mkState([item(1, 16, 222, 298), { id: 2, name: '缺', k: 16, w: 200 }]);
  const packed = I.autoPack(base);
  const sum = I.summarize({ spec: base.spec, items: base.items, sheets: packed.sheets, placements: packed.placements });
  assert.deepEqual(sum.incomplete, [2]);
});

test('超幅面当场标出溢出件，且该纸判为无效', () => {
  const state = mkState([item(1, 1, 900, 1200)]);
  const out = I.placeManual(state, 1, 0, 0, 0, false);
  assert.equal(out.summary.sheets[0].overflow, true);
  assert.deepEqual(out.summary.sheets[0].overflowItemIds, [1]);
  assert.equal(out.summary.sheets[0].valid, false);
});

test('压住咬口：该张纸不算数，肇事件被标出', () => {
  const items = [item(1, 16, 222, 298), item(2, 16, 222, 298)];
  const state = mkState(items);
  const out = I.placeManual(state, 1, 0, 0, 1182 - 6 + 3, false);
  assert.equal(out.summary.sheets[0].gripperCovered, true);
  assert.deepEqual(out.summary.sheets[0].gripperItemIds, [1]);
  assert.equal(out.summary.sheets[0].valid, false);
});

test('手动拖动后，其余件按开数顺序立刻重排/顺延到下一张', () => {
  const items = [];
  for (let i = 0; i < 7; i++) items.push(item(i + 1, 8, 298, 444));
  let out = I.autoPack(mkState(items));
  const dragged = out.placements.find((p) => p.itemId === 1);
  const work = Object.assign({}, mkState(items), { placements: out.placements, sheets: out.sheets });
  out = I.placeManual(work, 1, 0, 304, 0, false);
  const sheet0Ids = out.summary.sheets[0].itemIds;
  assert.ok(sheet0Ids.indexOf(1) >= 0);
  assert.ok(sheet0Ids.length <= 4);
  assert.deepEqual(out.summary.sheets[1].itemIds.length, 7 - sheet0Ids.length);
  const autoOrder = out.placements.filter((p) => p.mode === 'auto').map((p) => p.itemId);
  assert.deepEqual(autoOrder, [2, 3, 4, 5, 6, 7]);
});

test('草稿位（拖动中/关页面）保留，回来仍可续排并最终落版', () => {
  const state = mkState([item(1, 16, 222, 298)]);
  const out = I.placeManual(state, 1, 0, 10, 10, true);
  const p = out.placements.find((q) => q.itemId === 1);
  assert.equal(p.draft, true);
  assert.equal(p.mode, 'manual');
  assert.equal(p.x, 10);
  const committed = I.placeManual(
    Object.assign({}, state, { placements: out.placements, sheets: out.sheets }),
    1, 0, 20, 20, false);
  const cp = committed.placements.find((q) => q.itemId === 1);
  assert.equal(cp.draft, false);
  assert.equal(cp.x, 20);
});

test('自动铺版全部有效、无溢出无压咬口时纸张算数', () => {
  const items = [];
  for (let i = 0; i < 3; i++) items.push(item(i + 1, 16, 222, 298));
  const out = I.autoPack(mkState(items));
  assert.ok(out.summary.sheets.every((s) => s.valid));
  assert.deepEqual(out.summary.unplaced, []);
});
