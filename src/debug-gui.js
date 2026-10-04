import { GUI } from 'dat.gui';
import { ANGLE_LIMITS, setAzimuth, setAltitude, getCurrentAzimuth, getCurrentAltitude, fire } from './api.js';

/** Development controls exercise the same API used by the rest of the app. */
export function createDebugGui() {
  const values = {
    azimuth: getCurrentAzimuth(),
    altitude: getCurrentAltitude(),
    fire,
  };
  const gui = new GUI({ name: 'API testing', width: 280 });
  const azimuth = gui.add(values, 'azimuth', 0, Math.PI * 2)
    .step(0.001).name('Azimuth (rad)').onChange(setAzimuth);
  const altitude = gui.add(values, 'altitude', ANGLE_LIMITS.minAltitude, ANGLE_LIMITS.maxAltitude)
    .step(0.001).name('Altitude (rad)').onChange(setAltitude);
  gui.add(values, 'fire').name('Fire');

  const activePointers = new Set();
  const beginInteraction = event => activePointers.add(event.pointerId);
  const endInteraction = event => activePointers.delete(event.pointerId);
  const clearInteractions = () => activePointers.clear();
  gui.domElement.addEventListener('pointerdown', beginInteraction);
  window.addEventListener('pointerup', endInteraction);
  window.addEventListener('pointercancel', endInteraction);
  window.addEventListener('blur', clearInteractions);

  return {
    sync() {
      // Read the public getters without interrupting a drag or numeric edit.
      const focused = document.activeElement;
      if (activePointers.size || (focused?.tagName === 'INPUT' && gui.domElement.contains(focused))) return;
      const bearing = getCurrentAzimuth();
      const inclination = getCurrentAltitude();
      if (values.azimuth !== bearing) {
        values.azimuth = bearing;
        azimuth.updateDisplay();
      }
      if (values.altitude !== inclination) {
        values.altitude = inclination;
        altitude.updateDisplay();
      }
    },
    destroy() {
      gui.domElement.removeEventListener('pointerdown', beginInteraction);
      window.removeEventListener('pointerup', endInteraction);
      window.removeEventListener('pointercancel', endInteraction);
      window.removeEventListener('blur', clearInteractions);
      gui.destroy();
    },
  };
}
