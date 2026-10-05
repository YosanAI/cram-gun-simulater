import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createCameraViews } from '../src/camera-views.js';
import { createPhalanx } from '../src/model.js';
import { createDroneSwarm } from '../src/drones.js';

const close = (actual, expected) => assert.ok(actual.distanceTo(expected) < 1e-8);
const target = (id, x, y, z) => ({ id, pos: { x, y, z }, distance: Math.hypot(x, y, z) });

function harness(t, ui = {}) {
  const scene = new THREE.Scene();
  const model = createPhalanx();
  scene.add(model.root);
  const freeCamera = new THREE.PerspectiveCamera(38, 1.5, 0.08, 6000);
  freeCamera.position.set(7, 3, 9);
  freeCamera.lookAt(0, 0, 0);
  const controls = { enabled: true, updates: 0, update() { this.updates++; } };
  const views = createCameraViews({ freeCamera, controls, opticalSensor: model.opticalSensor, ...ui });
  t.after(() => {
    views.destroy();
    const resources = new Set();
    model.root.traverse(object => {
      if (object.geometry) resources.add(object.geometry);
      for (const material of [object.material].flat()) if (material) resources.add(material);
    });
    for (const resource of resources) resource.dispose();
  });
  return { scene, model, freeCamera, controls, views };
}

test('the forward gun camera follows both axes and sees the actual barrel surfaces without housing occlusion', t => {
  const { model, controls, views } = harness(t);
  close(model.opticalSensor.position, new THREE.Vector3(0.887, 1.06, 0.52));
  views.setView('gun');
  assert.equal(controls.enabled, false);
  const camera = views.getCamera();
  for (const yaw of [0, 37, 90, 225, 359]) {
    for (const elevation of [-15, 0, 45, 85]) {
      model.azimuth.rotation.y = THREE.MathUtils.degToRad(yaw);
      model.elevation.rotation.x = -THREE.MathUtils.degToRad(elevation);
      model.barrels.rotation.z = 1.7;
      // Follow uncached transforms, as in a frame that just advanced gun motion.
      views.update(0.05, []);
      const sensorPosition = model.opticalSensor.getWorldPosition(new THREE.Vector3());
      const sensorRotation = model.opticalSensor.getWorldQuaternion(new THREE.Quaternion());
      const localOffset = camera.position.clone().sub(sensorPosition).applyQuaternion(sensorRotation.clone().invert());
      assert.ok(localOffset.z > 0.03 && localOffset.y < 0 && localOffset.x < 0, 'the mount must be ahead of the lenses and below/inboard of the housing');
      const forward = camera.getWorldDirection(new THREE.Vector3());
      close(forward, model.muzzle.getWorldDirection(new THREE.Vector3()));
      model.root.updateMatrixWorld(true);
      const ray = new THREE.Raycaster(camera.position, forward);
      assert.equal(ray.intersectObject(model.root, true).length, 0, 'the housing must not block the view forward');
      // Being in the frustum alone does not mean the barrel is visible: cast
      // through its actual tube centers and require a tube to be the first hit.
      for (const aspect of [1.5, 0.6]) {
        views.resize(aspect);
        camera.updateMatrixWorld(true);
        for (const z of [0.55, 0.9, 1.2, 1.65, 1.9]) {
          const visible = Array.from({ length: 6 }, (_, i) => {
            const angle = i * Math.PI / 3;
            const point = model.barrels.localToWorld(new THREE.Vector3(0.122 * Math.cos(angle), 0.122 * Math.sin(angle), z));
            const projected = point.clone().project(camera);
            if (Math.abs(projected.x) >= 1 || Math.abs(projected.y) >= 1 || projected.z <= -1 || projected.z >= 1) return false;
            ray.set(camera.position, point.sub(camera.position).normalize());
            return ray.intersectObject(model.root, true)[0]?.object.parent === model.barrels;
          });
          assert.ok(visible.some(Boolean), 'actual barrel tubes must be unobstructed across most of their length in landscape and portrait');
        }
      }
    }
  }
  assert.equal(controls.updates, 0);
});

test('returning to free view preserves the independent camera and restores orbit controls', t => {
  const { freeCamera, controls, views } = harness(t);
  const position = freeCamera.position.clone();
  const orientation = freeCamera.quaternion.clone();
  views.setView('gun');
  views.update(0.05, [target(1, 20, 5, 30)]);
  views.setView('drone');
  views.update(0.05, [target(1, 19, 4.75, 28.5)]);
  close(freeCamera.position, position);
  assert.ok(freeCamera.quaternion.equals(orientation));
  assert.equal(controls.updates, 0);
  views.setView('free');
  assert.equal(views.getCamera(), freeCamera);
  assert.equal(controls.enabled, true);
  assert.equal(controls.updates, 1);
  views.update(0.05, []);
  assert.equal(controls.updates, 2);
});

