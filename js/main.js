// AirCanvas – app controller: UI, gesture → action mapping, feedback, files.
import { HandTracker } from './tracker.js';
import { GestureEngine, POSE_ICON, HAND_CONNECTIONS } from './gestures.js';
import { Draw2D, SHAPES } from './draw2d.js';
import { Draw3D, PRIMS } from './draw3d.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const PALETTE = ['#111111', '#ffffff', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#1e66f5', '#5856d6', '#af52de', '#ff2d92', '#8e5a2b'];
const TOOLS2D = ['pen', 'brush', 'marker', 'calligraphy', 'neon', 'rainbow', 'gradient', 'spray', 'eraser', ...SHAPES];
const TOOLS3D = ['stroke', 'ribbon', ...PRIMS, 'select', 'erase'];

// ---------------- state ----------------
const S = {
  mode: '2d', tool2d: 'pen', tool3d: 'stroke', colorA: '#1e66f5', colorB: '#ff3d7f', size: 8, opacity: 100, smooth: 60, fill: false,
  symmetry: 'none', depthRange: 50,
};
const SET = { dominant: 'Right', trigger: 'pinch', reach: 75, pinch: 32, dwell: 800, quality: 'balanced', delegate: 'GPU', skeleton: true, swap: false, sound: true };
try { Object.assign(SET, JSON.parse(localStorage.getItem('aircanvas.settings') || '{}')); } catch {}
const saveSettings = () => { try { localStorage.setItem('aircanvas.settings', JSON.stringify(SET)); } catch {} };

// ---------------- engines ----------------
const d2 = new Draw2D($('#c-bg'), $('#c-main'), $('#c-live'));
const d3 = new Draw3D($('#c-3d'));
const ge = new GestureEngine();
const overlay = $('#c-overlay'), ox = overlay.getContext('2d');
const skel = $('#c-skel'), sx = skel.getContext('2d');
const video = $('#video');
let autosaveT = null, uiSaveT = null, handDrawing2d = false;
let lastFrame = null, stageRect = $('#stage').getBoundingClientRect();

const tracker = new HandTracker(video, {
  onStatus: (k, cls, text) => setPill(k === 'cam' ? '#st-cam' : '#st-model', cls, text),
  onResults: (res, t) => onResults(res, t),
});

// ---------------- helpers ----------------
function setPill(sel, cls, text) { const el = $(sel); el.className = 'pill ' + (cls || ''); el.lastChild.textContent = text; }
function toast(msg, ms = 1400) {
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg; $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms); while ($('#toasts').children.length > 3) $('#toasts').firstChild.remove();
}
let actx = null;
function beep(f = 880, d = 0.05) {
  if (!SET.sound) return;
  try { actx = actx || new AudioContext(); const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = f; g.gain.value = 0.04; o.connect(g).connect(actx.destination); o.start(); g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + d); o.stop(actx.currentTime + d); } catch {}
}
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const opts2d = () => ({ color: S.colorA, color2: S.colorB, size: S.size, opacity: S.opacity / 100, sym: S.symmetry, fill: S.fill });

// ---------------- UI wiring ----------------
const sw = $('#swatches');
PALETTE.forEach(c => { const b = document.createElement('button'); b.className = 'sw'; b.style.background = c; b.dataset.color = c; b.setAttribute('data-air', ''); b.title = c; b.onclick = () => setColor(c); sw.appendChild(b); });
function setColor(c, which = 'A') {
  if (which === 'A') S.colorA = c; else S.colorB = c;
  $('#colorA').value = S.colorA; $('#colorB').value = S.colorB;
  $$('.sw').forEach(b => b.classList.toggle('active', b.dataset.color === S.colorA));
  if (S.mode === '3d' && d3.selected && which === 'A' && setColor.recolorSel) d3.recolor(d3.selected, c);
  scheduleUISave();
}
$('#colorA').oninput = (e) => setColor(e.target.value, 'A');
$('#colorB').oninput = (e) => setColor(e.target.value, 'B');
$('#btn-swap').onclick = () => { const a = S.colorA; S.colorA = S.colorB; S.colorB = a; setColor(S.colorA); };

function bindRange(id, key, fn) {
  const el = $('#' + id), lbl = $('#' + id + '-v');
  el.value = S[key] ?? SET[key];
  const upd = () => { lbl.textContent = el.value; fn(+el.value); };
  el.oninput = upd; upd();
}
bindRange('size', 'size', v => { S.size = v; d3.radius = 0.02 + v * 0.006; scheduleUISave(); });
bindRange('opacity', 'opacity', v => { S.opacity = v; scheduleUISave(); });
bindRange('smooth', 'smooth', v => { S.smooth = v; ge.setSmoothing(v / 100); scheduleUISave(); });
bindRange('depthRange', 'depthRange', v => { S.depthRange = v; scheduleUISave(); });
$('#fill').onchange = (e) => { S.fill = e.target.checked; scheduleUISave(); };
$('#layout').onchange = (e) => { d2.setLayout(e.target.value); };
$('#symmetry').onchange = (e) => { S.symmetry = e.target.value; scheduleUISave(); };
$('#material').onchange = (e) => { d3.setMaterialMode(e.target.value); scheduleAutosave(); };
$('#mirror3d').onchange = (e) => { d3.mirror = e.target.checked; };
$('#autorotate').onchange = (e) => d3.setAutoRotate(e.target.checked);
$('#showgrid').onchange = (e) => d3.setGrid(e.target.checked);
$$('[data-view]').forEach(b => b.onclick = () => d3.setView(b.dataset.view));

