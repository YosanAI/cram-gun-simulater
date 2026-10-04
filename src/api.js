import { MOTION, clamp, normalizeDegrees, createMotionState, chooseAzimuth, stepMotion } from './motion.js';

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const BURST_DURATION = 0.7;
const state = createMotionState();
let elapsed = 0;
let firingUntil = 0;
let burstTime = 0;

export const ANGLE_LIMITS = Object.freeze({
  minAltitude: MOTION.minElevation * DEG,
  maxAltitude: MOTION.maxElevation * DEG,
});

function validateAngle(rad) {
  if (!Number.isFinite(rad)) throw new TypeError('Angle must be a finite number in radians.');
}

/** Command a bearing in radians, following the existing shortest-path motion. */
export function setAzimuth(rad) {
  validateAngle(rad);
  const bearing = ((rad % TAU) + TAU) % TAU;
  chooseAzimuth(state, bearing / DEG);
}

/** Command the barrel inclination in radians, within the existing viewer limits. */
export function setAltitude(rad) {
  validateAngle(rad);
  state.targetElevation = clamp(rad, ANGLE_LIMITS.minAltitude, ANGLE_LIMITS.maxAltitude) / DEG;
}

/** Current animated bearing, normalized to [0, 2π), in radians. */
export function getCurrentAzimuth() {
  return normalizeDegrees(state.azimuth) * DEG;
}

/** Current animated barrel inclination in radians. */
export function getCurrentAltitude() {
  return state.elevation * DEG;
}

/** Start a short visual burst; repeated calls extend it from the latest call. */
export function fire() {
  if (elapsed >= firingUntil) burstTime = 0;
  firingUntil = elapsed + BURST_DURATION;
}

// Scene lifecycle helpers. Consumers only need the five functions above.
export function stopFiring() {
  firingUntil = elapsed;
}

export function getSceneState() {
  return { ...state, elapsed, burstTime, firing: elapsed < firingUntil };
}

export function advanceMotion(dt) {
  const delta = Number.isFinite(dt) ? clamp(dt, 0, 0.05) : 0;
  elapsed += delta;
  const firing = elapsed < firingUntil;
  stepMotion(state, delta, 0, 0, firing);
  if (firing) burstTime += delta;
  return { ...state, elapsed, burstTime, firing };
}
