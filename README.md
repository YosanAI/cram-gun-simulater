# Phalanx — Interactive CIWS

A detailed, procedural **Three.js exterior recreation of the Phalanx Mk 15 Block 1B** with independently articulated azimuth, elevation, and barrel rotation. The browser displays the naval deck and ocean scene with a camera compass and a JavaScript controller editor. A small development-only dat.gui panel also exercises the scene API.

## Run locally

Install Node.js **20.19+ or 22.12+** and npm, then install the dependencies and start the Vite development server:

```bash
npm install
npm run dev
```

Then open the URL printed by Vite (usually `http://localhost:5173`) in a browser with WebGL 2 and hardware acceleration enabled. Vite serves the JavaScript modules and reloads the page when you edit the source files.

Available commands:

| Command | Purpose |
| --- | --- |
| `npm run dev` / `npm start` | Start the Vite development server |
| `npm run build` | Create the production website in `dist/` |
| `npm run preview` | Serve the production build locally after building |
| `npm run check` | Check the application JavaScript syntax |
| `npm test` | Verify the angle API, firing lifecycle, and script runner |

Three.js is installed through npm and pinned to **0.180.0**. Vite resolves its imports during development and bundles it for production. All model geometry, material labels, environment textures, and firing effects are generated locally.

## Controls

Drag the scene to orbit, scroll or pinch to zoom, and right-drag or use two fingers to pan. The compass follows the camera orientation.

Under `npm run dev`, dat.gui provides only **Azimuth (rad)**, **Altitude (rad)**, and **Fire**. Both sliders call the public setters, and the button calls `fire()`. While you are not dragging or editing, the panel reads the public getters to show the current animated angles, including changes commanded from other code. The production build includes the scene, compass, and code editor; dat.gui remains development-only.

## Code editor and simulation

The CodeMirror editor starts with:

```js
function updateGun(elapsedTime, deltaTime) {

}
```

Write your controller and click **Run** (or press **Ctrl/Cmd + Enter** in the editor). The same button changes to **Stop** as soon as the sandbox starts, and returns to **Run** after stopping or an error. The code compiles once inside an isolated QuickJS VM in a Web Worker. Each visible animation frame sends an update when the worker is ready; successful API commands return to the scene asynchronously. Click **Stop**, press **Ctrl/Cmd + Enter** again, or press **Escape** in the editor to terminate the worker, discard pending commands, and cancel firing. The scene continues rendering normally.

Drag the editor's **top-right resize handle** to change its width and height. You can also focus the handle and use the arrow keys; hold **Shift** for larger steps. Sizes stay within the viewport and leave room for the compass. The header's chevron collapses or expands the editor while preserving its code and size. Run/Stop stays visible when collapsed, and collapsing does not stop a running script. Script errors automatically expand the editor to show the message.

`elapsedTime` is elapsed simulation time in **seconds**, starting at **0** on the first callback of each run. `deltaTime` is the simulation time since the previous callback. The scene retains its maximum timestep of **0.05 seconds**; if the worker is still busy, subsequent frames accumulate into the next callback's `deltaTime` instead of queueing work. The simulation clock pauses while the tab is hidden. Each new run resets the clock and variables declared in the editor; it keeps the gun's current pose. Editing while running applies to the next run after stopping.

The five gun API functions are available directly inside the code, with no imports or `window.phalanx` prefix. Angles are in **radians**. For example:

```js
let nextShot = 0;

function updateGun(elapsedTime, deltaTime) {
  setAzimuth(elapsedTime * 0.4);
  setAltitude(Math.PI / 6 + Math.sin(elapsedTime) * 0.1);

  if (elapsedTime >= nextShot) {
    fire();
    nextShot = elapsedTime + 1.5;
  }
}
```

Variables outside `updateGun` persist between frames within a run. Syntax errors, missing callbacks, thrown values, and runtime errors appear below the editor, with source line information when available. Errors stop the worker without stopping the scene. `updateGun` must be synchronous. Calling `fire()` on every update keeps extending the burst until the simulation is stopped.

