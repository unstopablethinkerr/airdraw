// 2D vector drawing engine: tools, shapes, symmetry, layouts, undo/redo, PNG/JPG/SVG export.
const DPR = () => Math.min(window.devicePixelRatio || 1, 2);
export const SHAPES = ['line', 'rect', 'ellipse', 'triangle', 'arrow', 'star'];

function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function lerpColor(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const r = Math.round(((pa >> 16) & 255) * (1 - t) + ((pb >> 16) & 255) * t);
  const g = Math.round(((pa >> 8) & 255) * (1 - t) + ((pb >> 8) & 255) * t);
  const bl = Math.round((pa & 255) * (1 - t) + (pb & 255) * t);
  return `rgb(${r},${g},${bl})`;
}
function symTransforms(sym, w, h) {
  const cx = w / 2, cy = h / 2, T = [];
  const rot = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy]; };
  T.push([1, 0, 0, 1, 0, 0]);
  if (sym === 'mirror-x' || sym === 'quad') T.push([-1, 0, 0, 1, 2 * cx, 0]);
  if (sym === 'mirror-y' || sym === 'quad') T.push([1, 0, 0, -1, 0, 2 * cy]);
  if (sym === 'quad') T.push([-1, 0, 0, -1, 2 * cx, 2 * cy]);
  const n = sym === 'radial6' ? 6 : sym === 'radial8' ? 8 : 0;
  for (let k = 1; k < n; k++) T.push(rot((2 * Math.PI * k) / n));
  return T;
}
function shapePoints(tool, a, b) {
  const [x1, y1] = a, [x2, y2] = b;
  if (tool === 'triangle') return [[(x1 + x2) / 2, y1], [x2, y2], [x1, y2]];
  if (tool === 'star') {
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, R = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)) / 2, r = R * 0.45, out = [];
    for (let i = 0; i < 10; i++) { const ang = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r : R; out.push([cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr]); }
    return out;
  }
  return null;
}

export class Draw2D {
  constructor(bg, main, live) {
    this.bg = bg; this.main = main; this.live = live;
    this.bx = bg.getContext('2d'); this.mx = main.getContext('2d'); this.lx = live.getContext('2d');
    this.doc = { width: 1280, height: 720, layout: 'white', strokes: [] };
    this.undoStack = []; this.redoStack = [];
    this.cur = null; this.onChange = () => {};
    this.view = { s: 1, ox: 0, oy: 0 };
    this.bgVideo = null;
  }

  newDoc(w, h, layout) { this.doc = { width: Math.round(w), height: Math.round(h), layout: layout || this.doc.layout, strokes: [] }; this.undoStack = []; this.redoStack = []; this.resize(); this.onChange(); }

  resize() {
    const r = this.main.parentElement.getBoundingClientRect(), d = DPR();
    for (const c of [this.bg, this.main, this.live]) { c.width = Math.max(1, Math.round(r.width * d)); c.height = Math.max(1, Math.round(r.height * d)); }
    this.view = { d, cw: r.width, ch: r.height };
    this._layout();
  }
  // zoom & pan (view only – the drawing itself is untouched)
  _layout() {
    const v = this.view, fit = Math.min(v.cw / this.doc.width, v.ch / this.doc.height);
    this.zoom = this.zoom || 1; this.panX = this.panX || 0; this.panY = this.panY || 0;
    v.s = fit * this.zoom;
    v.ox = (v.cw - this.doc.width * v.s) / 2 + this.panX; v.oy = (v.ch - this.doc.height * v.s) / 2 + this.panY;
    this.renderBackground(); this.renderAll(); this.renderLive(); this.onView?.(this.zoom);
  }
  setZoom(z, cx = this.view.cw / 2, cy = this.view.ch / 2) {
    const [dx, dy] = this.toDoc(cx, cy), v = this.view, fit = Math.min(v.cw / this.doc.width, v.ch / this.doc.height);
    this.zoom = Math.max(0.25, Math.min(8, z));
    const s = fit * this.zoom;
    this.panX = cx - dx * s - (v.cw - this.doc.width * s) / 2; this.panY = cy - dy * s - (v.ch - this.doc.height * s) / 2;
    if (Math.abs(this.zoom - 1) < 0.01 && Math.abs(this.panX) < 2 && Math.abs(this.panY) < 2) this.panX = this.panY = 0;
    this._layout();
  }
  panBy(dx, dy) { this.panX += dx; this.panY += dy; this._layout(); }
  resetView() { this.zoom = 1; this.panX = this.panY = 0; this._layout(); }
  // stage CSS px -> doc coords
  toDoc(x, y) { const v = this.view; return [(x - v.ox) / v.s, (y - v.oy) / v.s]; }
  _apply(ctx) { const v = this.view; ctx.setTransform(v.d * v.s, 0, 0, v.d * v.s, v.d * v.ox, v.d * v.oy); }

