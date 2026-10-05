import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createPhalanx, MOUNT_SURFACE_Y } from './model.js';
import { createEnvironment } from './environment.js';
import { createFiringEffects, FIRING_VISUALS } from './effects.js';
import { MOTION } from './motion.js';
import { createCodeEditor } from './code-editor.js';
import { createDroneSwarm } from './drones.js';
import { createRadar } from './radar.js';
import { createSceneAudio } from './audio.js';
import { createCameraViews } from './camera-views.js';
import { createFullscreenView } from './fullscreen-view.js';
import { createSoundToggle } from './sound-toggle.js';
import {
  setAzimuth, setElevation, getCurrentAzimuth, getCurrentElevation, fire,
  advanceMotion, getSceneState, stopFiring,
} from './api.js';

const DEG = Math.PI / 180;

function showError(error) {
  console.error('Phalanx viewer:', error);
  const status = document.getElementById('script-status');
  if (status) {
    status.textContent = `The scene could not start: ${error?.message || String(error)}`;
    status.classList.add('script-error');
  }
}

async function start() {
  const viewport = document.getElementById('viewport');
  const compassArrow = document.getElementById('compass-arrow');
  const compact = () => window.matchMedia('(max-width: 900px)').matches;
  let disposed = false;
  let frameId;
  let sceneGui;
  let codeEditor;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, compact() ? 1.5 : 1.8));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  viewport.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('aria-hidden', 'true');

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.08, FIRING_VISUALS.cameraFar);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.065;
  controls.minDistance = 1.9;
  controls.maxDistance = 240;
  controls.maxPolarAngle = Math.PI * 0.485;
  controls.minPolarAngle = 0.06;
  controls.panSpeed = 0.6;
  controls.rotateSpeed = 0.65;
  controls.zoomSpeed = 0.7;
  controls.autoRotateSpeed = 0.55;
  controls.target.set(0, 1.95 + MOUNT_SURFACE_Y, 0.4);

  const environment = createEnvironment(scene, renderer, { mountSurfaceY: MOUNT_SURFACE_Y });
  const model = createPhalanx();
  scene.add(model.root);
  model.azimuth.rotation.y = getCurrentAzimuth();
  model.elevation.rotation.x = -getCurrentElevation();
  const axes = new THREE.AxesHelper(0.7);
  axes.name = 'Fixed rotation axes origin';
  axes.material.depthTest = false;
  axes.material.toneMapped = false;
  axes.renderOrder = 6;
  scene.add(axes);
  const sound = createSceneAudio();
  const drones = createDroneSwarm(scene, {
    groundY: MOUNT_SURFACE_Y, onExplosion: sound.playExplosion, onClear: sound.clearDrones,
  });
  const effects = createFiringEffects(scene, model.muzzle, { onShot: (origin, direction) => drones.fireRay(origin, direction) });
  const radar = createRadar();
  radar.update(0, getCurrentAzimuth(), drones.getRadarData(), drones.getState());

  function stopInput() {
    stopFiring();
    effects.setEnabled(false);
    sound.stopFiring();
  }

  // Keep the original free-view framing and its independent orbit controls.
  camera.position.set(7.1, 4.7 + MOUNT_SURFACE_Y, 8.8);
  controls.target.set(0, 1.95 + MOUNT_SURFACE_Y, 0.5);
  controls.update();
  const cameraViews = createCameraViews({
    freeCamera: camera, controls, opticalSensor: model.opticalSensor,
    tabs: document.getElementById('camera-view-tabs'),
    status: document.getElementById('camera-view-status'), viewport,
  });
  const fullscreenView = createFullscreenView(viewport.parentElement, document.getElementById('toggle-fullscreen'));
  const soundToggle = createSoundToggle(document.getElementById('toggle-sound'), sound);

  function resize() {
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);
    renderer.setSize(width, height, false);
    cameraViews.resize(width / height);
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(viewport);
  resize();

  const compassDirection = new THREE.Vector3();
  function updateCompass() {
    cameraViews.getCamera().getWorldDirection(compassDirection);
    // A vertical drone view has no horizontal bearing; keep the last heading.
    if (Math.hypot(compassDirection.x, compassDirection.z) < 0.001) return;
    const cameraBearing = Math.atan2(compassDirection.x, compassDirection.z) / DEG;
    compassArrow.setAttribute('transform', `rotate(${-cameraBearing} 26 26)`);
  }
  updateCompass();

  window.phalanx = Object.freeze({
    setAzimuth, setElevation, getCurrentAzimuth, getCurrentElevation, fire,
    model, scene,
    get camera() { return cameraViews.getCamera(); },
    sound: Object.freeze({ setEnabled: sound.setEnabled, setVolume: sound.setVolume, getState: sound.getState }),
    getState: getSceneState,
    getStats: () => ({ ...model.getStats(), drawCalls: renderer.info.render.calls, renderedTriangles: renderer.info.render.triangles }),
  });

  const onBlur = () => { stopInput(); sound.setPaused(true); };
  const onFocus = () => { if (!document.hidden) sound.setPaused(false); };
  window.addEventListener('blur', onBlur);
  window.addEventListener('focus', onFocus);
  const onVisibilityChange = () => {
    if (document.hidden) stopInput();
    sound.setPaused(document.hidden || !document.hasFocus());
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  function dispose() {
    if (disposed) return;
    stopInput();
    disposed = true;
    cancelAnimationFrame(frameId);
    resizeObserver.disconnect();
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
    sceneGui?.destroy();
    codeEditor?.destroy();
    fullscreenView.destroy();
    soundToggle.destroy();
    cameraViews.destroy();
    scene.remove(axes);
    axes.dispose();
    effects.dispose();
    drones.dispose();
    sound.dispose();
    radar.destroy();
    environment.dispose();
    controls.dispose();
    renderer.dispose();
  }
  function onPageHide(event) {
    stopInput();
    sound.setPaused(true);
    // Preserve the renderer for pages restored through the back/forward cache.
    if (!event.persisted) dispose();
  }
  window.addEventListener('pagehide', onPageHide);
  const onPageShow = () => { if (!document.hidden && document.hasFocus()) sound.setPaused(false); };
  window.addEventListener('pageshow', onPageShow);
  renderer.domElement.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    dispose();
    showError(new Error('WebGL context lost'));
  });

  // Keep shader compilation and rendering behavior from the original viewer.
  scene.updateMatrixWorld(true);
  if (renderer.compileAsync) {
    try { await renderer.compileAsync(scene, camera); } catch { renderer.compile(scene, camera); }
  } else renderer.compile(scene, camera);
  if (disposed) return;
  cameraViews.update(0, drones.getRadarData());
  updateCompass();
  renderer.render(scene, cameraViews.getCamera());

  const { createSceneGui } = await import('./scene-gui.js');
  if (disposed) return;
  sceneGui = createSceneGui({ drones, includeGunControls: import.meta.env.DEV });
  if (disposed) return;

  codeEditor = createCodeEditor({
    api: { setAzimuth, setElevation, getCurrentAzimuth, getCurrentElevation, fire },
    onStart: sceneGui.spawnSwarm,
    onStop: stopInput,
  });

  let lastTime = performance.now();
  function animate(now) {
    if (disposed) return;
    frameId = requestAnimationFrame(animate);
    const dt = Math.min((now - lastTime) / 1000, .05);
    lastTime = now;
    if (document.hidden) return;
    // Send the frame to the sandbox without blocking rendering.
    codeEditor.tick(dt, drones.getRadarData());
    const state = advanceMotion(dt);
    model.azimuth.rotation.y = state.azimuth * DEG;
    model.elevation.rotation.x = -state.elevation * DEG;
    model.barrels.rotation.z = (model.barrels.rotation.z + MOTION.barrelAngularSpeed * state.drive * dt) % (Math.PI * 2);
    drones.update(dt);
    effects.setEnabled(state.firing);
    effects.update(dt, state.elapsed, state.drive);
    environment.update(dt, state.elapsed);
    const radarData = drones.getRadarData();
    sound.update({ firing: state.firing, drive: state.drive, deltaTime: dt, radarData });
    soundToggle.sync();
    radar.update(dt, state.azimuth * DEG, radarData, drones.getState());

    scene.updateMatrixWorld();
    cameraViews.update(dt, radarData);
    updateCompass();
    sceneGui.sync();
    renderer.render(scene, cameraViews.getCamera());
  }
  frameId = requestAnimationFrame(animate);

  if (import.meta.hot) import.meta.hot.dispose(dispose);
}

start().catch(showError);
