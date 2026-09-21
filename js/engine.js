/* 印刷拼版核心引擎：纯函数，浏览器与 Node 测试共用 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Imposition = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 常见纸张幅面（mm，短边 × 长边） */
  var PAPERS = [
    { id: 'custom', name: '自定义', w: null, h: null },
    { id: 'A0', name: 'A0 (841×1189)', w: 841, h: 1189 },
    { id: 'A1', name: 'A1 (594×841)', w: 594, h: 841 },
    { id: 'A2', name: 'A2 (420×594)', w: 420, h: 594 },
    { id: 'A3', name: 'A3 (297×420)', w: 297, h: 420 },
    { id: 'A4', name: 'A4 (210×297)', w: 210, h: 297 },
    { id: 'A5', name: 'A5 (148×210)', w: 148, h: 210 },
    { id: 'zhengdu', name: '正度全张 (787×1092)', w: 787, h: 1092 },
    { id: 'dadu', name: '大度全张 (889×1194)', w: 889, h: 1194 }
  ];

  /* 大度纸常见开数的成品参考尺寸（mm），新建成品件时预填，可改 */
  var FORMATS = [
    { k: '全', w: 860, h: 1160 },
    { k: '对开', w: 580, h: 860 },
    { k: '4开', w: 420, h: 580 },
    { k: '6开', w: 380, h: 420 },
    { k: '8开', w: 285, h: 420 },
    { k: '12开', w: 285, h: 280 },
    { k: '16开', w: 210, h: 285 },
    { k: '24开', w: 170, h: 210 },
    { k: '32开', w: 140, h: 203 }
  ];

  var FLAG = {
    OVERFLOW: 'overflow',   // 超出出血可用区/纸张幅面
    GRIPPER: 'gripper',     // 压住咬口
    TOO_LARGE: 'too_large'  // 占地大于可用区，任何位置都放不下
  };

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w &&
           a.y < b.y + b.h && b.y < a.y + a.h;
  }

  /**
   * 规则1：幅面、咬口、出血共同限定摆版范围。
   * 坐标以纸张左上角为 (0,0)，咬口是底部高 gripper 的纸口条。
   * 可用区 = 四周让出出血边，底部再让出咬口。
   */
  function usableArea(cfg) {
    var b = Math.max(0, isNum(cfg.bleed) ? cfg.bleed : 0);
    var g = Math.max(0, isNum(cfg.gripper) ? cfg.gripper : 0);
    return {
      x: b,
      y: b,
      w: Math.max(0, cfg.paperW - 2 * b),
      h: Math.max(0, cfg.paperH - 2 * b - g)
    };
  }

  function gripperRect(cfg) {
    var g = Math.max(0, cfg.gripper || 0);
    return { x: 0, y: cfg.paperH - g, w: cfg.paperW, h: g };
  }

  function validConfig(cfg) {
    var ua = usableArea(cfg);
    return isNum(cfg.paperW) && cfg.paperW > 0 &&
      isNum(cfg.paperH) && cfg.paperH > 0 &&
      ua.w > 0 && ua.h > 0;
  }

  /* 成品件落版占地 = 成品尺寸 + 两侧留边（出血是纸张级约束） */
  function cellSize(p) {
    var m = Math.max(0, isNum(p.margin) ? p.margin : 0);
    return p.rotated
      ? { w: p.h + 2 * m, h: p.w + 2 * m }
      : { w: p.w + 2 * m, h: p.h + 2 * m };
  }

  /* 规则4：成品尺寸、开数、留边缺一不可，缺项的件不得落版 */
  function pieceReady(p) {
    return !!p &&
      isNum(p.w) && p.w > 0 &&
      isNum(p.h) && p.h > 0 &&
      isNum(p.margin) && p.margin >= 0 &&
      typeof p.format === 'string' && p.format.length > 0;
  }

  /* 规则3：按开数顺序续排（全=1，对开=2…） */
  function formatOrder(f) {
    if (f === '全') return 1;
    if (f === '对开') return 2;
    var n = parseInt(String(f).replace(/[^0-9]/g, ''), 10);
    return isFinite(n) ? n : 9999;
  }
  function byFormatThenSeq(a, b) {
    var d = formatOrder(a.format) - formatOrder(b.format);
    return d !== 0 ? d : (a.seq || 0) - (b.seq || 0);
  }

  /**
   * 规则5、6：判定成品件落在 (x,y) 时的违规标记。
   * too_large：占地超过可用区，任何一张纸都放不下
   * overflow：当前位置越出可用区（压出血带或超出幅面）
   * gripper：当前位置压住咬口条 —— 该张纸不算数
   */
  function flagsAt(p, x, y, cfg) {
    var cell = cellSize(p);
    var r = { x: x, y: y, w: cell.w, h: cell.h };
    var flags = [];
    var ua = usableArea(cfg);

    if (cell.w > ua.w + 1e-6 || cell.h > ua.h + 1e-6) flags.push(FLAG.TOO_LARGE);

    var inside =
      x + 1e-6 >= ua.x && y + 1e-6 >= ua.y &&
      x + cell.w <= ua.x + ua.w + 1e-6 &&
      y + cell.h <= ua.y + ua.h + 1e-6;
    if (!inside) flags.push(FLAG.OVERFLOW);

    if ((cfg.gripper || 0) > 0 && rectsOverlap(r, gripperRect(cfg))) {
      flags.push(FLAG.GRIPPER);
    }
    return flags;
  }

  /**
   * 规则2、3：shelf（水平条带）装箱。
   * 按 pieces 给定顺序逐件摆；当前纸张各条带放不下就开新纸张，
   * 同一件只可能出现一次。本身大于可用区的件进 remainder。
   * 入参 allowRotate 为真时允许 90° 旋转找朝向。
   * 返回 { sheets:[{placements:[{piece,x,y,rotated}]}], remainder:[piece] }
   */
  function autoPack(pieces, cfg, opts) {
    var allowRotate = opts ? opts.allowRotate !== false : true;
    var ua = usableArea(cfg);

    function variants(p) {
      var m = Math.max(0, p.margin || 0);
      var vs = [{ w: p.w + 2 * m, h: p.h + 2 * m, rotated: false }];
      if (allowRotate && p.w !== p.h) {
        vs.push({ w: p.h + 2 * m, h: p.w + 2 * m, rotated: true });
      }
      return vs;
    }

    function newSheet() { return { rows: [], placements: [] }; }
    var sheets = [newSheet()];
    var remainder = [];

    pieces.forEach(function (p) {
      var vs = variants(p);
      var oversized = vs.every(function (c) {
        return c.w > ua.w + 1e-6 || c.h > ua.h + 1e-6;
      });
      if (oversized) { remainder.push(p); return; }

      var done = false;
      for (var si = 0; si < sheets.length && !done; si++) {
        var sh = sheets[si];
        for (var ri = 0; ri <= sh.rows.length && !done; ri++) {
          var row = ri < sh.rows.length ? sh.rows[ri] : null;
          var y = row ? row.y
            : (sh.rows.length
                ? sh.rows[sh.rows.length - 1].y + sh.rows[sh.rows.length - 1].h
                : ua.y);
          for (var vi = 0; vi < vs.length && !done; vi++) {
            var c = vs[vi];
            var x = row ? row.x + row.w : ua.x;
            var fitsW = x + c.w <= ua.x + ua.w + 1e-6;
            var fitsH = y + c.h <= ua.y + ua.h + 1e-6;
            var fitsRow = !row || c.h <= row.h + 1e-6;
            if (fitsW && fitsH && fitsRow) {
              if (row) { row.w += c.w; }
              else { sh.rows.push({ x: ua.x, y: y, w: c.w, h: c.h }); }
              sh.placements.push({ piece: p, x: x, y: y, rotated: c.rotated });
              done = true;
            }
          }
        }
      }

      // 规则3：所有现有纸张都放不下 → 顺序续到下一张
      if (!done) {
        var ns = newSheet();
        var c0 = vs[0];
        ns.rows.push({ x: ua.x, y: ua.y, w: c0.w, h: c0.h });
        ns.placements.push({ piece: p, x: ua.x, y: ua.y, rotated: false });
        sheets.push(ns);
      }
    });

    return { sheets: sheets, remainder: remainder };
  }

  return {
    PAPERS: PAPERS,
    FORMATS: FORMATS,
    FLAG: FLAG,
    usableArea: usableArea,
    gripperRect: gripperRect,
    validConfig: validConfig,
    cellSize: cellSize,
    pieceReady: pieceReady,
    formatOrder: formatOrder,
    byFormatThenSeq: byFormatThenSeq,
    flagsAt: flagsAt,
    rectsOverlap: rectsOverlap,
    autoPack: autoPack
  };
});