The VM exposes only the five gun functions and standard JavaScript built-ins. It cannot access the page, browser storage, networking, timers, worker messaging, or the app's objects. Getters read a snapshot of the current scene angles at the start of each callback. Commands are validated and applied only after a callback succeeds; commands from a failed or stopped callback are discarded.

Each script has a **32 MiB guest heap**, a **256 KiB stack**, and a **200 ms execution limit** during compilation and each callback. An independent watchdog terminates an unresponsive worker. Source is limited to **64K characters**, with at most **128 gun commands per callback**. Infinite loops, memory exhaustion, and worker failures are reported in the editor. These limits protect the interactive scene; execution remains entirely local.

## Scene API

Import the five functions from `src/api.js`. For example, from another module in `src/`:

```js
import {
  setAzimuth,
  setAltitude,
  getCurrentAzimuth,
  getCurrentAltitude,
  fire,
} from './api.js';

setAzimuth(Math.PI / 2);
setAltitude(Math.PI / 6);
fire();

// Read these as the scene animates toward the commanded angles.
const azimuth = getCurrentAzimuth();
const altitude = getCurrentAltitude();
```

The same functions are available as `window.phalanx.setAzimuth(rad)`, `window.phalanx.setAltitude(rad)`, `window.phalanx.getCurrentAzimuth()`, `window.phalanx.getCurrentAltitude()`, and `window.phalanx.fire()` once the scene initializes.

All angles use **radians**. Azimuth commands wrap around the circle and retain the existing shortest-path smoothing. `getCurrentAzimuth()` returns the current animated bearing in `[0, 2π)`. Altitude means the barrel inclination above horizontal; it is clamped to the existing **−15° to +85°** range (approximately **−0.262 to +1.484 rad**), with an initial inclination of **10°**. The getters return the current animated pose, so they may differ from a newly commanded angle while the mount moves. Setters reject non-finite values and non-number inputs with `TypeError`.

`fire()` starts a **0.7-second visual burst** using the existing barrel spin, muzzle flash, smoke, and streak effects. Calling it again extends the burst to 0.7 seconds from the latest call. Losing focus or hiding the page cancels firing. Sound remains disabled.

## Model and rig

The origin is at the mounting surface. The world uses **Y up**, **+Z forward / zero bearing**, and **+X right / east**. The camera is independent of the turret, so dragging the view never changes the gun's azimuth or elevation.

The visual hierarchy is:

- Fixed mount at the deck surface.
- Azimuth group rotating about local Y, carrying the mounting fork.
- Elevation cradle rotating about local X, carrying the radome, gun housing, magazine, sensor, and barrel assembly.
- Barrel rotor rotating about local Z within the elevation cradle.

Increasing displayed elevation applies **negative X rotation**, raising the +Z-facing barrel cluster. The radome tips rearward with that assembly. The muzzle anchor is attached to the elevation cradle outside the spinning rotor, which keeps its local +Z firing direction stable while the barrels spin.

`createPhalanx()` exports the named scene graph, joint references, component anchors, wireframe switch, and model statistics:

```js
const model = createPhalanx();
scene.add(model.root);

model.azimuth.rotation.y = azimuthDegrees * Math.PI / 180;
model.elevation.rotation.x = -elevationDegrees * Math.PI / 180;
model.barrels.rotation.z += spinRadians;
```

The modeled features include the tall pale radome, tracking enclosure, side optical sensor with lens surfaces, six separate barrel tubes with dark openings, external barrel brace, muzzle restraint, receiver details, transverse magazine, trunnion discs, rotating bearings, support ribs, conduits, fasteners, service access panels, handles, and decals. Repeated details are batched per material and joint so that the articulated exterior remains reasonably light to render.

## Project organization

