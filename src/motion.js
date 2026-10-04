/** Viewer motion only: these values are chosen for comfortable interaction. */
export const MOTION = Object.freeze({
  azimuthSpeed: 36,
  elevationSpeed: 25,
  minElevation: -15,
  maxElevation: 85,
  initialElevation: 10,
  barrelAngularSpeed: 66,
});

export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const normalizeDegrees = value => ((value % 360) + 360) % 360;
export const signedDegrees = value => ((value + 180) % 360 + 360) % 360 - 180;
export const damp = (current, target, rate, dt) => current + (target - current) * (1 - Math.exp(-rate * dt));

export function createMotionState() {
  return { azimuth: 0, targetAzimuth: 0, elevation: MOTION.initialElevation, targetElevation: MOTION.initialElevation, drive: 0 };
}

export function chooseAzimuth(state, desiredDegrees) {
  state.targetAzimuth += signedDegrees(desiredDegrees - state.targetAzimuth);
}

export function stepMotion(state, dt, azimuthInput, elevationInput, fireHeld) {
  dt = clamp(dt, 0, 0.05);
  state.targetAzimuth += clamp(azimuthInput, -1, 1) * MOTION.azimuthSpeed * dt;
  state.targetElevation = clamp(state.targetElevation + clamp(elevationInput, -1, 1) * MOTION.elevationSpeed * dt, MOTION.minElevation, MOTION.maxElevation);
  state.azimuth = damp(state.azimuth, state.targetAzimuth, 13, dt);
  state.elevation = damp(state.elevation, state.targetElevation, 13, dt);
  state.drive = damp(state.drive, fireHeld ? 1 : 0, fireHeld ? 5.8 : 3.2, dt);
  if (!fireHeld && state.drive < 0.001) state.drive = 0;
}