$$('[data-tool]').forEach(b => b.onclick = () => setTool2d(b.dataset.tool));
$$('[data-tool3]').forEach(b => b.onclick = () => setTool3d(b.dataset.tool3));
function setTool2d(t) { S.tool2d = t; $$('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t)); scheduleUISave(); }
function setTool3d(t) { S.tool3d = t; $$('[data-tool3]').forEach(b => b.classList.toggle('active', b.dataset.tool3 === t)); d3.setMouseTool(t, () => S.colorA); if (t !== 'select') d3.select(null); scheduleUISave(); }

$$('.tab').forEach(b => b.onclick = () => setMode(b.dataset.mode));
function setMode(m) {
  endAllInteractions();
  S.mode = m;
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  $('#view2d').classList.toggle('active', m === '2d'); $('#view3d').classList.toggle('active', m === '3d');
  for (const [a, b] of [['#tools2d', '#tools3d'], ['#props2d', '#props3d'], ['#export2d', '#export3d']]) { $(a).classList.toggle('hidden', m !== '2d'); $(b).classList.toggle('hidden', m !== '3d'); }
  d3.active = m === '3d';
  if (m === '3d') d3.resize(); else d2.resize();
  scheduleUISave();
}

$('#btn-undo').onclick = () => doEvent('undo');
$('#btn-redo').onclick = () => doEvent('redo');
$('#btn-clear').onclick = () => { if (confirmClear()) doEvent('clear'); };
function confirmClear() { return true; } // undo can always restore
$('#btn-png').onclick = () => exportImage('png');
$('#btn-jpg').onclick = () => exportImage('jpg');
$('#btn-svg').onclick = () => { download(new Blob([d2.toSVG()], { type: 'image/svg+xml' }), `aircanvas-${stamp()}.svg`); toast('⬇ SVG downloaded'); };
$('#btn-stl').onclick = () => exportSTL();
$('#btn-glb').onclick = async () => { if (!d3.items.length) return toast('Nothing to export'); const buf = await d3.exportGLB(); download(new Blob([buf], { type: 'model/gltf-binary' }), `aircanvas-${stamp()}.glb`); toast('⬇ GLB downloaded'); };
$('#btn-obj').onclick = () => { if (!d3.items.length) return toast('Nothing to export'); download(new Blob([d3.exportOBJ()], { type: 'text/plain' }), `aircanvas-${stamp()}.obj`); toast('⬇ OBJ downloaded'); };
$('#btn-shot').onclick = () => { fetch(d3.screenshot()).then(r => r.blob()).then(b => download(b, `aircanvas-3d-${stamp()}.png`)); toast('⬇ View PNG downloaded'); };
$('#btn-save').onclick = () => saveProject();
$('#btn-open').onclick = () => $('#file-open').click();
$('#file-open').onchange = (e) => { const f = e.target.files[0]; if (f) openProject(f); e.target.value = ''; };
$('#btn-new').onclick = () => { if (S.mode === '2d') { const r = $('#view2d').getBoundingClientRect(); d2.newDoc(r.width, r.height); } else d3.clear(); toast('New ' + S.mode.toUpperCase() + ' canvas'); };

$('#sel-move').onclick = () => d3.setGizmo('translate');
$('#sel-rot').onclick = () => d3.setGizmo('rotate');
$('#sel-scale').onclick = () => d3.setGizmo('scale');
$('#sel-dup').onclick = () => d3.duplicate(d3.selected);
$('#sel-del').onclick = () => d3.remove(d3.selected);
$('#sel-color').onclick = () => d3.recolor(d3.selected, S.colorA);
d3.onSelect = (it) => { $('#sel-info').textContent = it ? `Selected: ${it.kind === 'prim' ? it.type : it.kind} #${it.id}` : 'Nothing selected'; };

// modals
$('#btn-help').onclick = () => $('#help').classList.remove('hidden');
$('#btn-settings').onclick = () => $('#settings').classList.remove('hidden');
$$('[data-close]').forEach(b => b.onclick = () => b.closest('.modal').classList.add('hidden'));
$$('.modal').forEach(m => m.addEventListener('pointerdown', e => { if (e.target === m) m.classList.add('hidden'); }));

// settings
function bindSet(id, key, num) {
  const el = $('#' + id), lbl = $('#' + id + '-v');
  if (el.type === 'checkbox') el.checked = !!SET[key]; else el.value = SET[key];
  const apply = () => { SET[key] = el.type === 'checkbox' ? el.checked : num ? +el.value : el.value; if (lbl) lbl.textContent = el.value; applySettings(key); saveSettings(); };
  el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', apply);
  if (lbl) lbl.textContent = el.value;
}
bindSet('set-dominant', 'dominant'); bindSet('set-trigger', 'trigger'); bindSet('set-reach', 'reach', true); bindSet('set-pinch', 'pinch', true);
bindSet('set-dwell', 'dwell', true); bindSet('set-quality', 'quality'); bindSet('set-delegate', 'delegate');
bindSet('set-skeleton', 'skeleton'); bindSet('set-swap', 'swap'); bindSet('set-sound', 'sound');
function applySettings(changed) {
  Object.assign(ge.settings, { dominant: SET.dominant, reach: SET.reach / 100, pinch: SET.pinch / 100, swap: SET.swap, trigger: SET.trigger });
  tracker.setQuality(SET.quality);
  if (changed === 'delegate' && tracker.landmarker) tracker.loadModel(SET.delegate).then(() => toast('Processor: ' + tracker.delegate)).catch(e => toast('Model error: ' + e.message));
  $('#hc-dom .ht').textContent = `Draw hand (${SET.dominant})`;
  $('#hc-sup .ht').textContent = `Control hand (${SET.dominant === 'Right' ? 'Left' : 'Right'})`;
}
applySettings(); tracker.delegate = SET.delegate;

// camera button
$('#btn-camera').onclick = async () => {
  const b = $('#btn-camera');
  if (tracker.running) { tracker.stop(); b.textContent = '▶ Start camera'; b.classList.add('primary'); $('#cam-off').classList.remove('hidden'); $('#cam-box').className = ''; endAllInteractions(); return; }
  b.disabled = true; b.textContent = 'Starting…';
  try {
    await tracker.start();
    b.textContent = '⏹ Stop camera'; b.classList.remove('primary'); $('#cam-off').classList.add('hidden');
    if (d2.doc.layout === 'camera') d2.renderBackground();
    toast('Show your hand ✋ — pinch 🤏 to draw');
  } catch (e) {
    console.error(e);
    const msg = e.name === 'NotAllowedError' ? 'Camera permission denied' : e.name === 'NotFoundError' ? 'No camera found' : (e.message || 'Camera error');
    setPill('#st-cam', 'bad', msg); toast('⚠ ' + msg, 3000); b.textContent = '▶ Start camera';
    if (location.protocol === 'file:') toast('Open via a local server (see README) — file:// blocks camera & modules', 5000);
  }
  b.disabled = false;
};

// keyboard
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); doEvent(e.shiftKey ? 'redo' : 'undo'); }
  else if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); doEvent('redo'); }
  else if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); saveProject(); }
  else if (k === 'delete' && S.mode === '3d') d3.remove(d3.selected);
  else if (k === 'escape') { $$('.modal').forEach(m => m.classList.add('hidden')); d3.select(null); }
  else if (k === '[') { S.size = Math.max(1, S.size - 2); syncSize(); } else if (k === ']') { S.size = Math.min(80, S.size + 2); syncSize(); }
});
function syncSize() { $('#size').value = S.size; $('#size-v').textContent = S.size; d3.radius = 0.02 + S.size * 0.006; }

