const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const I = require('./lib/imposition');

const PORT = Number(process.env.PORT || 8080);
const DATA_FILE = path.join(__dirname, 'data', 'state.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

let state = null;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function cleanSpec(s) {
  return {
    paperW: Number(s && s.paperW),
    paperH: Number(s && s.paperH),
    gripper: Number(s && s.gripper),
    bleed: Number(s && s.bleed),
    gap: Number(s && s.gap),
    gripperEdge: s && s.gripperEdge
  };
}

function cleanItem(raw, id) {
  return {
    id,
    name: String(raw.name == null ? '' : raw.name),
    k: Number.isInteger(Number(raw.k)) ? Number(raw.k) : null,
    w: num(raw.w),
    h: num(raw.h),
    qty: Number.isInteger(Number(raw.qty)) && Number(raw.qty) > 0 ? Number(raw.qty) : 1
  };
}

function seedState() {
  const d = I.getDefaults();
  d.spec = { paperW: 889, paperH: 1194, gripper: 12, bleed: 3, gap: 2, gripperEdge: 'bottom' };
  const add = (name, k, w, h, qty) => {
    for (let n = 0; n < qty; n++) {
      d.items.push({ id: d.nextItemId, name: qty > 1 ? name + '-' + (n + 1) : name, k, w, h, qty: 1 });
      d.nextItemId += 1;
    }
  };
  add('海报 8开', 8, 298, 444, 5);
  add('卡片 16开', 16, 222, 298, 18);
  add('标签 32开', 32, 148, 222, 8);
  d.items.push({ id: d.nextItemId, name: '待补资料件（缺高度）', k: 16, w: 222, h: null, qty: 1 });
  d.nextItemId += 1;
  const packed = I.autoPack(d);
  d.sheets = packed.sheets;
  d.placements = packed.placements;
  return d;
}

async function loadState() {
  try {
    const raw = await fsp.readFile(DATA_FILE, 'utf8');
    state = JSON.parse(raw);
  } catch (e) {
    state = seedState();
    await persist();
  }
}

let saveChain = Promise.resolve();
function persist() {
  const snapshot = JSON.stringify(state, null, 2);
  saveChain = saveChain.then(async () => {
    const tmp = DATA_FILE + '.tmp.' + process.pid + '.' + crypto.randomBytes(3).toString('hex');
    await fsp.writeFile(tmp, snapshot, 'utf8');
    await fsp.rename(tmp, DATA_FILE);
  });
  return saveChain;
}

function publicState() {
  let summary;
  try {
    summary = I.summarize(state);
  } catch (e) {
    summary = { error: String(e.message || e) };
  }
  return Object.assign({}, state, { summary });
}

function guardInvariants(candidate) {
  const specErr = I.validateSpec(candidate.spec);
  if (specErr) throw Object.assign(new Error(specErr), { status: 400 });
  const ready = new Set(candidate.items.filter(I.isItemReady).map((x) => x.id));
  const seen = new Set();
  for (const p of candidate.placements) {
    if (!ready.has(p.itemId)) {
      throw Object.assign(new Error('成品尺寸、开数缺一项的件不能上纸（itemId=' + p.itemId + '）'), { status: 400 });
    }
    if (seen.has(p.itemId)) {
      throw Object.assign(new Error('同一个成品件不能同时出现在两张纸上（itemId=' + p.itemId + '）'), { status: 400 });
    }
    seen.add(p.itemId);
  }
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 5 * 1024 * 1024) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function applyAction(action, body) {
  if (action === 'addItem') {
    const it = cleanItem(body, state.nextItemId);
    if (!it.name.trim()) throw Object.assign(new Error('请填写成品名称'), { status: 400 });
    if (!I.isItemReady(it)) throw Object.assign(new Error('成品尺寸、开数缺一项，不能建档落版'), { status: 400 });
    const qty = Math.max(1, it.qty || 1);
    const created = [];
    for (let n = 0; n < qty; n++) {
      const item = Object.assign({}, it, { id: state.nextItemId, qty: 1 });
      if (qty > 1) item.name = it.name + '-' + (n + 1);
      state.items.push(item);
      created.push(item.id);
      state.nextItemId += 1;
    }
    return { createdItemIds: created };
  }
  if (action === 'updateItem') {
    const id = Number(body.id);
    const it = state.items.find((x) => x.id === id);
    if (!it) throw Object.assign(new Error('成品不存在'), { status: 404 });
    const merged = Object.assign({}, it, {
      name: body.name == null ? it.name : String(body.name),
      k: body.k === '' || body.k == null ? null : Number(body.k),
      w: body.w === '' || body.w == null ? null : Number(body.w),
      h: body.h === '' || body.h == null ? null : Number(body.h)
    });
    if (!I.isItemReady(merged) && state.placements.some((p) => p.itemId === id)) {
      const out = I.removePlacement(state, id);
      state.sheets = out.sheets;
      state.placements = out.placements;
    }
    state.items = state.items.map((x) => (x.id === id ? merged : x));
    return {};
  }
  if (action === 'deleteItem') {
    const id = Number(body.id);
    if (state.placements.some((p) => p.itemId === id)) {
      const out = I.removePlacement(state, id);
      state.sheets = out.sheets;
      state.placements = out.placements;
    }
    state.items = state.items.filter((x) => x.id !== id);
    return {};
  }
  if (action === 'updateSpec') {
    const candidate = cleanSpec(body);
    const err = I.validateSpec(candidate);
    if (err) throw Object.assign(new Error(err), { status: 400 });
    state.spec = candidate;
    const out = I.reflow(state, 0);
    state.sheets = out.sheets;
    state.placements = out.placements;
    return {};
  }
  if (action === 'autoPack') {
    const out = I.autoPack(state);
    state.sheets = out.sheets;
    state.placements = out.placements;
    return {};
  }
  if (action === 'placeManual') {
    const itemId = Number(body.itemId);
    const sheetIndex = Number(body.sheetIndex);
    const x = Number(body.x);
    const y = Number(body.y);
    const draft = !!body.draft;
    if (!Number.isInteger(sheetIndex) || sheetIndex < 0 || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw Object.assign(new Error('落版参数无效'), { status: 400 });
    }
    const out = I.placeManual(state, itemId, sheetIndex, x, y, draft);
    state.sheets = out.sheets;
    state.placements = out.placements;
    state.draft = draft ? { itemId, sheetIndex, x, y, at: Date.now() } : null;
    return {};
  }
  if (action === 'commitDraft') {
    if (!state.draft) return {};
    const d = state.draft;
    const out = I.placeManual(state, d.itemId, d.sheetIndex, d.x, d.y, false);
    state.sheets = out.sheets;
    state.placements = out.placements;
    state.draft = null;
    return {};
  }
  if (action === 'discardDraft') {
    if (state.draft) {
      const id = state.draft.itemId;
      const out = I.removePlacement(state, id);
      state.sheets = out.sheets;
      state.placements = out.placements;
      state.draft = null;
    }
    return {};
  }
  if (action === 'unpin') {
    const out = I.unpinPlacement(state, Number(body.itemId));
    state.sheets = out.sheets;
    state.placements = out.placements;
    return {};
  }
  if (action === 'removePlacement') {
    const out = I.removePlacement(state, Number(body.itemId));
    state.sheets = out.sheets;
    state.placements = out.placements;
    return {};
  }
  if (action === 'addSheet') {
    state.sheets.push({});
    return {};
  }
  throw Object.assign(new Error('未知操作: ' + action), { status: 400 });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url.startsWith('/api/state')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(publicState()));
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/api/action/')) {
      const action = req.url.slice('/api/action/'.length).split('?')[0];
      const body = await readJson(req);
      const extra = applyAction(action, body);
      guardInvariants(state);
      await persist();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(Object.assign({}, publicState(), extra)));
      return;
    }
    if (req.method === 'GET') {
      if (req.url.split('?')[0] === '/imposition.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        res.end(fs.readFileSync(path.join(__dirname, 'lib', 'imposition.js')));
        return;
      }
      serveStatic(req, res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (e) {
    const status = e.status || 400;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
});

(async () => {
  await loadState();
  server.listen(PORT, () => {
    console.log('印刷拼版系统已启动: http://localhost:' + PORT);
  });
})();
