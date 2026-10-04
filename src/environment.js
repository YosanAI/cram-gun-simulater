import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/** Procedural exhibition setting. The model's mounting surface is world y = 0. */
export function createEnvironment(scene, renderer) {
  const previous = {
    background: scene.background,
    environment: scene.environment,
    fog: scene.fog,
    environmentIntensity: scene.environmentIntensity,
  };
  const group = new THREE.Group();
  group.name = 'Phalanx environment';
  scene.add(group);
  const nautical = new THREE.Group();
  nautical.name = 'Naval deck and ocean';
  group.add(nautical);
  const resources = new Set();
  const own = value => (resources.add(value), value);
  const standard = options => own(new THREE.MeshStandardMaterial(options));
  const mesh = (geometry, material, parent = group) => {
    const object = new THREE.Mesh(own(geometry), material);
    object.receiveShadow = true;
    parent.add(object);
    return object;
  };

  // Deterministic, seamless aggregate: no images need to load over the network.
  const grainCanvas = document.createElement('canvas');
  grainCanvas.width = grainCanvas.height = 256;
  const grainContext = grainCanvas.getContext('2d');
  const grainImage = grainContext.createImageData(256, 256);
  let seed = 24015;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < grainImage.data.length; i += 4) {
    const value = 125 + Math.floor(random() * 34);
    grainImage.data[i] = value - 7;
    grainImage.data[i + 1] = value;
    grainImage.data[i + 2] = value + 3;
    grainImage.data[i + 3] = 255;
  }
  grainContext.putImageData(grainImage, 0, 0);
  const grain = own(new THREE.CanvasTexture(grainCanvas));
  grain.wrapS = grain.wrapT = THREE.RepeatWrapping;
  grain.repeat.set(14, 14);
  grain.colorSpace = THREE.SRGBColorSpace;
  grain.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const bump = own(grain.clone());
  bump.colorSpace = THREE.NoColorSpace;
  bump.needsUpdate = true;
  const deckMaterial = standard({
    color: 0x65757b, map: grain, bumpMap: bump, bumpScale: 0.012,
    metalness: 0.38, roughness: 0.92,
  });
  const rimMaterial = standard({ color: 0x455661, metalness: 0.65, roughness: 0.53 });
  const darkMaterial = standard({ color: 0x202b33, metalness: 0.62, roughness: 0.7 });

  const deck = mesh(new THREE.BoxGeometry(16, 0.32, 14), deckMaterial, nautical);
  deck.position.y = -0.28; // top = -0.12; the raised mount platform meets y = 0.
  const deckEdge = mesh(new THREE.BoxGeometry(16.05, 0.055, 14.05), rimMaterial, nautical);
  deckEdge.position.y = -0.43;
  const plinth = mesh(new THREE.CylinderGeometry(2.76, 2.83, 0.15, 96), deckMaterial);
  plinth.position.y = -0.085;
  const plinthRim = mesh(new THREE.CylinderGeometry(2.79, 2.84, 0.035, 96), rimMaterial);
  plinthRim.position.y = -0.147;

  // Panel joints remain thin enough to read as a deck, rather than a grid UI.
  const seamPositions = [];
  for (let x = -6; x <= 6; x += 3) {
    seamPositions.push(x, -0.118, -7, x, -0.118, 7);
  }
  for (let z = -5; z <= 5; z += 2.5) {
    seamPositions.push(-8, -0.118, z, 8, -0.118, z);
  }
  const seams = new THREE.LineSegments(
    own(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(seamPositions, 3))),
    own(new THREE.LineBasicMaterial({ color: 0x23313a, transparent: true, opacity: 0.55 })),
  );
  nautical.add(seams);

  // Recessed tie-down fittings along both sides of the otherwise open deck.
  const anchorLocations = [];
  for (const x of [-6.7, 6.7]) {
    for (let z = -5.5; z <= 5.5; z += 2.2) anchorLocations.push([x, z]);
  }
  const anchors = new THREE.InstancedMesh(own(new THREE.CylinderGeometry(0.105, 0.105, 0.008, 20)), darkMaterial, anchorLocations.length);
  const rings = new THREE.InstancedMesh(own(new THREE.TorusGeometry(0.058, 0.012, 6, 20)), rimMaterial, anchorLocations.length);
  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
  const unitScale = new THREE.Vector3(1, 1, 1);
  anchorLocations.forEach(([x, z], i) => {
    anchors.setMatrixAt(i, matrix.makeTranslation(x, -0.115, z));
    rings.setMatrixAt(i, matrix.compose(new THREE.Vector3(x, -0.104, z), rotation, unitScale));
  });
  nautical.add(anchors, rings);

  // One transparent canvas supplies every degree tick and stencil in one draw.
  const markingCanvas = document.createElement('canvas');
  markingCanvas.width = markingCanvas.height = 1024;
  const ctx = markingCanvas.getContext('2d');
  const c = 512;
  const radius = 456;
  ctx.strokeStyle = 'rgba(184,151,94,0.68)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(c, c, radius, 0, Math.PI * 2); ctx.stroke();
  for (let degrees = 0; degrees < 360; degrees += 5) {
    const angle = degrees * Math.PI / 180;
    const major = degrees % 30 === 0;
    const outer = radius - 5;
    const inner = outer - (major ? 17 : 7);
    ctx.strokeStyle = major ? 'rgba(205,212,208,0.63)' : 'rgba(205,212,208,0.29)';
    ctx.beginPath();
    ctx.moveTo(c + Math.sin(angle) * inner, c + Math.cos(angle) * inner);
    ctx.lineTo(c + Math.sin(angle) * outer, c + Math.cos(angle) * outer);
    ctx.stroke();
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '500 25px monospace';
  ctx.fillStyle = 'rgba(220,225,219,0.7)';
  // +Z is the model's zero-bearing direction; +X is 90 degrees.
  [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(([letter, degrees]) => {
    const angle = degrees * Math.PI / 180;
    ctx.fillText(letter, c + Math.sin(angle) * 409, c + Math.cos(angle) * 409);
  });
  ctx.font = '15px monospace';
  ctx.fillStyle = 'rgba(202,212,210,0.36)';
  for (let degrees = 30; degrees < 360; degrees += 30) {
    if (degrees % 90 === 0) continue;
    const angle = degrees * Math.PI / 180;
    ctx.fillText(String(degrees).padStart(3, '0'), c + Math.sin(angle) * 414, c + Math.cos(angle) * 414);
  }
  const markingsTexture = own(new THREE.CanvasTexture(markingCanvas));
  markingsTexture.colorSpace = THREE.SRGBColorSpace;
  markingsTexture.anisotropy = grain.anisotropy;
  const markings = mesh(new THREE.PlaneGeometry(5.86, 5.86), own(new THREE.MeshBasicMaterial({
    map: markingsTexture, transparent: true, depthWrite: false, polygonOffset: true,
    polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  })));
  markings.rotation.x = -Math.PI / 2;
  markings.position.y = -0.008;
  markings.renderOrder = 1;

  // A calm sea: analytic small waves keep both geometry and draw count modest.
  const oceanMaterial = own(new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uHaze: { value: new THREE.Color(0x526976) } },
    vertexShader: `
      uniform float uTime;
      varying vec3 vWorld;
      varying vec3 vNormal;
      void main() {
        vec3 p = position;
        float a = p.x * 0.13 + p.z * 0.08 + uTime * 0.31;
        float b = p.z * 0.23 - p.x * 0.06 - uTime * 0.25;
        p.y += sin(a) * 0.09 + sin(b) * 0.045;
        float dx = cos(a) * 0.0117 - cos(b) * 0.0027;
        float dz = cos(a) * 0.0072 + cos(b) * 0.01035;
        vNormal = normalize(vec3(-dx, 1.0, -dz));
        vWorld = (modelMatrix * vec4(p, 1.0)).xyz;
        gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform vec3 uHaze;
      varying vec3 vWorld;
      varying vec3 vNormal;
      void main() {
        vec3 viewDirection = normalize(cameraPosition - vWorld);
        vec3 n = normalize(vNormal + vec3(
          sin(vWorld.x * 1.9 + vWorld.z * 1.4 + uTime * 0.6) * 0.025,
          0.0,
          cos(vWorld.z * 2.3 - vWorld.x * 0.8 + uTime * 0.4) * 0.023
        ));
        float fresnel = pow(1.0 - max(dot(n, viewDirection), 0.0), 4.0);
        vec3 color = mix(vec3(0.012,0.032,0.046), vec3(0.115,0.175,0.21), fresnel);
        vec3 halfDirection = normalize(viewDirection + normalize(vec3(-0.4,0.6,0.5)));
        float sheen = pow(max(dot(n, halfDirection), 0.0), 100.0);
        color += sheen * vec3(0.32,0.31,0.26);
        float distanceFromCamera = length(cameraPosition.xz - vWorld.xz);
        color = mix(color, uHaze, 1.0-exp(-distanceFromCamera*0.0045));
        gl_FragColor = vec4(color,1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  }));
  const oceanGeometry = new THREE.PlaneGeometry(3000, 3000, 100, 100);
  oceanGeometry.rotateX(-Math.PI / 2);
  const ocean = mesh(oceanGeometry, oceanMaterial, nautical);
  ocean.name = 'Procedural ocean';
  ocean.position.y = -1.45;
  ocean.receiveShadow = false;

  const skyCanvas = document.createElement('canvas');
  skyCanvas.width = 1024;
  skyCanvas.height = 512;
  const skyContext = skyCanvas.getContext('2d');
  const skyGradient = skyContext.createLinearGradient(0, 0, 0, 512);
  skyGradient.addColorStop(0, '#0c1622');
  skyGradient.addColorStop(0.32, '#243c50');
  skyGradient.addColorStop(0.48, '#526976');
  skyGradient.addColorStop(0.515, '#617781');
  skyGradient.addColorStop(0.6, '#263e4b');
  skyGradient.addColorStop(1, '#152630');
  skyContext.fillStyle = skyGradient;
  skyContext.fillRect(0, 0, 1024, 512);
  const sky = own(new THREE.CanvasTexture(skyCanvas));
  sky.mapping = THREE.EquirectangularReflectionMapping;
  sky.colorSpace = THREE.SRGBColorSpace;

  const studioFloor = mesh(new THREE.PlaneGeometry(180, 180), standard({
    color: 0x24323e, roughness: 0.95, metalness: 0.16,
  }));
  studioFloor.rotation.x = -Math.PI / 2;
  studioFloor.position.y = -0.175;
  studioFloor.visible = false;

  // The room provides soft reflections on every bolt and every dark barrel.
  const room = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environmentTarget = pmrem.fromScene(room, 0.055);
  room.dispose();
  pmrem.dispose();
  scene.environment = environmentTarget.texture;
  scene.environmentIntensity = 0.65;

  const key = new THREE.DirectionalLight(0xffead0, 3.5);
  key.position.set(-4.5, 8, 6);
  key.target.position.set(0, 1.6, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -7, right: 7, top: 8, bottom: -7, near: 0.5, far: 27 });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -0.00015;
  key.shadow.normalBias = 0.025;
  key.shadow.radius = 3;
  const fill = new THREE.DirectionalLight(0xb3d9ff, 1.65);
  fill.position.set(5, 4.2, 2);
  const rim = new THREE.DirectionalLight(0xe2f0ff, 2.5);
  rim.position.set(-2.5, 6, -7);
  const ambient = new THREE.HemisphereLight(0xc4d9eb, 0x3a4653, 0.7);
  group.add(key, key.target, fill, rim, ambient);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  let disposed = false;
  let currentMode = 'deck';
  function setMode(mode) {
    currentMode = mode === 'studio' ? 'studio' : 'deck';
    const isDeck = currentMode === 'deck';
    nautical.visible = isDeck;
    studioFloor.visible = !isDeck;
    scene.background = isDeck ? sky : new THREE.Color(0x17222d);
    scene.fog = isDeck ? new THREE.FogExp2(0x526976, 0.0025) : new THREE.Fog(0x17222d, 18, 65);
    scene.environmentIntensity = isDeck ? 0.65 : 0.85;
    key.intensity = isDeck ? 3.5 : 3.1;
    fill.intensity = isDeck ? 1.65 : 2.0;
  }
  setMode('deck');

  return {
    update(dt, time) {
      if (disposed || currentMode !== 'deck') return;
      oceanMaterial.uniforms.uTime.value = Number.isFinite(time)
        ? time : oceanMaterial.uniforms.uTime.value + Math.min(dt || 0, 0.1);
    },
    setMode,
    dispose() {
      if (disposed) return;
      disposed = true;
      scene.remove(group);
      key.shadow.dispose();
      environmentTarget.dispose();
      for (const resource of resources) resource.dispose();
      scene.background = previous.background;
      scene.environment = previous.environment;
      scene.fog = previous.fog;
      scene.environmentIntensity = previous.environmentIntensity;
    },
  };
}