  // ---------------- background layouts ----------------
  setLayout(l) { this.doc.layout = l; this.renderBackground(); this.onChange(); }
  renderBackground() {
    const ctx = this.bx, { width: W, height: H, layout } = this.doc;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, this.bg.width, this.bg.height);
    this._ensureBgVideo(layout === 'camera');
    this._apply(ctx);
    drawLayout(ctx, layout, W, H);
  }
  _ensureBgVideo(on) {
    if (on && !this.bgVideo) {
      const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.autoplay = true;
      v.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:scaleX(-1);opacity:.85';
      this.bg.after(v); this.bgVideo = v;
    }
    if (this.bgVideo) {
      this.bgVideo.style.display = on ? 'block' : 'none';
      const src = document.getElementById('video').srcObject;
      if (on && this.bgVideo.srcObject !== src) { this.bgVideo.srcObject = src; this.bgVideo.play().catch(() => {}); }
    }
  }

  // ---------------- strokes ----------------
  _push() { this.undoStack.push(this.doc.strokes.slice()); if (this.undoStack.length > 300) this.undoStack.shift(); this.redoStack = []; }
  begin(tool, p, o) {
    let [x, y] = this.toDoc(p[0], p[1]);
    if (this.snapOn && SHAPES.includes(tool)) [x, y] = this.snapPt(x, y);
    this.cur = { tool, color: o.color, color2: o.color2, size: o.size, opacity: o.opacity, sym: o.sym, fill: !!o.fill, fillMode: o.fillMode || (o.fill ? 'gradient' : 'off'), seed: (Math.random() * 1e9) | 0, pts: [[x, y, 1]], t: performance.now() };
    if (SHAPES.includes(tool)) this.cur.pts.push([x, y, 1]);
    this.renderLive();
  }
  add(p) {
    const c = this.cur; if (!c) return;
    let [x, y] = this.toDoc(p[0], p[1]);
    if (SHAPES.includes(c.tool)) {
      if (this.snapOn) {
        if (c.tool === 'line' || c.tool === 'arrow') { // 15° angle steps, length to grid
          const [x0, y0] = c.pts[0], a = Math.round(Math.atan2(y - y0, x - x0) / (Math.PI / 12)) * (Math.PI / 12);
          const near = this._nearKey(x, y);
          if (near) [x, y] = near;
          else { const L = Math.round(Math.hypot(x - x0, y - y0) / this.gridSize()) * this.gridSize(); x = x0 + Math.cos(a) * L; y = y0 + Math.sin(a) * L; }
        } else [x, y] = this.snapPt(x, y);
      }
      c.pts[1] = [x, y, 1]; this.renderLive(); return;
    }
    const last = c.pts[c.pts.length - 1], dist = Math.hypot(x - last[0], y - last[1]);
    if (dist < 1.2) return;
    const now = performance.now(), dt = Math.max(1, now - c.t); c.t = now;
    let w = 1;
    if (c.tool === 'brush') { const sp = dist / dt; w = Math.max(0.3, Math.min(1.35, 1.35 - sp * 0.55)); w = last[2] * 0.7 + w * 0.3; }
    c.pts.push([x, y, w]);
    if (c.tool === 'eraser') this._eraseSeg(c, c.pts.length - 1); else this.renderLive();
  }
  end(dropTail = 0, opts = {}) {
    const c = this.cur; if (!c) return; this.cur = null;
    if (!SHAPES.includes(c.tool) && dropTail && c.pts.length > dropTail + 2) c.pts.splice(-dropTail);
    // hand strokes: clean up the path after release
    if (opts.finish && !SHAPES.includes(c.tool) && c.tool !== 'eraser' && c.tool !== 'spray' && c.pts.length > 3) {
      if (opts.straighten) { // shape assist: straight edges + sharp corners (stars, polygons)
        // smooth away tremor first, then keep only real corners (tolerance scales with the drawing's size)
        const xs = c.pts.map(q => q[0]), ys = c.pts.map(q => q[1]);
        const span = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
        const p = rdp(smoothPts(resample(c.pts, 3), 3, 2), Math.max(7, span * 0.022));
        if (p.length > 3 && Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) < 35) p[p.length - 1] = [...p[0]];
        c.pts = p.map(q => (this.snapOn ? [...this.snapPt(q[0], q[1]), 1] : [q[0], q[1], 1])); c.poly = true;
      } else c.pts = rdp(smoothPts(resample(c.pts, 2.5), 3, 2), 0.3);
    }
    if (SHAPES.includes(c.tool) && Math.hypot(c.pts[1][0] - c.pts[0][0], c.pts[1][1] - c.pts[0][1]) < 4) { this.renderLive(); return; }
    delete c.t;
    c.pts = c.pts.map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10, Math.round(p[2] * 100) / 100]);
    this._push(); this.doc.strokes.push(c);
    if (c.tool !== 'eraser') { this._apply(this.mx); this._renderStroke(this.mx, c); }
    this.renderLive(); this.onChange();
  }
  cancel() { this.cur = null; this.renderLive(); }
  // two-hand shape: both points given
  shapeFromTwo(tool, a, b, o) {
    if (!this.cur || this.cur.tool !== tool) this.begin(tool, a, o);
    this.cur.pts[0] = [...this.toDoc(a[0], a[1]), 1]; this.cur.pts[1] = [...this.toDoc(b[0], b[1]), 1];
    this.renderLive();
  }
  _eraseSeg(c, i) {
    const ctx = this.mx; this._apply(ctx);
    for (const T of symTransforms(c.sym, this.doc.width, this.doc.height)) {
      ctx.save(); ctx.transform(...T);
      ctx.globalCompositeOperation = 'destination-out'; ctx.lineCap = ctx.lineJoin = 'round'; ctx.lineWidth = c.size * 2.2;
      const a = c.pts[Math.max(0, i - 1)], b = c.pts[i];
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.restore();
    }
  }

  undo() { this.sel = null; if (!this.undoStack.length) return false; this.redoStack.push(this.doc.strokes); this.doc.strokes = this.undoStack.pop(); this.renderAll(); this.onChange(); return true; }
  redo() { this.sel = null; if (!this.redoStack.length) return false; this.undoStack.push(this.doc.strokes); this.doc.strokes = this.redoStack.pop(); this.renderAll(); this.onChange(); return true; }
  clear() { this.sel = null; if (!this.doc.strokes.length) return; this._push(); this.doc.strokes = []; this.renderAll(); this.onChange(); }

  renderAll() {
    const ctx = this.mx; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, this.main.width, this.main.height);
    this._apply(ctx);
    this.doc.strokes.forEach((s, i) => { if (i !== this.editing) this._renderStroke(ctx, s); });
  }
  renderLive() {
    const ctx = this.lx; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, this.live.width, this.live.height);
    if (this.cur && this.cur.tool !== 'eraser') { this._apply(ctx); this._renderStroke(ctx, this.cur); }
    const st = this.doc.strokes[this.sel];
    if (st) { // selection: the object being edited + dashed box with corner handles
      this._apply(ctx);
      if (this.editing === this.sel) this._renderStroke(ctx, st);
      const [x0, y0, x1, y1] = bboxOf(st), k = 1 / this.view.s, h = 7 * k;
      ctx.save(); ctx.setLineDash([6 * k, 4 * k]); ctx.strokeStyle = '#ffb000'; ctx.lineWidth = 1.5 * k;
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0); ctx.setLineDash([]); ctx.fillStyle = '#fff';
      for (const [cx, cy] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) { ctx.fillRect(cx - h, cy - h, 2 * h, 2 * h); ctx.strokeRect(cx - h, cy - h, 2 * h, 2 * h); }
      ctx.restore();
    }
  }

  // ---------------- snapping ----------------
  gridSize() { return { grid: 32, dots: 24, lined: 34, blueprint: 24 }[this.doc.layout] || 24; }
  _keys() { // corners / ends of existing objects
    if (this._keyCache && this._keyN === this.doc.strokes.length) return this._keyCache;
    const K = [];
    for (const s of this.doc.strokes) {
      if (s.tool === 'eraser' || s.tool === 'spray') continue;
      if (SHAPES.includes(s.tool)) { const [x0, y0, x1, y1] = bboxOf(s, 0); K.push([x0, y0], [x1, y0], [x1, y1], [x0, y1], [(x0 + x1) / 2, (y0 + y1) / 2]); if (s.tool === 'line' || s.tool === 'arrow') K.push(s.pts[0], s.pts[1]); }
      else if (s.poly) K.push(...s.pts);
      else K.push(s.pts[0], s.pts[s.pts.length - 1]);
    }
    this._keyCache = K; this._keyN = this.doc.strokes.length; return K;
  }
  _nearKey(x, y) {
    let best = null, bd = 14 / this.view.s;
    for (const k of this._keys()) { const d = Math.hypot(k[0] - x, k[1] - y); if (d < bd) { bd = d; best = [k[0], k[1]]; } }
    return best;
  }
  snapPt(x, y) { const n = this._nearKey(x, y); if (n) return n; const g = this.gridSize(); return [Math.round(x / g) * g, Math.round(y / g) * g]; }

  // ---------------- select / move / resize ----------------
  // returns {idx, mode:'move'|'resize', corner} for a stage point, or null
  hitTest(p) {
    const [x, y] = this.toDoc(p[0], p[1]), tol = 12 / this.view.s;
    const cur = this.doc.strokes[this.sel];
    if (cur) {
      const [x0, y0, x1, y1] = bboxOf(cur), C = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      for (let i = 0; i < 4; i++) if (Math.hypot(C[i][0] - x, C[i][1] - y) < tol * 1.6) return { idx: this.sel, mode: 'resize', corner: i };
      if (x > x0 - tol && x < x1 + tol && y > y0 - tol && y < y1 + tol) return { idx: this.sel, mode: 'move' };
    }
    for (let i = this.doc.strokes.length - 1; i >= 0; i--) {
      const s = this.doc.strokes[i]; if (s.tool === 'eraser') continue;
      const [x0, y0, x1, y1] = bboxOf(s);
      if (x < x0 - tol || x > x1 + tol || y < y0 - tol || y > y1 + tol) continue;
      if (SHAPES.includes(s.tool) || s.tool === 'spray') return { idx: i, mode: 'move' };
      for (let j = 0; j < s.pts.length; j++) { const a = s.pts[Math.max(0, j - 1)], b = s.pts[j]; if (segDist(x, y, a, b) < s.size / 2 + tol) return { idx: i, mode: 'move' }; }
    }
    return null;
  }
  select(idx) { this.sel = idx ?? null; this.renderLive(); this.onSelect?.(this.sel); }
  startEdit(hit, p) {
    this._push();
    const s = JSON.parse(JSON.stringify(this.doc.strokes[hit.idx])); this.doc.strokes[hit.idx] = s; // edit a copy: undo keeps the original
    this.sel = this.editing = hit.idx;
    this.ed = { ...hit, orig: s.pts.map(q => q.slice()), box: bboxOf(s, 0), start: this.toDoc(p[0], p[1]) };
    this.renderAll(); this.renderLive();
  }
  dragEdit(p) {
    const e = this.ed, s = this.doc.strokes[this.editing]; if (!e || !s) return;
    const [x, y] = this.toDoc(p[0], p[1]); const [bx0, by0, bx1, by1] = e.box;
    if (e.mode === 'move') {
      let dx = x - e.start[0], dy = y - e.start[1];
      if (this.snapOn) { const [sx, sy] = this.snapPt(bx0 + dx, by0 + dy); dx = sx - bx0; dy = sy - by0; }
      s.pts = e.orig.map(q => [q[0] + dx, q[1] + dy, q[2]]);
    } else if (e.mode === 'resize') {
      const C = [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]], A = C[(e.corner + 2) % 4], P = C[e.corner];
      let [nx, ny] = this.snapOn ? this.snapPt(x, y) : [x, y];
      const fx = (P[0] - A[0]) ? (nx - A[0]) / (P[0] - A[0]) : 1, fy = (P[1] - A[1]) ? (ny - A[1]) / (P[1] - A[1]) : 1;
      const cl = (f) => (Math.abs(f) < 0.05 ? (f < 0 ? -0.05 : 0.05) : f);
      s.pts = e.orig.map(q => [A[0] + (q[0] - A[0]) * cl(fx), A[1] + (q[1] - A[1]) * cl(fy), q[2]]);
    }
    this._keyCache = null; this.renderLive();
  }
  scaleEdit(f) { // uniform scale around the centre (control-hand pinch)
    const e = this.ed, s = this.doc.strokes[this.editing]; if (!e || !s) return;
    const cx = (e.box[0] + e.box[2]) / 2, cy = (e.box[1] + e.box[3]) / 2, k = Math.max(0.05, Math.min(20, f));
    s.pts = e.orig.map(q => [cx + (q[0] - cx) * k, cy + (q[1] - cy) * k, q[2]]); this.renderLive();
  }
  endEdit() {
    if (this.editing == null) return;
    const s = this.doc.strokes[this.editing];
    if (s) s.pts = s.pts.map(q => [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10, q[2]]);
    this.editing = null; this.ed = null; this._keyCache = null; this.renderAll(); this.renderLive(); this.onChange();
  }
  deleteSelected() { if (this.sel == null) return false; this._push(); this.doc.strokes = this.doc.strokes.filter((_, i) => i !== this.sel); this.sel = null; this._keyCache = null; this.renderAll(); this.renderLive(); this.onChange(); return true; }
  duplicateSelected() {
    const s = this.doc.strokes[this.sel]; if (!s) return false; this._push();
    const c = JSON.parse(JSON.stringify(s)); c.seed = (Math.random() * 1e9) | 0; c.pts = c.pts.map(q => [q[0] + 24, q[1] + 24, q[2]]);
    this.doc.strokes.push(c); this.sel = this.doc.strokes.length - 1; this._keyCache = null; this.renderAll(); this.renderLive(); this.onChange(); return true;
  }
  _renderStroke(ctx, s) {
    for (const T of symTransforms(s.sym, this.doc.width, this.doc.height)) {
      ctx.save(); ctx.transform(...T); renderStroke(ctx, s); ctx.restore();
    }
  }

  // ---------------- export ----------------
  toCanvas(withBg = true, type = 'png') {
    const { width: W, height: H, layout } = this.doc, scale = 2;
    const c = document.createElement('canvas'); c.width = W * scale; c.height = H * scale;
    const ctx = c.getContext('2d'); ctx.scale(scale, scale);
    if (withBg) {
      if (layout === 'camera') {
        const v = document.getElementById('video');
        if (v.readyState >= 2) { ctx.save(); ctx.translate(W, 0); ctx.scale(-1, 1); coverImage(ctx, v, W, H); ctx.restore(); }
        else { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); }
      } else if (layout === 'transparent' && type === 'jpg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); }
      else drawLayout(ctx, layout, W, H);
    }
    const layer = document.createElement('canvas'); layer.width = c.width; layer.height = c.height;
    const lx = layer.getContext('2d'); lx.scale(scale, scale);
    for (const s of this.doc.strokes) for (const T of symTransforms(s.sym, W, H)) { lx.save(); lx.transform(...T); renderStroke(lx, s); lx.restore(); }
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(layer, 0, 0);
    return c;
  }
  toSVG() {
    const { width: W, height: H, layout } = this.doc;
    let content = '', mid = 0;
    for (const s of this.doc.strokes) {
      const g = symTransforms(s.sym, W, H).map(T => `<g transform="matrix(${T.map(n => +n.toFixed(4)).join(' ')})">${strokeSVG(s, s.tool === 'eraser' ? '#000' : null)}</g>`).join('');
      if (s.tool === 'eraser') { mid++; content = `<mask id="m${mid}" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>${g}</mask><g mask="url(#m${mid})">${content}</g>`; }
      else content += g;
    }
    const bgc = { white: '#ffffff', dark: '#14161c', grid: '#ffffff', dots: '#ffffff', lined: '#fffdf5', blueprint: '#123a6b' }[layout];
    const bgRect = bgc ? `<rect width="${W}" height="${H}" fill="${bgc}"/>` : '';
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>${bgRect}${content}</svg>`;
  }
  serialize() { return JSON.parse(JSON.stringify(this.doc)); }
  load(doc) { this.sel = null; this.editing = null; this._keyCache = null; this.doc = { width: doc.width || 1280, height: doc.height || 720, layout: doc.layout || 'white', strokes: doc.strokes || [] }; this.undoStack = []; this.redoStack = []; this.resize(); this.onChange(); }
}

function coverImage(ctx, img, W, H) {
  const iw = img.videoWidth || img.width, ih = img.videoHeight || img.height, s = Math.max(W / iw, H / ih);
  ctx.drawImage(img, (W - iw * s) / 2, (H - ih * s) / 2, iw * s, ih * s);
}

export function drawLayout(ctx, layout, W, H) {
  const fill = (c) => { ctx.fillStyle = c; ctx.fillRect(0, 0, W, H); };
  if (layout === 'transparent' || layout === 'camera') {
    if (layout === 'transparent') { // checkerboard only on screen
      ctx.fillStyle = '#e9e9ee'; ctx.fillRect(0, 0, W, H); ctx.fillStyle = '#d6d6de';
      for (let y = 0; y < H; y += 16) for (let x = (y / 16) % 2 ? 16 : 0; x < W; x += 32) ctx.fillRect(x, y, 16, 16);
    }
    return;
  }
  if (layout === 'dark') return fill('#14161c');
  if (layout === 'blueprint') {
    fill('#123a6b'); ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1; grid(ctx, W, H, 24);
    ctx.strokeStyle = 'rgba(255,255,255,.25)'; grid(ctx, W, H, 120); return;
  }
  fill(layout === 'lined' ? '#fffdf5' : '#ffffff');
  if (layout === 'grid') { ctx.strokeStyle = '#e3e6ee'; ctx.lineWidth = 1; grid(ctx, W, H, 32); }
  if (layout === 'dots') { ctx.fillStyle = '#c9cdd8'; for (let y = 24; y < H; y += 24) for (let x = 24; x < W; x += 24) { ctx.beginPath(); ctx.arc(x, y, 1.4, 0, 7); ctx.fill(); } }
  if (layout === 'lined') {
    ctx.strokeStyle = '#cfe0f5'; ctx.lineWidth = 1;
    for (let y = 80; y < H; y += 34) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    ctx.strokeStyle = '#f3b0b0'; ctx.beginPath(); ctx.moveTo(90, 0); ctx.lineTo(90, H); ctx.stroke();
  }
}
function grid(ctx, W, H, g) { ctx.beginPath(); for (let x = g; x < W; x += g) { ctx.moveTo(x, 0); ctx.lineTo(x, H); } for (let y = g; y < H; y += g) { ctx.moveTo(0, y); ctx.lineTo(W, y); } ctx.stroke(); }

// ---- geometry helpers ----
function bboxOf(s, padIt = 1) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of s.pts) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
  const pad = padIt ? (s.tool === 'spray' ? s.size * 1.6 : s.size / 2) : 0;
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}
function segDist(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L)) : 0;
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
}
// ---- path clean-up helpers ----
function resample(pts, step) {
  const out = [pts[0]]; let prev = pts[0], carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = prev, b = pts[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let t = step - carry;
    while (t <= d) { const k = t / d; out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]); t += step; }
    carry = d - (t - step); prev = b;
  }
  out.push(pts[pts.length - 1]); return out;
}
function smoothPts(pts, r, passes) { // moving average, endpoints fixed
  let p = pts;
  for (let n = 0; n < passes; n++) {
    const q = p.map(x => x.slice());
    for (let i = 1; i < p.length - 1; i++) {
      const lo = Math.max(0, i - r), hi = Math.min(p.length - 1, i + r); let sx = 0, sy = 0, sw = 0;
      for (let j = lo; j <= hi; j++) { sx += p[j][0]; sy += p[j][1]; sw += p[j][2]; }
      const k = hi - lo + 1; q[i] = [sx / k, sy / k, sw / k];
    }
    p = q;
  }
  return p;
}
function rdp(pts, eps) { // Ramer–Douglas–Peucker simplification
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let md = 0, mi = -1;
    const [x1, y1] = pts[a], [x2, y2] = pts[b], L = Math.hypot(x2 - x1, y2 - y1) || 1e-6;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((x2 - x1) * (y1 - pts[i][1]) - (x1 - pts[i][0]) * (y2 - y1)) / L; if (d > md) { md = d; mi = i; } }
    if (md > eps) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function pathOf(ctx, s) {
  if (!s.poly) return smoothPath(ctx, s.pts);
  ctx.beginPath(); ctx.moveTo(s.pts[0][0], s.pts[0][1]); for (const q of s.pts.slice(1)) ctx.lineTo(q[0], q[1]);
}
function dOf(s) { return s.poly ? 'M' + s.pts.map(q => q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join('L') : smoothD(s.pts); }

function smoothPath(ctx, pts) {
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  if (pts.length < 3) { ctx.lineTo(pts[pts.length - 1][0] + 0.01, pts[pts.length - 1][1]); return; }
  for (let i = 1; i < pts.length - 1; i++) { const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2; ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my); }
  const l = pts[pts.length - 1]; ctx.lineTo(l[0], l[1]);
}
function smoothD(pts) {
  const f = (n) => +n.toFixed(1);
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  if (pts.length < 3) return d + `L${f(pts[pts.length - 1][0] + 0.01)} ${f(pts[pts.length - 1][1])}`;
  for (let i = 1; i < pts.length - 1; i++) d += `Q${f(pts[i][0])} ${f(pts[i][1])} ${f((pts[i][0] + pts[i + 1][0]) / 2)} ${f((pts[i][1] + pts[i + 1][1]) / 2)}`;
  const l = pts[pts.length - 1]; return d + `L${f(l[0])} ${f(l[1])}`;
}

function shapePath(ctx, s) {
  const [a, b] = s.pts, t = s.tool; ctx.beginPath();
  if (t === 'line') { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
  else if (t === 'rect') ctx.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
  else if (t === 'ellipse') ctx.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(b[0] - a[0]) / 2, Math.abs(b[1] - a[1]) / 2, 0, 0, Math.PI * 2);
  else if (t === 'arrow') {
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), hl = Math.max(12, s.size * 3);
    ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    ctx.moveTo(b[0] - hl * Math.cos(ang - 0.45), b[1] - hl * Math.sin(ang - 0.45)); ctx.lineTo(b[0], b[1]);
    ctx.lineTo(b[0] - hl * Math.cos(ang + 0.45), b[1] - hl * Math.sin(ang + 0.45));
  } else { const p = shapePoints(t, a, b); ctx.moveTo(p[0][0], p[0][1]); for (const q of p.slice(1)) ctx.lineTo(q[0], q[1]); ctx.closePath(); }
}
function shapeSVG(s, attrs) {
  const [a, b] = s.pts, t = s.tool, f = (n) => +n.toFixed(1);
  if (t === 'line') return `<line x1="${f(a[0])}" y1="${f(a[1])}" x2="${f(b[0])}" y2="${f(b[1])}" ${attrs}/>`;
  if (t === 'rect') return `<rect x="${f(Math.min(a[0], b[0]))}" y="${f(Math.min(a[1], b[1]))}" width="${f(Math.abs(b[0] - a[0]))}" height="${f(Math.abs(b[1] - a[1]))}" ${attrs}/>`;
  if (t === 'ellipse') return `<ellipse cx="${f((a[0] + b[0]) / 2)}" cy="${f((a[1] + b[1]) / 2)}" rx="${f(Math.abs(b[0] - a[0]) / 2)}" ry="${f(Math.abs(b[1] - a[1]) / 2)}" ${attrs}/>`;
  if (t === 'arrow') {
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), hl = Math.max(12, s.size * 3);
    return `<path d="M${f(a[0])} ${f(a[1])}L${f(b[0])} ${f(b[1])}M${f(b[0] - hl * Math.cos(ang - 0.45))} ${f(b[1] - hl * Math.sin(ang - 0.45))}L${f(b[0])} ${f(b[1])}L${f(b[0] - hl * Math.cos(ang + 0.45))} ${f(b[1] - hl * Math.sin(ang + 0.45))}" ${attrs.replace(/fill="[^"]*"/, 'fill="none"')}/>`;
  }
  return `<polygon points="${shapePoints(t, a, b).map(p => f(p[0]) + ',' + f(p[1])).join(' ')}" ${attrs}/>`;
}

