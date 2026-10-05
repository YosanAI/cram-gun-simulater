import { GUI } from 'dat.gui';
import { ANGLE_LIMITS, setAzimuth, setElevation, getCurrentAzimuth, getCurrentElevation, fire } from './api.js';
import { DEFAULT_SWARM, DRONE_LIMITS } from './drones.js';

/** Swarm controls in every build, with gun API testing controls in development. */
export function createSceneGui({ drones, includeGunControls = false }) {
  const host = document.getElementById('scene-controls');
  const status = document.createElement('output');
  status.className = 'scene-controls-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const gui = new GUI({ name: 'Scene controls', width: 280, autoPlace: false, closeOnTop: true });
  gui.domElement.style.width = '100%';
  host.append(status, gui.domElement);
  const values = {
    azimuth: getCurrentAzimuth(),
    elevation: getCurrentElevation(),
    fire,
    minRadius: DEFAULT_SWARM.minRadius,
    maxRadius: DEFAULT_SWARM.maxRadius,
    count: DEFAULT_SWARM.count,
    speed: DEFAULT_SWARM.speed,
    spawnInterval: DEFAULT_SWARM.spawnInterval,
    spawn() {
      try {
        drones.queueSwarm({
          minRadius: values.minRadius, maxRadius: values.maxRadius,
          count: values.count, speed: values.speed,
          spawnInterval: values.spawnInterval,
        });
        statusError = false;
        updateStatus();
      } catch (error) {
        statusError = true;
        status.classList.add('controls-error');
        status.textContent = error.message;
      }
    },
    clear() {
      drones.clear();
      statusError = false;
      updateStatus();
    },
  };
  let statusError = false;
  let previousStatus;
  function updateStatus() {
    if (statusError) return;
    const state = drones.getState();
    const message = state.active + ' in flight · ' + state.queued + ' queued · ' + state.killed + ' killed · ' + state.impacts + ' impacts';
    if (previousStatus !== message || status.classList.contains('controls-error')) {
      status.textContent = message;
      status.classList.remove('controls-error');
      previousStatus = message;
    }
  }

  let azimuth;
  let elevation;
  if (includeGunControls) {
    const gun = gui.addFolder('Gun API testing');
    azimuth = gun.add(values, 'azimuth', 0, Math.PI * 2)
      .step(0.001).name('Azimuth (rad)').onChange(setAzimuth);
    elevation = gun.add(values, 'elevation', ANGLE_LIMITS.minElevation, ANGLE_LIMITS.maxElevation)
      .step(0.001).name('Elevation (rad)').onChange(setElevation);
    gun.add(values, 'fire').name('Fire');
    gun.open();
  }

  const swarm = gui.addFolder('Drone swarm');
  swarm.add(values, 'spawn').name('Spawn swarm');
  swarm.add(values, 'clear').name('Clear drones');
  swarm.add(values, 'count', 1, DRONE_LIMITS.maxActive).step(1).name('Swarm size');
  swarm.add(values, 'spawnInterval', DRONE_LIMITS.minSpawnInterval, DRONE_LIMITS.maxSpawnInterval).step(0.1).name('Spawn interval (s)');
  const near = swarm.add(values, 'minRadius', DRONE_LIMITS.minRadius, DRONE_LIMITS.maxRadius).step(1).name('Near radius');
  const far = swarm.add(values, 'maxRadius', DRONE_LIMITS.minRadius, DRONE_LIMITS.maxRadius).step(1).name('Far radius');
  near.onChange(value => {
    if (value > values.maxRadius) { values.maxRadius = value; far.updateDisplay(); }
  });
  far.onChange(value => {
    if (value < values.minRadius) { values.minRadius = value; near.updateDisplay(); }
  });
  swarm.add(values, 'speed', DRONE_LIMITS.minSpeed, DRONE_LIMITS.maxSpeed).step(0.5).name('Speed (units/s)').onChange(value => drones.setSpeed(value));
  swarm.open();
  updateStatus();

  const activePointers = new Set();
  const beginInteraction = event => activePointers.add(event.pointerId);
  const endInteraction = event => activePointers.delete(event.pointerId);
  const clearInteractions = () => activePointers.clear();
  gui.domElement.addEventListener('pointerdown', beginInteraction);
  window.addEventListener('pointerup', endInteraction);
  window.addEventListener('pointercancel', endInteraction);
  window.addEventListener('blur', clearInteractions);

  return {
    spawnSwarm: values.spawn,
    sync() {
      updateStatus();
      if (!includeGunControls) return;
      // Read the public getters without interrupting a drag or numeric edit.
      const focused = document.activeElement;
      if (activePointers.size || (focused?.tagName === 'INPUT' && gui.domElement.contains(focused))) return;
      const bearing = getCurrentAzimuth();
      const inclination = getCurrentElevation();
      if (values.azimuth !== bearing) {
        values.azimuth = bearing;
        azimuth.updateDisplay();
      }
      if (values.elevation !== inclination) {
        values.elevation = inclination;
        elevation.updateDisplay();
      }
    },
    destroy() {
      gui.domElement.removeEventListener('pointerdown', beginInteraction);
      window.removeEventListener('pointerup', endInteraction);
      window.removeEventListener('pointercancel', endInteraction);
      window.removeEventListener('blur', clearInteractions);
      gui.destroy();
      gui.domElement.remove();
      status.remove();
    },
  };
}