// mouse / touch drawing in 2D
const cm = $('#c-main');
cm.addEventListener('pointerdown', (e) => { cm.setPointerCapture(e.pointerId); d2.begin(S.tool2d, [e.offsetX, e.offsetY], opts2d()); });
cm.addEventListener('pointermove', (e) => { if (d2.cur && !handDrawing2d) { for (const ev of (e.getCoalescedEvents ? e.getCoalescedEvents() : [e])) d2.add([ev.offsetX, ev.offsetY]); } });
cm.addEventListener('pointerup', () => { if (!handDrawing2d) d2.end(); });

// ---------------- events ----------------
function doEvent(type) {
  const eng = S.mode === '2d' ? d2 : d3;
  switch (type) {
    case 'undo': if (eng.undo()) { toast('↶ Undo'); beep(520); } break;
    case 'redo': if (eng.redo()) { toast('↷ Redo'); beep(700); } break;
    case 'clear': eng.clear(); toast('🗑 Cleared (undo restores)'); beep(300, 0.12); break;
    case 'nextColor': { const i = (PALETTE.indexOf(S.colorA) + 1) % PALETTE.length; setColor(PALETTE[i]); toast('🎨 Colour'); beep(990); break; }
    case 'nextTool': {
      if (S.mode === '2d') { const i = (TOOLS2D.indexOf(S.tool2d) + 1) % TOOLS2D.length; setTool2d(TOOLS2D[i]); toast('Tool: ' + TOOLS2D[i]); }
      else { const i = (TOOLS3D.indexOf(S.tool3d) + 1) % TOOLS3D.length; setTool3d(TOOLS3D[i]); toast('Tool: ' + TOOLS3D[i]); }
      beep(800); break;
    }
    case 'mode': setMode(S.mode === '2d' ? '3d' : '2d'); toast(S.mode === '2d' ? '🖌 2D mode' : '🧊 3D mode'); beep(660, 0.1); break;
    case 'download': S.mode === '2d' ? exportImage('png') : exportSTL(); beep(1200, 0.1); break;
    case 'save': saveProject(); beep(1100, 0.1); break;
  }
}
function exportImage(type) {
  const c = d2.toCanvas(true, type);
  c.toBlob(b => download(b, `aircanvas-${stamp()}.${type}`), type === 'jpg' ? 'image/jpeg' : 'image/png', 0.92);
  toast(`⬇ ${type.toUpperCase()} downloaded`);
}
function exportSTL() {
  if (!d3.items.length) return toast('Nothing to export yet');
  const data = d3.exportSTL(); download(new Blob([data], { type: 'model/stl' }), `aircanvas-${stamp()}.stl`); toast('⬇ STL downloaded');
}