| File | Responsibility |
| --- | --- |
| `index.html` | Scene, compass, code-editor panel, and Vite entry point |
| `styles.css` | Scene, compass, and editor layout |
| `src/main.js` | Existing scene setup, orbit controls, compass, lifecycle, and render loop |
| `src/api.js` | Radian angle commands, current-angle getters, and visual burst control |
| `src/debug-gui.js` | Development-only dat.gui controls calling the public API |
| `src/code-editor.js` | CodeMirror JavaScript editor, API completion, Run/Stop toggle, and error status |
| `src/editor-panel.js` | Pointer/keyboard resizing, collapse/expand behavior, and compass spacing |
| `src/simulation.js` | Worker lifecycle, frame scheduling, validated API bridge, and watchdogs |
| `src/gun-sandbox.js` | Isolated QuickJS VM, guest APIs, execution/memory limits, and source errors |
| `src/sandbox.worker.js` / `src/sandbox-worker-host.js` | Worker-side VM initialization and request handling |
| `src/sandbox-limits.js` | Resource limits, command validation, and bounded error messages |
| `vite.config.js` | Module-worker bundling and local WebAssembly assets |
| `src/model.js` | Procedural model, materials, exterior details, component anchors, and joint hierarchy |
| `src/motion.js` | Viewer limits, angle wrapping, and frame-rate-independent motion smoothing |
| `src/environment.js` | Deck, studio, ocean, generated surface textures, lighting, and environment reflections |
| `src/effects.js` | Cosmetic flash, smoke, light streaks, and optional synthesized sound |
| `tests/api.test.js` | API behavior and lifecycle tests using Node's built-in test runner |
| `tests/simulation.test.js` | Actual worker execution, API integration, error recovery, isolation, and resource limits |
| `public/three-LICENSE.txt` | Three.js MIT license, copied into the production build |
| `package.json` / `package-lock.json` | npm scripts and reproducible dependency versions |
| `dist/` | Generated production output; run `npm run build` to create it |

The app also retains `window.phalanx.getState()` and `window.phalanx.getStats()` for inspection in browser developer tools, plus references to the model, scene, and camera. The model geometry, environment, effects, and original motion module are unchanged.

## Scope and accuracy

This is an **exterior visual replica**, not a measured or verified engineering digital twin. Forms and proportions are interpreted from public references. It has no live connection to a real machine. Internal mechanisms, sensor behavior, and firing physics are not modeled. Smoke and streaks are visual effects; the audio is synthesized. The movement range and timing are selected for comfortable viewing and are not specifications for the real equipment.

The API angle limits and burst timing are viewer controls and are not specifications for the real equipment.

## Public references

- [RTX / Raytheon — Phalanx Weapon System](https://www.rtx.com/raytheon/what-we-do/sea/phalanx-close-in-weapon-system): manufacturer overview and credited U.S. Navy exterior imagery.
- [General Dynamics OTS — Phalanx brochure](https://www.gd-ots.com/wp-content/uploads/2024/03/400002644-PHALANX-Close-In-Weapon-System-CIWS-Product-Brochure-2024-03-V02-1.pdf): exterior variant references, including Block 1B barrel brace, muzzle restraint, and sensor additions.
- [U.S. Navy — USS Gridley, February 17, 2022](https://www.navy.mil/Resources/Photo-Gallery/igphoto/2002942051/): official exterior photograph, image 220217-N-JO829-1899.

The app contains original procedural geometry and original effects. No external photographs or third-party 3D assets are embedded. Three.js is distributed under its included MIT license.

## Verification

Run `npm run check`, `npm test`, and `npm run build` to verify syntax, API behavior, sandbox execution, and production bundling. Tests use real worker threads and the same QuickJS engine to verify frame timing, stopping, restarts, error lines, discarded commands, infinite-loop interruption, guest memory limits, unavailable host globals, stale responses, validated command batches, and watchdog termination. Interactive browser QA requires a browser with WebGL 2 and hardware acceleration.