export function renderStroke(ctx, s) {
  const pts = s.pts; if (!pts.length) return;
  ctx.globalAlpha = s.opacity ?? 1; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = s.size;
  switch (s.tool) {
    case 'pen': pathOf(ctx, s); ctx.stroke(); break;
    case 'eraser': ctx.globalCompositeOperation = 'destination-out'; ctx.globalAlpha = 1; ctx.lineWidth = s.size * 2.2; pathOf(ctx, s); ctx.stroke(); break;
    case 'marker': ctx.globalAlpha = (s.opacity ?? 1) * 0.45; ctx.lineCap = 'butt'; ctx.lineWidth = s.size * 2; pathOf(ctx, s); ctx.stroke(); break;
    case 'brush':
      for (let i = 1; i < pts.length; i++) { ctx.lineWidth = s.size * (pts[i][2] + pts[i - 1][2]) / 2 * 1.4; ctx.beginPath(); ctx.moveTo(pts[i - 1][0], pts[i - 1][1]); ctx.lineTo(pts[i][0], pts[i][1]); ctx.stroke(); }
      if (pts.length === 1) { ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], s.size * 0.7, 0, 7); ctx.fill(); }
      break;
    case 'calligraphy': {
      const nx = Math.cos(-Math.PI / 4) * s.size, ny = Math.sin(-Math.PI / 4) * s.size;
      ctx.beginPath();
      for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i]; ctx.moveTo(a[0] - nx, a[1] - ny); ctx.lineTo(a[0] + nx, a[1] + ny); ctx.lineTo(b[0] + nx, b[1] + ny); ctx.lineTo(b[0] - nx, b[1] - ny); ctx.closePath(); }
      ctx.fill(); break;
    }
    case 'neon':
      ctx.shadowBlur = s.size * 2.5; ctx.shadowColor = s.color; pathOf(ctx, s); ctx.stroke();
      ctx.shadowBlur = 0; ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = Math.max(1, s.size * 0.35); ctx.stroke(); break;
    case 'rainbow': case 'gradient': {
      let total = 0; const acc = [0];
      for (let i = 1; i < pts.length; i++) { total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); acc.push(total); }
      for (let i = 1; i < pts.length; i++) {
        ctx.strokeStyle = s.tool === 'rainbow' ? `hsl(${(acc[i] * 0.6 + (s.seed % 360)) % 360},90%,55%)` : lerpColor(s.color, s.color2 || s.color, total ? acc[i] / total : 0);
        ctx.beginPath(); ctx.moveTo(pts[i - 1][0], pts[i - 1][1]); ctx.lineTo(pts[i][0], pts[i][1]); ctx.stroke();
      }
      if (pts.length === 1) { ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], s.size / 2, 0, 7); ctx.fill(); }
      break;
    }
    case 'spray': {
      const r = rng(s.seed), rad = s.size * 1.6;
      for (let i = 0; i < pts.length; i++) for (let k = 0; k < 14; k++) {
        const a = r() * 6.283, d = Math.sqrt(r()) * rad; ctx.fillRect(pts[i][0] + Math.cos(a) * d, pts[i][1] + Math.sin(a) * d, 1.6, 1.6);
      }
      break;
    }
    default: // shapes
      if (s.tool === 'gradient-fill') break;
      shapePath(ctx, s);
      if (s.fill && s.tool !== 'line' && s.tool !== 'arrow') {
        if (s.fillMode === 'solid') { ctx.fillStyle = s.color2 || s.color; ctx.fill(); ctx.stroke(); } // fill B + outline A
        else { // gradient A → B (older files without fillMode behave like before)
          if (s.color2 && s.color2 !== s.color) { const g = ctx.createLinearGradient(pts[0][0], pts[0][1], pts[1][0], pts[1][1]); g.addColorStop(0, s.color); g.addColorStop(1, s.color2); ctx.fillStyle = g; }
          ctx.fill();
        }
      } else ctx.stroke();
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.shadowBlur = 0;
}