// ---------------- project files ----------------
function projectData() {
  return { format: 'aircanvas', version: 1, savedAt: new Date().toISOString(), mode: S.mode, ui: { ...S }, d2: d2.serialize(), d3: d3.serialize() };
}
function saveProject() {
  download(new Blob([JSON.stringify(projectData())], { type: 'application/json' }), `aircanvas-${stamp()}.aircanvas.json`);
  toast('💾 Project saved — reopen it with 📂 Open');
}
function applyProject(p) {
  if (p.format !== 'aircanvas') throw new Error('Not an AirCanvas project');
  if (p.ui) Object.assign(S, p.ui);
  if (p.d2) d2.load(p.d2);
  if (p.d3) d3.load(p.d3);
  $('#layout').value = d2.doc.layout; $('#symmetry').value = S.symmetry; $('#material').value = d3.matMode; $('#fill').checked = S.fill;
  for (const id of ['size', 'opacity', 'smooth', 'depthRange']) { $('#' + id).value = S[id]; $('#' + id + '-v').textContent = S[id]; }
  ge.setSmoothing(S.smooth / 100); syncSize();
  setColor(S.colorA); setTool2d(S.tool2d); setTool3d(S.tool3d); setMode(p.mode || S.mode);
}
function openProject(file) {
  const r = new FileReader();
  r.onload = () => { try { applyProject(JSON.parse(r.result)); toast('📂 Project opened: ' + file.name, 2200); } catch (e) { toast('⚠ Could not open: ' + e.message, 3000); } };
  r.readAsText(file);
}
function scheduleAutosave() { clearTimeout(autosaveT); autosaveT = setTimeout(() => { try { localStorage.setItem('aircanvas.autosave', JSON.stringify(projectData())); $('#autosave-info').textContent = 'Autosaved ' + new Date().toLocaleTimeString(); } catch { $('#autosave-info').textContent = 'Autosave: storage full – use 💾 Save'; } }, 1500); }
function scheduleUISave() { clearTimeout(uiSaveT); uiSaveT = setTimeout(scheduleAutosave, 500); }
d2.onChange = scheduleAutosave; d3.onChange = scheduleAutosave;

