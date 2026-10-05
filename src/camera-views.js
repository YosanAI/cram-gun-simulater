import * as THREE from 'three';

const MODES = ['free', 'gun', 'drone'];
const FORWARD_CAMERA = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
// Just ahead of the lenses, inboard and above the receiver, clear of the pod.
const GUN_MOUNT_OFFSET = new THREE.Vector3(-0.587, -0.46, 0.06);
const DRONE_TAIL_MOUNT = new THREE.Vector3(0, 0.52, -1.42);
const DRONE_VIEW_ROTATION = FORWARD_CAMERA.clone().multiply(
  new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -THREE.MathUtils.degToRad(10)),
);
const ORIGIN = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const VIEW_LABELS = {
  free: '3D scene. Drag to orbit, scroll or pinch to zoom, right-drag to pan.',
  gun: '3D scene beside the gun optical pod, looking over the barrel. Follows gun azimuth and elevation.',
  drone: '3D scene from above an incoming drone tail, looking over its airframe toward the gun.',
};

/** Separate cameras preserve the free orbit while the other views follow live poses. */
export function createCameraViews({ freeCamera, controls, opticalSensor, tabs, status, viewport }) {
  const gunCamera = freeCamera.clone();
  const droneCamera = freeCamera.clone();
  gunCamera.name = 'Gun forward camera';
  droneCamera.name = 'Drone tail camera';
  gunCamera.near = droneCamera.near = 0.03;
  const cameras = { free: freeCamera, gun: gunCamera, drone: droneCamera };
  const buttons = [...(tabs?.querySelectorAll('[data-camera-view]') || [])];
  const mountOffset = new THREE.Vector3();
  const droneOrientation = new THREE.Quaternion();
  const droneRotation = new THREE.Matrix4();
  let mode = 'free';
  let droneId = null;
  let lastRadarData = [];

  function syncUi() {
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.cameraView === mode));
    if (status) status.textContent = mode === 'free' ? 'Orbit · pan · zoom'
      : mode === 'gun' ? 'Gun-mounted' : droneId === null ? 'Waiting for a drone…' : 'Drone #' + droneId;
    if (viewport) {
      viewport.dataset.cameraView = mode;
      viewport.setAttribute('aria-label', VIEW_LABELS[mode]);
    }
  }

  function resize(aspect) {
    for (const [name, camera] of Object.entries(cameras)) {
      camera.aspect = aspect;
      camera.fov = name === 'free' ? (aspect < 1 ? 49 : 38)
        : name === 'gun' ? (aspect < 1 ? 70 : 60) : (aspect < 1 ? 75 : 65);
      camera.updateProjectionMatrix();
    }
  }

  function update(deltaTime, radarData = lastRadarData) {
    lastRadarData = radarData;
    if (mode === 'free') {
      controls.update(deltaTime);
    } else if (mode === 'gun') {
      opticalSensor.getWorldPosition(gunCamera.position);
      opticalSensor.getWorldQuaternion(gunCamera.quaternion);
      // Keep the mount clear of the housing as both gun joints rotate.
      gunCamera.position.add(mountOffset.copy(GUN_MOUNT_OFFSET).applyQuaternion(gunCamera.quaternion));
      // Three.js cameras look down -Z; the optical head looks along +Z.
      gunCamera.quaternion.multiply(FORWARD_CAMERA);
    } else {
      const target = radarData.find(item => item.id === droneId) || radarData[0];
      const nextId = target?.id ?? null;
      if (nextId !== droneId) { droneId = nextId; syncUi(); }
      if (target) {
        droneCamera.position.set(target.pos.x, target.pos.y, target.pos.z);
        // Match the airframe's +Z-forward orientation, including vertical flights.
        droneOrientation.setFromRotationMatrix(droneRotation.lookAt(ORIGIN, droneCamera.position, UP));
        droneCamera.position.add(mountOffset.copy(DRONE_TAIL_MOUNT).applyQuaternion(droneOrientation));
        droneCamera.quaternion.copy(droneOrientation).multiply(DRONE_VIEW_ROTATION);
      }
    }
  }

  function setView(nextMode) {
    if (!MODES.includes(nextMode)) throw new RangeError('Unknown camera view: ' + nextMode);
    if (nextMode === mode) return;
    if (nextMode === 'drone') {
      // If no drone is live yet, keep the current view until the next launch.
      droneCamera.position.copy(cameras[mode].position);
      droneCamera.quaternion.copy(cameras[mode].quaternion);
    }
    mode = nextMode;
    droneId = null;
    controls.enabled = mode === 'free';
    update(0);
    syncUi();
  }

  const selectView = event => setView(event.currentTarget.dataset.cameraView);
  for (const button of buttons) button.addEventListener('click', selectView);
  resize(freeCamera.aspect);
  syncUi();

  return {
    update, resize, setView,
    getCamera: () => cameras[mode],
    getState: () => ({ mode, droneId, waiting: mode === 'drone' && droneId === null }),
    destroy() {
      for (const button of buttons) button.removeEventListener('click', selectView);
      controls.enabled = true;
    },
  };
}
