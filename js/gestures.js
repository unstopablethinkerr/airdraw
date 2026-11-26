// Gesture engine: filtering, pose classification, hand assignment, holds and two-hand combos.

// ---------- One Euro filter (jitter-free yet responsive) ----------
class LowPass { constructor() { this.y = null; } f(x, a) { this.y = this.y === null ? x : a * x + (1 - a) * this.y; return this.y; } }
export class OneEuro {
  constructor(minCutoff = 1.2, beta = 0.02, dCutoff = 1.0) { this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff; this.x = new LowPass(); this.dx = new LowPass(); this.t = null; }
  alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  reset() { this.x = new LowPass(); this.dx = new LowPass(); this.t = null; }
  filter(v, tMs) {
    if (this.t === null) { this.t = tMs; this.dx.f(0, 1); return this.x.f(v, 1); }
    const dt = Math.max(1e-3, (tMs - this.t) / 1000); this.t = tMs;
    const prev = this.x.y;
    const d = this.dx.f((v - prev) / dt, this.alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(d);
    return this.x.f(v, this.alpha(cutoff, dt));
  }
}

export const POSE_ICON = { NONE: '—', POINT: '☝️ Point', PINCH: '🤏 Pinch', OPEN: '✋ Open', FIST: '✊ Fist', PEACE: '✌️ Peace', THREE: '🤟 Three', THUMB: '👍 Thumb up', ROCK: '🤘 Rock', OTHER: '🖐 …' };

const d2 = (a, b, ar = 1) => Math.hypot((a.x - b.x) * ar, a.y - b.y);

function classify(lm, ar, pinchOn, pinchThresh) {
  const scale = d2(lm[0], lm[9], ar) || 1e-3;
  const w = lm[0];
  const ext = (tip, pip) => d2(lm[tip], w, ar) > d2(lm[pip], w, ar) * 1.12;
  const I = ext(8, 6), M = ext(12, 10), R = ext(16, 14), P = ext(20, 18);
  const thumbOut = d2(lm[4], lm[9], ar) > d2(lm[3], lm[9], ar) * 1.05 && d2(lm[4], lm[5], ar) > scale * 0.55;
  const pinchDist = d2(lm[4], lm[8], ar) / scale;
  // hysteresis: harder to start a pinch than to keep it
  const onT = pinchThresh, offT = pinchThresh * 1.45;
  const pinch = pinchOn ? pinchDist < offT : pinchDist < onT;
  let pose = 'OTHER';
  if (pinch) pose = 'PINCH';
  else if (!I && !M && !R && !P) pose = thumbOut && lm[4].y < lm[5].y - scale * 0.25 ? 'THUMB' : 'FIST';
  else if (I && !M && !R && !P) pose = 'POINT';
  else if (I && M && !R && !P) pose = 'PEACE';
  else if (I && M && R && !P) pose = 'THREE';
  else if (I && !M && !R && P) pose = 'ROCK';
  else if (I && M && R && P) pose = 'OPEN';
  return { pose, pinch: pose === 'PINCH', pinchDist, scale };
}

const HOLD_MS = { undo: 550, redo: 550, mode: 900, download: 900, clear: 1500, save: 1000 };

class HandState {
  constructor(role) {
    this.role = role; this.present = false; this.lastSeen = 0;
    this.fx = new OneEuro(); this.fy = new OneEuro(); this.fs = new OneEuro(0.8, 0.01); this.fr = new OneEuro(1, 0.01);
    this.pose = 'NONE'; this.rawPose = 'NONE'; this.poseCount = 0; this.pinch = false; this.pinchFrames = 0;
    this.x = 0.5; this.y = 0.5; this.scale = 0.2; this.roll = 0; this.pinchStrength = 0; this.score = 0; this.lm = null;
    this.edges = {};
  }
}

export class GestureEngine {
  constructor() {
    this.settings = { dominant: 'Right', reach: 0.75, pinch: 0.32, swap: false, smooth: 0.6, trigger: 'pinch' };
    this.dom = new HandState('dom'); this.sup = new HandState('sup');
    this.holds = {}; // key -> {start, fired}
    this.cooldown = {};
    this.combo = '';
    this.handCount = 0;
  }

  setSmoothing(s) { // 0..1, higher = smoother
    this.settings.smooth = s;
    const mc = 3.0 - s * 2.6, beta = 0.05 - s * 0.04;
    for (const h of [this.dom, this.sup]) { h.fx.minCutoff = h.fy.minCutoff = mc; h.fx.beta = h.fy.beta = beta; }
  }