test('drone view holds its target, follows flight, switches after destruction, and waits between launches', t => {
  const { scene, views } = harness(t);
  views.update(0, [target(1, 20, 5, 30), target(2, -30, 10, 20)]);
  views.setView('drone');
  const camera = views.getCamera();
  assert.equal(views.getState().droneId, 1);
  const moving = target(1, 18, 4.5, 27);
  views.update(0.05, [target(2, -30, 10, 20), moving]);
  assert.equal(views.getState().droneId, 1, 'reordering radar targets should not change the followed drone');
  const position = new THREE.Vector3(moving.pos.x, moving.pos.y, moving.pos.z);
  const direction = position.clone().normalize().negate();
  const bodyRotation = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), position, new THREE.Vector3(0, 1, 0)));
  const localPosition = camera.position.clone().sub(position).applyQuaternion(bodyRotation.invert());
  assert.ok(localPosition.z < -1.3 && localPosition.y > 0.35, 'the camera must sit above the rear airframe');
  assert.ok(camera.getWorldDirection(new THREE.Vector3()).dot(direction) > 0.98, 'the view should look forward with a slight downward tilt');
  views.update(0.05, [target(2, -30, 10, 20)]);
  assert.equal(views.getState().droneId, 2);
  const lastPosition = camera.position.clone();
  views.update(0.05, []);
  assert.deepEqual(views.getState(), { mode: 'drone', droneId: null, waiting: true });
  close(camera.position, lastPosition);
  views.update(0.05, [target(3, 0, 40, 0)]);
  assert.equal(views.getState().droneId, 3);
  assert.ok(camera.getWorldDirection(new THREE.Vector3()).dot(new THREE.Vector3(0, -1, 0)) > 0.98);

  // Check the mount and foreground against the actual instanced airframe pose.
  const swarm = createDroneSwarm(scene);
  t.after(() => swarm.dispose());
  swarm.queueSwarm({ count: 1, minRadius: 30, maxRadius: 30, randomDirections: false, azimuth: 0.9, elevation: 0.6 });
  views.update(0.05, swarm.getRadarData());
  const pose = new THREE.Matrix4();
  scene.getObjectByName('Delta-wing airframes').getMatrixAt(0, pose);
  const actualPosition = new THREE.Vector3();
  const actualRotation = new THREE.Quaternion();
  pose.decompose(actualPosition, actualRotation, new THREE.Vector3());
  const mount = camera.position.clone().sub(actualPosition).applyQuaternion(actualRotation.invert());
  assert.ok(mount.z < -1.3 && mount.y > 0.35);
  camera.updateMatrixWorld(true);
  for (const point of [new THREE.Vector3(0, 0.06, 1.4), new THREE.Vector3(-0.45, 0.045, -0.05), new THREE.Vector3(0.45, 0.045, -0.05)]) {
    const projected = point.applyMatrix4(pose).project(camera);
    assert.ok(Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1 && projected.z > -1 && projected.z < 1, 'the nose and forward wings must be visible from the tail');
  }
});

test('drone view selected before spawning retains the current pose until a drone appears', t => {
  const { views } = harness(t);
  views.setView('gun');
  const position = views.getCamera().position.clone();
  const orientation = views.getCamera().quaternion.clone();
  views.setView('drone');
  assert.equal(views.getState().waiting, true);
  close(views.getCamera().position, position);
  assert.ok(views.getCamera().quaternion.equals(orientation));
  views.update(0.05, [target(7, 0, 5, 20)]);
  assert.deepEqual(views.getState(), { mode: 'drone', droneId: 7, waiting: false });
});

test('resizing updates all projections while retaining near/far limits for each view', t => {
  const { views } = harness(t);
  for (const [aspect, fields] of [[1.7, { free: 38, gun: 60, drone: 65 }], [0.6, { free: 49, gun: 70, drone: 75 }]]) {
    views.resize(aspect);
    for (const [mode, fov] of Object.entries(fields)) {
      views.setView(mode);
      const camera = views.getCamera();
      assert.equal(camera.aspect, aspect);
      assert.equal(camera.fov, fov);
      assert.equal(camera.far, 6000);
      assert.equal(camera.near, mode === 'free' ? 0.08 : 0.03);
      assert.ok(Math.abs(camera.projectionMatrix.elements[5] / camera.projectionMatrix.elements[0] - aspect) < 1e-9);
    }
  }
});

test('view buttons update their selected state and drone status and detach on disposal', t => {
  class Button extends EventTarget {
    constructor(mode) { super(); this.dataset = { cameraView: mode }; this.attributes = new Map(); }
    setAttribute(name, value) { this.attributes.set(name, value); }
  }
  const buttons = ['free', 'gun', 'drone'].map(mode => new Button(mode));
  const status = {};
  const viewport = { dataset: {}, setAttribute() {} };
  const { views, controls } = harness(t, { tabs: { querySelectorAll: () => buttons }, status, viewport });
  assert.equal(buttons[0].attributes.get('aria-pressed'), 'true');
  buttons[2].dispatchEvent(new Event('click'));
  assert.equal(buttons[0].attributes.get('aria-pressed'), 'false');
  assert.equal(buttons[2].attributes.get('aria-pressed'), 'true');
  assert.equal(viewport.dataset.cameraView, 'drone');
  assert.equal(status.textContent, 'Waiting for a drone…');
  views.update(0.05, [target(12, 0, 5, 20)]);
  assert.equal(status.textContent, 'Drone #12');
  views.setView('free');
  views.destroy();
  buttons[1].dispatchEvent(new Event('click'));
  assert.equal(views.getState().mode, 'free');
  assert.equal(controls.enabled, true);
});
