import * as THREE from 'three';
import { createDroneAirframe } from './drone-model.js';
import { createImpactEffects } from './impact-effects.js';

export const DRONE_LIMITS = Object.freeze({ maxActive: 200, minRadius: 5, maxRadius: 200, minSpeed: 0.5, maxSpeed: 20, minSpawnInterval: 0.1, maxSpawnInterval: 10 });
export const DEFAULT_SWARM = Object.freeze({ count: 12, minRadius: 20, maxRadius: 40, speed: 4, spawnInterval: 0.8, randomDirections: true, azimuth: 0, altitude: Math.PI / 6 });
// Deliberately simple gameplay hit volumes and range, in scene units.
export const GUN_HIT_LIMITS = Object.freeze({ radius: 1.5, range: 250 });
const ORIGIN = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const SCALE = new THREE.Vector3(1, 1, 1);
const IMPACT_DISTANCE = 1.5; // The local +Z nose reaches the mount's origin here.

function validateOptions(options) {
  const settings = { ...DEFAULT_SWARM, ...options };
  for (const name of ['count', 'minRadius', 'maxRadius', 'speed', 'spawnInterval', 'azimuth', 'altitude']) {
    if (!Number.isFinite(settings[name])) throw new TypeError(name + ' must be a finite number.');
  }
  if (!Number.isInteger(settings.count) || settings.count < 1 || settings.count > DRONE_LIMITS.maxActive) {
    throw new RangeError('Swarm size must be an integer from 1 to ' + DRONE_LIMITS.maxActive + '.');
  }
  if (settings.minRadius < DRONE_LIMITS.minRadius || settings.maxRadius > DRONE_LIMITS.maxRadius || settings.minRadius > settings.maxRadius) {
    throw new RangeError('Spawn radii must be ordered between ' + DRONE_LIMITS.minRadius + ' and ' + DRONE_LIMITS.maxRadius + '.');
  }
  if (settings.speed < DRONE_LIMITS.minSpeed || settings.speed > DRONE_LIMITS.maxSpeed) throw new RangeError('Drone speed is outside the allowed range.');
  if (settings.spawnInterval < DRONE_LIMITS.minSpawnInterval || settings.spawnInterval > DRONE_LIMITS.maxSpawnInterval) {
    throw new RangeError('Spawn interval must be between 0.1 and 10 seconds.');
  }
  if (settings.altitude < 0 || settings.altitude > Math.PI / 2) throw new RangeError('Spawn altitude must be between the horizon and overhead.');
  if (typeof settings.randomDirections !== 'boolean') throw new TypeError('randomDirections must be a boolean.');
  return settings;
}