// ---------------- gesture → action ----------------
const G = { // interaction state
  twoShape: false, palm: false, palmT: 0, sizeY0: 0, size0: 0, sizing: false,
  d3Draw: null, grabbing: false, prevCursor: null, prevSup: null, orbit: null, depthBase: 0, depthRef: null, scale0: null, depthNow: 0,
  dwellEl: null, dwellT: 0, dwellP: 0, lastCards: 0,
};
function endAllInteractions() {
  if (d2.cur) d2.end(2); handDrawing2d = false; G.twoShape = false; G.palm = false; G.sizing = false;
  if (d3.live) { d3.live.kind === 'prim' ? d3.endPrim() : d3.endStroke(); }
  if (G.grabbing) { d3.endEdit(); G.grabbing = false; }
  G.orbit = null; G.d3Draw = null;
}
const UI_SEL = '.panel, #topbar, #cam-box, #hand-cards, .modal';
function uiAt(x, y) {
  const el = document.elementFromPoint(x, y); if (!el) return null;
  if (!el.closest(UI_SEL)) return null;
  return el.closest('button, select, label.check, input[type=checkbox], .sw') || el.closest(UI_SEL);
}
function airClick(el) {
  if (!el || el.matches('.panel, #topbar, #cam-box, #hand-cards, .modal')) return;
  if (el.tagName === 'SELECT') { el.selectedIndex = (el.selectedIndex + 1) % el.options.length; el.dispatchEvent(new Event('change')); toast(el.options[el.selectedIndex].text); }
  else if (el.matches('label.check')) { const cb = el.querySelector('input'); cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
  else el.click();
  beep(1000); el.classList.add('air-hover'); setTimeout(() => el.classList.remove('air-hover'), 250);
}

function onResults(res, t) {
  if (!res) { lastFrame = null; drawSkeleton(null); return; }
  const f = ge.update(res, t, video.videoWidth / Math.max(1, video.videoHeight) || 4 / 3);
  lastFrame = f;
  drawSkeleton(res);
  for (const ev of f.events) doEvent(ev.type);
  const W = innerWidth, H = innerHeight;
  const D = f.dom, Sp = f.sup;
  const dp = [D.x * W, D.y * H], sp = [Sp.x * W, Sp.y * H];
  const st = (p) => [p[0] - stageRect.left, p[1] - stageRect.top];
  const drawOn = D.present && (SET.trigger === 'pinch' ? D.pinch : D.pose === 'POINT');
  const drawStart = SET.trigger === 'pinch' ? D.edges.pinchStart : (D.edges.poseChanged !== undefined && D.pose === 'POINT');
  const modalOpen = !!document.querySelector('.modal:not(.hidden)');
  const uiEl = D.present ? uiAt(dp[0], dp[1]) : null;

  // ---- air UI: pinch-tap or dwell on buttons ----
  if (uiEl && D.edges.pinchStart) { airClick(uiEl); G.dwellEl = null; }
  const dwellPose = D.pose === 'POINT';
  if (uiEl && dwellPose && !uiEl.matches(UI_SEL)) {
    if (G.dwellEl !== uiEl) { G.dwellEl = uiEl; G.dwellT = t; }
    G.dwellP = Math.min(1, (t - G.dwellT) / SET.dwell);
    if (G.dwellP >= 1) { airClick(uiEl); G.dwellT = t + 600; }
  } else { G.dwellEl = null; G.dwellP = 0; }

  if (modalOpen) { endAllInteractions(); return updateFeedback(f, t); }
  if (S.mode === '2d') handle2d(f, t, D, Sp, st(dp), st(sp), drawOn, drawStart, !!uiEl);
  else handle3d(f, t, D, Sp, dp, sp, drawOn, drawStart, !!uiEl);
  updateFeedback(f, t);
}

function handle2d(f, t, D, Sp, p, q, drawOn, drawStart, overUI) {
  // two-hand shape: draw pinch + control pinch
  const bothPinch = D.present && Sp.present && D.pinch && Sp.pinch;
  if (bothPinch && !G.twoShape && (!d2.cur || d2.cur.pts.length < 6) && !overUI) {
    if (d2.cur) d2.cancel();
    if (G.sizing) { S.size = G.size0; syncSize(); G.sizing = false; }
    G.twoShape = true; handDrawing2d = true;
  }
  if (G.twoShape) {
    if (bothPinch) { d2.shapeFromTwo(SHAPES.includes(S.tool2d) ? S.tool2d : 'rect', q, p, opts2d()); return; }
    d2.end(); G.twoShape = false; handDrawing2d = false; return;
  }
  // control-hand pinch alone → brush size
  if (Sp.present && Sp.pinch && !D.pinch) {
    if (!G.sizing) { G.sizing = true; G.sizeY0 = Sp.y; G.size0 = S.size; }
    S.size = Math.round(Math.max(1, Math.min(80, G.size0 + (G.sizeY0 - Sp.y) * 140))); syncSize();
  } else G.sizing = false;

  // palm eraser (draw hand open, not during clear combo)
  const palmOK = D.present && D.pose === 'OPEN' && !(Sp.present && Sp.pose === 'OPEN');
  if (palmOK) {
    if (!G.palmT) G.palmT = t;
    const pc = palmCenter(D);
    if (!G.palm && t - G.palmT > 250 && !overUI) { G.palm = true; d2.begin('eraser', pc, { ...opts2d(), size: Math.max(14, S.size * 2.5), sym: 'none' }); }
    else if (G.palm) d2.add(pc);
    return;
  } else { G.palmT = 0; if (G.palm) { d2.end(); G.palm = false; } }

  // freehand / single-hand shape
  if (drawOn && !handDrawing2d && drawStart && !overUI) {
    const ruler = Sp.present && Sp.pose === 'OPEN' && !SHAPES.includes(S.tool2d) && S.tool2d !== 'eraser';
    d2.begin(ruler ? 'line' : S.tool2d, p, opts2d()); handDrawing2d = true;
  } else if (drawOn && handDrawing2d) d2.add(p);
  else if (!drawOn && handDrawing2d) { d2.end(2); handDrawing2d = false; }
}
function palmCenter(D) {
  const lm = D.lm, r = ge.settings.reach, m = (1 - r) / 2;
  const nx = Math.max(0, Math.min(1, ((1 - lm[9].x) - m) / r)), ny = Math.max(0, Math.min(1, (lm[9].y - m) / r));
  return [nx * innerWidth - stageRect.left, ny * innerHeight - stageRect.top];
}

function handle3d(f, t, D, Sp, dp, sp, drawOn, drawStart, overUI) {
  const ndc = (p) => [((p[0] - stageRect.left) / stageRect.width) * 2 - 1, -((p[1] - stageRect.top) / stageRect.height) * 2 + 1];
  const range = S.depthRange / 100 * 8;
  // depth from hand size: slow-adapting reference while idle, frozen while acting
  if (D.present) {
    const acting = D.pinch || G.grabbing;
    if (G.depthRef === null) G.depthRef = D.scale;
    if (!acting) G.depthRef = G.depthRef * 0.97 + D.scale * 0.03;
    G.depthNow = Math.max(-range, Math.min(range, (1 - D.scale / G.depthRef) * range * 2.2));
  } else { G.depthRef = null; G.depthNow = 0; }
  const [nx, ny] = ndc(dp);
  const world = D.present ? d3.worldAt(nx, ny, G.depthBase + G.depthNow) : null;
  const both = D.present && Sp.present && D.pinch && Sp.pinch;

  // select tool: grabbing an object wins over two-hand orbit
  let grabTarget = null;
  if (S.tool3d === 'select' && drawStart && !overUI && !G.grabbing && world) grabTarget = d3.pick(nx, ny) || d3.nearest(world, 1.0);
  // two-hand orbit / zoom (when not drawing or grabbing)
  if (both && !G.grabbing && !G.d3Draw && !grabTarget) {
    const mid = [(dp[0] + sp[0]) / 2, (dp[1] + sp[1]) / 2], dist = Math.hypot(dp[0] - sp[0], dp[1] - sp[1]);
    if (G.orbit) {
      d3.orbit((mid[0] - G.orbit.mid[0]) / innerWidth * 6, (mid[1] - G.orbit.mid[1]) / innerHeight * 4);
      if (dist > 40 && G.orbit.dist > 40) d3.zoom(G.orbit.dist / dist);
    }
    G.orbit = { mid, dist };
    d3.showCursor(world, '#7fd1ff'); return;
  } else if (!both) G.orbit = null;

  // control-hand alone pinch: depth plane push/pull (or scale selected)
  if (Sp.present && Sp.pinch && !D.pinch) {
    if (G.prevSup) {
      const dy = G.prevSup[1] - Sp.y;
      if (S.tool3d === 'select' && d3.selected) { if (!G.scaling) { d3.beginEdit(); G.scaling = true; } d3.scaleSelected(1 + dy * 3); }
      else G.depthBase = Math.max(-8, Math.min(8, G.depthBase + dy * 10));
    }
    G.prevSup = [Sp.x, Sp.y, Sp.roll];
  } else if (Sp.present && Sp.pinch && G.grabbing) {
    if (G.prevSup) d3.rotateSelected((Sp.x - G.prevSup[0]) * 7, (Sp.y - G.prevSup[1]) * 7, angDiff(Sp.roll, G.prevSup[2]));
    G.prevSup = [Sp.x, Sp.y, Sp.roll];
  } else { G.prevSup = null; if (G.scaling) { d3.endEdit(); G.scaling = false; } }

  if (!D.present) { d3.showCursor(null, '', false); endD3(); return; }
  const tool = S.tool3d;
  if (drawStart && !overUI && !G.d3Draw && !G.grabbing) {
    if (tool === 'stroke' || tool === 'ribbon') { d3.beginStroke(tool, world, S.colorA); G.d3Draw = 'stroke'; }
    else if (PRIMS.includes(tool)) { d3.beginPrim(tool, world, S.colorA); G.d3Draw = 'prim'; }
    else if (tool === 'select') {
      const it = grabTarget;
      d3.select(it);
      if (it) { d3.beginEdit(); G.grabbing = true; G.prevCursor = world.clone(); beep(900); }
    } else if (tool === 'erase') { const it = d3.pick(nx, ny) || d3.nearest(world, 0.4); if (it) { d3.remove(it); toast('Deleted'); beep(400); } }
  } else if (drawOn) {
    if (G.d3Draw === 'stroke') d3.addStrokePoint(world);
    else if (G.d3Draw === 'prim') d3.updatePrim(world);
    else if (G.grabbing) { d3.moveSelected(world.clone().sub(G.prevCursor)); G.prevCursor = world.clone(); }
  } else endD3();
  d3.showCursor(world, G.grabbing ? '#ffd76a' : drawOn ? S.colorA : '#ffffff');
  $('#depth-fill').style.bottom = (50 + ((G.depthBase + G.depthNow) / 16) * 100).toFixed(1) + '%';
}
function endD3() {
  if (G.d3Draw === 'stroke') d3.endStroke(); else if (G.d3Draw === 'prim') d3.endPrim();
  G.d3Draw = null;
  if (G.grabbing) { d3.endEdit(); G.grabbing = false; }
}
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };

// ---------------- feedback ----------------
let noHandSince = 0, lowLight = false;
function updateFeedback(f, t) {
  const n = f.count;
  setPill('#st-hands', n === 2 ? 'ok' : n === 1 ? 'ok' : 'warn', `Hands: ${n}`);
  $('#cam-box').className = n ? 'tracking' : 'nohand';
  if (n === 0) { if (!noHandSince) noHandSince = t; } else noHandSince = 0;
  let hint = '';
  if (noHandSince && t - noHandSince > 1500) hint = '✋ No hand detected — raise your hand in front of the camera';
  else if (f.dom.present && f.dom.scale > 0.5) hint = '↔ Hand too close — move back a little';
  else if (f.dom.present && f.dom.scale < 0.08) hint = '↔ Hand far away — move closer for better tracking';
  else if (lowLight) hint = '💡 Low light — face a light source for better tracking';
  else if (f.combo && Object.keys(f.holds).length) hint = 'Hold… ' + f.combo;
  const h = $('#hint'); h.textContent = hint; h.classList.toggle('hidden', !hint);
  if (t - G.lastCards > 90) { // throttle DOM updates
    G.lastCards = t;
    card('#hc-dom', f.dom, actionLabel(f.dom, true)); card('#hc-sup', f.sup, actionLabel(f.sup, false));
    $('#hc-combo .hp').textContent = f.combo || '—';
    setPill('#st-perf', '', `${tracker.fps.toFixed(0)} fps · ${tracker.inferMs.toFixed(0)} ms · ${tracker.delegate}`);
  }
}
function actionLabel(h, dom) {
  if (!h.present) return '';
  if (dom) {
    if (S.mode === '2d') { if (G.twoShape) return 'Two-hand shape'; if (G.palm) return 'Palm eraser'; if (handDrawing2d) return 'Drawing · ' + S.tool2d; }
    else { if (G.grabbing) return 'Holding object'; if (G.d3Draw) return 'Creating · ' + S.tool3d; if (G.orbit) return 'Orbit / zoom'; }
    if (G.dwellEl) return 'Air-click ' + Math.round(G.dwellP * 100) + '%';
    return 'Ready';
  }
  if (G.sizing) return 'Brush size ' + S.size;
  if (G.scaling) return 'Scaling object';
  if (G.prevSup && S.mode === '3d') return G.grabbing ? 'Rotating object' : 'Depth plane ' + G.depthBase.toFixed(1);
  const hk = Object.keys(ge.holds)[0]; if (hk) return 'Hold for ' + hk;
  return 'Ready';
}
function card(sel, h, action) {
  const el = $(sel); el.classList.toggle('on', h.present); el.classList.toggle('off', !h.present);
  el.querySelector('.hp').textContent = h.present ? POSE_ICON[h.pose] || h.pose : 'not seen';
  el.querySelector('.pm').style.width = h.present ? (h.pinchStrength * 100).toFixed(0) + '%' : '0';
  el.querySelector('.hs').textContent = h.present ? `${h.side} · conf ${(h.score * 100).toFixed(0)}% · ${action}` : '';
}
setInterval(() => { const b = tracker.brightness(); lowLight = b !== null && b < 55; }, 2000);

