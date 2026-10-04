import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createPhalanx } from './model.js';
import { createEnvironment } from './environment.js';
import { createFiringEffects } from './effects.js';
import { MOTION } from './motion.js';
import { createCodeEditor } from './code-editor.js';
import {
  setAzimuth, setAltitude, getCurrentAzimuth, getCurrentAltitude, fire,
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
  let debugGui;
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
  const camera = new THREE.PerspectiveCamera(38, 1, 0.08, 1700);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.065;
  controls.minDistance = 1.9;
  controls.maxDistance = 24;
  controls.maxPolarAngle = Math.PI * 0.485;
  controls.minPolarAngle = 0.06;
  controls.panSpeed = 0.6;
  controls.rotateSpeed = 0.65;
  controls.zoomSpeed = 0.7;
  controls.autoRotateSpeed = 0.55;
  controls.target.set(0, 1.95, 0.4);

  const environment = createEnvironment(scene, renderer);
  const model = createPhalanx();
  scene.add(model.root);
  model.elevation.rotation.x = -getCurrentAltitude();
  const effects = createFiringEffects(scene, model.muzzle);

  function stopInput() {
    stopFiring();
    effects.setEnabled(false);
  }

  function resize() {
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // A wider portrait field of view preserves the full mount and muzzle.
    camera.fov = camera.aspect < 1 ? 49 : 38;
    camera.updateProjectionMatrix();
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(viewport);
  resize();

  // Keep the original perspective camera framing.
  camera.position.set(7.1, 4.7, 8.8);
  controls.target.set(0, 1.95, 0.5);
  controls.update();

  function updateCompass() {
    const cameraBearing = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z) / DEG;
    compassArrow.setAttribute('transform', `rotate(${180 - cameraBearing} 26 26)`);
  }
  updateCompass();

  window.phalanx = Object.freeze({
    setAzimuth, setAltitude, getCurrentAzimuth, getCurrentAltitude, fire,
    model, scene, camera,
    getState: getSceneState,
    getStats: () => ({ ...model.getStats(), drawCalls: renderer.info.render.calls, renderedTriangles: renderer.info.render.triangles }),
  });

  window.addEventListener('blur', stopInput);
  const onVisibilityChange = () => { if (document.hidden) stopInput(); };
  document.addEventListener('visibilitychange', onVisibilityChange);

  function dispose() {
    if (disposed) return;
    stopInput();
    disposed = true;
    cancelAnimationFrame(frameId);
    resizeObserver.disconnect();
    window.removeEventListener('blur', stopInput);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', onPageHide);
    debugGui?.destroy();
    codeEditor?.destroy();
    effects.dispose();
    environment.dispose();
    controls.dispose();
    renderer.dispose();
  }
  function onPageHide(event) {
    stopInput();
    // Preserve the renderer for pages restored through the back/forward cache.
    if (!event.persisted) dispose();
  }
  window.addEventListener('pagehide', onPageHide);
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
  renderer.render(scene, camera);

  codeEditor = createCodeEditor({
    api: { setAzimuth, setAltitude, getCurrentAzimuth, getCurrentAltitude, fire },
    onStop: stopInput,
  });

  if (import.meta.env.DEV) {
    try {
      const { createDebugGui } = await import('./debug-gui.js');
      if (disposed) return;
      debugGui = createDebugGui();
    } catch (error) {
      console.error('Phalanx API testing panel:', error);
    }
  }
  if (disposed) return;

  let lastTime = performance.now();
  function animate(now) {
    if (disposed) return;
    frameId = requestAnimationFrame(animate);
    const dt = Math.min((now - lastTime) / 1000, .05);
    lastTime = now;
    if (document.hidden) return;
    // Send the frame to the sandbox without blocking rendering.
    codeEditor.tick(dt);
    const state = advanceMotion(dt);
    model.azimuth.rotation.y = state.azimuth * DEG;
    model.elevation.rotation.x = -state.elevation * DEG;
    model.barrels.rotation.z = (model.barrels.rotation.z + MOTION.barrelAngularSpeed * state.drive * dt) % (Math.PI * 2);
    effects.setEnabled(state.firing);
    effects.update(dt, state.elapsed, state.drive);
    environment.update(dt, state.elapsed);

    controls.update(dt);
    scene.updateMatrixWorld();
    updateCompass();
    debugGui?.sync();
    renderer.render(scene, camera);
  }
  frameId = requestAnimationFrame(animate);

  if (import.meta.hot) import.meta.hot.dispose(dispose);
}

start().catch(showError);
