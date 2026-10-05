import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createDroneSwarm, DRONE_LIMITS, GUN_HIT_LIMITS } from '../src/drones.js';
import { createImpactEffects } from '../src/impact-effects.js';
import { createFiringEffects } from '../src/effects.js';

function seededRandom() {
  let seed = 1234;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function harness(t, options = {}) {
  const scene = new THREE.Scene();
  const swarm = createDroneSwarm(scene, { random: seededRandom(), ...options });
  t.after(() => swarm.dispose());
  return { scene, swarm };
}

test('random swarms honor their count and radius range across the upper hemisphere', t => {
  const { swarm } = harness(t);
  const ids = swarm.queueSwarm({ count: 200, minRadius: 12, maxRadius: 35, spawnInterval: 0.1 });
  assert.equal(new Set(ids).size, 200);
  const seen = new Map();
  for (let frame = 0; frame < 200; frame++) {
    for (const drone of swarm.getDrones()) if (!seen.has(drone.id)) seen.set(drone.id, drone);
    swarm.update(0.1);
  }
  const drones = [...seen.values()];
  assert.equal(drones.length, 200);
  for (const drone of drones) {
    assert.ok(drone.position.length() >= 12 && drone.position.length() <= 35);
    assert.ok(drone.position.y >= 0);
    assert.ok(drone.direction.dot(drone.position.clone().normalize()) < -0.999999);
  }
  assert.ok(drones.some(drone => drone.position.x < 0) && drones.some(drone => drone.position.x > 0));
  assert.ok(drones.some(drone => drone.position.z < 0) && drones.some(drone => drone.position.z > 0));
});

test('fixed bearings match the gun coordinates, including horizon and overhead', t => {
  const { swarm } = harness(t);
  for (const [azimuth, elevation, expected] of [
    [0, 0, new THREE.Vector3(0, 0, 10)],
    [Math.PI / 2, 0, new THREE.Vector3(10, 0, 0)],
    [Math.PI, Math.PI / 6, new THREE.Vector3(0, 5, -Math.sqrt(75))],
    [0, Math.PI / 2, new THREE.Vector3(0, 10, 0)],
  ]) {
    swarm.clear();
    swarm.queueSwarm({ count: 1, minRadius: 10, maxRadius: 10, randomDirections: false, azimuth, elevation });
    assert.ok(swarm.getDrones()[0].position.distanceTo(expected) < 1e-10);
  }
});

test('drones keep their nose toward the origin and advance at the configured speed', t => {
  const { scene, swarm } = harness(t);
  swarm.queueSwarm({ count: 1, minRadius: 20, maxRadius: 20, speed: 4 });
  const before = swarm.getDrones()[0];
  swarm.update(0.5);
  const after = swarm.getDrones()[0];
  assert.ok(Math.abs(before.position.distanceTo(after.position) - 2) < 1e-10);
  assert.ok(Math.abs(after.position.length() - 18) < 1e-10);
  const matrix = new THREE.Matrix4();
  scene.getObjectByName('Delta-wing airframes').getMatrixAt(0, matrix);
  const forward = new THREE.Vector3(0, 0, 1).transformDirection(matrix);
  assert.ok(forward.dot(after.direction) > 0.999999);
  // Inspection data must not permit external code to move live drones.
  after.position.set(0, 0, 0);
  assert.ok(swarm.getDrones()[0].position.length() > 17);
});

test('crossing the origin triggers one impact, removes the drone, and lets the explosion expire', t => {
  const impacts = [];
  const { scene, swarm } = harness(t, { onImpact: impact => impacts.push(impact) });
  swarm.queueSwarm({ count: 1, minRadius: 5, maxRadius: 5, speed: 20 });
  swarm.update(1);
  assert.deepEqual(swarm.getState(), { active: 0, queued: 0, killed: 0, impacts: 1, explosions: 1 });
  assert.equal(impacts.length, 1);
  assert.equal(impacts[0].position.length(), 0);
  assert.equal(scene.getObjectByName('Delta-wing airframes').count, 0);
  assert.equal(scene.getObjectByName('Impact fireballs').count, 1);
  swarm.update(6);
  assert.deepEqual(swarm.getState(), { active: 0, queued: 0, killed: 0, impacts: 1, explosions: 0 });
  assert.equal(impacts.length, 1);
  assert.equal(scene.getObjectByName('Impact fireballs').count, 0);
  assert.equal(scene.getObjectByName('Impact sparks').geometry.drawRange.count, 0);
});

test('invalid settings or capacity overflow reject a whole spawn without changing the swarm', t => {
  const { swarm } = harness(t);
  swarm.queueSwarm({ count: 2 });
  const before = swarm.getState();
  for (const settings of [
    { count: 0 }, { count: 1.5 }, { count: NaN }, { count: '2' },
    { count: DRONE_LIMITS.maxActive }, { minRadius: 40, maxRadius: 20 },
    { minRadius: 0 }, { maxRadius: 201 }, { speed: Infinity }, { speed: 0 },
    { elevation: -1 }, { elevation: Math.PI }, { azimuth: '1' }, { randomDirections: 'yes' },
    { spawnInterval: 0 }, { spawnInterval: -1 }, { spawnInterval: 11 },
    { spawnInterval: NaN }, { spawnInterval: '0.8' },
  ]) {
    assert.throws(() => swarm.queueSwarm(settings));
    assert.deepEqual(swarm.getState(), before);
  }
});

test('a large queued swarm stays within the effect pool, and Clear resets flights and effects', t => {
  const { scene, swarm } = harness(t);
  swarm.queueSwarm({ count: 200, minRadius: 5, maxRadius: 5, speed: 20, spawnInterval: 0.1 });
  // Instancing keeps the airframe draw count constant as swarm size grows.
  const meshes = scene.getObjectByName('Incoming drone swarm').children;
  assert.equal(meshes.length, 2);
  assert.ok(meshes.every(mesh => mesh.isInstancedMesh && mesh.count === 1));
  assert.equal(swarm.getState().queued, 199);
  swarm.update(20.25);
  assert.deepEqual(swarm.getState(), { active: 0, queued: 0, killed: 0, impacts: 200, explosions: 32 });
  swarm.queueSwarm({ count: 3 });
  swarm.clear();
  assert.deepEqual(swarm.getState(), { active: 0, queued: 0, killed: 0, impacts: 0, explosions: 0 });
  assert.ok(meshes.every(mesh => mesh.count === 0));
  assert.equal(scene.getObjectByName('Impact sparks').geometry.drawRange.count, 0);
  assert.equal(swarm.queueSwarm({ count: 200 }).length, 200);
});

test('disposal frees shared resources once and preserves other scene objects', t => {
  const { scene, swarm } = harness(t);
  const unrelated = new THREE.Group();
  scene.add(unrelated);
  const meshes = [];
  scene.traverse(object => { if (object.isMesh || object.isPoints) meshes.push(object); });
  const resources = new Set(meshes.flatMap(mesh => [mesh.geometry, mesh.material]));
  const disposals = new Map();
  for (const resource of resources) resource.addEventListener('dispose', () => disposals.set(resource, (disposals.get(resource) || 0) + 1));
  swarm.queueSwarm();
  swarm.dispose();
  swarm.dispose();
  assert.deepEqual(scene.children, [unrelated]);
  for (const resource of resources) assert.equal(disposals.get(resource), 1);
  assert.throws(() => swarm.queueSwarm(), /disposed/);
});

test('impact particles fade and the bounded pool can be reused', t => {
  const scene = new THREE.Scene();
  const effects = createImpactEffects(scene, { random: seededRandom(), capacity: 2 });
  t.after(() => effects.dispose());
  for (let i = 0; i < 5; i++) effects.burst(new THREE.Vector3(i, 0, 0));
  effects.update(0.1);
  assert.equal(effects.getActiveCount(), 2);
  assert.equal(scene.getObjectByName('Impact fireballs').count, 2);
  assert.equal(scene.getObjectByName('Impact sparks').geometry.drawRange.count, 96);
  effects.update(1.2);
  assert.equal(scene.getObjectByName('Impact fireballs').count, 0);
  assert.ok(scene.getObjectByName('Impact smoke').count > 0);
  effects.update(4);
  assert.equal(effects.getActiveCount(), 0);
  assert.equal(scene.getObjectByName('Impact smoke').count, 0);
  effects.burst(new THREE.Vector3());
  effects.update(0);
  assert.equal(effects.getActiveCount(), 1);
});

test('equal-distance drones launch and impact at the selected interval', t => {
  const hits = [];
  const { swarm } = harness(t, { onImpact: hit => hits.push(hit) });
  const ids = swarm.queueSwarm({ count: 3, minRadius: 10, maxRadius: 10, speed: 4, spawnInterval: 0.5, randomDirections: false });
  assert.equal(swarm.getState().active, 1);
  assert.equal(swarm.getState().queued, 2);
  swarm.update(0.49);
  assert.equal(swarm.getState().active, 1);
  swarm.update(0.01);
  assert.equal(swarm.getState().active, 2);
  assert.ok(Math.abs(swarm.getDrones().find(drone => drone.id === ids[1]).position.length() - 10) < 1e-9);
  swarm.update(0.5);
  assert.equal(swarm.getState().active, 3);
  assert.equal(swarm.getState().queued, 0);
  swarm.update(1.15);
  assert.equal(hits.length, 1);
  swarm.update(0.5);
  assert.equal(hits.length, 2);
  swarm.update(0.5);
  assert.equal(hits.length, 3);
  assert.deepEqual(hits.map(hit => hit.id), ids);
  for (let i = 1; i < hits.length; i++) assert.ok(Math.abs(hits[i].time - hits[i - 1].time - 0.5) < 1e-9);
});

test('long and short frames produce the same scheduled flight positions', t => {
  const { swarm: longFrames } = harness(t);
  const { swarm: shortFrames } = harness(t);
  const options = { count: 5, minRadius: 20, maxRadius: 20, speed: 4, spawnInterval: 0.5, randomDirections: false };
  longFrames.queueSwarm(options);
  shortFrames.queueSwarm(options);
  longFrames.update(2.2);
  for (let i = 0; i < 22; i++) shortFrames.update(0.1);
  assert.deepEqual(longFrames.getState(), shortFrames.getState());
  const other = shortFrames.getDrones();
  longFrames.getDrones().forEach((drone, index) => {
    assert.ok(drone.position.distanceTo(other[index].position) < 1e-9);
  });
  assert.ok(Math.abs(longFrames.getDrones().at(-1).position.length() - 19.2) < 1e-9);
});

test('repeated swarm requests append to the queue without simultaneous launches', t => {
  const { swarm } = harness(t);
  swarm.queueSwarm({ count: 2, spawnInterval: 0.5 });
  swarm.queueSwarm({ count: 3, spawnInterval: 0.25 });
  assert.equal(swarm.getState().active, 1);
  assert.equal(swarm.getState().queued, 4);
  swarm.update(0.5);
  assert.equal(swarm.getState().active, 2);
  swarm.update(0.25);
  assert.equal(swarm.getState().active, 3);
  swarm.update(0.5);
  assert.equal(swarm.getState().active, 5);
  assert.equal(swarm.getState().queued, 0);
});

test('Clear cancels every pending launch and the next swarm can start immediately', t => {
  const hits = [];
  const { swarm } = harness(t, { onImpact: hit => hits.push(hit) });
  swarm.queueSwarm({ count: 4, spawnInterval: 2 });
  swarm.update(0.2);
  assert.equal(swarm.getState().queued, 3);
  swarm.clear();
  swarm.update(20);
  assert.deepEqual(swarm.getState(), { active: 0, queued: 0, killed: 0, impacts: 0, explosions: 0 });
  assert.equal(hits.length, 0);
  swarm.queueSwarm({ count: 1 });
  assert.equal(swarm.getState().active, 1);
});

test('large fireballs include layered flames and a growing shockwave, then clean up', t => {
  const scene = new THREE.Scene();
  const effects = createImpactEffects(scene, { random: seededRandom() });
  t.after(() => effects.dispose());
  effects.burst(new THREE.Vector3());
  effects.update(0.25);
  const matrix = new THREE.Matrix4();
  scene.getObjectByName('Impact fireballs').getMatrixAt(0, matrix);
  assert.ok(new THREE.Vector3().setFromMatrixScale(matrix).x > 8);
  assert.ok(scene.getObjectByName('Impact white-hot cores').count > 0);
  assert.ok(scene.getObjectByName('Impact flame lobes').count > 1);
  const shockwave = scene.getObjectByName('Impact shockwaves');
  assert.equal(shockwave.count, 1);
  shockwave.getMatrixAt(0, matrix);
  const radius = new THREE.Vector3().setFromMatrixScale(matrix).x;
  effects.update(0.25);
  shockwave.getMatrixAt(0, matrix);
  assert.ok(new THREE.Vector3().setFromMatrixScale(matrix).x > radius);
  effects.update(2);
  assert.equal(scene.getObjectByName('Impact fireballs').count, 0);
  assert.ok(scene.getObjectByName('Impact smoke').count > 0);
  effects.update(3);
  for (const name of ['Impact fireballs', 'Impact white-hot cores', 'Impact flame lobes', 'Impact smoke', 'Impact shockwaves']) {
    assert.equal(scene.getObjectByName(name).count, 0);
  }
  assert.equal(scene.getObjectByName('Impact sparks').geometry.drawRange.count, 0);
});

test('radar snapshots contain only live target IDs, plain positions, and scalar distances', t => {
  const { swarm } = harness(t);
  const ids = swarm.queueSwarm({ count: 2, minRadius: 10, maxRadius: 10, speed: 4, randomDirections: false, elevation: 0 });
  const snapshot = swarm.getRadarData();
  assert.deepEqual(snapshot, [{ id: ids[0], pos: { x: 0, y: 0, z: 10 }, distance: 10 }]);
  snapshot[0].pos.z = 999;
  snapshot.pop();
  swarm.update(0.5);
  assert.deepEqual(swarm.getRadarData(), [{ id: ids[0], pos: { x: 0, y: 0, z: 8 }, distance: 8 }]);
  swarm.clear();
  assert.deepEqual(swarm.getRadarData(), []);
});

test('a gun hit removes the live drone once, explodes in the air, and counts a kill without a mount impact', t => {
  const mountImpacts = [];
  const { scene, swarm } = harness(t, { onImpact: hit => mountImpacts.push(hit) });
  const [id] = swarm.queueSwarm({ count: 1, minRadius: 20, maxRadius: 20, randomDirections: false, elevation: Math.PI / 6 });
  const position = swarm.getDrones()[0].position;
  const origin = new THREE.Vector3(0, 3, 2);
  const direction = position.clone().sub(origin).normalize();
  const hit = swarm.fireRay(origin, direction);
  assert.equal(hit.id, id);
  assert.ok(hit.position.distanceTo(position) < 1e-9);
  assert.deepEqual(swarm.getState(), { active: 0, queued: 0, killed: 1, impacts: 0, explosions: 1 });
  assert.deepEqual(swarm.getRadarData(), []);
  assert.equal(scene.getObjectByName('Delta-wing airframes').count, 0);
  assert.equal(scene.getObjectByName('Airframe trailing-edge details').count, 0);
  const matrix = new THREE.Matrix4();
  scene.getObjectByName('Impact fireballs').getMatrixAt(0, matrix);
  const fireballPosition = new THREE.Vector3().setFromMatrixPosition(matrix);
  assert.ok(Math.abs(fireballPosition.y - position.y - 1) < 1e-6);
  assert.ok(Math.abs(fireballPosition.z - position.z) < 1e-6);
  assert.equal(swarm.fireRay(origin, direction), null);
  swarm.update(6);
  assert.equal(swarm.getState().killed, 1);
  assert.equal(swarm.getState().explosions, 0);
  assert.deepEqual(mountImpacts, []);
  swarm.clear();
  assert.equal(swarm.getState().killed, 0);
});

test('a shot hits only the nearest intersected drone and never destroys queued drones', t => {
  const { swarm } = harness(t);
  const [farId] = swarm.queueSwarm({ count: 1, minRadius: 30, maxRadius: 30, randomDirections: false, elevation: 0 });
  const [nearId, queuedId] = swarm.queueSwarm({ count: 2, minRadius: 10, maxRadius: 10, randomDirections: false, elevation: 0 });
  swarm.update(0.8);
  const origin = new THREE.Vector3();
  const direction = new THREE.Vector3(0, 0, 1);
  assert.equal(swarm.fireRay(origin, direction).id, nearId);
  assert.deepEqual(swarm.getRadarData().map(target => target.id), [farId]);
  assert.equal(swarm.fireRay(origin, direction).id, farId);
  assert.equal(swarm.fireRay(origin, direction), null);
  assert.equal(swarm.getState().queued, 1);
  swarm.update(0.8);
  assert.deepEqual(swarm.getRadarData().map(target => target.id), [queuedId]);
  assert.equal(swarm.getState().killed, 2);
});

test('hit detection rejects misses, targets behind the muzzle, and targets beyond range', t => {
  const { swarm } = harness(t);
  swarm.queueSwarm({ count: 1, minRadius: 20, maxRadius: 20, randomDirections: false, elevation: 0 });
  const forward = new THREE.Vector3(0, 0, 1);
  assert.equal(swarm.fireRay(new THREE.Vector3(), new THREE.Vector3(1, 0, 0)), null);
  assert.equal(swarm.fireRay(new THREE.Vector3(), new THREE.Vector3()), null);
  assert.equal(swarm.fireRay(new THREE.Vector3(0, 0, 30), forward), null);
  assert.equal(swarm.fireRay(new THREE.Vector3(0, 0, -GUN_HIT_LIMITS.range), forward), null);
  assert.equal(swarm.fireRay(new THREE.Vector3(GUN_HIT_LIMITS.radius + 0.01, 0, 0), forward), null);
  assert.equal(swarm.getState().active, 1);
  assert.equal(swarm.getState().killed, 0);
  assert.ok(swarm.fireRay(new THREE.Vector3(GUN_HIT_LIMITS.radius - 0.01, 0, 0), forward));
});

test('firing effects hit through the current muzzle world transform and disabled firing cannot kill', t => {
  const { scene, swarm } = harness(t);
  swarm.queueSwarm({ count: 1, minRadius: 20, maxRadius: 20, randomDirections: false, azimuth: Math.PI / 2, elevation: 0 });
  const rig = new THREE.Group();
  const muzzle = new THREE.Object3D();
  muzzle.position.z = 1;
  rig.add(muzzle);
  scene.add(rig);
  scene.updateMatrixWorld(true);
  // Leave cached world matrices stale, as happens before the render step.
  rig.rotation.y = Math.PI / 2;
  let shots = 0;
  const effects = createFiringEffects(scene, muzzle, {
    onShot(origin, direction) {
      shots++;
      assert.ok(origin.distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-9);
      assert.ok(direction.distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-9);
      swarm.fireRay(origin, direction);
    },
  });
  t.after(() => effects.dispose());
  effects.setEnabled(false);
  effects.update(0.05, 0.05, 1);
  assert.equal(shots, 0);
  assert.equal(swarm.getState().killed, 0);
  effects.setEnabled(true);
  effects.update(0.05, 0.1, 1);
  assert.equal(shots, 1);
  assert.equal(swarm.getState().killed, 1);
  assert.equal(swarm.getState().active, 0);
  effects.setEnabled(false);
  effects.update(0.05, 0.15, 1);
  assert.equal(shots, 1);
});

test('shot emission cadence stays consistent across frame sizes', t => {
  function countShots(steps, delta) {
    const scene = new THREE.Scene();
    const muzzle = new THREE.Object3D();
    scene.add(muzzle);
    let shots = 0;
    const effects = createFiringEffects(scene, muzzle, { onShot: () => shots++ });
    t.after(() => effects.dispose());
    for (let frame = 0; frame < steps; frame++) effects.update(delta, frame * delta, 1);
    return shots;
  }
  assert.equal(countShots(100, 0.01), countShots(10, 0.1));
});
