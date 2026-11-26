// Camera + MediaPipe Hand Landmarker wrapper (all assets loaded locally).
import { FilesetResolver, HandLandmarker } from '../lib/mediapipe/vision_bundle.mjs';

const WASM_PATH = new URL('../lib/mediapipe/wasm', import.meta.url).href;
const MODEL_PATH = new URL('../models/hand_landmarker.task', import.meta.url).href;

const QUALITY = { eco: 20, balanced: 30, high: 60 };

export class HandTracker {
  constructor(video, { onStatus, onResults }) {
    this.video = video;
    this.onStatus = onStatus || (() => {});
    this.onResults = onResults || (() => {});
    this.landmarker = null;
    this.stream = null;
    this.running = false;
    this.delegate = 'GPU';
    this.maxFps = 30;
    this.lastDetect = 0;
    this.lastVideoTime = -1;
    this.inferMs = 0;
    this.fps = 0;
    this._fpsCount = 0; this._fpsT = performance.now();
    this._loop = this._loop.bind(this);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.video.pause(); else if (this.running) this.video.play().catch(() => {});
    });
  }

  setQuality(q) { this.maxFps = QUALITY[q] || 30; }

  loadModel(delegate = 'GPU') {
    this._loading = this._load(delegate).finally(() => { this._loading = null; });
    return this._loading;
  }
  async _load(delegate) {
    this.onStatus('model', 'busy', 'Loading model…');
    const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
    const make = (d) => HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_PATH, delegate: d },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    if (this.landmarker) { try { this.landmarker.close(); } catch {} this.landmarker = null; }
    try {
      this.landmarker = await make(delegate);
      this.delegate = delegate;
    } catch (e) {
      if (delegate === 'GPU') {
        console.warn('GPU delegate failed, falling back to CPU', e);
        this.landmarker = await make('CPU');
        this.delegate = 'CPU';
      } else throw e;
    }
    this.onStatus('model', 'ok', `Model · ${this.delegate}`);
  }

  async start() {
    if (this._loading) await this._loading;
    if (!this.landmarker) await this.loadModel(this.delegate);
    this.onStatus('cam', 'busy', 'Camera…');
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 60 }, facingMode: 'user' },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.running = true;
    this.onStatus('cam', 'ok', 'Camera on');
    this._schedule();
  }

  stop() {
    this.running = false;
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.onStatus('cam', '', 'Camera off');
    this.onResults(null);
  }

  _schedule() {
    if (!this.running) return;
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) this.video.requestVideoFrameCallback(this._loop);
    else requestAnimationFrame(this._loop);
  }

  _loop() {
    if (!this.running) return;
    const now = performance.now();
    const v = this.video;
    if (v.readyState >= 2 && v.currentTime !== this.lastVideoTime && now - this.lastDetect >= 1000 / this.maxFps - 2) {
      this.lastVideoTime = v.currentTime;
      this.lastDetect = now;
      const t0 = performance.now();
      let res = null;
      try { res = this.landmarker.detectForVideo(v, now); } catch (e) { console.error(e); }
      const dt = performance.now() - t0;
      this.inferMs = this.inferMs * 0.9 + dt * 0.1;
      this._fpsCount++;
      if (now - this._fpsT > 1000) { this.fps = this._fpsCount * 1000 / (now - this._fpsT); this._fpsCount = 0; this._fpsT = now; }
      if (res) this.onResults(res, now);
    }
    this._schedule();
  }

  // average brightness 0..255 (cheap, sampled on a tiny canvas)
  brightness() {
    if (!this.running || this.video.readyState < 2) return null;
    if (!this._bc) { this._bc = document.createElement('canvas'); this._bc.width = 32; this._bc.height = 24; this._bx = this._bc.getContext('2d', { willReadFrequently: true }); }
    this._bx.drawImage(this.video, 0, 0, 32, 24);
    const d = this._bx.getImageData(0, 0, 32, 24).data;
    let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
    return s / (d.length / 4);
  }
}