function drawSkeleton(res) {
  const d = Math.min(devicePixelRatio || 1, 2), w = skel.clientWidth, hh = skel.clientHeight;
  if (skel.width !== Math.round(w * d)) { skel.width = Math.round(w * d); skel.height = Math.round(hh * d); }
  sx.setTransform(d, 0, 0, d, 0, 0); sx.clearRect(0, 0, w, hh);
  if (!res || !SET.skeleton || !res.landmarks) return;
  // video uses object-fit: cover → compute mapping
  const vw = video.videoWidth || 640, vh = video.videoHeight || 480, s = Math.max(w / vw, hh / vh), offx = (w - vw * s) / 2, offy = (hh - vh * s) / 2;
  const P = (l) => [w - (l.x * vw * s + offx), l.y * vh * s + offy];
  res.landmarks.forEach((lm, i) => {
    const isDom = lastFrame && lastFrame.dom.lm === lm;
    sx.strokeStyle = isDom ? '#4f8cff' : '#ffb84f'; sx.lineWidth = 2; sx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) { const pa = P(lm[a]), pb = P(lm[b]); sx.moveTo(pa[0], pa[1]); sx.lineTo(pb[0], pb[1]); }
    sx.stroke(); sx.fillStyle = '#fff';
    for (const l of lm) { const p = P(l); sx.fillRect(p[0] - 1.5, p[1] - 1.5, 3, 3); }
    const hd = res.handedness?.[i]?.[0]; if (hd) { const p = P(lm[0]); sx.font = '11px system-ui'; sx.fillText(isDom ? 'DRAW' : 'CTRL', p[0] - 14, p[1] + 14); }
  });
}

