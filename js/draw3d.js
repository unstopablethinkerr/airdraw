// 3D sculpt engine: tube/ribbon strokes, primitives, selection, transforms, materials, STL/GLB/OBJ/JSON.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';

export const PRIMS = ['cube', 'sphere', 'cylinder', 'cone', 'torus'];
const GEO = {
  cube: () => new THREE.BoxGeometry(1, 1, 1),
  sphere: () => new THREE.SphereGeometry(0.5, 40, 24),
  cylinder: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 40),
  cone: () => new THREE.ConeGeometry(0.5, 1, 40),
  torus: () => new THREE.TorusGeometry(0.4, 0.14, 20, 64),
};
const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const r3 = (n) => Math.round(n * 1000) / 1000;

export class Draw3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0f1117');
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
    this.camera.position.set(0, 1.5, 10);
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#30344a', 1.4));
    const dl = new THREE.DirectionalLight('#ffffff', 2.2); dl.position.set(5, 8, 6); this.scene.add(dl);
    const dl2 = new THREE.DirectionalLight('#8fb0ff', 0.8); dl2.position.set(-6, 2, -4); this.scene.add(dl2);
    this.grid = new THREE.GridHelper(20, 20, '#3a4160', '#262b3c'); this.grid.position.y = -3; this.scene.add(this.grid);
    this.content = new THREE.Group(); this.content.name = 'AirCanvasModel'; this.scene.add(this.content);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.12;
    this.controls.addEventListener('change', () => this.dirty = true);
    this.tcontrols = new TransformControls(this.camera, canvas);
    this.tcontrols.addEventListener('dragging-changed', (e) => { this.controls.enabled = !e.value; if (e.value) this._pendingUndo = this._snapshot(); else this._commit(); });
    this.tcontrols.addEventListener('change', () => { this.dirty = true; this._updateSelBox(); });
    this.scene.add(this.tcontrols.getHelper());

    // 3D cursor + depth guide
    this.cursor = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 12), new THREE.MeshBasicMaterial({ color: '#ffd76a' }));
    this.cursorRing = new THREE.Mesh(new THREE.RingGeometry(0.12, 0.16, 32), new THREE.MeshBasicMaterial({ color: '#ffd76a', side: THREE.DoubleSide, transparent: true, opacity: .6 }));
    this.cursorRing.rotation.x = -Math.PI / 2;
    const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.dropLine = new THREE.Line(lg, new THREE.LineDashedMaterial({ color: '#ffd76a', dashSize: 0.1, gapSize: 0.08, transparent: true, opacity: .5 }));
    this.cursorGroup = new THREE.Group(); this.cursorGroup.add(this.cursor, this.cursorRing, this.dropLine); this.cursorGroup.visible = false;
    this.scene.add(this.cursorGroup);

    this.items = []; // {id, kind, color, ...data, mesh}
    this.nextId = 1; this.undoStack = []; this.redoStack = [];
    this.matMode = 'standard'; this.mirror = false; this.radius = 0.08;
    this.selected = null; this.selBox = null;
    this.live = null; this.dirty = true; this.onChange = () => {}; this.onSelect = () => {};
    this.raycaster = new THREE.Raycaster();
    this._lastLiveBuild = 0;
    this.active = false;
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
    canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
  }

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / Math.max(1, r.height); this.camera.updateProjectionMatrix(); this.dirty = true;
  }
  _loop() {
    requestAnimationFrame(this._loop);
    if (!this.active) return;
    const moved = this.controls.update();
    if (moved || this.dirty || this.controls.autoRotate) { this.renderer.render(this.scene, this.camera); this.dirty = false; }
  }
  setAutoRotate(on) { this.controls.autoRotate = on; this.controls.autoRotateSpeed = 1.5; this.dirty = true; }
  setGrid(on) { this.grid.visible = on; this.dirty = true; }

  // ---------- materials ----------
  material(color) {
    const c = new THREE.Color(color);
    switch (this.matMode) {
      case 'glossy': return new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.15, clearcoat: 1, clearcoatRoughness: 0.1 });
      case 'metal': return new THREE.MeshStandardMaterial({ color: c, roughness: 0.25, metalness: 0.9 });
      case 'toon': return new THREE.MeshToonMaterial({ color: c });
      case 'wire': return new THREE.MeshBasicMaterial({ color: c, wireframe: true });
      case 'normal': return new THREE.MeshNormalMaterial();
      default: return new THREE.MeshStandardMaterial({ color: c, roughness: 0.55, metalness: 0.05 });
    }
  }
  setMaterialMode(m) {
    this.matMode = m;
    for (const it of this.items) it.mesh.traverse(o => { if (o.isMesh) { const side = o.material.side; o.material.dispose(); o.material = this.material(it.color); o.material.side = side; } });
    this.dirty = true;
  }

  // ---------- cursor / picking ----------
  // ndc in -1..1, depth offset in world units (positive = farther)
  worldAt(ndcX, ndcY, depth = 0) {
    this.raycaster.setFromCamera({ x: ndcX, y: ndcY }, this.camera);
    const dir = new THREE.Vector3(); this.camera.getWorldDirection(dir);
    const p0 = this.controls.target.clone().addScaledVector(dir, depth);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(dir.clone().negate(), p0);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(plane, out) || p0;
  }
  showCursor(p, color, on = true) {
    this.cursorGroup.visible = on; if (!on) { this.dirty = true; return; }
    this.cursor.position.copy(p); this.cursor.material.color.set(color);
    const gy = this.grid.position.y + 0.01;
    this.cursorRing.position.set(p.x, gy, p.z);
    const pos = this.dropLine.geometry.attributes.position; pos.setXYZ(0, p.x, p.y, p.z); pos.setXYZ(1, p.x, gy, p.z); pos.needsUpdate = true;
    this.dropLine.computeLineDistances();
    this.dirty = true;
  }
  pick(ndcX, ndcY) {
    this.raycaster.setFromCamera({ x: ndcX, y: ndcY }, this.camera);
    const hits = this.raycaster.intersectObjects(this.content.children, true);
    for (const h of hits) { let o = h.object; while (o && !o.userData.itemId) o = o.parent; if (o) return this.items.find(i => i.id === o.userData.itemId); }
    return null;
  }
  // nearest item to a world point (for gesture grabbing without exact ray hit)
  nearest(p, maxDist = 1.2) {
    let best = null, bd = maxDist;
    for (const it of this.items) {
      const box = new THREE.Box3().setFromObject(it.mesh), d = box.distanceToPoint(p);
      if (d < bd) { bd = d; best = it; }
    }
    return best;
  }

  // ---------- strokes ----------
  beginStroke(kind, p, color) { this.live = { kind, color, pts: [p.clone()], mesh: null }; }
  addStrokePoint(p) {
    const L = this.live; if (!L) return;
    if (L.pts[L.pts.length - 1].distanceTo(p) < 0.03) return;
    L.pts.push(p.clone());
    const now = performance.now();
    if (now - this._lastLiveBuild > 45) { this._lastLiveBuild = now; this._rebuildLive(); }
  }
  _rebuildLive() {
    const L = this.live; if (!L || L.pts.length < 2) return;
    if (L.mesh) { this.scene.remove(L.mesh); disposeTree(L.mesh); }
    L.mesh = this._strokeMesh({ kind: L.kind, color: L.color, pts: L.pts.map(v => v.toArray()), radius: this.radius, normal: this._viewNormal() }, true);
    this.scene.add(L.mesh); this.dirty = true;
  }
  endStroke() {
    const L = this.live; this.live = null; if (!L) return;
    if (L.mesh) { this.scene.remove(L.mesh); disposeTree(L.mesh); }
    if (L.pts.length < 2) { this.dirty = true; return; }
    const pts = simplify(L.pts, 0.02).map(v => [r3(v.x), r3(v.y), r3(v.z)]);
    const data = { kind: L.kind, color: L.color, pts, radius: this.radius, normal: this._viewNormal().toArray().map(r3) };
    this._pushUndo();
    this._addItem(data);
    if (this.mirror) this._addItem({ ...data, pts: pts.map(p => [-p[0], p[1], p[2]]), normal: [-data.normal[0], data.normal[1], data.normal[2]] });
    this.onChange(); this.dirty = true;
  }
  _viewNormal() { const d = new THREE.Vector3(); this.camera.getWorldDirection(d); return d.negate(); }
  _strokeMesh(d, preview = false) {
    const pts = d.pts.map(v3), color = d.color;
    const group = new THREE.Group();
    if (pts.length < 2) return group;
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const segs = Math.min(800, Math.max(8, pts.length * (preview ? 2 : 4)));
    let geo;
    if (d.kind === 'ribbon') geo = ribbonGeometry(curve, segs, d.radius * 3, v3(d.normal || [0, 0, 1]));
    else geo = new THREE.TubeGeometry(curve, segs, d.radius, preview ? 6 : 10, false);
    const mat = this.material(color); if (d.kind === 'ribbon') mat.side = THREE.DoubleSide;
    group.add(new THREE.Mesh(geo, mat));
    if (d.kind !== 'ribbon') { // round caps -> closed, printable-looking ends
      const cg = new THREE.SphereGeometry(d.radius, preview ? 8 : 14, preview ? 6 : 10);
      for (const p of [pts[0], pts[pts.length - 1]]) { const c = new THREE.Mesh(cg, mat); c.position.copy(p); group.add(c); }
    }
    return group;
  }

  // ---------- primitives ----------
  beginPrim(type, p, color) {
    const mesh = new THREE.Mesh(GEO[type](), this.material(color)); mesh.position.copy(p); mesh.scale.setScalar(0.3);
    this.live = { kind: 'prim', type, color, center: p.clone(), mesh }; this.scene.add(mesh); this.dirty = true;
  }
  updatePrim(p) {
    const L = this.live; if (!L || L.kind !== 'prim') return;
    const s = Math.max(0.3, L.center.distanceTo(p) * 2); L.mesh.scale.setScalar(s); this.dirty = true;
  }
  endPrim() {
    const L = this.live; this.live = null; if (!L || L.kind !== 'prim') return;
    this.scene.remove(L.mesh); disposeTree(L.mesh);
    const camQ = new THREE.Euler().setFromQuaternion(this.camera.quaternion);
    const data = { kind: 'prim', type: L.type, color: L.color, pos: L.center.toArray().map(r3), rot: [0, r3(L.type === 'torus' ? camQ.y : 0), 0], scl: Array(3).fill(r3(L.mesh.scale.x)) };
    this._pushUndo(); this._addItem(data);
    if (this.mirror && Math.abs(data.pos[0]) > 0.05) this._addItem({ ...data, pos: [-data.pos[0], data.pos[1], data.pos[2]], rot: [data.rot[0], -data.rot[1], -data.rot[2]] });
    this.onChange(); this.dirty = true;
  }
  addPrimAt(type, p, color, size = 1) { this._pushUndo(); const it = this._addItem({ kind: 'prim', type, color, pos: p.toArray().map(r3), rot: [0, 0, 0], scl: [size, size, size] }); this.onChange(); return it; }

  // ---------- items ----------
  _addItem(data) {
    const it = { id: this.nextId++, ...data };
    if (data.kind === 'prim') {
      it.mesh = new THREE.Mesh(GEO[data.type](), this.material(data.color));
      it.mesh.position.fromArray(data.pos); it.mesh.rotation.fromArray([...data.rot, 'XYZ']); it.mesh.scale.fromArray(data.scl);
    } else {
      it.mesh = this._strokeMesh(data);
      if (data.pivot) { const pv = v3(data.pivot); for (const ch of it.mesh.children) ch.position.sub(pv); it.mesh.userData.centered = true; it.mesh.userData.pivot = data.pivot; }
      if (data.pos) { it.mesh.position.fromArray(data.pos); it.mesh.rotation.fromArray([...data.rot, 'XYZ']); it.mesh.scale.fromArray(data.scl); }
    }
    it.mesh.userData.itemId = it.id;
    this.content.add(it.mesh); this.items.push(it); return it;
  }
  _snapshot() { return this.items.map(it => this._itemData(it)); }
  _itemData(it) {
    const { mesh, id, ...d } = it;
    if (mesh.userData.pivot) d.pivot = mesh.userData.pivot;
    return { ...d, pos: mesh.position.toArray().map(r3), rot: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z].map(r3), scl: mesh.scale.toArray().map(r3) };
  }
  _restore(list) {
    this.select(null);
    for (const it of this.items) { this.content.remove(it.mesh); disposeTree(it.mesh); }
    this.items = []; for (const d of list) this._addItem(d); this.dirty = true;
  }
  _pushUndo() { this.undoStack.push(this._snapshot()); if (this.undoStack.length > 100) this.undoStack.shift(); this.redoStack = []; }
  _commit() { // after a transform drag: record state
    if (this._pendingUndo) { this.undoStack.push(this._pendingUndo); this._pendingUndo = null; this.redoStack = []; }
    this.onChange();
  }
  undo() { if (!this.undoStack.length) return false; this.redoStack.push(this._snapshot()); this._restore(this.undoStack.pop()); this.onChange(); return true; }
  redo() { if (!this.redoStack.length) return false; this.undoStack.push(this._snapshot()); this._restore(this.redoStack.pop()); this.onChange(); return true; }
  clear() { if (!this.items.length) return; this._pushUndo(); this._restore([]); this.onChange(); }
  remove(it) { if (!it) return; this._pushUndo(); if (this.selected === it) this.select(null); this.content.remove(it.mesh); disposeTree(it.mesh); this.items = this.items.filter(i => i !== it); this.dirty = true; this.onChange(); }
  duplicate(it) { if (!it) return; this._pushUndo(); const d = this._itemData(it); d.pos = [d.pos[0] + 0.6, d.pos[1], d.pos[2]]; const n = this._addItem(d); this.select(n); this.onChange(); }
  recolor(it, color) {
    if (!it) return; this._pushUndo(); it.color = color;
    it.mesh.traverse(o => { if (o.isMesh) { const side = o.material.side; o.material.dispose(); o.material = this.material(color); o.material.side = side; } });
    this.dirty = true; this.onChange();
  }

  // ---------- selection & transforms ----------
  select(it) {
    this.selected = it || null;
    if (this.selBox) { this.scene.remove(this.selBox); this.selBox.geometry.dispose(); this.selBox = null; }
    if (it) {
      // strokes: re-center pivot so rotation happens around the object's middle
      if (it.kind !== 'prim') recenter(it.mesh);
      this.selBox = new THREE.BoxHelper(it.mesh, '#ffd76a'); this.scene.add(this.selBox);
      this.tcontrols.attach(it.mesh);
    } else this.tcontrols.detach();
    this.onSelect(this.selected); this.dirty = true;
  }
  setGizmo(mode) { this.tcontrols.setMode(mode); this.dirty = true; }
  _updateSelBox() { if (this.selBox) this.selBox.update(); }
  beginEdit() { this._pendingUndo = this._snapshot(); }
  endEdit() { this._commit(); }
  moveSelected(delta) { if (!this.selected) return; this.selected.mesh.position.add(delta); this._updateSelBox(); this.dirty = true; }
  rotateSelected(dYaw, dPitch, dRoll) {
    if (!this.selected) return;
    const m = this.selected.mesh, up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion), fwd = this._viewNormal();
    const q = new THREE.Quaternion().setFromAxisAngle(up, dYaw).multiply(new THREE.Quaternion().setFromAxisAngle(right, dPitch)).multiply(new THREE.Quaternion().setFromAxisAngle(fwd, dRoll));
    m.quaternion.premultiply(q); this._updateSelBox(); this.dirty = true;
  }
  scaleSelected(f) { if (!this.selected) return; const m = this.selected.mesh; m.scale.multiplyScalar(f); m.scale.clampScalar(0.05, 50); this._updateSelBox(); this.dirty = true; }

  // ---------- camera ----------
  orbit(dTheta, dPhi) {
    const off = this.camera.position.clone().sub(this.controls.target), sp = new THREE.Spherical().setFromVector3(off);
    sp.theta -= dTheta; sp.phi = Math.max(0.1, Math.min(Math.PI - 0.1, sp.phi - dPhi));
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3().setFromSpherical(sp)); this.camera.lookAt(this.controls.target); this.dirty = true;
  }
  zoom(f) {
    const off = this.camera.position.clone().sub(this.controls.target); const len = Math.max(2, Math.min(60, off.length() * f));
    this.camera.position.copy(this.controls.target).add(off.setLength(len)); this.dirty = true;
  }
  setView(v) {
    const t = this.controls.target, d = this.camera.position.distanceTo(t) || 10;
    const dirs = { front: [0, 0, 1], top: [0, 1, 0.0001], side: [1, 0, 0], iso: [0.7, 0.55, 0.7] };
    this.camera.position.copy(t).add(v3(dirs[v]).normalize().multiplyScalar(d)); this.camera.lookAt(t); this.controls.update(); this.dirty = true;
  }

  // ---------- mouse ----------
  setMouseTool(tool, colorFn) { this.mouseTool = tool; this.colorFn = colorFn; }
  _onPointerDown(e) {
    if (this.tcontrols.dragging) return;
    const r = this.canvas.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * 2 - 1, y = -((e.clientY - r.top) / r.height) * 2 + 1;
    if (this.mouseTool === 'select') { if (e.button === 0) { const it = this.pick(x, y); if (it || !this.tcontrols.axis) this.select(it); } }
    else if (this.mouseTool === 'erase') { const it = this.pick(x, y); if (it) this.remove(it); }
    else if (PRIMS.includes(this.mouseTool) && e.shiftKey) this.addPrimAt(this.mouseTool, this.worldAt(x, y, 0), this.colorFn(), 1);
  }

  // ---------- IO ----------
  serialize() {
    return { camera: { pos: this.camera.position.toArray().map(r3), target: this.controls.target.toArray().map(r3) }, material: this.matMode, items: this._snapshot() };
  }
  load(d) {
    this.undoStack = []; this.redoStack = [];
    if (d.material) this.matMode = d.material;
    this._restore(d.items || []);
    if (d.camera) { this.camera.position.fromArray(d.camera.pos); this.controls.target.fromArray(d.camera.target); this.camera.lookAt(this.controls.target); }
    this.onChange();
  }
  exportSTL() { this.select(null); return new STLExporter().parse(this.content, { binary: true }); }
  exportOBJ() { this.select(null); return new OBJExporter().parse(this.content); }
  async exportGLB() { this.select(null); return new GLTFExporter().parseAsync(this.content, { binary: true }); }
  screenshot() { this.cursorGroup.visible = false; this.renderer.render(this.scene, this.camera); return this.renderer.domElement.toDataURL('image/png'); }
}

