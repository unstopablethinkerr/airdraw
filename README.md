# AirCanvas: two-hand gesture drawing (2D + 3D)

You draw in the air with your webcam. Hand tracking runs fully in the browser through MediaPipe Hand Landmarker, and 3D uses Three.js. **Every library and the model are bundled here**, so the app needs no CDN and no internet at runtime.

## Run it

Browsers block the camera and ES modules on `file://`, so you need a local server or a host:

- **Windows:** double-click `start-windows.bat`
- **Mac/Linux:** `./start-mac-linux.sh`
- Or run `python -m http.server 8080` in this folder, then open http://localhost:8080
- **Netlify / GitHub Pages / Vercel:** deploy the folder as-is. These hosts use https, which the camera requires.

Click **▶ Start camera** and allow camera access.

## Features

**2D:** pen, speed-sensitive brush, marker, calligraphy, neon, rainbow, gradient (colour A→B), spray and eraser. Shapes: line, rect, ellipse, triangle, arrow and star, outlined or filled. A filled shape with two different colours gets a gradient fill. Layouts: white, dark, grid, dots, lined, blueprint, transparent and camera AR. Symmetry: mirror, 4-way, radial 6 and radial 8. Export: PNG, JPG and SVG (vector).

**3D:** tube strokes, ribbons, cube, sphere, cylinder, cone and torus. Select lets you move, rotate and scale objects by gesture or with the mouse gizmo. Delete, duplicate and recolour. Mirror-X symmetric sculpting. Materials: standard, glossy, metal, toon, wireframe and normals. View presets and auto-rotate. Export: **STL**, GLB, OBJ, and a PNG of the view.

**Projects:** 💾 Save writes a `.aircanvas.json` that holds both the 2D and 3D work. 📂 Open reloads it so you can keep editing. Autosave to browser storage restores your last session.

**Feedback:** status pills for camera, model (GPU/CPU), hand count and fps/latency. The live skeleton preview labels hands DRAW and CTRL. Per-hand cards show the pose, pinch strength, confidence and current action. Hold-progress rings, dwell rings, and hints cover no hand, too close, too far and low light.

## Tutorial

On first launch an interactive tutorial opens. Reopen it any time with 🎓 Tutorial. Each step watches your hands and moves on only when you've done the gesture: draw hand, both hands, pointing at targets, pinch drawing, pen up/down, air-click, colour, size, tool, palm eraser and two-hand shape. If your camera reports left and right reversed, it fixes that automatically. Your drawing is saved before the tutorial and restored after.

## Gestures

**Undo / Redo are buttons only.** Point at them or pinch on them, so nothing is undone by accident.

The draw hand is your dominant hand, set in ⚙. Each hand is tracked by position and keeps its role while both stay in view, so the hands can't swap mid-gesture. If only the control hand is visible it doesn't draw, unless you turn on *One visible hand always draws* in ⚙.

| Draw hand | Action |
|---|---|
| ☝️ Point | Cursor. Hover a button ~0.8 s to click it (air-click) |
| 🤏 Pinch | Draw, place or grab. Pinching over a button clicks it |
| ✋ Open palm | 2D palm eraser |
| ✊ Fist | Pen up |

| Control hand | Action |
|---|---|
| ✌️ | Next colour |
| 🤟 three fingers | Next tool |
| 🤏 + move up/down | 2D brush size · 3D depth plane, or scale the selected object |
| 🤘 hold | Switch 2D ⇄ 3D |

| Both hands | Action |
|---|---|
| 🤏 + 🤏 | 2D: shape stretched between the hands · 3D: orbit + zoom |
| 🤏 grab + 🤏 control | 3D Select: rotate the held object (move, tilt, twist the control hand) |
| draw + ✋ control open | 2D straight line (ruler) |
| 👍 + 👍 hold | Download (2D PNG · 3D STL) |
| ✌️ + ✌️ hold | Save project file |
| ✋ + ✋ hold 1.5 s | Clear (undo restores) |

Keyboard: Ctrl+Z / Ctrl+Y, Ctrl+S to save, `[` `]` for brush size, Delete removes the selected 3D object, Esc. The mouse and touch also work.

## Performance notes

- Detection is capped at 20, 30 or max fps (⚙ Tracking quality) and runs once per new video frame. Inference uses the GPU and falls back to CPU automatically.
- 3D renders only when something changes. Live strokes rebuild at about 20 Hz.
- 2D strokes are vectors: each finished stroke is drawn once to a cached layer, and only the active stroke redraws.
- Tracking pauses while the tab is hidden.
- A One Euro filter, pinch hysteresis, 2-frame pinch confirmation and tail trimming remove jitter and accidental dots.

## 3D depth

A webcam can't measure depth, so depth comes from hand size. Push your hand toward the camera to bring the stroke closer, and pull it back to send it farther. The control-hand pinch moves the whole drawing plane. Watch the depth bar and the dashed drop-line to the grid. Change the sensitivity with *Depth range*.

## Structure

```
index.html            UI
css/app.css
js/main.js            app controller: gesture → action, feedback, files
js/tracker.js         camera + MediaPipe (local wasm + model)
js/gestures.js        filters, pose classifier, two-hand combos, holds
js/draw2d.js          2D vector engine and exports
js/draw3d.js          3D engine and STL/GLB/OBJ export
lib/mediapipe/        @mediapipe/tasks-vision 1.2.3 (Apache-2.0)
lib/three/            three.js r187 + addons (MIT)
models/hand_landmarker.task   MediaPipe hand model, float16 v1 (Apache-2.0)
```

To use the official model copy instead, download it from
https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
into `models/`.
