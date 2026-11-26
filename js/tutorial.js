// Interactive in-app tutorial: each step watches the live hand tracking and only
// moves on when the user has actually done the gesture. Runs in a sandbox: the
// user's drawing is saved before and restored after.

export class Tutorial {
  constructor(api) {
    this.api = api; // { S, SET, G, startCamera, isCameraOn, swapHands, snapshot, restore, setMode, setTool, clearDoc, beep, toast }
    this.el = document.getElementById('tutor');
    this.layer = document.getElementById('tutor-targets');
    this.i = 0; this.active = false; this.st = {};
    this.el.querySelector('#tu-back').onclick = () => this.go(this.i - 1);
    this.el.querySelector('#tu-skip').onclick = () => this.go(this.i + 1);
    this.el.querySelector('#tu-exit').onclick = () => this.finish(false);
    this.el.querySelector('#tu-action').onclick = () => this.step().action?.();
    this.steps = this._steps();
  }

  start() {
    if (this.active) return;
    this.active = true; this.saved = this.api.snapshot();
    this.api.setMode('2d'); this.api.setTool('pen'); this.api.clearDoc();
    this.el.classList.remove('hidden'); this.go(0);
  }
  finish(done = true) {
    this.active = false; this.el.classList.add('hidden'); this.layer.innerHTML = '';
    if (this.saved) this.api.restore(this.saved); this.saved = null;
    try { localStorage.setItem('aircanvas.tutorialDone', '1'); } catch {}
    this.api.toast(done ? '🎓 Tutorial complete — your drawing is back' : 'Tutorial closed — reopen it with 🎓', 2500);
  }
  step() { return this.steps[this.i]; }
  go(n) {
    if (n < 0) n = 0;
    if (n >= this.steps.length) return this.finish(true);
    this.step()?.exit?.call(this);
    this.layer.innerHTML = '';
    this.i = n; this.st = { prog: 0, t0: performance.now() };
    const s = this.step();
    this.$('#tu-count').textContent = `Step ${n + 1} / ${this.steps.length}`;
    this.$('#tu-icon').textContent = s.icon;
    this.$('#tu-title').textContent = s.title;
    this.$('#tu-text').innerHTML = s.text;
    const a = this.$('#tu-action'); a.classList.toggle('hidden', !s.actionLabel); a.textContent = s.actionLabel || '';
    this.$('#tu-skip').textContent = n === this.steps.length - 1 ? 'Finish ✓' : 'Skip ›';
    this.$('#tu-back').disabled = n === 0;
    this._progress(0); this._status('');
    s.enter?.call(this);
  }
  $(q) { return this.el.querySelector(q); }
  _progress(p) { this.$('#tu-bar').style.width = Math.round(p * 100) + '%'; }
  _status(msg, ok) { const el = this.$('#tu-status'); el.innerHTML = msg; el.className = 'tu-status' + (ok ? ' ok' : ''); }

  // called on every tracking frame
  tick(f, t) {
    if (!this.active || this.passing) return;
    const s = this.step(); if (!s.check) return;
    const r = s.check.call(this, f, t);
    if (r === true || r >= 1) this._pass();
    else if (typeof r === 'number') this._progress(r);
  }
  // called on app events (nextColor, nextTool, airclick, …)
  notify(type, data) { if (this.active && !this.passing) this.step().on?.call(this, type, data); }
  _pass() {
    this.passing = true; this._progress(1); this._status('✅ Great!', true); this.api.beep(1320, 0.12);
    setTimeout(() => { this.passing = false; if (this.active) this.go(this.i + 1); }, 900);
  }
  // hold a condition for ms → progress 0..1
  hold(key, cond, ms, t) {
    if (!cond) { this.st[key] = 0; return 0; }
    if (!this.st[key]) this.st[key] = t;
    return Math.min(1, (t - this.st[key]) / ms);
  }
  hand(f) { return f.dom.present ? f.dom : f.sup.present ? f.sup : null; }
  sideWord(side) { return side === 'Right' ? 'RIGHT' : 'LEFT'; }