function ribbonGeometry(curve, segs, width, normal) {
  const pos = [], idx = [], pts = curve.getSpacedPoints(segs);
  for (let i = 0; i < pts.length; i++) {
    const t = curve.getTangentAt(Math.min(1, i / segs)), side = new THREE.Vector3().crossVectors(t, normal).normalize().multiplyScalar(width / 2);
    const a = pts[i].clone().add(side), b = pts[i].clone().sub(side); pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    if (i > 0) { const k = i * 2; idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals(); return g;
}
function simplify(pts, tol) { // drop points closer than tol
  const out = [pts[0]]; for (let i = 1; i < pts.length - 1; i++) if (pts[i].distanceTo(out[out.length - 1]) >= tol) out.push(pts[i]);
  out.push(pts[pts.length - 1]); return out;
}
function recenter(group) {
  if (group.userData.centered) return;
  const box = new THREE.Box3().setFromObject(group), c = box.getCenter(new THREE.Vector3());
  const local = group.worldToLocal(c.clone());
  for (const ch of group.children) ch.position.sub(local);
  group.position.add(c.clone().sub(group.localToWorld(new THREE.Vector3()))); // keep world placement
  group.updateMatrixWorld(true); group.userData.centered = true; group.userData.pivot = local.toArray().map(r3);
}
function disposeTree(o) { o.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach(m => m.dispose()); }); }
