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

**Shapes:** line, rect, ellipse, **polygon (3–20 sides)**, arrow, and a star whose point count is set by *Sides*. Twist the control hand while drawing a shape to rotate it.

**Edit & snap (2D):** Selected objects show an orange rotate handle above the box: pinch and drag it to rotate (15° steps with Snap). Control-hand pinch + twist rotates an object while you hold it. ✋ Select tool: pinch an object to move it, pinch a corner square to resize it, or pinch the control hand up/down to scale it. Copy and Delete buttons are included. 🧲 Snap locks shapes, straight lines and moved objects to the grid, to corners and ends of other objects, and to 15° angles.

**Projects:** 💾 Save writes a `.aircanvas.json` that holds both the 2D and 3D work. 📂 Open reloads it so you can keep editing. Autosave to browser storage restores your last session.

**Feedback:** status pills for camera, model (GPU/CPU), hand count and fps/latency. The live skeleton preview labels hands DRAW and CTRL. Per-hand cards show the pose, pinch strength, confidence and current action. Hold-progress rings, dwell rings, and hints cover no hand, too close, too far and low light.

## Tutorial

On first launch an interactive tutorial opens. Reopen it any time with 🎓 Tutorial. Each step watches your hands and moves on only when you've done the gesture: draw hand, both hands, pointing at targets, pinch drawing, pen up/down, air-click, colour, size, tool, palm eraser and two-hand shape. If your camera reports left and right reversed, it fixes that automatically. Your drawing is saved before the tutorial and restored after.

## Activation gate (start / pause)

Hands are locked 🔒 until their cursor passes through the dashed **✋ zone** in the top bar. A locked hand can't draw, erase, click or change anything. That stops accidental actions when you rest, scratch, pick up your phone, or someone else walks into view. A hand stays active while it is tracked. Move an active hand back into the zone, or hold ✌️ with the draw hand, to **pause**. You can turn this off in ⚙.

Clicking buttons needs a pinch by default. The button under the cursor gets a yellow outline, and the click goes to the button you were resting on just before you pinched. Hover-to-click (dwell) can be switched on in ⚙. **🖱 Pointer mode** (toolbar button, or hold 🤟 with the draw hand) lets you browse buttons without ever drawing.

## Gestures

**Undo / Redo are buttons only.** Point at them or pinch on them, so nothing is undone by accident.

The draw hand is your dominant hand, set in ⚙. Each hand is tracked by position and keeps its role while both stay in view, so the hands can't swap mid-gesture. If only the control hand is visible it doesn't draw, unless you turn on *One visible hand always draws* in ⚙.

| Draw hand | Action |
|---|---|
| ☝️ Point | Cursor. Hover a button ~0.8 s to click it (air-click) |
| 🤏 Pinch | Draw, place or grab. Pinching over a button clicks it |
| ✋ Open palm | 2D palm eraser |
| ✊ Fist | Pen up |
| ✌️ hold | Pause (hands become inactive) |
| 🤟 hold | Pointer mode on/off |

| Control hand | Action |
|---|---|
| ✊ fist + move | 2D: move the paper (pan) when zoomed in |
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

Zoom: − / % / + buttons under Undo/Redo, or the mouse wheel on the canvas (% resets to fit).

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