  _steps() {
    const A = this.api;
    const domSide = () => A.SET.dominant, ctrlSide = () => (A.SET.dominant === 'Right' ? 'Left' : 'Right');
    return [
      {
        icon: '👋', title: 'Welcome to AirCanvas',
        text: 'You will draw in the air with your hands. Sit about an arm\'s length from the camera, in good light, with your hands at chest height.<br><br>Every step checks that you can do it before moving on. Your current drawing is kept safe and restored at the end.',
        actionLabel: '▶ Start camera',
        action: () => A.startCamera(),
        enter() { if (A.isCameraOn()) { this.$('#tu-action').classList.add('hidden'); this._status('Camera is on ✓ — keep going', true); } },
        check(f, t) { return A.isCameraOn() ? this.hold('cam', true, 1200, t) : 0; },
      },
      {
        icon: '✋', title: '', text: '',
        enter() {
          this.$('#tu-title').textContent = `Raise only your ${this.sideWord(domSide())} hand`;
          this.$('#tu-text').innerHTML = `This is your <b>draw hand</b>. Hold it up, palm facing the screen. Keep your other hand down.<br><span class="muted small">If the app sees it as the wrong hand, it fixes this automatically.</span>`;
        },
        check(f, t) {
          if (f.count !== 1) { this.st.wrong = 0; this._status(f.count === 0 ? 'Waiting for your hand…' : 'Only one hand please'); return 0; }
          const h = this.hand(f);
          if (h.side === domSide()) { this._status(`Seen as your ${this.sideWord(h.side)} hand ✓ — hold still`, true); return this.hold('ok', true, 1000, t); }
          this.st.ok = 0;
          if (!this.st.wrong) this.st.wrong = t;
          this._status(`Seen as your ${this.sideWord(h.side)} hand — checking…`);
          if (t - this.st.wrong > 1500) { A.swapHands(); this.st.wrong = 0; A.toast('↔ Left/right corrected for your camera', 2500); }
          return 0;
        },
      },
      {
        icon: '🙌', title: 'Now show both hands', text: '',
        enter() { this.$('#tu-text').innerHTML = `Raise both hands. Your ${this.sideWord(domSide())} hand is the <b style="color:#4f8cff">DRAW</b> hand, and your ${this.sideWord(ctrlSide())} hand is the <b style="color:#ffb84f">CONTROL</b> hand.<br>Look at the camera box: the skeletons are labelled DRAW and CTRL.`; },
        actionLabel: '↔ My hands are reversed',
        action: () => { A.swapHands(); A.toast('↔ Swapped left/right'); },
        check(f, t) {
          if (f.count < 2) { this._status(`Hands seen: ${f.count} / 2`); return 0; }
          this._status('Both hands tracked ✓ — DRAW hand is blue, CONTROL hand is orange', true);
          return this.hold('both', true, 1500, t);
        },
      },
      {
        icon: '☝️', title: 'Point and move the cursor',
        text: 'With your draw hand, point your index finger up. A ring cursor follows it. Touch the 3 yellow dots.<br><span class="muted small">Tip: rest your elbow and make small movements.</span>',
        enter() {
          this.st.targets = [[0.28, 0.55], [0.5, 0.78], [0.68, 0.5]].map(([x, y]) => {
            const d = document.createElement('div'); d.className = 'tu-target'; d.style.left = x * 100 + '%'; d.style.top = y * 100 + '%'; this.layer.appendChild(d); return { x, y, d, hit: false };
          });
        },
        check(f) {
          if (!f.dom.present) { this._status('Show your draw hand'); return null; }
          const cx = f.dom.x * innerWidth, cy = f.dom.y * innerHeight;
          for (const g of this.st.targets) if (!g.hit) {
            const r = g.d.getBoundingClientRect();
            if (Math.hypot(cx - (r.left + r.width / 2), cy - (r.top + r.height / 2)) < 48) { g.hit = true; g.d.classList.add('hit'); A.beep(1000); }
          }
          const n = this.st.targets.filter(g => g.hit).length;
          this._status(`Dots touched: ${n} / 3 · pose: ${f.dom.pose}`, n > 0);
          return n / 3;
        },
      },
      {
        icon: '🤏', title: 'Pinch to draw',
        text: 'Touch your thumb and index finger together. That is <b>pen down</b>. Move to draw, then open your fingers to lift the pen.<br>Draw a long line or a loop.',
        check(f) {
          if (!f.dom.present) { this._status('Show your draw hand'); return null; }
          const p = [f.dom.x * innerWidth, f.dom.y * innerHeight];
          if (f.dom.pinch) { if (this.st.last) this.st.len = (this.st.len || 0) + Math.hypot(p[0] - this.st.last[0], p[1] - this.st.last[1]); this.st.last = p; }
          else this.st.last = null;
          const prog = Math.min(1, (this.st.len || 0) / 700);
          this._status(f.dom.pinch ? `Drawing… ${Math.round(prog * 100)}%` : `Pinch strength: ${Math.round(f.dom.pinchStrength * 100)}% — close the pinch to draw`, f.dom.pinch);
          return prog;
        },
      },
      {
        icon: '✍️', title: 'Pen up and pen down',
        text: 'Write separate marks: pinch, move a little, release. Do it <b>3 times</b> to make 3 separate strokes, like dashes.',
        check(f) {
          if (f.dom.present && f.dom.edges.pinchEnd) this.st.n = (this.st.n || 0) + 1;
          const n = this.st.n || 0;
          this._status(`Strokes: ${n} / 3`, n > 0);
          return n / 3;
        },
      },
      {
        icon: '👆', title: 'Click a button in the air',
        text: 'Point at the <b>Undo</b> button in the left toolbar. Hold still until the ring fills, or pinch on it.<br>Undo and Redo are buttons only, so you can\'t undo by accident.',
        enter() { document.getElementById('btn-undo').classList.add('tu-glow'); },
        exit() { document.getElementById('btn-undo').classList.remove('tu-glow'); },
        on(type, el) { if (type === 'airclick' && el?.id === 'btn-undo') this._pass(); else if (type === 'airclick') this._status('That was a different button — aim for Undo'); },
        check(f) { this._status(f.dom.present ? 'Point at the glowing Undo button' : 'Show your draw hand'); return null; },
      },
      {
        icon: '✌️', title: 'Control hand: change colour', text: '',
        enter() { this.$('#tu-text').innerHTML = `Show a <b>peace sign</b> ✌️ with your ${this.sideWord(ctrlSide())} (control) hand. Each time you make it, the colour changes.<br>Change colour <b>2 times</b>. Open your hand between signs.`; },
        on(type) { if (type === 'nextColor') { this.st.n = (this.st.n || 0) + 1; this._status(`Colour changes: ${this.st.n} / 2`, true); if (this.st.n >= 2) this._pass(); else this._progress(0.5); } },
        check(f) { if (!this.st.n) this._status(f.sup.present ? `Control hand: ${f.sup.pose}` : 'Show your control hand'); return null; },
      },
      {
        icon: '↕️', title: 'Control hand: brush size',
        text: 'Pinch with your <b>control</b> hand and move it <b>up</b> for a bigger brush, <b>down</b> for smaller. Keep your draw hand open or pointing, not pinching.',
        enter() { this.st.size0 = A.S.size; },
        check(f) {
          const d = Math.abs(A.S.size - this.st.size0);
          this._status(f.sup.present ? (f.sup.pinch ? `Size: ${A.S.size} (changed by ${d})` : 'Pinch with the control hand, then move up/down') : 'Show your control hand', d > 0);
          return Math.min(1, d / 10);
        },
      },
      {
        icon: '🤟', title: 'Control hand: next tool',
        text: 'Show <b>three fingers</b> (index, middle, ring) with your control hand. The tool changes, so watch the left toolbar.',
        on(type) { if (type === 'nextTool') this._pass(); },
        check(f) { this._status(f.sup.present ? `Control hand: ${f.sup.pose}` : 'Show your control hand'); return null; },
        exit() { A.setTool('pen'); },
      },
      {
        icon: '✋', title: 'Palm eraser',
        text: 'Open your <b>draw</b> hand flat, palm to the camera, and wipe over your drawing. Keep the control hand down or closed.',
        check(f, t) {
          const on = A.G.palm;
          this._status(on ? 'Erasing… keep wiping' : f.dom.present ? `Draw hand: ${f.dom.pose} — open your palm` : 'Show your draw hand', on);
          return this.hold('palm', on, 1200, t);
        },
      },
      {
        icon: '🤏🤏', title: 'Two-hand shape',
        text: 'Pinch with <b>both hands</b>. A rectangle stretches between them. Move your hands apart, then release to place it.<br><span class="muted small">Choose another shape in the toolbar first to get circles, stars and more.</span>',
        check(f, t) {
          if (A.G.twoShape) this.st.seen = true;
          if (this.st.seen && !A.G.twoShape) return true;
          this._status(A.G.twoShape ? 'Stretching the shape — release to place it' : `Draw: ${f.dom.present ? f.dom.pose : '—'} · Control: ${f.sup.present ? f.sup.pose : '—'}`, A.G.twoShape);
          return A.G.twoShape ? 0.6 : 0;
        },
      },
      {
        icon: '🎉', title: 'You\'re ready!',
        text: 'Quick recap:<br>☝️ point = cursor · 🤏 pinch = draw · ✋ palm = erase<br>✌️ control = colour · 🤟 control = tool · 🤏 control up/down = size<br>🤏+🤏 = shape (2D) or orbit (3D) · 👍+👍 hold = download<br>Undo and Redo: point at the buttons.<br><br>Press <b>Finish</b>, and your drawing comes back. Reopen this tutorial any time with 🎓.',
      },
    ];
  }
}