function strokeSVG(s, forceColor) {
  const pts = s.pts, op = s.opacity ?? 1, col = forceColor || s.color;
  const base = `stroke-linecap="round" stroke-linejoin="round"`;
  switch (s.tool) {
    case 'pen': return `<path d="${dOf(s)}" fill="none" stroke="${col}" stroke-width="${s.size}" opacity="${op}" ${base}/>`;
    case 'eraser': return `<path d="${dOf(s)}" fill="none" stroke="#000" stroke-width="${s.size * 2.2}" ${base}/>`;
    case 'marker': return `<path d="${dOf(s)}" fill="none" stroke="${col}" stroke-width="${s.size * 2}" opacity="${op * 0.45}" stroke-linejoin="round"/>`;
    case 'neon': return `<g filter="url(#glow)"><path d="${dOf(s)}" fill="none" stroke="${col}" stroke-width="${s.size}" opacity="${op}" ${base}/></g><path d="${dOf(s)}" fill="none" stroke="#fff" stroke-opacity=".85" stroke-width="${Math.max(1, s.size * 0.35)}" ${base}/>`;
    case 'brush': case 'rainbow': case 'gradient': {
      let total = 0; const acc = [0]; for (let i = 1; i < pts.length; i++) { total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); acc.push(total); }
      let out = `<g opacity="${op}" ${base} fill="none">`;
      for (let i = 1; i < pts.length; i++) {
        const c = s.tool === 'rainbow' ? `hsl(${((acc[i] * 0.6 + (s.seed % 360)) % 360).toFixed(0)},90%,55%)` : s.tool === 'gradient' ? lerpColor(s.color, s.color2 || s.color, total ? acc[i] / total : 0) : col;
        const w = s.tool === 'brush' ? s.size * (pts[i][2] + pts[i - 1][2]) / 2 * 1.4 : s.size;
        out += `<line x1="${pts[i - 1][0]}" y1="${pts[i - 1][1]}" x2="${pts[i][0]}" y2="${pts[i][1]}" stroke="${c}" stroke-width="${w.toFixed(1)}"/>`;
      }
      return out + '</g>';
    }
    case 'calligraphy': {
      const nx = Math.cos(-Math.PI / 4) * s.size, ny = Math.sin(-Math.PI / 4) * s.size; let d = '';
      for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i]; d += `M${(a[0] - nx).toFixed(1)} ${(a[1] - ny).toFixed(1)}L${(a[0] + nx).toFixed(1)} ${(a[1] + ny).toFixed(1)}L${(b[0] + nx).toFixed(1)} ${(b[1] + ny).toFixed(1)}L${(b[0] - nx).toFixed(1)} ${(b[1] - ny).toFixed(1)}Z`; }
      return `<path d="${d}" fill="${col}" opacity="${op}"/>`;
    }
    case 'spray': {
      const r = rng(s.seed), rad = s.size * 1.6; let out = `<g fill="${col}" opacity="${op}">`;
      for (let i = 0; i < pts.length; i++) for (let k = 0; k < 14; k++) { const a = r() * 6.283, d = Math.sqrt(r()) * rad; out += `<rect x="${(pts[i][0] + Math.cos(a) * d).toFixed(1)}" y="${(pts[i][1] + Math.sin(a) * d).toFixed(1)}" width="1.6" height="1.6"/>`; }
      return out + '</g>';
    }
    default: {
      const filled = s.fill && s.tool !== 'line' && s.tool !== 'arrow';
      if (filled && s.fillMode === 'solid') return shapeSVG(s, `fill="${s.color2 || col}" stroke="${col}" stroke-width="${s.size}" opacity="${op}" ${base}`);
      if (filled && s.color2 && s.color2 !== s.color) {
        const id = 'g' + (s.seed >>> 0), [a, b] = s.pts;
        return `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"><stop offset="0" stop-color="${s.color}"/><stop offset="1" stop-color="${s.color2}"/></linearGradient></defs>` + shapeSVG(s, `fill="url(#${id})" stroke="none" opacity="${op}"`);
      }
      return shapeSVG(s, `fill="${filled ? col : 'none'}" stroke="${filled ? 'none' : col}" stroke-width="${s.size}" opacity="${op}" ${base}`);
    }
  }
}
