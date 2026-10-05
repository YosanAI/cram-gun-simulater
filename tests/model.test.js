import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createPhalanx, MOUNT_SURFACE_Y } from '../src/model.js';
import { createDroneSwarm } from '../src/drones.js';
import { createFiringEffects } from '../src/effects.js';
import { createImpactEffects } from '../src/impact-effects.js';

const DEG = Math.PI / 180;
function close(actual, expected, tolerance = 1e-9) {
  assert.ok(actual.distanceTo(expected) < tolerance, `${actual.toArray()} != ${expected.toArray()}`);
}

function harness(t) {
  const scene = new THREE.Scene();
  const model = createPhalanx();
  scene.add(model.root);
  const resources = new Set();
  model.root.traverse(object => {
    if (object.geometry) resources.add(object.geometry);
    for (const material of [object.material].flat()) if (material) resources.add(material);
  });
  t.after(() => { for (const resource of resources) resource.dispose(); });
  return { scene, model };
}

test('both rotation axes intersect at fixed scene zero and the barrel line crosses it at every pose', t => {
  const { scene, model } = harness(t);
  const zero = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  for (const azimuth of [0, 37, 90, 180, 270, 359]) {
    for (const altitude of [-15, 0, 10, 45, 85]) {
      for (const spin of [0, 1.2]) {
        model.azimuth.rotation.y = azimuth * DEG;
        model.elevation.rotation.x = -altitude * DEG;
        model.barrels.rotation.z = spin;
        scene.updateMatrixWorld(true);
        close(model.origin.getWorldPosition(new THREE.Vector3()), zero);
        close(model.elevation.getWorldPosition(new THREE.Vector3()), zero);
        // These are the original joint placements relative to their parents.
        close(model.azimuth.position, new THREE.Vector3(0, 1.02, 0));
        close(model.elevation.position, new THREE.Vector3(0, 1.06, 0));
        const yawAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(model.azimuth.getWorldQuaternion(quaternion));
        const yawPivot = model.azimuth.getWorldPosition(new THREE.Vector3());
        assert.ok(yawPivot.clone().negate().cross(yawAxis).length() < 1e-9);
        close(yawAxis, new THREE.Vector3(0, 1, 0));
        const pitchAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(model.elevation.getWorldQuaternion(quaternion));
        close(pitchAxis, new THREE.Vector3(Math.cos(azimuth * DEG), 0, -Math.sin(azimuth * DEG)));
        const direction = model.muzzle.getWorldDirection(new THREE.Vector3());
        const expected = new THREE.Vector3(Math.sin(azimuth * DEG) * Math.cos(altitude * DEG), Math.sin(altitude * DEG), Math.cos(azimuth * DEG) * Math.cos(altitude * DEG));
        close(direction, expected);
        const muzzle = model.muzzle.getWorldPosition(new THREE.Vector3());
        close(muzzle, direction.clone().multiplyScalar(3.102));
        close(model.barrels.getWorldPosition(new THREE.Vector3()), direction.clone().multiplyScalar(1.08));
        close(model.barrels.getWorldDirection(new THREE.Vector3()), direction);
      }
    }
  }
  close(model.root.position, new THREE.Vector3(0, MOUNT_SURFACE_Y, 0));
});

test('actual gun poses hit radar targets with matching azimuth and altitude about the new origin', t => {
  const { scene, model } = harness(t);
  const swarm = createDroneSwarm(scene, { groundY: MOUNT_SURFACE_Y });
  t.after(() => swarm.dispose());
  let target;
  let shots = 0;
  const effects = createFiringEffects(scene, model.muzzle, {
    onShot(origin, direction) {
      shots++;
      close(origin.clone().normalize(), target.clone().normalize());
      close(direction, target.clone().normalize());
      assert.ok(swarm.fireRay(origin, direction));
    },
  });
  t.after(() => effects.dispose());
  let time = 0;
  for (const [azimuth, altitude] of [[0, 10], [90, 30], [225, 65], [350, 85]]) {
    swarm.clear();
    swarm.queueSwarm({ count: 1, minRadius: 20, maxRadius: 20, randomDirections: false, azimuth: azimuth * DEG, altitude: altitude * DEG });
    const radar = swarm.getRadarData()[0];
    target = new THREE.Vector3(radar.pos.x, radar.pos.y, radar.pos.z);
    assert.ok(Math.abs(radar.distance - 20) < 1e-9);
    // Exercise stale cached matrices, as joints are changed before rendering.
    model.azimuth.rotation.y = azimuth * DEG;
    model.elevation.rotation.x = -altitude * DEG;
    effects.setEnabled(false);
    effects.update(0.05, time += 0.05, 1);
    effects.setEnabled(true);
    effects.update(0.05, time += 0.05, 1);
    assert.equal(swarm.getState().killed, 1);
    assert.equal(swarm.getState().active, 0);
    assert.deepEqual(swarm.getRadarData(), []);
  }
  assert.equal(shots, 4);
});

test('explosion sparks fall below the pivot origin and stop at the shifted deck height', t => {
  const scene = new THREE.Scene();
  const effects = createImpactEffects(scene, { groundY: MOUNT_SURFACE_Y, random: () => 0 });
  t.after(() => effects.dispose());
  effects.burst(new THREE.Vector3());
  effects.update(1.5);
  const sparks = scene.getObjectByName('Impact sparks').geometry;
  assert.equal(sparks.drawRange.count, 48);
  for (let i = 0; i < sparks.drawRange.count; i++) {
    assert.ok(Math.abs(sparks.attributes.position.getY(i) - (MOUNT_SURFACE_Y + 0.06)) < 1e-6);
  }
});
