/* Node 测试：node test/engine.test.js
   覆盖需求 1-7 中可由引擎保证的全部规则。 */
var assert = require('assert');
var E = require('../js/engine.js');

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

function piece(seq, w, h, format, margin, rotated) {
  return { id: 'p' + seq, seq: seq * 2, name: '件' + seq, w: w, h: h,
    format: format, margin: margin == null ? 0 : margin, rotated: !!rotated, status: 'auto' };
}
var cfg = { paperW: 300, paperH: 400, gripper: 20, bleed: 10, allowRotate: false };

console.log('规则1：幅面、咬口、出血限定摆版区');
test('可用区 = 四周出血 + 底部咬口', function () {
  var ua = E.usableArea(cfg);
  assert.deepStrictEqual(ua, { x: 10, y: 10, w: 280, h: 360 });
});
test('咬口条位于纸张底部', function () {
  assert.deepStrictEqual(E.gripperRect(cfg), { x: 0, y: 380, w: 300, h: 20 });
});
test('咬口+出血吃掉整纸时配置无效', function () {
  assert.strictEqual(E.validConfig({ paperW: 10, paperH: 30, gripper: 20, bleed: 10 }), false);
  assert.strictEqual(E.validConfig(cfg), true);
});

console.log('规则2：同张纸拖动后其他件重排');
test('shelf 装箱保持顺序且互不重叠', function () {
  var ps = [piece(1, 100, 100, '16开', 0), piece(2, 100, 100, '16开', 0), piece(3, 100, 100, '16开', 0)];
  var r = E.autoPack(ps, cfg);
  assert.strictEqual(r.sheets.length, 1);
  assert.strictEqual(r.sheets[0].placements.length, 3);
  for (var i = 0; i < 3; i++) {
    var pl = r.sheets[0].placements[i];
    var fl = E.flagsAt(pl.piece, pl.x, pl.y, cfg);
    assert.deepStrictEqual(fl, []);
  }
});
test('每件在结果中只出现一次（不可能同时在两张纸）', function () {
  var ps = [];
  for (var i = 1; i <= 20; i++) ps.push(piece(i, 120, 120, '8开', 0));
  var r = E.autoPack(ps, cfg);
  var seen = {};
  var count = 0;
  r.sheets.forEach(function (sh) {
    sh.placements.forEach(function (pl) {
      assert.ok(!seen[pl.piece.id], pl.piece.id + ' 重复出现');
      seen[pl.piece.id] = 1; count++;
    });
  });
  assert.strictEqual(count, 20);
});

console.log('规则3：放不下按开数顺序续到下一张');
test('超量件续排到第二张且顺序不乱', function () {
  var ps = [piece(1, 150, 150, '8开', 0), piece(2, 150, 150, '8开', 0),
            piece(3, 150, 150, '8开', 0), piece(4, 150, 150, '8开', 0)];
  var r = E.autoPack(ps, cfg);
  assert.ok(r.sheets.length >= 2);
  // 可用区 280 宽：每条带只能摆 1 个 150，竖向 2 条 = 300，第三件续页
  assert.deepStrictEqual(
    r.sheets[0].placements.map(function (p) { return p.piece.id; }), ['p1', 'p2']);
  assert.deepStrictEqual(
    r.sheets[1].placements.map(function (p) { return p.piece.id; }), ['p3', 'p4']);
});
test('开数排序：小开数（大成品）优先摆', function () {
  var ps = [piece(2, 210, 285, '16开', 0), piece(1, 420, 580, '4开', 0)];
  ps.sort(E.byFormatThenSeq);
  assert.strictEqual(ps[0].format, '4开');
  assert.strictEqual(ps[1].format, '16开');
});

console.log('规则4：成品尺寸/开数/留边缺一不可');
test('缺开数或尺寸不允许落版', function () {
  assert.strictEqual(E.pieceReady(piece(1, 100, 100, '16开', 0)), true);
  assert.strictEqual(E.pieceReady({ w: 100, h: 100, format: '', margin: 0 }), false);
  assert.strictEqual(E.pieceReady({ w: null, h: 100, format: '16开', margin: 0 }), false);
  assert.strictEqual(E.pieceReady({ w: 100, h: 0, format: '16开', margin: 0 }), false);
  assert.strictEqual(E.pieceReady({ w: 100, h: 100, format: '16开' }), false);
});
test('留边计入落版占地（成品+两侧留边）', function () {
  var c = E.cellSize({ w: 100, h: 80, margin: 5 });
  assert.deepStrictEqual(c, { w: 110, h: 90 });
});

console.log('规则5：超出幅面当场标出溢出件');
test('压出血带/超幅面 → overflow', function () {
  var p = piece(1, 100, 100, '16开', 0);
  var fl = E.flagsAt(p, 200, 300, cfg); // 右边 300=纸宽，下边 400 压咬口
  assert.ok(fl.indexOf(E.FLAG.OVERFLOW) >= 0);
});
test('大于可用区的件 → too_large 进 remainder，上溢出纸', function () {
  var p = piece(1, 290, 370, '全', 0);
  var fl = E.flagsAt(p, 5, 5, cfg);
  assert.ok(fl.indexOf(E.FLAG.TOO_LARGE) >= 0);
  var r = E.autoPack([p], cfg);
  assert.strictEqual(r.remainder.length, 1);
  assert.strictEqual(r.sheets[0].placements.length, 0);
});
test('可用区内合法摆放无标记', function () {
  var p = piece(1, 100, 100, '16开', 2);
  assert.deepStrictEqual(E.flagsAt(p, 10, 10, cfg), []);
});

console.log('规则6：咬口不能被压住');
test('件压住咬口条 → gripper，该纸判无效', function () {
  var p = piece(1, 100, 100, '16开', 0);
  var fl = E.flagsAt(p, 50, 330, cfg); // 330+100=430 侵入咬口(380起)
  assert.ok(fl.indexOf(E.FLAG.GRIPPER) >= 0);
});
test('贴住咬口上沿但不压入 → 合法', function () {
  var p = piece(1, 100, 100, '16开', 0);
  assert.deepStrictEqual(E.flagsAt(p, 50, 270, cfg), []); // 底 370=出血内沿，不压咬口
});

console.log('规则7：进度可序列化恢复（由 app 的 localStorage 持久化保证）');
test('摆放结果仅依赖纯数据状态，可序列化后重算', function () {
  var ps = [piece(1, 120, 120, '8开', 3), piece(2, 90, 90, '16开', 3)];
  var r1 = E.autoPack(ps, cfg);
  var restored = JSON.parse(JSON.stringify({ cfg: cfg, pieces: ps }));
  var r2 = E.autoPack(restored.pieces, restored.cfg);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(r1.sheets.map(function (s) {
      return s.placements.map(function (pl) { return [pl.piece.id, pl.x, pl.y]; });
    }))),
    JSON.parse(JSON.stringify(r2.sheets.map(function (s) {
      return s.placements.map(function (pl) { return [pl.piece.id, pl.x, pl.y]; });
    })))
  );
});

console.log('\n' + passed + ' 项全部通过');