  // MediaPipe result -> frame
  update(res, t, aspect) {
    const events = [];
    const seen = { dom: null, sup: null };
    const list = [];
    if (res && res.landmarks) {
      for (let i = 0; i < res.landmarks.length; i++) {
        const lm = res.landmarks[i];
        const hd = res.handedness?.[i]?.[0] || res.handednesses?.[i]?.[0];
        let side = hd ? (hd.categoryName === 'Left' ? 'Right' : 'Left') : 'Right'; // un-mirrored input → invert
        if (this.settings.swap) side = side === 'Left' ? 'Right' : 'Left';
        list.push({ lm, side, score: hd ? hd.score : 0, cx: 1 - lm[9].x });
      }
    }
    this.handCount = list.length;
    if (list.length === 1) seen.dom = list[0];
    else if (list.length >= 2) {
      let [a, b] = list;
      if (a.side === b.side) { // ambiguous: decide by screen position
        const right = a.cx > b.cx ? a : b, left = right === a ? b : a;
        right.side = 'Right'; left.side = 'Left';
      }
      seen.dom = a.side === this.settings.dominant ? a : b;
      seen.sup = seen.dom === a ? b : a;
    }

    for (const role of ['dom', 'sup']) {
      const h = this[role], s = seen[role];
      h.edges = {};
      if (!s) {
        if (h.present && t - h.lastSeen > 180) { // coast briefly through dropouts
          h.present = false;
          if (h.pinch) h.edges.pinchEnd = true;
          h.pinch = false; h.pose = 'NONE'; h.rawPose = 'NONE';
          h.fx.reset(); h.fy.reset(); h.fs.reset(); h.fr.reset();
          h.edges.lost = true;
        }
        continue;
      }
      const wasPresent = h.present;
      h.present = true; h.lastSeen = t; h.lm = s.lm; h.side = s.side; h.score = s.score;
      const c = classify(s.lm, aspect, h.pinch, this.settings.pinch);
      // pinch needs 2 consistent frames to start (avoids accidental dots)
      let pinchNow = c.pinch;
      if (pinchNow && !h.pinch) { h.pinchFrames++; if (h.pinchFrames < 2) pinchNow = false; } else if (!pinchNow) h.pinchFrames = 0;
      // pose debounce
      let raw = pinchNow ? 'PINCH' : (c.pose === 'PINCH' ? h.pose : c.pose);
      if (raw === h.rawPose) h.poseCount++; else { h.rawPose = raw; h.poseCount = 1; }
      const prevPose = h.pose;
      if (raw === 'PINCH' || h.poseCount >= 3 || !wasPresent) h.pose = raw;
      if (h.pose !== prevPose) h.edges.poseChanged = prevPose;

      if (pinchNow && !h.pinch) h.edges.pinchStart = true;
      if (!pinchNow && h.pinch) h.edges.pinchEnd = true;
      h.pinch = pinchNow;
      h.pinchStrength = Math.max(0, Math.min(1, 1 - (c.pinchDist - this.settings.pinch * 0.6) / (this.settings.pinch * 1.6)));

      // cursor: index tip blending to thumb-index midpoint as the pinch closes
      const lm = s.lm;
      const k = Math.max(0, Math.min(1, (0.75 - c.pinchDist) / 0.4));
      const px = lm[8].x * (1 - k) + (lm[8].x + lm[4].x) / 2 * k;
      const py = lm[8].y * (1 - k) + (lm[8].y + lm[4].y) / 2 * k;
      const r = this.settings.reach, m = (1 - r) / 2;
      const nx = Math.max(0, Math.min(1, ((1 - px) - m) / r));
      const ny = Math.max(0, Math.min(1, (py - m) / r));
      h.x = h.fx.filter(nx, t); h.y = h.fy.filter(ny, t);
      h.scale = h.fs.filter(c.scale, t);
      h.roll = h.fr.filter(Math.atan2(-(lm[9].y - lm[0].y), -(lm[9].x - lm[0].x) * aspect), t);
      if (!wasPresent) h.edges.found = true;
    }

    // ---------- holds & combos ----------
    const D = this.dom, S = this.sup;
    const dp = D.present ? D.pose : 'NONE', sp = S.present ? S.pose : 'NONE';
    const two = D.present && S.present;
    let combo = '';
    const want = {};
    if (two && dp === 'THUMB' && sp === 'THUMB') { want.download = true; combo = '👍👍 Download'; }
    else if (two && dp === 'OPEN' && sp === 'OPEN') { want.clear = true; combo = '✋✋ Clear'; }
    else if (two && dp === 'PEACE' && sp === 'PEACE') { want.save = true; combo = '✌️✌️ Save project'; }
    else if (two && dp === 'PINCH' && sp === 'PINCH') combo = '🤏🤏 Two-hand';
    else if (two && dp === 'POINT' && sp === 'OPEN') combo = '☝️✋ Ruler line';
    else if (S.present) {
      if (sp === 'FIST') want.undo = true;
      else if (sp === 'THUMB') want.redo = true;
      else if (sp === 'ROCK') want.mode = true;
    }
    if (S.present && S.edges.poseChanged !== undefined && !two_same(dp, sp)) {
      if (sp === 'PEACE' && dp !== 'PEACE') events.push({ type: 'nextColor' });
      if (sp === 'THREE') events.push({ type: 'nextTool' });
    }
    this.combo = combo;
    for (const key of Object.keys(HOLD_MS)) {
      const hld = this.holds[key];
      if (want[key]) {
        if (!hld) this.holds[key] = { start: t, fired: false, progress: 0 };
        else {
          hld.progress = Math.min(1, (t - hld.start) / HOLD_MS[key]);
          if (hld.progress >= 1 && !hld.fired) {
            hld.fired = true; events.push({ type: key });
            // undo/redo auto-repeat while held
            if (key === 'undo' || key === 'redo') { hld.start = t + 250; hld.fired = false; hld.progress = 0; }
          }
        }
      } else delete this.holds[key];
    }
    return { dom: D, sup: S, events, combo, holds: this.holds, count: this.handCount };
  }
}
function two_same(a, b) { return a === b; }

export const HAND_CONNECTIONS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