/** System-owned launch queue and straight flights, independent of gun scripts. */
export function createDroneSwarm(scene, { random = Math.random, onImpact = () => {} } = {}) {
  const group = new THREE.Group();
  group.name = 'Incoming drone swarm';
  scene.add(group);
  const airframe = createDroneAirframe();
  const meshes = airframe.parts.map(part => {
    const mesh = new THREE.InstancedMesh(part.geometry, part.material, DRONE_LIMITS.maxActive);
    mesh.name = part.name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.count = 0;
    group.add(mesh);
    return mesh;
  });
  const impacts = createImpactEffects(scene, { random });
  const drones = [];
  const pending = [];
  const matrix = new THREE.Matrix4();
  const shotRay = new THREE.Ray();
  const hitSphere = new THREE.Sphere(new THREE.Vector3(), GUN_HIT_LIMITS.radius);
  const hitPoint = new THREE.Vector3();
  let nextId = 0;
  let impactCount = 0;
  let killedCount = 0;
  let disposed = false;
  let simulationTime = 0;
  let lastSpawnAt = -Infinity;

  function syncMeshes() {
    drones.forEach((drone, index) => {
      matrix.compose(drone.position, drone.orientation, SCALE);
      for (const mesh of meshes) mesh.setMatrixAt(index, matrix);
    });
    for (const mesh of meshes) {
      mesh.count = drones.length;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  function clear() {
    drones.length = 0;
    pending.length = 0;
    impactCount = 0;
    killedCount = 0;
    simulationTime = 0;
    lastSpawnAt = -Infinity;
    impacts.clear();
    syncMeshes();
  }

  function activateReady() {
    while (pending.length && pending[0].spawnAt <= simulationTime + 1e-9) {
      const entry = pending.shift();
      drones.push(entry.drone);
      lastSpawnAt = entry.spawnAt;
    }
  }

  function advanceFlights(deltaTime) {
    impacts.update(deltaTime);
    for (let i = drones.length - 1; i >= 0; i--) {
      const drone = drones[i];
      const timeToImpact = Math.max(0, (drone.position.length() - IMPACT_DISTANCE) / drone.speed);
      if (timeToImpact <= deltaTime + 1e-9) {
        drones.splice(i, 1);
        impactCount++;
        impacts.burst(ORIGIN, Math.max(0, deltaTime - timeToImpact));
        onImpact({ id: drone.id, position: ORIGIN.clone(), time: simulationTime + timeToImpact });
      } else {
        drone.position.addScaledVector(drone.direction, drone.speed * deltaTime);
      }
    }
  }

  return {
    queueSwarm(options = {}) {
      if (disposed) throw new Error('The drone swarm has been disposed.');
      const settings = validateOptions(options);
      if (drones.length + pending.length + settings.count > DRONE_LIMITS.maxActive) {
        throw new RangeError('At most ' + DRONE_LIMITS.maxActive + ' drones can be in flight or queued. Clear drones or wait for impacts.');
      }
      const ids = [];
      const firstSpawnAt = pending.length
        ? pending.at(-1).spawnAt + settings.spawnInterval
        : Math.max(simulationTime, lastSpawnAt + settings.spawnInterval);
      for (let i = 0; i < settings.count; i++) {
        const radius = settings.minRadius + random() * (settings.maxRadius - settings.minRadius);
        const azimuth = settings.randomDirections ? random() * Math.PI * 2 : settings.azimuth;
        // Sampling sine(elevation) evenly distributes directions across the hemisphere.
        const altitude = settings.randomDirections ? Math.asin(random()) : settings.altitude;
        const horizontal = radius * Math.cos(altitude);
        const position = new THREE.Vector3(Math.sin(azimuth) * horizontal, Math.sin(altitude) * radius, Math.cos(azimuth) * horizontal);
        const direction = position.clone().normalize().negate();
        const orientation = new THREE.Quaternion().setFromRotationMatrix(matrix.lookAt(ORIGIN, position, UP));
        const id = ++nextId;
        pending.push({ spawnAt: firstSpawnAt + i * settings.spawnInterval, drone: { id, position, direction, orientation, speed: settings.speed } });
        ids.push(id);
      }
      activateReady();
      syncMeshes();
      return ids;
    },
    update(deltaTime) {
      if (disposed || !Number.isFinite(deltaTime) || deltaTime < 0) return;
      const endTime = simulationTime + deltaTime;
      if (!drones.length && !pending.length && !impacts.getActiveCount()) {
        simulationTime = endTime;
        return;
      }
      // Split at launch times so later drones never get an earlier drone's timestep.
      while (pending.length && pending[0].spawnAt <= endTime + 1e-9) {
        const launchTime = Math.min(endTime, Math.max(simulationTime, pending[0].spawnAt));
        advanceFlights(launchTime - simulationTime);
        simulationTime = launchTime;
        activateReady();
      }
      advanceFlights(endTime - simulationTime);
      simulationTime = endTime;
      syncMeshes();
      impacts.update(0);
    },
    clear,
    fireRay(origin, direction) {
      if (disposed || !drones.length) return null;
      // Use the actual muzzle pose, never the desired angles or camera bearing.
      shotRay.origin.copy(origin);
      shotRay.direction.copy(direction).normalize();
      if (!shotRay.direction.lengthSq()) return null;
      let nearestIndex = -1;
      let nearestDistance = Infinity;
      for (let index = 0; index < drones.length; index++) {
        hitSphere.center.copy(drones[index].position);
        if (!shotRay.intersectSphere(hitSphere, hitPoint)) continue;
        const distance = shotRay.origin.distanceTo(hitPoint);
        if (distance <= GUN_HIT_LIMITS.range && distance < nearestDistance) {
          nearestIndex = index;
          nearestDistance = distance;
        }
      }
      if (nearestIndex < 0) return null;
      const [drone] = drones.splice(nearestIndex, 1);
      killedCount++;
      // The burst follows the drone's world position, including airborne hits.
      impacts.burst(drone.position);
      impacts.update(0);
      syncMeshes();
      return { id: drone.id, position: drone.position.clone() };
    },
    getState: () => ({ active: drones.length, queued: pending.length, killed: killedCount, impacts: impactCount, explosions: impacts.getActiveCount() }),
    getRadarData: () => drones.map(drone => ({
      id: drone.id,
      pos: { x: drone.position.x, y: drone.position.y, z: drone.position.z },
      distance: drone.position.length(),
    })),
    getDrones: () => drones.map(drone => ({ id: drone.id, position: drone.position.clone(), direction: drone.direction.clone() })),
    dispose() {
      if (disposed) return;
      clear();
      disposed = true;
      scene.remove(group);
      for (const mesh of meshes) mesh.dispose();
      airframe.dispose();
      impacts.dispose();
    },
  };
}
