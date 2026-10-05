# Phalanx — Interactive CIWS

A detailed, procedural **Three.js exterior recreation of the Phalanx Mk 15 Block 1B** with independently articulated azimuth, elevation, and barrel rotation. The browser displays the naval deck and ocean scene with a camera compass, a JavaScript controller editor, configurable incoming drone swarms, a live radar widget, and sampled sound effects. A dat.gui panel controls sound and drone spawning in every build and also exercises the gun API during development.

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
| `npm test` | Verify the angle API, script sandbox, drone flights, impacts, audio behavior, and resource cleanup |

Three.js is installed through npm and pinned to **0.180.0**. Vite resolves its imports during development and bundles it for production. All model geometry, material labels, environment textures, and firing effects are generated locally.

## Controls

Drag the scene to orbit, scroll or pinch to zoom, and right-drag or use two fingers to pan. The compass follows the camera orientation.

The top-right dat.gui panel includes **Drone swarm** controls in development and production. Under `npm run dev`, an additional **Gun API testing** folder provides **Azimuth (rad)**, **Elevation (rad)**, and **Fire**. Both sliders call the public setters, and the button calls `fire()`. While you are not dragging or editing, the panel reads the public getters to show the current animated angles, including changes commanded from other code. The controls scroll on small screens and can be collapsed from the top.

## Drone swarms

Click **Spawn swarm** to queue drones using the current settings:

- **Swarm size:** 1–200 drones per request, with at most 200 in flight or waiting to launch.
- **Spawn interval (s):** 0.1–10 seconds between launches. The initial drone launches immediately; subsequent drones appear one at a time. Additional requests join the existing schedule and respect the selected spacing, even if the previous request contained only one drone.
- **Near radius / Far radius:** minimum and maximum distance from the gun's origin, from 5–200 scene units. Equal values place drones at one exact distance. Adjusting either limit keeps the range ordered.
- **Random directions:** distributes the swarm across the hemisphere above the origin. Turn this off to choose **Azimuth (°)** from 0–360° and **Elevation (°)** from 0–90° above the horizon. Zero azimuth is +Z; 90° is +X, matching the gun coordinates.
- **Speed (units/s):** constant flight speed from 0.5–20 scene units per second.
- **Clear drones:** cancels pending launches, removes current flights and effects, and resets the kill and impact counters.

New requests add to the existing launch queue; settings are captured for each swarm. The default is 12 drones, 20–40 units away, with random directions, a speed of 4 units/s, and **0.8 seconds between launches**. The panel reports the number in flight, waiting to launch, killed by the gun, and total impacts on the mount. Exceeding capacity displays an error without partially queueing a swarm. Scheduling uses the scene's simulation clock, so hidden pages pause launches as well as flight.

The original procedural airframes use a Shahed-inspired delta wing, rounded fuselage, and twin wingtip fins, without propellers. They point along their flight path and fly straight toward the fixed gun origin. When a nose reaches the mount, the drone is removed and a large expanding fireball appears with a white-hot core, turbulent flame lobes, an expanding ground shockwave, sparks, stronger light, and rising smoke. Fireballs last about 1.2 seconds, while smoke fades over 5 seconds. Flights continue independently of the controller script. Airframes use two instanced meshes regardless of swarm size, and impact effects share a pool of at most 32 simultaneous bursts.

The scene system owns the swarm instance and its internal `queueSwarm(options)` command. The controls exercise that system directly; spawning is not exposed on `window.phalanx` or in the controller editor's five-function gun API.

### Gun hits and destruction

Gun hits use **hitscan ray–sphere intersection**. Each emitted firing streak triggers one shot from the muzzle's current world position along its local +Z axis transformed into world space. Detection uses the actual animated barrel pose after updating its ancestor transforms, so commanded angles do not score hits before the gun turns. Each live drone has a simplified sphere of **1.5 scene units** around its center. The nearest forward intersection within **250 scene units** destroys one drone; targets behind the muzzle, missed spheres, and queued drones are unaffected. The camera does not affect aiming.