// overlay cursors (rAF; cheap)
function drawOverlay() {
  requestAnimationFrame(drawOverlay);
  const d = Math.min(devicePixelRatio || 1, 2);
  if (overlay.width !== Math.round(innerWidth * d)) { overlay.width = Math.round(innerWidth * d); overlay.height = Math.round(innerHeight * d); }
  ox.setTransform(d, 0, 0, d, 0, 0); ox.clearRect(0, 0, innerWidth, innerHeight);
  const f = lastFrame; if (!f || !tracker.running) return;
  const W = innerWidth, H = innerHeight;
  for (const h of [f.dom, f.sup]) {
    if (!h.present) continue;
    const x = h.x * W, y = h.y * H, isDom = h === f.dom;
    if (isDom) {
      const r = S.mode === '2d' ? Math.max(4, S.size / 2 * d2.view.s) : 10;
      ox.lineWidth = 2; ox.strokeStyle = h.pinch ? S.colorA : '#ffffff'; ox.fillStyle = h.pinch ? S.colorA + '55' : 'rgba(255,255,255,.12)';
      if (G.palm) { const pc = palmCenter(h); ox.beginPath(); ox.arc(pc[0] + stageRect.left, pc[1] + stageRect.top, Math.max(14, S.size * 2.5) * 1.1 * d2.view.s, 0, 7); ox.strokeStyle = '#ff7b7b'; ox.stroke(); continue; }
      ox.beginPath(); ox.arc(x, y, r + 3, 0, 7); ox.fill(); ox.stroke();
      ox.beginPath(); ox.arc(x, y, 2, 0, 7); ox.fillStyle = '#000'; ox.fill();
      if (G.dwellEl && G.dwellP > 0) { ox.beginPath(); ox.strokeStyle = '#ffd76a'; ox.lineWidth = 4; ox.arc(x, y, r + 12, -Math.PI / 2, -Math.PI / 2 + G.dwellP * Math.PI * 2); ox.stroke(); }
    } else {
      ox.fillStyle = 'rgba(255,184,79,.25)'; ox.strokeStyle = '#ffb84f'; ox.lineWidth = 2;
      ox.beginPath(); ox.arc(x, y, h.pinch ? 9 : 13, 0, 7); ox.fill(); ox.stroke();
      ox.font = '16px system-ui'; ox.fillStyle = '#fff'; ox.fillText((POSE_ICON[h.pose] || '').split(' ')[0], x + 16, y + 6);
      if (G.sizing) { ox.fillText('Size ' + S.size, x + 16, y + 26); }
    }
  }
  // hold progress rings
  const holds = Object.entries(f.holds);
  if (holds.length) {
    const [key, hd] = holds[0], anchor = f.combo && f.sup.present && f.dom.present ? [(f.dom.x + f.sup.x) / 2 * W, (f.dom.y + f.sup.y) / 2 * H] : [f.sup.x * W, f.sup.y * H];
    ox.lineWidth = 6; ox.strokeStyle = 'rgba(255,255,255,.15)'; ox.beginPath(); ox.arc(anchor[0], anchor[1], 34, 0, 7); ox.stroke();
    ox.strokeStyle = key === 'clear' ? '#ff5c5c' : '#2ecc71'; ox.beginPath(); ox.arc(anchor[0], anchor[1], 34, -Math.PI / 2, -Math.PI / 2 + hd.progress * Math.PI * 2); ox.stroke();
    ox.font = '13px system-ui'; ox.fillStyle = '#fff'; ox.textAlign = 'center'; ox.fillText(key, anchor[0], anchor[1] + 5); ox.textAlign = 'left';
  }
  // two-hand link line
  if (f.dom.present && f.sup.present && (G.twoShape || G.orbit)) {
    ox.setLineDash([6, 6]); ox.strokeStyle = '#ffd76a'; ox.lineWidth = 1.5; ox.beginPath(); ox.moveTo(f.dom.x * W, f.dom.y * H); ox.lineTo(f.sup.x * W, f.sup.y * H); ox.stroke(); ox.setLineDash([]);
  }
}
requestAnimationFrame(drawOverlay);

// ---------------- layout / init ----------------
function onResize() { stageRect = $('#stage').getBoundingClientRect(); if (S.mode === '2d') d2.resize(); else d3.resize(); }
window.addEventListener('resize', () => { clearTimeout(onResize.t); onResize.t = setTimeout(onResize, 120); });

(function init() {
  stageRect = $('#stage').getBoundingClientRect();
  const r = $('#view2d').getBoundingClientRect();
  d2.doc.width = Math.round(r.width); d2.doc.height = Math.round(r.height);
  ge.setSmoothing(S.smooth / 100);
  let restored = false;
  try { const a = localStorage.getItem('aircanvas.autosave'); if (a) { applyProject(JSON.parse(a)); restored = true; } } catch (e) { console.warn('autosave restore failed', e); }
  if (!restored) { d2.resize(); setColor(S.colorA); setTool3d('stroke'); setMode('2d'); }
  d3.resize();
  if (restored) toast('Restored your last session (📂 New to start fresh)', 2500);
  if (!window.isSecureContext) toast('⚠ Camera needs https:// or http://localhost', 5000);
  setPill('#st-model', '', 'Model (loads with camera)');
  setPill('#st-cam', '', 'Camera off');
  // preload model in background so camera start is quick
  setTimeout(() => tracker.loadModel(SET.delegate).catch(e => { console.error(e); setPill('#st-model', 'bad', 'Model failed: ' + e.message); }), 300);
})();
window.AirCanvas = { d2, d3, ge, tracker, S, SET, onResults, G, applyProject, projectData, doEvent }; // handy for debugging in DevTools
