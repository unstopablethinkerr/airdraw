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

const HOLD_MS = { mode: 900, download: 900, clear: 1500, save: 1000 };

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
    this.tracks = []; this.trackSeq = 0;
  }

  // Stable role assignment. Each physical hand is followed frame to frame by position,
  // its left/right label is averaged over time, and once both hands have roles they are
  // LOCKED while both stay in view. Per-frame label flicker can no longer swap them.
  _assignRoles(list, t, seen) {
    const used = new Set();
    for (const d of list) {
      const vd = d.side === 'Right' ? 1 : -1;
      let best = null, bd = 0.3;
      for (const tr of this.tracks) {
        if (used.has(tr)) continue;
        // distance, plus a penalty when this frame's label disagrees with the hand's long-term label
        const dd = Math.hypot(tr.cx - d.cx, tr.cy - d.cy) + (Math.abs(tr.vote) > 0.5 && Math.sign(tr.vote) !== vd ? 0.25 : 0);
        if (dd < bd) { bd = dd; best = tr; }
      }
      if (!best) { best = { id: ++this.trackSeq, vote: 0, n: 0, role: null, forced: false }; this.tracks.push(best); }
      used.add(best);
      best.cx = d.cx; best.cy = d.cy; best.lastSeen = t;
      const v = (d.side === 'Right' ? 1 : -1) * (d.score || 0.5);
      // single-frame flicker barely moves the vote; a label that stays different for 5+ frames is believed quickly
      best.disagree = best.n && Math.sign(v) !== Math.sign(best.vote) ? (best.disagree || 0) + 1 : 0;
      const k = best.disagree >= 5 ? 0.3 : 0.08;
      best.vote = best.n ? best.vote * (1 - k) + v * k : v; best.n++;
      d.track = best;
    }
    // forget hands that left the view (short grace period keeps roles through dropouts)
    this.tracks = this.tracks.filter(tr => used.has(tr) || t - tr.lastSeen < (tr.keep ? 1500 : 400));
    const domSide = this.settings.dominant;
    const roleOf = (vote) => ((vote >= 0 ? 'Right' : 'Left') === domSide ? 'dom' : 'sup');
    const live = list.map(d => d.track);

    if (live.length === 1) {
      const tr = live[0], other = this.tracks.find(x => x !== tr && x.role);
      if (!tr.role) {
        // the same hand came back elsewhere (old track not seen this frame) and its label is clear → it keeps its role
        if (other && !used.has(other) && !this.settings.oneHandDraws && Math.abs(tr.vote) > 0.7 && roleOf(tr.vote) === other.role) { tr.role = other.role; this.tracks = this.tracks.filter(x => x !== other); }
        else if (other) { tr.role = other.role === 'dom' ? 'sup' : 'dom'; tr.forced = false; }
        else if (this.settings.oneHandDraws || Math.abs(tr.vote) < 0.3) { tr.role = 'dom'; tr.forced = true; }
        else { tr.role = roleOf(tr.vote); tr.forced = false; }
      }
      if (this.settings.oneHandDraws && !other && tr.role !== 'dom') { tr.role = 'dom'; tr.forced = true; }
    } else if (live.length >= 2) {
      const [a, b] = live;
      const byVotes = () => {
        let right;
        if (Math.abs(a.vote - b.vote) > 0.3) right = a.vote > b.vote ? a : b;
        else right = a.cx > b.cx ? a : b; // labels unclear → screen position (mirrored view)
        const left = right === a ? b : a;
        right.role = domSide === 'Right' ? 'dom' : 'sup'; left.role = right.role === 'dom' ? 'sup' : 'dom';
        a.forced = b.forced = false;
      };
      if (a.role && b.role && a.role !== b.role && !a.forced && !b.forced) {
        // locked: keep roles while both hands stay tracked
      } else if (a.role && !b.role || b.role && !a.role) {
        const known = a.role ? a : b, fresh = known === a ? b : a;
        const decisive = Math.abs(known.vote - fresh.vote) > 0.8 && Math.sign(known.vote) !== Math.sign(fresh.vote);
        if (known.forced && decisive) byVotes(); // single-hand guess was wrong → fix it now
        else { fresh.role = known.role === 'dom' ? 'sup' : 'dom'; known.forced = false; }
      } else byVotes();
    }
    // correction: only when the long-term label strongly contradicts the role (not single-frame flicker)
    const wrong = (tr) => tr.n > 8 && Math.abs(tr.vote) > 0.7 && roleOf(tr.vote) !== tr.role;
    if (live.length === 1 && !this.settings.oneHandDraws && wrong(live[0]) && !this.tracks.some(x => x !== live[0] && x.role === roleOf(live[0].vote))) live[0].role = roleOf(live[0].vote);
    if (live.length >= 2 && wrong(live[0]) && wrong(live[1])) { const r = live[0].role; live[0].role = live[1].role; live[1].role = r; }
    for (const d of list) if (d.track.role && !seen[d.track.role]) seen[d.track.role] = d;
  }

  setSmoothing(s) { // 0..1, higher = smoother
    this.settings.smooth = s;
    const mc = 4.5 - s * 3.0, beta = 0.08 - s * 0.05; // light: the pen stabilizer does the rest
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
        let side = hd ? hd.categoryName : 'Right'; // matches the user's own hand when sitting in front of a laptop camera
        if (this.settings.swap) side = side === 'Left' ? 'Right' : 'Left';
        list.push({ lm, side, score: hd ? hd.score : 0, cx: 1 - lm[9].x, cy: lm[9].y });
      }
    }
    this.handCount = list.length;
    this._assignRoles(list, t, seen);

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
      if (h.trackId !== s.track.id) { // role moved to another physical hand → start clean
        if (h.pinch) h.edges.pinchEnd = true;
        h.pinch = false; h.present = false; h.pose = 'NONE'; h.rawPose = 'NONE';
        h.fx.reset(); h.fy.reset(); h.fs.reset(); h.fr.reset(); h.trackId = s.track.id;
      }
      const wasPresent = h.present;
      h.present = true; h.lastSeen = t; h.lm = s.lm; h.side = s.track.vote >= 0 ? 'Right' : 'Left'; h.score = Math.min(1, Math.abs(s.track.vote));
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
      h.rx = nx; h.ry = ny; // raw (unfiltered) position
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
      if (sp === 'ROCK') want.mode = true; // undo/redo are buttons only (no fist/thumb gestures)
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
          }
        }
      } else delete this.holds[key];
    }
    return { dom: D, sup: S, events, combo, holds: this.holds, count: this.handCount };
  }
}
function two_same(a, b) { return a === b; }

export const HAND_CONNECTIONS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
