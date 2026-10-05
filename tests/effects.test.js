import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createFiringEffects, FIRING_VISUALS } from '../src/effects.js';

function harness(t) {
  const scene = new THREE.Scene();
  const muzzle = new THREE.Object3D();
  scene.add(muzzle);
  let shots = 0;
  const effects = createFiringEffects(scene, muzzle, { onShot: () => shots++ });
  t.after(() => effects.dispose());
  return { scene, muzzle, effects, shots: () => shots,
    streaks: scene.getObjectByName('Illustrative firing streaks') };
}

test('tracers travel quickly and expire at 1.3 seconds without firing additional shots', t => {
  const h = harness(t);
  h.effects.update(0, 0, 1);
  h.effects.setEnabled(false);
  h.effects.update(0.1, 0.1, 0);
  h.effects.update(0.1, 0.2, 0);
  const matrix = new THREE.Matrix4();
  h.streaks.getMatrixAt(0, matrix);
  assert.ok(new THREE.Vector3().setFromMatrixPosition(matrix).z > 200);
  assert.ok(h.streaks.geometry.attributes.aOpacity.getX(0) > 0.5);
  for (let i = 0; i < 8; i++) h.effects.update(0.1, 0.3 + i * 0.1, 0);
  h.streaks.getMatrixAt(0, matrix);
  assert.ok(new THREE.Vector3().setFromMatrixPosition(matrix).z > 1000);
  assert.ok(h.streaks.geometry.attributes.aOpacity.getX(0) > 0.5);
  h.effects.update(0.1, 1.1, 0);
  h.effects.update(0.1, 1.2, 0);
  assert.ok(h.streaks.geometry.attributes.aOpacity.getX(0) > 0);
  h.effects.update(0.1, 1.3, 0);
  assert.equal(h.streaks.geometry.attributes.aOpacity.getX(0), 0);
  assert.equal(h.shots(), 1);
});

test('tracers retain their launch direction while the gun turns and the effect pool stays bounded', t => {
  const h = harness(t);
  h.muzzle.rotation.y = Math.PI / 2;
  h.effects.update(0, 0, 1);
  h.effects.setEnabled(false);
  h.muzzle.rotation.y = 0;
  for (let i = 0; i < 2; i++) h.effects.update(0.1, i * 0.1, 0);
  const matrix = new THREE.Matrix4();
  h.streaks.getMatrixAt(0, matrix);
  const position = new THREE.Vector3().setFromMatrixPosition(matrix);
  assert.ok(position.x > 200);
  assert.ok(Math.abs(position.z) < 1e-6);
  h.effects.setEnabled(true);
  for (let i = 0; i < 200; i++) h.effects.update(0.05, 1 + i * 0.05, 1);
  assert.equal(h.streaks.count, FIRING_VISUALS.streakCount);
  assert.ok(h.streaks.geometry.attributes.aOpacity.array.filter(alpha => alpha > 0).length <= FIRING_VISUALS.streakCount);
  const resources = new Set();
  h.scene.traverse(object => {
    // Three.js shares sprite geometry globally; the effect does not own it.
    if (object.geometry && !object.isSprite) resources.add(object.geometry);
    if (object.material) resources.add(object.material);
  });
  const disposed = new Map([...resources].map(resource => [resource, 0]));
  for (const resource of resources) resource.addEventListener('dispose', () => disposed.set(resource, disposed.get(resource) + 1));
  h.effects.dispose();
  h.effects.dispose();
  assert.ok([...disposed.values()].every(count => count === 1));
  assert.equal(h.scene.getObjectByName('Muzzle sparks'), undefined);
  assert.equal(h.muzzle.children.length, 0);
});