The first shot appears as the firing effects start; subsequent shots follow the existing streak emission budget of up to **19 shots per simulation second**, scaled by barrel drive. These are illustrative gameplay settings. Hits are instantaneous; the visible streaks are cosmetic and do not model projectile flight, gravity, or travel time.

The muzzle effect combines a bright white core, orange glow, three turbulent flash jets, expanding pressure rings, and brief sparks with denser smoke. Tracers use thin camera-facing ribbons with a pale core and orange halo. They travel at **1,100 scene units/s** for **1.3 seconds** (about 1,430 units of travel), with a **0.08-unit halo width** and an **18-unit trail length**. Minimum screen dimensions are **3 px across the halo and 4 px along the streak**, and brightness is 80%. They stay bright for the first 75% of their lifetime, then fade. The first rendered segment covers its initial frame's travel so a fast shot does not skip the nearby view; segments crossing the camera are clipped before projection. Tracers still respect scene depth and the camera's field of view. The camera far plane is **6,000 units**, and the pool is limited to 80 tracers.

The speed approximates the order of magnitude of Phalanx ammunition: the [Army's 2025 ammunition reference](https://jpeoaa.army.mil/Portals/94/Documents/JPEOAAPortfolioBook_2025.pdf?ver=A_B_NzEETpCjNyGj93y_2g%3D%3D) lists 3,610 ft/s (about 1,100 m/s) for the Block 1B MK 244 round. Scene dimensions are approximate, and these remain cosmetic constant-speed tracers; hit detection is instantaneous hitscan.

A hit removes both airframe instances and the radar target immediately, bursts fire, sparks, a shockwave, and smoke at the drone's world position, and increments **killed** exactly once. A drone that reaches the mount instead increments **impacts**, without awarding a kill. The radar has a persistent kill counter, also repeated in the swarm controls. Clearing drones resets both counters and all effects.

## Sound

Sound is enabled by default at 65% volume. Click, tap, or press a key to activate browser audio. The **Sound** folder provides **Sound on**, **Volume (%)**, and an **Audio** status field. All samples are bundled locally; playback never contacts an external sound service. Sources and CC0 licenses are listed in [public/audio/CREDITS.txt](public/audio/CREDITS.txt).

- **Firing:** a real Phalanx recording, trimmed into a continuous burst loop that plays while the gun fires.
- **Drones:** a two-stroke engine recording approximates a small piston-engine drone. Each live drone has a desynchronized loop with slight pitch variation and Doppler adjustment.
- **Shot-down drones:** a shorter, sharper airburst plays at the destroyed target's position, and its engine stops immediately.
- **Unshot impacts:** a deeper, longer explosion with a metal crash layer plays when a drone reaches the gun. This uses the existing mount-impact event; drone flights still terminate at the gun origin.

The listener stays at the fixed gun origin, facing +Z. Moving the camera does not change sound volume or direction. Engine and explosion volume depend on 3D distance `d`, using `8 / (8 + 1.6 * Math.max(0, d - 8))`. Nearby sounds have full spatial gain; distant sounds are quieter and lose high frequencies. Left/right panning follows the target's position relative to the fixed origin. This is an illustrative sound mix rather than a calibrated acoustic simulation.

The mixer limits playback to the nearest 24 engine voices and 16 simultaneous explosions, with a shared compressor. **Clear drones** stops their engines and explosions. Stopping the controller cancels gun audio; losing focus or hiding the page silences and suspends all audio. Returning to the page resumes live engine sounds. Disposal stops sources, disconnects nodes, and closes the audio context. Browsers without available audio still run the visual scene.

For browser-console control, `window.phalanx.sound.setEnabled(boolean)`, `setVolume(0…1)`, and `getState()` are available. These controls are separate from the editor's gun API.

## Radar

The bottom-right radar shows live drone positions in a **north-up X/Z view**, centered on the fixed gun origin. +Z is north (top) and +X is east (right), independent of the camera. A white central arrow follows the gun's current animated azimuth. Green blips have short movement trails and brighten as the scan sweeps past them; nearby drones turn amber. Their positions update every visible scene frame, regardless of the scan angle.

The range starts at 50 scene units and expands in 25-unit steps to include more distant drones. It stays stable while a swarm is in flight or queued, then resets when the airspace is clear. Hover or touch a blip to show its ID, distance from the origin, and height; height is shown separately from the top-down position. Live and queued counts appear in the header. Blips disappear immediately on impact or Clear, and queued drones appear only when launched.

The radar uses its own lightweight 2D canvas and receives the same `radarData` snapshot format as the controller. It follows the scene's pause/lifecycle behavior. On smaller screens it shrinks and sits above the editor, with the compass alongside it and the swarm controls scrolling in the remaining space.

## Code editor and simulation

The CodeMirror editor starts with:

```js
function updateGun(elapsedTime, deltaTime, radarData) {

}
```

Write your controller and click **Run** (or press **Ctrl/Cmd + Enter** in the editor). The same button changes to **Stop** as soon as the sandbox starts, and returns to **Run** after stopping or an error. The code compiles once inside an isolated QuickJS VM in a Web Worker. Each visible animation frame sends an update when the worker is ready; successful API commands return to the scene asynchronously. Click **Stop**, press **Ctrl/Cmd + Enter** again, or press **Escape** in the editor to terminate the worker, discard pending commands, and cancel firing. The scene continues rendering normally.

Drag the editor's **top-right resize handle** to change its width and height. You can also focus the handle and use the arrow keys; hold **Shift** for larger steps. Sizes stay within the viewport and leave room for the compass. The header's chevron collapses or expands the editor while preserving its code and size. Run/Stop stays visible when collapsed, and collapsing does not stop a running script. Script errors automatically expand the editor to show the message.

`elapsedTime` is elapsed simulation time in **seconds**, starting at **0** on the first callback of each run. `deltaTime` is the simulation time since the previous callback. The scene retains its maximum timestep of **0.05 seconds**; if the worker is still busy, subsequent frames accumulate into the next callback's `deltaTime` instead of queueing work. The simulation clock pauses while the tab is hidden. Each new run resets the clock and variables declared in the editor; it keeps the gun's current pose. Editing while running applies to the next run after stopping.

The third parameter, `radarData`, is a fresh array of **live targets only**:

```js
[{ id: 1, pos: { x: 3, y: 4, z: 12 }, distance: 13 }]
```

`id` is a stable drone ID, `pos` is a plain object containing the target's world coordinates, and `distance` is the scalar 3D distance from the fixed intersection of the gun's azimuth and elevation axes in scene units (`Math.hypot(pos.x, pos.y, pos.z)`). The array is empty when no drones are in flight. Queued, killed, and impacted drones are omitted. A snapshot is captured when a frame is sent to the worker; slow callbacks receive the latest targets on their next frame. Data is copied into the isolated VM, so modifying the array or its positions in a script does not change live drones. Existing two-parameter controllers continue to work.

The five gun API functions are available directly inside the code, with no imports or `window.phalanx` prefix. Angles are in **radians**. For example:

```js
let nextShot = 0;

function updateGun(elapsedTime, deltaTime, radarData) {
  setAzimuth(elapsedTime * 0.4);
  setElevation(Math.PI / 6 + Math.sin(elapsedTime) * 0.1);

  if (elapsedTime >= nextShot) {
    fire();
    nextShot = elapsedTime + 1.5;
  }
}
```

Variables outside `updateGun` persist between frames within a run. Syntax errors, missing callbacks, thrown values, and runtime errors appear below the editor, with source line information when available. Errors stop the worker without stopping the scene. Calling `fire()` on every update keeps extending the burst until the simulation is stopped.

The editor provides normal JavaScript built-ins, including **Math**, JSON, Date, arrays, typed arrays, Maps, Sets, classes, helper functions, generators used as helpers, `eval`, and `Function`. **THREE** is the actual installed Three.js 0.180.0 core library, loaded into the VM's own heap. No imports are needed. You can use its vectors, matrices, quaternions, colors, rays, geometry, materials, meshes, local scenes, animation calculations, and other operations that work without browser resources. `performance.now()` is also available for timing calculations and Three.js clocks.

```js
const position = new THREE.Vector3();

function updateGun(elapsedTime, deltaTime, radarData) {
  if (!radarData.length) return;
  const { x, y, z } = radarData[0].pos;
  position.set(x, y, z);
  const bearing = Math.atan2(position.x, position.z);
  setAzimuth(bearing);
  if (elapsedTime === 0) {
    console.log("Distance:", position.length(), "Bearing:", THREE.MathUtils.radToDeg(bearing));
  }
}
```

`console.log`, `info`, `warn`, `error`, and `debug` forward text to the **browser developer tools Console**, prefixed with `[updateGun]`. Objects and arrays are JSON snapshots; circular references are marked `[Circular]`. `dir`, `table`, `assert`, `count`/`countReset`, `time`/`timeLog`/`timeEnd`, `trace`, and group methods also work. Tables and groups produce plain text, and `clear`/`groupEnd` are harmless no-ops. Logs emitted before a script error remain visible. Math, THREE, and console methods have editor completion.

Async helpers and `async function updateGun(...)` are supported when their Promises settle through local computations within the callback. The VM drains Promise jobs before applying commands, so commands after `await Promise.resolve(...)` work. Rejections discard the whole command batch. A Promise that never settles or needs an unavailable external operation stops the script with an error. The frame callback itself must be a normal or async function; generator helper functions are allowed.

The remaining access restrictions are:

| Restricted capability | Reason and scope |
| --- | --- |
| Page, DOM, navigation, browser storage, cookies, and live app objects | Scripts cannot alter the page, access private browser data, or bypass the gun API. Local THREE scenes and meshes do not modify the displayed scene. |
| Network and external modules | `fetch`, XMLHttpRequest, WebSocket, arbitrary imports, and script loading have no host bridge. Three.js URL/image loaders therefore cannot fetch assets. Core THREE is preloaded; addons and other npm libraries are not preloaded. |
| OS, filesystem, workers, and messaging | No Node globals, process execution, file access, Worker, importScripts, or postMessage are exposed. |
| Browser rendering and devices | There is no DOM canvas, GPU, audio, camera, microphone, or device access. THREE renderers and browser-dependent helpers cannot use those resources. |
| Timers and work that outlives a callback | Browser timers and animation-frame APIs are unavailable. Use `elapsedTime`/`deltaTime` to schedule controller actions. Local Promise computations are supported. |

These boundaries come from running inside QuickJS rather than deleting a few globals from the browser. Even `eval`, function constructors, and Three.js constructors stay inside that VM. Getters read the current scene angle snapshot; radar positions are copies. Commands are validated and applied only after a callback succeeds, and responses from a stopped worker are ignored.

To stop runaway CPU, memory, and output usage, each script has a **128 MiB guest heap**, a **1 MiB stack**, and a **500 ms execution limit** during compilation and each callback. Trusted library initialization gets up to **5 seconds**; startup has a **10-second watchdog**, and callback responses have a **2-second watchdog**. Source is limited to **256K characters**, with at most **1,024 gun commands** and **1,024 Promise jobs per callback**. Console output allows **64 entries per initialization/callback**, **200 entries per second**, **8,000 characters per entry**, and **32 arguments per call**; excess log entries are dropped without stopping gun commands. Infinite loops, memory exhaustion, unbounded Promise jobs, invalid commands, and worker failures appear as editor errors. Loading the full library increases worker download size and initialization time; it remains bundled locally with no runtime CDN dependency.

## Scene API

Import the five functions from `src/api.js`. For example, from another module in `src/`:

```js
import {
  setAzimuth,
  setElevation,
  getCurrentAzimuth,
  getCurrentElevation,
  fire,
} from './api.js';

setAzimuth(Math.PI / 2);
setElevation(Math.PI / 6);
fire();

// Read these as the scene animates toward the commanded angles.
const azimuth = getCurrentAzimuth();
const elevation = getCurrentElevation();
```

The same functions are available as `window.phalanx.setAzimuth(rad)`, `window.phalanx.setElevation(rad)`, `window.phalanx.getCurrentAzimuth()`, `window.phalanx.getCurrentElevation()`, and `window.phalanx.fire()` once the scene initializes.

All angles use **radians**. Azimuth commands wrap around the circle and retain the existing shortest-path smoothing. `getCurrentAzimuth()` returns the current animated bearing in `[0, 2π)`. Elevation means the barrel inclination above horizontal; it is clamped to the existing **−15° to +85°** range (approximately **−0.262 to +1.484 rad**), with an initial inclination of **10°**. The getters return the current animated pose, so they may differ from a newly commanded angle while the mount moves. Setters reject non-finite values and non-number inputs with `TypeError`.

`fire()` starts a **0.7-second burst** using barrel spin, muzzle flash, smoke, streak effects, and the firing sound, with gun hit detection on each emitted streak. Calling it again extends the burst to 0.7 seconds from the latest call. Losing focus or hiding the page cancels firing.

## Model and rig

The fixed scene origin `(0, 0, 0)` is the **intersection of the azimuth and elevation rotation axes**, marked by a small red/green/blue axis helper. The world uses **Y up**, **+Z forward / zero bearing**, and **+X right / east**. Geometry retains its deck-relative dimensions internally, while the model root, environment, and camera framing are translated down by 2.08 scene units. The mounting surface is now at `y = -2.08`.

The complete cannon assembly (receiver, magazine, barrel brace, rotor, and muzzle anchor) is raised **0.065 scene units** relative to the elevation cradle, canceling its previous downward offset. Both joint placements and the existing rotation behavior are preserved. The elevation axis still turns with azimuth, and both axes always cross at the fixed origin. The barrel assembly's extended centerline passes through that origin at every azimuth and elevation, including while the rotor spins. The barrel's rear face remains forward of the pivot; its center moves as the gun turns.

Drone spawning, flight destinations, radar positions, and scalar distances all use this same fixed origin. Gun angle conventions are unchanged, so a target's direction from the origin directly yields `Math.atan2(x, z)` for azimuth and `Math.atan2(y, Math.hypot(x, z))` for elevation. The camera is independent of the turret, so dragging the view never changes the gun's azimuth or elevation.

The visual hierarchy is:

- Fixed mount at the deck surface.
- Azimuth group rotating about local Y, carrying the mounting fork.
- Elevation cradle rotating about local X, carrying the radome, gun housing, magazine, sensor, and barrel assembly.
- Aligned cannon group inside the elevation cradle, raising the receiver, magazine, brace, rotor, and muzzle together without moving the joints.
- Barrel rotor rotating about local Z within the elevation cradle.

Increasing displayed elevation applies **negative X rotation**, raising the +Z-facing barrel cluster. The radome tips rearward with that assembly. The muzzle anchor is attached to the aligned cannon group outside the spinning rotor, which keeps its local +Z firing direction stable while the barrels spin. `model.origin` is a fixed inspection anchor on the model root at the axes' intersection.

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
| `src/api.js` | Radian angle commands, current-angle getters, and firing burst control |
| `src/scene-gui.js` | Sound and swarm controls, live counts, and development-only gun API controls |
| `src/drones.js` | Timed launches, instanced flights, radar snapshots, gun hit detection, destruction, and counters |
| `src/drone-model.js` | Original merged delta-wing airframe geometry and shared materials |
| `src/impact-effects.js` | Bounded pools of large fireballs, flame lobes, shockwaves, sparks, smoke, and light |
| `src/radar.js` | Read-only live radar, scan sweep, trails, automatic range, hover details, and canvas lifecycle |
| `src/code-editor.js` | CodeMirror JavaScript editor, API completion, Run/Stop toggle, and error status |
| `src/editor-panel.js` | Pointer/keyboard resizing, collapse/expand behavior, and compass spacing |
| `src/simulation.js` | Worker lifecycle, frame scheduling, validated API bridge, and watchdogs |
| `src/gun-sandbox.js` | Isolated QuickJS VM, guest APIs, execution/memory limits, and source errors |
| `src/sandbox-globals.js` | Guest console, timing, and local AbortController compatibility for Three.js |
| `src/sandbox.worker.js` / `src/sandbox-worker-host.js` | Worker-side VM initialization and request handling |
| `src/sandbox-limits.js` | Resource limits, command validation, and bounded error messages |
| `vite.config.js` | Module-worker bundling and local WebAssembly assets |
| `src/model.js` | Procedural model, materials, exterior details, component anchors, and joint hierarchy |
| `src/motion.js` | Viewer limits, angle wrapping, and frame-rate-independent motion smoothing |
| `src/environment.js` | Deck, studio, ocean, generated surface textures, lighting, and environment reflections |
| `src/effects.js` | Flash, smoke, light streaks, and per-shot hit callback |
| `src/audio.js` | Sample preparation, shared mixer, distance attenuation, engine voices, and classified explosions |
| `public/audio/` | Bundled CC0 sound recordings/effects and their source credits |
| `tests/api.test.js` | API behavior and lifecycle tests using Node's built-in test runner |
| `tests/simulation.test.js` | Actual worker execution, API integration, error recovery, isolation, and resource limits |
| `tests/drones.test.js` | Spawn bounds, launch/impact spacing, frame timing, queue cancellation, effects, and disposal |
| `tests/audio.test.js` | Audio activation, sample preparation, distance, event classification, voice limits, and cleanup |
| `tests/effects.test.js` | Tracer speed/lifetime, retained launch direction, bounded visual pools, and resource disposal |
| `public/three-LICENSE.txt` | Three.js MIT license, copied into the production build |
| `package.json` / `package-lock.json` | npm scripts and reproducible dependency versions |
| `dist/` | Generated production output; run `npm run build` to create it |

The app also retains `window.phalanx.getState()` and `window.phalanx.getStats()` for inspection in browser developer tools, plus references to the model, scene, and camera.

## Scope and accuracy

This is an **exterior visual replica**, not a measured or verified engineering digital twin. Forms and proportions are interpreted from public references. It has no live connection to a real machine. Internal mechanisms, sensor behavior, and physical ballistics are not modeled; gun hits use the simplified gameplay rules above. Smoke and streaks are visual effects. Gun audio uses a real recording; drone engines and explosions are sound-design approximations. The movement range and timing are selected for comfortable viewing and are not specifications for the real equipment.

The API angle limits and burst timing are viewer controls and are not specifications for the real equipment.

## Public references

- [RTX / Raytheon — Phalanx Weapon System](https://www.rtx.com/raytheon/what-we-do/sea/phalanx-close-in-weapon-system): manufacturer overview and credited U.S. Navy exterior imagery.
- [General Dynamics OTS — Phalanx brochure](https://www.gd-ots.com/wp-content/uploads/2024/03/400002644-PHALANX-Close-In-Weapon-System-CIWS-Product-Brochure-2024-03-V02-1.pdf): exterior variant references, including Block 1B barrel brace, muzzle restraint, and sensor additions.
- [U.S. Navy — USS Gridley, February 17, 2022](https://www.navy.mil/Resources/Photo-Gallery/igphoto/2002942051/): official exterior photograph, image 220217-N-JO829-1899.
- [U.S. Defense Intelligence Agency — Shahed-136 exterior drawing, hosted on Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Shahed-136_(Geran-2)_drawing_by_Defense_Intelligence_Agency.jpg): visual reference for the drone silhouette and wingtip fins; no reference image is embedded in the app.

The app contains original procedural geometry and original effects. No external photographs or third-party 3D assets are embedded. Three.js is distributed under its included MIT license.

## Verification

Run `npm run check`, `npm test`, and `npm run build` to verify syntax, API behavior, sandbox execution, drone spawning and flight, effect cleanup, and production bundling. Tests use real worker threads, QuickJS, and the installed Three.js source to verify vectors, geometry, scene objects, Math, console output, async calculations, frame timing, restarts, errors, discarded commands, CPU/memory/Promise/output limits, constructor isolation, stale responses, validated command batches, and watchdog termination. Drone tests cover hemisphere/radius bounds, fixed bearings, nose orientation, constant speed, launch and impact intervals, long/short frame consistency, appended queues, queue cancellation, whole-swarm rejection, large effect layers, pool limits, and disposal. Interactive browser QA requires a browser with WebGL 2 and hardware acceleration.
